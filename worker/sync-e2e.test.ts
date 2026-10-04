import { env, exports } from "cloudflare:workers";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import { buildGroceryList } from "../src/domain/engines/grocery";
import { replayObservations } from "../src/domain/engines/pricing";
import { rollCycle } from "../src/domain/engines/roller";
import { scaleRecipe } from "../src/domain/engines/scaling";
import type { PriceObservation } from "../src/domain/schemas/app";
import { createStorage, type Storage } from "../src/storage";
import { writeTx } from "../src/storage/outbox";

const RUN = Date.now().toString(36);
let clients = 0; // every client instance is a distinct device (a fresh IndexedDB always gets a fresh device id)
const T0 = Date.now() - 6 * 3_600_000; // realistic, and well behind the server's clock-skew guard
const edge = (url: string, init?: RequestInit) => exports.default.fetch(new Request(`http://edge.test${url}`, init));
const first = <T>(sql: string, ...p: unknown[]) => env.DB.prepare(sql).bind(...p).first<T>();
const all = async <T>(sql: string, ...p: unknown[]) => (await env.DB.prepare(sql).bind(...p).all<T>()).results;

type Client = Awaited<ReturnType<typeof makeClient>>;
/** A full client: its own IndexedDB, its own (skewable) clock, talking to the real Worker + D1. */
async function makeClient(name: string, startMs = T0, fetchImpl: typeof fetch = edge as never) {
  const clock = { ms: startMs };
  let n = 0;
  const no = ++clients;
  const dev = `dev-${name}-${RUN}-${no}`;
  const s = await createStorage({ name, indexedDB: new IDBFactory(), IDBKeyRange, now: () => clock.ms, newId: () => (n++ === 0 ? dev : `${name}-${RUN}-${no}-${n}`) });
  const engine = s.sync({ fetch: fetchImpl, log: { warn: vi.fn() }, batchSize: 50, pullLimit: 40 });
  return {
    s, engine, dev,
    clock: Object.assign(clock, { state_wall: () => s.clock.state().wall }),
    async sync() {
      const r = await engine.syncOnce();
      expect(r.error, "sync should succeed").toBeUndefined();
      return r;
    },
  };
}
/**
 * Make `winner`'s next write strictly later than anything `loser` (or the winner itself) has seen.
 * HLC order is (wall, counter, device): once devices have synced, their clocks share a high-water mark,
 * so "a slower wall clock" alone does not decide a conflict. Tests that assert a winner must say so explicitly.
 */
const outpace = (winner: Client, loser: Client) => {
  winner.clock.ms = Math.max(winner.clock.ms, winner.clock.state_wall(), loser.clock.state_wall()) + 60_000;
};
/** Everything that must be identical across converged devices (sync plumbing excluded). */
async function state(s: Storage) {
  const t = s.db;
  const byKey = <T>(rows: T[], k: (r: T) => string) => [...rows].sort((a, b) => (k(a) < k(b) ? -1 : 1));
  return {
    recipes: byKey(await t.recipes.toArray(), (r) => r.id),
    registry: byKey(await t.priceRegistry.toArray(), (r) => r.ingredient_id),
    observations: byKey(await t.priceObservations.toArray(), (r) => r.id),
    meta: byKey(await t.ingredientMeta.toArray(), (r) => r.ingredient_id),
    cycles: byKey(await t.cycles.toArray(), (r) => r.id),
    dishes: byKey(await t.cycleDishes.toArray(), (r) => `${r.cycle_id}|${r.week}|${r.slot}`),
    pantry: byKey(await t.pantry.toArray(), (r) => `${r.ingredient_id}|${r.state}`),
    grocery: byKey(await t.groceryLineState.toArray(), (r) => `${r.cycle_id}|${r.line_key}`),
  };
}
const obs = (id: string, ingredient_id: string, price: number, at: string, device_id: string, kind: PriceObservation["kind"] = "observed"): PriceObservation => ({ id, ingredient_id, kind, price, observed_at: at, cycle_id: null, device_id });
const serverCursor = async () => (await first<{ c: number }>("SELECT COALESCE(MAX(seq), 0) AS c FROM change_log"))!.c;

