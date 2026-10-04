import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import pinakbet from "../fixtures/recipes/pinakbet.json";
import { RecipeSchema, type Recipe } from "../src/domain/schemas/blueprint";
import type { Change, PullResponse, PushResponse } from "../src/domain/sync/protocol";
import { MAX_CLOCK_SKEW_MS, type Mutation } from "../src/domain/sync/protocol";
import { push as pushDirect, skewVerdict } from "./sync";

const db = env.DB;
let seq = 0;
let uid = 0;
const U = (p: string) => `${p}-${Date.now().toString(36)}-${++uid}`;
const hlc = (wall: number, counter = 0, dev = "dev-a") => `${String(wall).padStart(15, "0")}-${String(counter).padStart(5, "0")}-${dev}`;
const WALL = Date.now() - 24 * 3_600_000; // a day ago: realistic, and safely behind the server's clock-skew guard

const call = (path: string, init?: RequestInit) => exports.default.fetch(new Request(`http://edge.test${path}`, init));
const mut = (entity: Mutation["entity"], entity_key: string, h: string, payload: unknown, device_id = h.split("-").slice(2).join("-")) => ({ client_seq: ++seq, entity, entity_key, hlc: h, device_id, payload });
async function push(...mutations: ReturnType<typeof mut>[]): Promise<PushResponse> {
  const res = await call("/api/sync/push", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device_id: "dev-a", mutations }) });
  expect(res.status).toBe(200);
  return (await res.json()) as PushResponse;
}
const statuses = (r: PushResponse) => r.results.map((x) => x.status);
async function pull(since = 0, limit = 500): Promise<PullResponse> {
  const res = await call(`/api/sync/pull?since=${since}&limit=${limit}`);
  expect(res.status).toBe(200);
  return (await res.json()) as PullResponse;
}
const cursor = async () => ((await (await call("/api/health")).json()) as { cursor: number }).cursor;
const changesSince = async (c: number): Promise<Change[]> => (await pull(c, 500)).changes;
const first = <T>(sql: string, ...p: unknown[]) => db.prepare(sql).bind(...p).first<T>();

const cyclePayload = (id: string, h: string, over: Record<string, unknown> = {}) => ({ id, start_date: "2026-10-04", seed: 42, global_portions: 10, status: "draft", updated_at: h, ...over });
const dishPayload = (cycle_id: string, week: number, slot: number, recipe_id: string, h: string, over: Record<string, unknown> = {}) => ({ cycle_id, week, slot, recipe_id, locked: false, portion_override: null, _hlc: h, ...over });

/** Rebuild a Recipe from the normalised tables: proves the relational mirror is lossless. */
async function loadRecipe(id: string): Promise<{ recipe: Recipe; updated_at: string; deleted: number } | null> {
  const r = await first<Record<string, unknown>>("SELECT * FROM recipes WHERE id = ?", id);
  if (!r) return null;
  const videos = (await db.prepare("SELECT title, platform, url FROM recipe_videos WHERE recipe_id = ? ORDER BY ord").bind(id).all()).results;
  const items = (await db.prepare("SELECT * FROM recipe_prep_items WHERE recipe_id = ? ORDER BY ord").bind(id).all<Record<string, unknown>>()).results;
  const steps = (await db.prepare("SELECT text FROM recipe_cook_steps WHERE recipe_id = ? ORDER BY ord").bind(id).all<{ text: string }>()).results;
  const recipe = RecipeSchema.parse({
    id: r.id, name: r.name, default_portions: r.default_portions, protein_category: r.protein_category, sauce_base: r.sauce_base,
    perishability_tier: r.perishability_tier, stove_priority: r.stove_priority, estimated_base_cost_php: r.estimated_base_cost_php, pack_step: r.pack_step,
    videos,
    prep_items: items.map((p) => ({
      ingredient_id: p.ingredient_id, display_name: p.display_name, cut_technique: p.cut_technique, cut_note: p.cut_note, granularity: p.granularity,
      pieces_per_portion: p.pieces_per_portion, quantity_per_portion: p.quantity_per_portion, unit: p.unit,
      ...(p.pkg_retail_unit === null ? {} : { packaging: { retail_unit: p.pkg_retail_unit, pack_size: p.pkg_pack_size, snap_to_whole_pack: p.pkg_snap_to_whole_pack === 1 } }),
    })),
    cook_steps: steps.map((s) => s.text),
  });
  return { recipe, updated_at: r.updated_at as string, deleted: r.deleted as number };
}

describe("health and routing", () => {
  it("GET /api/health reports ok and the current cursor", async () => {
    const res = await call("/api/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ ok: true, service: "meal-prep-engine", cursor: expect.any(Number) });
  });
  it("unknown routes return JSON 404", async () => {
    const res = await call("/api/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });
});

describe("POST /api/sync/push: validation", () => {
  it("rejects non-JSON and malformed envelopes with 400", async () => {
    expect((await call("/api/sync/push", { method: "POST", body: "not json" })).status).toBe(400);
    const bad = await call("/api/sync/push", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device_id: "d", mutations: [{ entity: "nope" }] }) });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "invalid push request" });
    const huge = await call("/api/sync/push", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device_id: "d", mutations: Array(201).fill(mut("cycle", "x", hlc(WALL), {})) }) });
    expect(huge.status).toBe(400);
  });

  it("marks schema-invalid, mismatched-key and mismatched-stamp payloads as invalid and never logs them", async () => {
    const c0 = await cursor();
    const id = U("cyc");
    const r = await push(
      mut("cycle", id, hlc(WALL), cyclePayload(id, hlc(WALL), { status: "weird" })),
      mut("cycle", "other-key", hlc(WALL), cyclePayload(id, hlc(WALL))),
      mut("cycle", id, hlc(WALL + 1), cyclePayload(id, hlc(WALL))),
      mut("recipe", "x", hlc(WALL), null),
    );
    expect(statuses(r)).toEqual(["invalid", "invalid", "invalid", "invalid"]);
    expect(r.results[0]!.message).toContain("status");
    expect(await changesSince(c0)).toEqual([]);
    expect(await first("SELECT 1 AS x FROM cycles WHERE id = ?", id)).toBeNull();
  });

  it("schema-valid but DB-invalid data is reported invalid (CHECK), not a 500", async () => {
    const p = structuredClone(pinakbet) as Recipe;
    p.id = U("rcp");
    p.prep_items[0] = { ...p.prep_items[0]!, granularity: "discrete", pieces_per_portion: 7 }; // Zod allows it; the DB invariant (1..6) does not
    const r = await push(mut("recipe", p.id, hlc(WALL), { recipe: p, deleted: false }));
    expect(statuses(r)).toEqual(["invalid"]);
    expect(await first("SELECT 1 AS x FROM recipes WHERE id = ?", p.id)).toBeNull(); // atomic: nothing partially written
  });
});