describe("two-client offline divergence: independent price calibrations converge", () => {
  it("both devices end with the exact same registry, equal to the server and to a fresh device", async () => {
    const A = await makeClient("A");
    const B = await makeClient("B", T0 + 5_000); // B's clock runs 5 s ahead
    await A.sync();
    await B.sync();

    const ing = `labuyo-${RUN}`;
    // ── offline: each device calibrates on its own ──
    await A.s.registry.appendObservations([
      obs(`a1-${RUN}`, "potato", 120, "2026-10-05T01:00:00.000Z", A.dev),
      obs(`a2-${RUN}`, "potato", 140, "2026-10-06T01:00:00.000Z", A.dev, "receipt_allocated"),
      obs(`a3-${RUN}`, "pork_shoulder", 350, "2026-10-05T02:00:00.000Z", A.dev),
    ]);
    await B.s.registry.appendObservations([
      obs(`b1-${RUN}`, "potato", 80, "2026-10-05T09:00:00.000Z", B.dev),
      obs(`b2-${RUN}`, "pork_shoulder", 300, "2026-10-04T23:00:00.000Z", B.dev), // older than A's, arrives later
      obs(`b3-${RUN}`, "garlic", 170, "2026-10-07T01:00:00.000Z", B.dev),
    ]);
    // both also invent the SAME new ingredient, with different units and seed prices
    A.clock.ms += 1_000;
    await A.s.registry.ensure({ ingredient_id: ing, display_name: "Labuyo (A)", pricing_unit: "kg", price: 400 });
    outpace(B, A); // B's registration of the same ingredient is the later write
    await B.s.registry.ensure({ ingredient_id: ing, display_name: "Labuyo (B)", pricing_unit: "pack", price: 5 });
    await A.s.registry.appendObservations([obs(`a4-${RUN}`, ing, 420, "2026-10-08T00:00:00.000Z", A.dev)]);

    const aBefore = await A.s.registry.snapshot();
    const bBefore = await B.s.registry.snapshot();
    expect(aBefore.potato!.price_per_unit).not.toBe(bBefore.potato!.price_per_unit); // they genuinely diverged
    expect(aBefore[ing]!.pricing_unit).not.toBe(bBefore[ing]!.pricing_unit);

    // ── back online: sync in the order that is hardest for convergence ──
    await A.sync();
    await B.sync();
    await A.sync();
    await B.sync();

    const a = await A.s.registry.snapshot();
    const b = await B.s.registry.snapshot();
    expect(a).toEqual(b); // identical values, field for field
    for (const id of ["potato", "pork_shoulder", "garlic", ing]) expect(a[id]!.price_per_unit, id).toBeGreaterThan(0);

    // …and identical to the server's registry…
    for (const id of ["potato", "pork_shoulder", "garlic", ing]) {
      const row = await first<{ price_per_unit: number; pricing_unit: string; display_name: string }>("SELECT price_per_unit, pricing_unit, display_name FROM price_registry WHERE ingredient_id = ?", id);
      expect(row, id).toMatchObject({ price_per_unit: a[id]!.price_per_unit, pricing_unit: a[id]!.pricing_unit, display_name: a[id]!.display_name });
    }
    // …to an independent oracle: the pure fold over every observation the server holds…
    const serverObs = await all<PriceObservation>("SELECT id, ingredient_id, kind, price, observed_at, cycle_id, device_id FROM price_observations");
    const seedBase = Object.fromEntries(Object.entries(a).map(([k, v]) => [k, { ...v, price_per_unit: 0 }]));
    const oracle = replayObservations(seedBase, serverObs);
    for (const id of ["potato", "pork_shoulder", "garlic", ing]) expect(a[id]!.price_per_unit, `${id} vs oracle`).toBe(oracle[id]!.price_per_unit);
    // …and to a brand-new device that has only ever pulled the log.
    const C = await makeClient("C");
    await C.sync();
    expect((await C.s.registry.snapshot())).toEqual(a);

    // the later stamp won the identity conflict on every device (B's clock was ahead)
    expect(a[ing]).toMatchObject({ display_name: "Labuyo (B)", pricing_unit: "pack" });
    // plumbing: nothing left to send, everyone is at the server's cursor
    for (const c of [A, B, C]) {
      expect(await c.s.db.outbox.count()).toBe(0);
      expect((await c.s.db.syncMeta.get("pullCursor"))?.value).toBe(await serverCursor());
    }
    expect(await state(A.s)).toEqual(await state(B.s)); // not just prices: the whole synced state
  });
});