describe("clock-skew guard", () => {
  const NOW = 1_800_000_000_000;
  const stamp = (offsetMs: number) => hlc(NOW + offsetMs);
  const cyc = (id: string, h: string) => cyclePayload(id, h);

  it("skewVerdict: allows up to exactly 60 s ahead, refuses anything beyond, and never flags the past", () => {
    expect(MAX_CLOCK_SKEW_MS).toBe(60_000);
    expect(skewVerdict(stamp(-86_400_000), NOW)).toBeNull();
    expect(skewVerdict(stamp(0), NOW)).toBeNull();
    expect(skewVerdict(stamp(60_000), NOW)).toBeNull(); // boundary is inclusive
    expect(skewVerdict(stamp(60_001), NOW)).toContain("61s ahead");
    expect(skewVerdict(stamp(365 * 86_400_000), NOW)).toContain("clock skew");
  });

  it("a future-dated change is refused (retry): nothing is written, nothing is logged, and it cannot poison LWW", async () => {
    const id = U("cyc");
    const c0 = await cursor();
    const future = stamp(3_600_000); // an hour ahead
    const r = await pushDirect(db, [mut("cycle", id, future, cyc(id, future))], NOW);
    expect(statuses(r)).toEqual(["retry"]);
    expect(r.results[0]!.message).toContain("fix the device clock");
    expect(await first("SELECT 1 AS x FROM cycles WHERE id = ?", id)).toBeNull();
    expect(await changesSince(c0)).toEqual([]);

    // the honest write that follows still wins: the future stamp never got a foothold
    const ok = stamp(-1_000);
    expect(statuses(await pushDirect(db, [mut("cycle", id, ok, cyc(id, ok))], NOW))).toEqual(["applied"]);
    expect((await first<{ u: string }>("SELECT updated_at AS u FROM cycles WHERE id = ?", id))!.u).toBe(ok);
  });

  it("is judged per mutation: a mixed batch applies the honest ones", async () => {
    const [a, b, c] = [U("cyc"), U("cyc"), U("cyc")];
    const r = await pushDirect(db, [mut("cycle", a, stamp(-5), cyc(a, stamp(-5))), mut("cycle", b, stamp(120_000), cyc(b, stamp(120_000))), mut("cycle", c, stamp(59_000), cyc(c, stamp(59_000)))], NOW);
    expect(statuses(r)).toEqual(["applied", "retry", "applied"]);
  });

  it("is enforced on the real endpoint using the server's own clock", async () => {
    const id = U("cyc");
    const future = hlc(Date.now() + 10 * 60_000);
    expect(statuses(await push(mut("cycle", id, future, cyclePayload(id, future))))).toEqual(["retry"]);
    const near = hlc(Date.now() + 30_000); // within tolerance
    const id2 = U("cyc");
    expect(statuses(await push(mut("cycle", id2, near, cyclePayload(id2, near))))).toEqual(["applied"]);
  });

  it("applies to every entity type (the check runs before validation or any write)", async () => {
    const future = stamp(600_000);
    const r = await pushDirect(db, [
      mut("recipe", "pinakbet", future, { recipe: pinakbet, deleted: false }),
      mut("pantry", "potato|loose", future, null),
      mut("priceObservation", "o-future", future, { id: "o-future", ingredient_id: "potato", kind: "observed", price: 1, observed_at: "2026-10-05T00:00:00.000Z", cycle_id: null, device_id: "d" }),
    ], NOW);
    expect(statuses(r)).toEqual(["retry", "retry", "retry"]);
  });
});

describe("last-write-wins by HLC", () => {
  it("newer wins, older is stale, replays are idempotent, and only winners reach the change_log", async () => {
    const id = U("cyc");
    const c0 = await cursor();
    const h1 = hlc(WALL + 10), h2 = hlc(WALL + 20), h0 = hlc(WALL + 5);
    expect(statuses(await push(mut("cycle", id, h1, cyclePayload(id, h1, { global_portions: 11 }))))).toEqual(["applied"]);
    expect(statuses(await push(mut("cycle", id, h0, cyclePayload(id, h0, { global_portions: 9 }))))).toEqual(["stale"]);
    expect((await first<{ global_portions: number }>("SELECT global_portions FROM cycles WHERE id = ?", id))!.global_portions).toBe(11);
    expect(statuses(await push(mut("cycle", id, h2, cyclePayload(id, h2, { global_portions: 12, status: "locked" }))))).toEqual(["applied"]);
    expect(statuses(await push(mut("cycle", id, h2, cyclePayload(id, h2, { global_portions: 12, status: "locked" }))))).toEqual(["applied"]); // replay
    expect(await first("SELECT global_portions AS g, status AS s, updated_at AS u FROM cycles WHERE id = ?", id)).toEqual({ g: 12, s: "locked", u: h2 });
    const log = (await changesSince(c0)).filter((c) => c.entity_key === id);
    expect(log.map((c) => c.hlc)).toEqual([h1, h2]); // h0 (stale) and the replay never logged
    expect(log.map((c) => c.seq)).toEqual([...log.map((c) => c.seq)].sort((a, b) => a - b));
  });

  it("exact ties are broken by device id, whatever the arrival order", async () => {
    const a = U("cyc"), b = U("cyc");
    const ha = hlc(WALL + 30, 0, "dev-a"), hb = hlc(WALL + 30, 0, "dev-b"); // same wall + counter
    await push(mut("cycle", a, ha, cyclePayload(a, ha, { global_portions: 1 })), mut("cycle", a, hb, { ...cyclePayload(a, hb, { global_portions: 2 }), id: a }));
    await push(mut("cycle", b, hb, cyclePayload(b, hb, { global_portions: 2 })), mut("cycle", b, ha, cyclePayload(b, ha, { global_portions: 1 })));
    expect((await first<{ g: number }>("SELECT global_portions AS g FROM cycles WHERE id = ?", a))!.g).toBe(2);
    expect((await first<{ g: number }>("SELECT global_portions AS g FROM cycles WHERE id = ?", b))!.g).toBe(2); // dev-b wins both ways
  });

  it("interleaved concurrent pushes converge on the highest stamp", async () => {
    const id = U("cyc");
    const hs = [5, 9, 3, 7, 8, 1].map((n) => hlc(WALL + 100 + n));
    await Promise.all(hs.map((h) => push(mut("cycle", id, h, cyclePayload(id, h, { global_portions: Number(h.slice(12, 15)) % 30 || 1 })))));
    expect((await first<{ u: string }>("SELECT updated_at AS u FROM cycles WHERE id = ?", id))!.u).toBe(hlc(WALL + 109));
  });

  it("ingredient meta and grocery line state are LWW too", async () => {
    const cid = U("cyc");
    await push(mut("cycle", cid, hlc(WALL + 1), cyclePayload(cid, hlc(WALL + 1))));
    const g = (h: string, bought: boolean) => ({ cycle_id: cid, line_key: "potato|g|cycle", deduct_stock: true, bought, paid_php: null, updated_at: h });
    await push(mut("groceryLineState", `${cid}|potato|g|cycle`, hlc(WALL + 20), g(hlc(WALL + 20), true)));
    expect(statuses(await push(mut("groceryLineState", `${cid}|potato|g|cycle`, hlc(WALL + 10), g(hlc(WALL + 10), false))))).toEqual(["stale"]);
    expect((await first<{ b: number }>("SELECT bought AS b FROM grocery_line_state WHERE cycle_id = ?", cid))!.b).toBe(1);

    const m = (h: string, aisle: string) => ({ ingredient_id: "potato", aisle, storage_class: "loose_produce", surface_prep: null, avg_unit_mass_g: 150, updated_at: h });
    await push(mut("ingredientMeta", "potato", hlc(WALL + 50), m(hlc(WALL + 50), "produce")));
    expect(statuses(await push(mut("ingredientMeta", "potato", hlc(WALL + 40), m(hlc(WALL + 40), "canned_dry"))))).toEqual(["stale"]);
    expect((await first<{ a: string }>("SELECT aisle AS a FROM ingredient_meta WHERE ingredient_id = 'potato'"))!.a).toBe("produce");
  });
});