describe("remote mutation: a recipe edited on Client A shows up on Client B", () => {
  it("edit → push → pull: B holds the edited recipe, validated, and the server stores it normalised", async () => {
    const A = await makeClient("A");
    const B = await makeClient("B");
    await A.sync();
    await B.sync();
    expect((await B.s.recipes.get("pork-adobo"))!.name).toBe("Pork Adobo");

    const adobo = (await A.s.recipes.get("pork-adobo"))!;
    const edited = { ...adobo, name: "Pork Adobo (Lola's)", cook_steps: [...adobo.cook_steps, "Rest off the heat until the sauce settles."], prep_items: adobo.prep_items.map((p, i) => (i === 0 ? { ...p, quantity_per_portion: 120 } : p)) };
    A.clock.ms += 10_000;
    await A.s.recipes.put(edited);
    const r = await A.sync();
    expect(r.pushed).toBeGreaterThanOrEqual(1);
    await B.sync();

    const onB = (await B.s.recipes.get("pork-adobo"))!;
    expect(onB).toEqual(edited); // exactly what A wrote, as a validated Recipe
    expect(onB.name).toBe("Pork Adobo (Lola's)");
    expect(onB.prep_items[0]!.quantity_per_portion).toBe(120);
    expect(onB.cook_steps.at(-1)).toBe("Rest off the heat until the sauce settles.");
    expect((await B.s.db.recipes.get("pork-adobo"))!._hlc > "000000000000000-00000-seed").toBe(true);
    expect(await first("SELECT name AS n FROM recipes WHERE id = 'pork-adobo'")).toEqual({ n: "Pork Adobo (Lola's)" });
    expect((await first<{ c: number }>("SELECT COUNT(*) AS c FROM recipe_cook_steps WHERE recipe_id = 'pork-adobo'"))!.c).toBe(edited.cook_steps.length);

    // B's roller now uses the edit
    const pool = await B.s.recipes.list();
    expect(pool.find((x) => x.id === "pork-adobo")!.name).toBe("Pork Adobo (Lola's)");
  });

  it("a brand-new recipe (with a brand-new ingredient) propagates, and soft delete + restore follow", async () => {
    const A = await makeClient("A");
    const B = await makeClient("B");
    await A.sync();
    await B.sync();
    const id = `pinakbet-${RUN}`;
    const ing = `okra2_${RUN}`;
    const base = (await A.s.recipes.get("pinakbet"))!;
    const text = JSON.stringify({ ...base, id, name: "Pinakbet 2", prep_items: [...base.prep_items, { ...base.prep_items[0]!, ingredient_id: ing, display_name: "Okra 2" }] });
    const res = await A.s.ingest.commit(text, [{ ingredient_id: ing, pricing_unit: "kg", price: 90, aisle: "produce", storage_class: "loose_produce" }]);
    expect(res.ok).toBe(true);
    await A.sync();
    await B.sync();
    expect(await B.s.recipes.has(id)).toBe(true);
    expect((await B.s.registry.get(ing))).toMatchObject({ pricing_unit: "kg", price_per_unit: 90 });
    expect((await B.s.meta.get(ing))!.aisle).toBe("produce");

    A.clock.ms += 1000;
    await A.s.recipes.remove(id);
    await A.sync();
    await B.sync();
    expect(await B.s.recipes.has(id)).toBe(false);
    B.clock.ms += 5000;
    await B.s.recipes.restore(id);
    await B.sync();
    await A.sync();
    expect(await A.s.recipes.has(id)).toBe(true);
  });

  it("conflicting offline edits of the same recipe: the later stamp wins on both devices and the server", async () => {
    const A = await makeClient("A");
    const B = await makeClient("B", T0 + 60_000);
    await A.sync();
    await B.sync();
    const r = (await A.s.recipes.get("chicken-adobo"))!;
    await A.s.recipes.put({ ...r, name: "Chicken Adobo by A" });
    outpace(B, A);
    await B.s.recipes.put({ ...r, name: "Chicken Adobo by B" }); // strictly later than A's edit
    await B.sync();
    await A.sync();
    await B.sync();
    for (const c of [A, B]) expect((await c.s.recipes.get("chicken-adobo"))!.name).toBe("Chicken Adobo by B");
    expect(await first("SELECT name AS n FROM recipes WHERE id = 'chicken-adobo'")).toEqual({ n: "Chicken Adobo by B" });
  });
});