describe("recipes: normalised mirror", () => {
  it("a recipe edit round-trips losslessly through the relational tables, replacing children", async () => {
    const edited = structuredClone(pinakbet) as Recipe;
    edited.name = "Pinakbet (edited at the edge)";
    edited.cook_steps = ["Sauté garlic until fragrant.", "Cover and steam until tender."];
    edited.videos = [{ title: "Reel", platform: "youtube_shorts", url: "https://www.youtube.com/shorts/aqz-KE-bpKQ" }];
    edited.prep_items = edited.prep_items.slice(0, 3);
    const h = hlc(WALL + 200);
    expect(statuses(await push(mut("recipe", "pinakbet", h, { recipe: edited, deleted: false })))).toEqual(["applied"]);
    const stored = (await loadRecipe("pinakbet"))!;
    expect(stored.recipe).toEqual(RecipeSchema.parse(edited));
    expect(stored).toMatchObject({ updated_at: h, deleted: 0 });
    expect(stored.recipe.prep_items).toHaveLength(3); // the 4 removed items are gone
  });

  it("a stale recipe edit changes nothing (children included); a newer one replaces everything", async () => {
    const id = U("rcp");
    const base = { ...structuredClone(pinakbet), id, name: "Base" } as Recipe;
    await push(mut("recipe", id, hlc(WALL + 300), { recipe: base, deleted: false }));
    const older = { ...base, name: "Older", cook_steps: ["Stir until thick."], prep_items: base.prep_items.slice(0, 1) };
    expect(statuses(await push(mut("recipe", id, hlc(WALL + 250), { recipe: older, deleted: false })))).toEqual(["stale"]);
    expect((await loadRecipe(id))!.recipe).toEqual(RecipeSchema.parse(base));
    const newer = { ...base, name: "Newer", cook_steps: ["Stir until thick."] };
    await push(mut("recipe", id, hlc(WALL + 350), { recipe: newer, deleted: false }));
    expect((await loadRecipe(id))!.recipe).toEqual(RecipeSchema.parse(newer));
  });

  it("soft delete is an LWW write and keeps the rows", async () => {
    const id = U("rcp");
    const r = { ...structuredClone(pinakbet), id } as Recipe;
    await push(mut("recipe", id, hlc(WALL + 400), { recipe: r, deleted: false }));
    await push(mut("recipe", id, hlc(WALL + 410), { recipe: r, deleted: true }));
    expect((await loadRecipe(id))).toMatchObject({ deleted: 1 });
    await push(mut("recipe", id, hlc(WALL + 405), { recipe: { ...r, name: "zombie" }, deleted: false })); // older: must not revive
    expect(await loadRecipe(id)).toMatchObject({ deleted: 1 });
  });

  it("a recipe referencing an unknown ingredient is 'retry' (not dropped, not an error) and succeeds once it exists", async () => {
    const id = U("rcp");
    const ing = U("ing");
    const r = { ...structuredClone(pinakbet), id } as Recipe;
    r.prep_items = [{ ...r.prep_items[0]!, ingredient_id: ing }];
    const m = mut("recipe", id, hlc(WALL + 500), { recipe: r, deleted: false });
    expect(statuses(await push(m))).toEqual(["retry"]);
    expect(await first("SELECT 1 AS x FROM recipes WHERE id = ?", id)).toBeNull(); // atomic
    const reg = mut("priceRegistry", ing, hlc(WALL + 490), { ingredient_id: ing, display_name: "Labuyo", pricing_unit: "kg" });
    expect(statuses(await push(reg, m))).toEqual(["applied", "applied"]);
  });
});

describe("price registry and observations", () => {
  const registry = (ing: string, h: string, unit = "kg") => mut("priceRegistry", ing, h, { ingredient_id: ing, display_name: ing, pricing_unit: unit });
  const obs = (ing: string, oid: string, price: number, at: string, h: string, kind = "observed") =>
    mut("priceObservation", oid, h, { id: oid, ingredient_id: ing, kind, price, observed_at: at, cycle_id: null, device_id: "dev-a" });

  it("observations are idempotent (INSERT OR IGNORE) and need their ingredient (else retry)", async () => {
    const ing = U("ing");
    const o = obs(ing, U("obs"), 100, "2026-10-05T00:00:00.000Z", hlc(WALL + 600));
    expect(statuses(await push(o))).toEqual(["retry"]);
    expect(statuses(await push(registry(ing, hlc(WALL + 590)), o, o))).toEqual(["applied", "applied", "applied"]);
    expect((await first<{ c: number }>("SELECT COUNT(*) AS c FROM price_observations WHERE ingredient_id = ?", ing))!.c).toBe(1);
    expect((await first<{ c: number }>("SELECT COUNT(*) AS c FROM change_log WHERE entity = 'priceObservation' AND entity_key = ?", (o.payload as { id: string }).id))!.c).toBe(1);
  });

  it("recomputes the registry with the shared EMA engine: seed 100, then obs 120 → 108", async () => {
    const ing = U("ing");
    await push(
      registry(ing, hlc(WALL + 700)),
      obs(ing, U("seed"), 100, "2026-10-04T00:00:00.000Z", hlc(WALL + 701), "seed"),
      obs(ing, U("obs"), 120, "2026-10-05T00:00:00.000Z", hlc(WALL + 702)),
    );
    expect(await first("SELECT price_per_unit AS p, last_updated AS l FROM price_registry WHERE ingredient_id = ?", ing)).toEqual({ p: 108, l: "2026-10-05T00:00:00.000Z" });
  });

  it("cold start: a PHP 0 registry takes the first observation as the price", async () => {
    const ing = U("ing");
    await push(registry(ing, hlc(WALL + 710)), obs(ing, U("obs"), 250, "2026-10-05T00:00:00.000Z", hlc(WALL + 711)));
    expect((await first<{ p: number }>("SELECT price_per_unit AS p FROM price_registry WHERE ingredient_id = ?", ing))!.p).toBe(250);
  });

  it("the registry is order-independent: the same observations in any order give the same price", async () => {
    const mk = (ing: string) => [
      obs(ing, `${ing}-1`, 100, "2026-10-01T00:00:00.000Z", hlc(WALL + 800, 1), "seed"),
      obs(ing, `${ing}-2`, 130, "2026-10-02T00:00:00.000Z", hlc(WALL + 800, 2)),
      obs(ing, `${ing}-3`, 90, "2026-10-03T00:00:00.000Z", hlc(WALL + 800, 3), "receipt_allocated"),
      obs(ing, `${ing}-4`, 120, "2026-10-04T00:00:00.000Z", hlc(WALL + 800, 4)),
    ];
    const a = U("ing"), b = U("ing");
    await push(registry(a, hlc(WALL + 799)), registry(b, hlc(WALL + 799)));
    await push(...mk(a));
    await push(...[...mk(b)].reverse());
    const p = async (i: string) => (await first<{ p: number }>("SELECT price_per_unit AS p FROM price_registry WHERE ingredient_id = ?", i))!.p;
    expect(await p(b)).toBe(await p(a));
    expect(await p(a)).toBeGreaterThan(0);
  });

  it("a skewed clock cannot make a seed override later observations (seed always folds first)", async () => {
    const ing = U("ing");
    await push(
      registry(ing, hlc(WALL + 900)),
      obs(ing, U("obs"), 120, "2026-10-05T00:00:00.000Z", hlc(WALL + 901)),
      obs(ing, U("seed"), 100, "2026-12-31T00:00:00.000Z", hlc(WALL + 902), "seed"), // stamped later than the observation
    );
    expect((await first<{ p: number }>("SELECT price_per_unit AS p FROM price_registry WHERE ingredient_id = ?", ing))!.p).toBe(108);
  });

  it("registry identity (name + unit) is LWW", async () => {
    const ing = U("ing");
    await push(registry(ing, hlc(WALL + 950), "kg"));
    expect(statuses(await push(registry(ing, hlc(WALL + 940), "pack")))).toEqual(["stale"]);
    expect(statuses(await push(registry(ing, hlc(WALL + 960), "pouch")))).toEqual(["applied"]);
    expect((await first<{ u: string }>("SELECT pricing_unit AS u FROM price_registry WHERE ingredient_id = ?", ing))!.u).toBe("pouch");
  });
});