describe("a shared plan: cycle, dishes, locks and grocery state sync between devices", () => {
  it("B sees A's rolled + locked plan, and A sees B's shopping progress; derived grocery lists match", async () => {
    const A = await makeClient("A");
    const B = await makeClient("B", T0 + 2_000);
    await A.sync();
    await B.sync();

    const cycle = await A.s.cycles.create({ start_date: "2026-10-18", seed: 5150 });
    const roll = rollCycle({ pool: await A.s.recipes.list(), seed: cycle.seed, locks: {}, previousCycleRecipeIds: new Set() });
    if (!roll.ok) throw new Error(roll.error.detail);
    await A.s.cycles.applyRollResult(cycle.id, roll);
    await A.s.cycles.setLocked(cycle.id, 1, 1, true);
    await A.s.cycles.setPortionOverride(cycle.id, 2, 0, 8);
    await A.s.cycles.setGlobalPortions(cycle.id, 12);
    await A.s.cycles.transition(cycle.id, "locked");
    await A.s.pantry.add({ ingredient_id: "potato", state: "loose", quantity: 400, unit: "g" });
    await A.sync();
    await B.sync();

    expect(await B.s.cycles.get(cycle.id)).toMatchObject({ seed: 5150, status: "locked", global_portions: 12, start_date: "2026-10-18" });
    const planB = await B.s.cycles.getPlan(cycle.id);
    expect(planB).toEqual(await A.s.cycles.getPlan(cycle.id));
    expect(planB.dishes).toHaveLength(6);
    expect(await B.s.cycles.locks(cycle.id)).toEqual({ "1-1": roll.week1[1]!.id });
    expect(planB.dishes.find((d) => d.week === 2 && d.slot === 0)!.portion_override).toBe(8);
    expect(await B.s.pantry.list()).toEqual(await A.s.pantry.list());

    // B goes shopping.
    const listOf = async (s: Storage) => {
      const { cycle: c, dishes } = await s.cycles.getPlan(cycle.id);
      const recipes = new Map((await s.recipes.list()).map((r) => [r.id, r]));
      return buildGroceryList({ cycleId: cycle.id, dishes: dishes.map((d) => scaleRecipe(recipes.get(d.recipe_id)!, s.cycles.portionsFor(c, d), d.week)), pantry: await s.pantry.list(), meta: await s.meta.all(), registry: await s.registry.snapshot(), lineState: await s.groceryState.forCycle(cycle.id) });
    };
    const before = await listOf(B.s);
    expect(await listOf(A.s)).toEqual(before); // same inputs => the same deterministic list on both devices
    B.clock.ms += 10_000;
    await B.s.groceryState.markAllBought(cycle.id, before.lines.slice(0, 3).map((l) => l.key));
    await B.s.groceryState.setDeductStock(cycle.id, before.lines[3]!.key, false);
    await B.s.groceryState.setPaid(cycle.id, before.lines[0]!.key, 88.5);
    await B.sync();
    await A.sync();
    const after = await listOf(A.s);
    expect(after).toEqual(await listOf(B.s));
    expect(after.lines.slice(0, 3).every((l) => l.bought)).toBe(true);
    expect(after.lines[3]).toMatchObject({ deductStock: false });
    expect(after.lines[0]!.paidPhp).toBe(88.5);
    expect(await state(A.s)).toEqual(await state(B.s));
  });

  it("intra-cycle exclusion survives conflicting offline plan edits: no duplicate recipe, devices and server agree", async () => {
    const A = await makeClient("A");
    const B = await makeClient("B", T0 + 30_000); // B edits later
    await A.sync();
    await B.sync();
    const cycle = await A.s.cycles.create({ start_date: "2026-11-01", seed: 99 });
    const roll = rollCycle({ pool: await A.s.recipes.list(), seed: 99, locks: {}, previousCycleRecipeIds: new Set() });
    if (!roll.ok) throw new Error("roll");
    await A.s.cycles.applyRollResult(cycle.id, roll);
    await A.sync();
    await B.sync();
    const [P, Q, R] = roll.week1.map((r) => r.id) as [string, string, string];

    // offline: A swaps slots 0<->1 (P,Q); B swaps slots 1<->2 (Q,R). Both move Q.
    await A.s.cycles.setDishes(cycle.id, [{ week: 1, slot: 0, recipe_id: Q }, { week: 1, slot: 1, recipe_id: P }]);
    outpace(B, A);
    await B.s.cycles.setDishes(cycle.id, [{ week: 1, slot: 1, recipe_id: R }, { week: 1, slot: 2, recipe_id: Q }]);

    await A.sync();
    await B.sync();
    await A.sync();
    await B.sync();

    const planA = (await A.s.cycles.getPlan(cycle.id)).dishes.map((d) => `${d.week}-${d.slot}:${d.recipe_id}`);
    const planB = (await B.s.cycles.getPlan(cycle.id)).dishes.map((d) => `${d.week}-${d.slot}:${d.recipe_id}`);
    expect(planA).toEqual(planB);
    const server = (await all<{ week: number; slot: number; recipe_id: string }>("SELECT week, slot, recipe_id FROM cycle_dishes WHERE cycle_id = ? ORDER BY week, slot", cycle.id)).map((d) => `${d.week}-${d.slot}:${d.recipe_id}`);
    expect(server).toEqual(planA);
    const ids = planA.map((x) => x.split(":")[1]);
    expect(new Set(ids).size).toBe(ids.length); // never the same dish twice
    // B edited later, so B's placements win: Q ends in slot 2, R in slot 1; A's stale Q@0 was evicted.
    expect(planA).toContain(`1-2:${Q}`);
    expect(planA).toContain(`1-1:${R}`);
    expect(planA.find((x) => x.startsWith("1-0:"))).toBeUndefined();
    expect(await state(A.s)).toEqual(await state(B.s));
  });
});