describe("pantry tombstones", () => {
  it("a delete beats older writes, a late older write cannot resurrect stock, and a newer write revives it", async () => {
    const key = "potato|loose";
    const put = (h: string, q: number) => mut("pantry", key, h, { ingredient_id: "potato", state: "loose", quantity: q, unit: "g", opened_cycle_id: null, updated_at: h });
    const c0 = await cursor();
    await push(put(hlc(WALL + 1000), 500));
    expect(statuses(await push(mut("pantry", key, hlc(WALL + 1010), null)))).toEqual(["applied"]);
    expect(statuses(await push(put(hlc(WALL + 1005), 999)))).toEqual(["stale"]);
    expect(await first("SELECT deleted AS d, quantity AS q FROM pantry_stock WHERE ingredient_id = 'potato' AND state = 'loose'")).toEqual({ d: 1, q: 0 });
    expect(statuses(await push(put(hlc(WALL + 1020), 250)))).toEqual(["applied"]);
    expect(await first("SELECT deleted AS d, quantity AS q FROM pantry_stock WHERE ingredient_id = 'potato' AND state = 'loose'")).toEqual({ d: 0, q: 250 });
    const log = (await changesSince(c0)).filter((c) => c.entity === "pantry");
    expect(log.map((c) => (c.payload === null ? "delete" : (c.payload as { quantity: number }).quantity))).toEqual([500, "delete", 250]);
  });
});

describe("intra-cycle exclusion under LWW", () => {
  async function setup() {
    const cid = U("cyc");
    const [r1, r2] = [U("rcp"), U("rcp")];
    const rec = (id: string) => ({ recipe: { ...structuredClone(pinakbet), id } as Recipe, deleted: false });
    await push(mut("cycle", cid, hlc(WALL + 1100), cyclePayload(cid, hlc(WALL + 1100))), mut("recipe", r1, hlc(WALL + 1101), rec(r1)), mut("recipe", r2, hlc(WALL + 1102), rec(r2)));
    return { cid, r1, r2 };
  }
  const dish = (cid: string, w: number, s: number, r: string, h: string) => mut("cycleDish", `${cid}|${w}|${s}`, h, dishPayload(cid, w, s, r, h));

  it("moving a recipe to a newer slot evicts the old placement and logs the eviction", async () => {
    const { cid, r1 } = await setup();
    const c0 = await cursor();
    await push(dish(cid, 1, 0, r1, hlc(WALL + 1200)));
    expect(statuses(await push(dish(cid, 1, 1, r1, hlc(WALL + 1210))))).toEqual(["applied"]);
    const rows = (await db.prepare("SELECT week, slot FROM cycle_dishes WHERE cycle_id = ?").bind(cid).all()).results;
    expect(rows).toEqual([{ week: 1, slot: 1 }]);
    const log = (await changesSince(c0)).filter((c) => c.entity === "cycleDish").map((c) => [c.entity_key, c.payload === null ? "delete" : "put"]);
    expect(log).toEqual([[`${cid}|1|0`, "put"], [`${cid}|1|0`, "delete"], [`${cid}|1|1`, "put"]]);
    const evict = (await changesSince(c0)).find((c) => c.entity === "cycleDish" && c.payload === null)!;
    expect(evict.device_id).toBe("server"); // server-authored: no client may treat it as its own echo
  });

  it("an OLDER placement that conflicts with a newer one is stale and changes nothing", async () => {
    const { cid, r1 } = await setup();
    await push(dish(cid, 1, 1, r1, hlc(WALL + 1310)));
    expect(statuses(await push(dish(cid, 2, 2, r1, hlc(WALL + 1300))))).toEqual(["stale"]);
    expect((await db.prepare("SELECT week, slot FROM cycle_dishes WHERE cycle_id = ?").bind(cid).all()).results).toEqual([{ week: 1, slot: 1 }]);
  });

  it("a swap (two moves) lands cleanly, and the DB never holds a duplicate", async () => {
    const { cid, r1, r2 } = await setup();
    await push(dish(cid, 1, 0, r1, hlc(WALL + 1400)), dish(cid, 1, 1, r2, hlc(WALL + 1401)));
    expect(statuses(await push(dish(cid, 1, 0, r2, hlc(WALL + 1410)), dish(cid, 1, 1, r1, hlc(WALL + 1411))))).toEqual(["applied", "applied"]);
    const rows = (await db.prepare("SELECT slot, recipe_id FROM cycle_dishes WHERE cycle_id = ? ORDER BY slot").bind(cid).all()).results;
    expect(rows).toEqual([{ slot: 0, recipe_id: r2 }, { slot: 1, recipe_id: r1 }]);
  });

  it("dishes need their cycle and recipe (retry); clients cannot push deletes", async () => {
    const { r1 } = await setup();
    expect(statuses(await push(dish("no-such-cycle", 1, 0, r1, hlc(WALL + 1500))))).toEqual(["retry"]);
    const { cid } = await setup();
    expect(statuses(await push(dish(cid, 1, 0, "no-such-recipe", hlc(WALL + 1501))))).toEqual(["retry"]);
    expect(statuses(await push(mut("cycleDish", `${cid}|1|0`, hlc(WALL + 1502), null)))).toEqual(["invalid"]);
  });
});

describe("GET /api/sync/pull", () => {
  it("returns changes after the cursor in seq order, with parsed payloads, and pages with has_more", async () => {
    const c0 = await cursor();
    const ids = [U("cyc"), U("cyc"), U("cyc")];
    for (const [i, id] of ids.entries()) await push(mut("cycle", id, hlc(WALL + 2000 + i), cyclePayload(id, hlc(WALL + 2000 + i))));
    const all = await pull(c0, 500);
    expect(all.changes.map((c) => c.entity_key)).toEqual(ids);
    expect(all.has_more).toBe(false);
    expect(all.cursor).toBe(all.changes[2]!.seq);
    expect(all.changes[0]!.payload).toMatchObject({ id: ids[0], status: "draft" });

    const p1 = await pull(c0, 2);
    expect(p1.changes).toHaveLength(2);
    expect(p1.has_more).toBe(true);
    const p2 = await pull(p1.cursor, 2);
    expect(p2.changes.map((c) => c.entity_key)).toEqual([ids[2]]);
    expect(p2.has_more).toBe(false);
    expect(await pull(p2.cursor)).toMatchObject({ changes: [], cursor: p2.cursor, has_more: false });
  });

  it("an empty pull keeps the caller's cursor; bad parameters are 400", async () => {
    expect(await pull(10_000_000)).toEqual({ changes: [], cursor: 10_000_000, has_more: false });
    for (const q of ["since=-1", "since=abc", "limit=0", "since=1.5"]) expect((await call(`/api/sync/pull?${q}`)).status, q).toBe(400);
  });

  it("the change_log is append-only and monotonic across pushes", async () => {
    const c0 = await cursor();
    const id = U("cyc");
    await push(mut("cycle", id, hlc(WALL + 3000), cyclePayload(id, hlc(WALL + 3000))));
    await push(mut("cycle", id, hlc(WALL + 3001), cyclePayload(id, hlc(WALL + 3001), { status: "locked" })));
    const seqs = (await changesSince(c0)).map((c) => c.seq);
    expect(seqs).toHaveLength(2);
    expect(seqs[1]!).toBeGreaterThan(seqs[0]!);
    expect(await cursor()).toBe(seqs[1]);
  });
});