describe("pantry across devices", () => {
  it("a deletion propagates, a late older edit from an offline device cannot resurrect stock", async () => {
    const A = await makeClient("A");
    const B = await makeClient("B", T0 + 100_000); // B's later edits will be newer than A's offline ones
    await A.sync();
    await B.sync();
    await A.s.pantry.add({ ingredient_id: "carrot", state: "loose", quantity: 300, unit: "g" });
    await A.sync();
    await B.sync();
    expect((await B.s.pantry.list()).map((p) => p.ingredient_id)).toContain("carrot");

    A.clock.ms += 1_000;
    await A.s.pantry.add({ ingredient_id: "carrot", state: "loose", quantity: 50, unit: "g" }); // A, offline: tops up (older stamp)
    outpace(B, A);
    await B.s.pantry.remove("carrot", "loose"); // B tosses it (strictly later than A's top-up)
    await B.sync();
    await A.sync(); // A's stale top-up reaches the server AFTER the delete
    await B.sync();
    for (const c of [A, B]) expect((await c.s.pantry.list()).filter((p) => p.ingredient_id === "carrot")).toEqual([]);
    expect(await first("SELECT deleted AS d FROM pantry_stock WHERE ingredient_id = 'carrot' AND state = 'loose'")).toEqual({ d: 1 });
  });
});

describe("offline resilience and bad mutations", () => {
  it("while the network is down nothing throws and nothing is lost; on reconnect everything lands", async () => {
    let down = true;
    const flaky = (async (url: string, init?: RequestInit) => {
      if (down) throw new TypeError("Failed to fetch");
      return edge(url, init);
    }) as unknown as typeof fetch;
    const A = await makeClient("A", T0, flaky);
    const r = await A.engine.syncOnce();
    expect(r.ok).toBe(false);
    expect(A.engine.status().state).toBe("offline");

    const c = await A.s.cycles.create({ start_date: "2026-12-06", seed: 1 });
    await A.s.pantry.add({ ingredient_id: "garlic", state: "loose", quantity: 20, unit: "g" });
    await A.engine.syncOnce(); // still down: must not throw
    expect(await A.s.db.outbox.count()).toBeGreaterThanOrEqual(2);
    expect(A.engine.status().pending).toBeGreaterThanOrEqual(2);

    down = false;
    expect((await A.engine.syncOnce()).ok).toBe(true);
    expect(await A.s.db.outbox.count()).toBe(0);
    expect(await first("SELECT id FROM cycles WHERE id = ?", c.id)).toEqual({ id: c.id });
  });

  it("a permanently invalid mutation is dropped (counted) and does not block the rest of the queue", async () => {
    const A = await makeClient("A");
    await A.sync();
    // a recipe the Zod schema accepts but the DB rejects (discrete pieces must be 1..6): bypasses client validation on purpose
    const poison = { ...(await A.s.recipes.get("pinakbet"))!, id: `poison-${RUN}` };
    poison.prep_items = [{ ...poison.prep_items[0]!, granularity: "discrete", pieces_per_portion: 7 }];
    await writeTx(A.s.ctx, [A.s.db.recipes], async (tx) => {
      const hlc = tx.stamp();
      await A.s.db.recipes.put({ ...poison, _hlc: hlc, _deleted: false });
      await tx.log("recipe", poison.id, hlc, { recipe: poison, deleted: false });
    });
    await A.s.cycles.create({ start_date: "2027-01-03", seed: 3 }); // a good one queued behind it
    const r = await A.engine.syncOnce();
    expect(r).toMatchObject({ ok: true, rejected: 1 });
    expect(await A.s.db.outbox.count()).toBe(0);
    expect(A.engine.status().rejected).toBe(1);
    expect(await first("SELECT 1 AS x FROM recipes WHERE id = ?", poison.id)).toBeNull();
    expect((await first<{ c: number }>("SELECT COUNT(*) AS c FROM cycles WHERE start_date = '2027-01-03'"))!.c).toBeGreaterThanOrEqual(1);
  });

  it("a mutation that depends on missing data is retried (kept), and lands once its dependency arrives", async () => {
    const A = await makeClient("A");
    await A.sync();
    const ing = `later_${RUN}`;
    const rid = `needs-${RUN}`;
    const base = (await A.s.recipes.get("pinakbet"))!;
    const recipe = { ...base, id: rid, prep_items: [{ ...base.prep_items[0]!, ingredient_id: ing }] };
    // queue the recipe BEFORE its ingredient exists on the server
    await A.s.db.priceRegistry.put({ ingredient_id: ing, display_name: "Later", price_per_unit: 0, pricing_unit: "kg", last_updated: "t", _hlc: "000000000000000-00000-x" });
    await writeTx(A.s.ctx, [A.s.db.recipes], async (tx) => {
      const hlc = tx.stamp();
      await A.s.db.recipes.put({ ...recipe, _hlc: hlc, _deleted: false });
      await tx.log("recipe", rid, hlc, { recipe, deleted: false });
    });
    expect(await A.engine.syncOnce()).toMatchObject({ ok: true, pushed: 0 });
    expect(await A.s.db.outbox.count()).toBe(1); // kept, not dropped
    expect(await first("SELECT 1 AS x FROM recipes WHERE id = ?", rid)).toBeNull();

    await writeTx(A.s.ctx, [A.s.db.priceRegistry], async (tx) => {
      const hlc = tx.stamp();
      await tx.log("priceRegistry", ing, hlc, { ingredient_id: ing, display_name: "Later", pricing_unit: "kg" });
    });
    // the registry mutation now sits AFTER the recipe in the outbox; one pass delivers it, the next delivers the recipe
    await A.engine.syncOnce();
    await A.engine.syncOnce();
    expect(await A.s.db.outbox.count()).toBe(0);
    expect(await first("SELECT name AS n FROM recipes WHERE id = ?", rid)).toBeDefined();
  });

  it("large backlogs are batched on push and paged on pull, and still converge", async () => {
    const A = await makeClient("A");
    const B = await makeClient("B");
    await A.sync();
    await B.sync();
    const many = Array.from({ length: 130 }, (_, i) => obs(`bulk-${RUN}-${i}`, "carrot", 60 + (i % 40), `2026-11-${String(1 + (i % 28)).padStart(2, "0")}T${String(i % 24).padStart(2, "0")}:00:00.000Z`, A.dev));
    await A.s.registry.appendObservations(many);
    const r = await A.sync();
    expect(r.pushed).toBeGreaterThanOrEqual(130);
    await B.sync();
    expect((await B.s.registry.observationsFor("carrot")).filter((o) => o.id.startsWith(`bulk-${RUN}`))).toHaveLength(130);
    expect(await B.s.registry.snapshot()).toEqual(await A.s.registry.snapshot());
  });

  it("repeated syncs are idempotent: no duplicate pushes, no change in state", async () => {
    const A = await makeClient("A");
    await A.s.cycles.create({ start_date: "2027-02-07", seed: 8 });
    await A.sync();
    const snap = await state(A.s);
    const cursor = await serverCursor();
    const r = await A.sync();
    expect(r).toMatchObject({ pushed: 0 });
    expect(await state(A.s)).toEqual(snap);
    expect(await serverCursor()).toBe(cursor);
  });
});
