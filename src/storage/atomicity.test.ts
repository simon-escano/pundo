import { describe, expect, it, vi } from "vitest";
import { rollCycle } from "../domain/engines/roller";
import type { Storage } from "./index";
import { StorageError } from "./errors";
import { makeHarness } from "./testing/harness";

/** Full, order-stable dump of every table: used to prove a failed mutation changed nothing. */
async function dump(s: Storage) {
  const t = s.db.tables.map(async (tbl) => [tbl.name, await tbl.toArray()] as const);
  return Object.fromEntries(await Promise.all(t));
}

async function richState() {
  const h = makeHarness();
  const s = await h.open();
  const cycle = await s.cycles.create({ start_date: "2026-10-04", seed: 7 });
  const roll = rollCycle({ pool: await s.recipes.list(), seed: 7, locks: {}, previousCycleRecipeIds: new Set() });
  if (!roll.ok) throw new Error("roll failed");
  await s.cycles.applyRollResult(cycle.id, roll);
  await s.pantry.add({ ingredient_id: "potato", state: "loose", quantity: 500, unit: "g" });
  await s.groceryState.setBought(cycle.id, "potato|g|cycle", true);
  await s.recipes.put({ ...(await s.recipes.get("pinakbet"))!, id: "to-delete", name: "To Delete" });
  await s.recipes.remove("to-delete");
  const dishes = (await s.cycles.getPlan(cycle.id)).dishes;
  const other = (await s.recipes.list()).find((r) => !dishes.some((d) => d.recipe_id === r.id) && r.perishability_tier === "TIER_2_HARDY")!;
  return { s, cycle, other, roll };
}

type Ctx = Awaited<ReturnType<typeof richState>>;
const newRecipeJson = async (s: Storage, id: string) => JSON.stringify({ ...(await s.recipes.get("pinakbet"))!, id, name: `Copy ${id}` });

// Every repository mutation, with the state it needs. Each one must (a) write the outbox, (b) be all-or-nothing.
const mutations: [string, (c: Ctx) => Promise<unknown>][] = [
  ["recipes.put", async ({ s }) => s.recipes.put({ ...(await s.recipes.get("pinakbet"))!, id: "new-one", name: "New One" })],
  ["recipes.saveJson", async ({ s }) => s.recipes.saveJson(await newRecipeJson(s, "json-one"))],
  ["recipes.remove", ({ s }) => s.recipes.remove("pinakbet")],
  ["recipes.restore", ({ s }) => s.recipes.restore("to-delete")],
  ["registry.ensure", ({ s }) => s.registry.ensure({ ingredient_id: "sili", display_name: "Sili", pricing_unit: "kg", price: 150 })],
  ["registry.appendObservations", ({ s }) => s.registry.appendObservations([{ id: "o1", ingredient_id: "potato", kind: "observed", price: 100, observed_at: "2026-10-05T00:00:00.000Z", cycle_id: null, device_id: "d" }])],
  ["meta.put", ({ s }) => s.meta.put({ ingredient_id: "potato", aisle: "produce", storage_class: "loose_produce", surface_prep: "Scrub", avg_unit_mass_g: 160 })],
  ["cycles.create", ({ s }) => s.cycles.create({ start_date: "2026-10-18", seed: 1 })],
  ["cycles.setDishes", ({ s, cycle, other }) => s.cycles.setDishes(cycle.id, [{ week: 1, slot: 0, recipe_id: other.id }])],
  ["cycles.applyRollResult", ({ s, cycle, roll }) => s.cycles.applyRollResult(cycle.id, { ...roll, week1: [roll.week1[1]!, roll.week1[0]!, roll.week1[2]!] })],
  ["cycles.setLocked", ({ s, cycle }) => s.cycles.setLocked(cycle.id, 1, 0, true)],
  ["cycles.setWeekLocked", ({ s, cycle }) => s.cycles.setWeekLocked(cycle.id, 1, true)],
  ["cycles.setPortionOverride", ({ s, cycle }) => s.cycles.setPortionOverride(cycle.id, 2, 1, 6)],
  ["cycles.setSeed", ({ s, cycle }) => s.cycles.setSeed(cycle.id, 777)],
  ["cycles.setGlobalPortions", ({ s, cycle }) => s.cycles.setGlobalPortions(cycle.id, 12)],
  ["cycles.transition", ({ s, cycle }) => s.cycles.transition(cycle.id, "locked")],
  ["pantry.add", ({ s }) => s.pantry.add({ ingredient_id: "carrot", state: "loose", quantity: 2, unit: "kg" })],
  ["pantry.captureSurplus", ({ s }) => s.pantry.captureSurplus({ ingredient_id: "tomato_sauce", state: "opened", quantity: 70, unit: "g", opened_cycle_id: "c", updated_at: "" })],
  ["pantry.deduct", ({ s }) => s.pantry.deduct("potato", "loose", 200, "g")],
  ["pantry.deduct (to zero)", ({ s }) => s.pantry.deduct("potato", "loose", 500, "g")],
  ["pantry.remove", ({ s }) => s.pantry.remove("potato", "loose")],
  ["groceryState.setBought", ({ s, cycle }) => s.groceryState.setBought(cycle.id, "carrot|g|cycle", true)],
  ["groceryState.setDeductStock", ({ s, cycle }) => s.groceryState.setDeductStock(cycle.id, "potato|g|cycle", false)],
  ["groceryState.setPaid", ({ s, cycle }) => s.groceryState.setPaid(cycle.id, "potato|g|cycle", 55)],
  ["groceryState.markAllBought", ({ s, cycle }) => s.groceryState.markAllBought(cycle.id, ["a|g|cycle", "b|g|cycle"])],
  ["ingest.commit", async ({ s }) => {
    const r = JSON.parse(await newRecipeJson(s, "ingested"));
    r.prep_items.push({ ...r.prep_items[0], ingredient_id: "labuyo", display_name: "Labuyo" });
    return s.ingest.commit(JSON.stringify(r), [{ ingredient_id: "labuyo", pricing_unit: "kg", price: 400, aisle: "produce", storage_class: "loose_produce" }]);
  }],
];

describe("every repository mutation honours the atomic write invariant", () => {
  it.each(mutations)("%s appends to the outbox when it succeeds", async (_n, run) => {
    const c = await richState();
    const before = await c.s.db.outbox.count();
    await run(c);
    expect(await c.s.db.outbox.count()).toBeGreaterThan(before);
  });

  it.each(mutations)("%s leaves the whole database untouched when the outbox write fails", async (_n, run) => {
    const c = await richState();
    const before = await dump(c.s);
    const spy = vi.spyOn(c.s.db.outbox, "add").mockRejectedValue(new Error("outbox down"));
    await expect(run(c)).rejects.toThrow("outbox down");
    expect(spy).toHaveBeenCalled(); // the failure was exercised, not skipped
    spy.mockRestore();
    expect(await dump(c.s)).toEqual(before);
  });
});

describe("compound operations are all-or-nothing", () => {
  it("ingest.commit rolls back registry + meta + outbox when the final recipe write fails", async () => {
    const { s } = await richState();
    const before = await dump(s);
    const r = JSON.parse(await newRecipeJson(s, "atomic"));
    r.prep_items.push({ ...r.prep_items[0], ingredient_id: "labuyo", display_name: "Labuyo" });
    const spy = vi.spyOn(s.db.recipes, "put").mockRejectedValue(new Error("disk full"));
    await expect(s.ingest.commit(JSON.stringify(r), [{ ingredient_id: "labuyo", pricing_unit: "kg", aisle: "produce", storage_class: "loose_produce" }])).rejects.toThrow("disk full");
    spy.mockRestore();
    expect(await dump(s)).toEqual(before);
    expect(await s.registry.get("labuyo")).toBeUndefined();
  });

  it("markAllBought rolls back every line when one fails", async () => {
    const { s, cycle } = await richState();
    const before = await dump(s);
    const real = s.db.groceryLineState.put.bind(s.db.groceryLineState);
    let n = 0;
    const spy = vi.spyOn(s.db.groceryLineState, "put").mockImplementation(((...a: Parameters<typeof real>) => (++n === 3 ? Promise.reject(new Error("third fails")) : real(...a))) as never);
    await expect(s.groceryState.markAllBought(cycle.id, ["a|g|cycle", "b|g|cycle", "c|g|cycle"])).rejects.toThrow("third fails");
    spy.mockRestore();
    expect(await dump(s)).toEqual(before);
  });

  it("validation failures never touch storage", async () => {
    const { s } = await richState();
    const before = await dump(s);
    await expect(s.recipes.put({ id: "bad" })).rejects.toBeInstanceOf(StorageError);
    await expect(s.pantry.add({ ingredient_id: "x", state: "loose", quantity: 1, unit: "handful" })).rejects.toBeInstanceOf(StorageError);
    expect(await dump(s)).toEqual(before);
  });
});

describe("guard: no repository method escapes classification", () => {
  // Read-only (or derived-cache) methods. Anything else MUST appear in `mutations` above and so be proven atomic.
  const readOnly: Record<string, string[]> = {
    recipes: ["get", "has", "list", "listAll", "toJson"],
    registry: ["snapshot", "get", "observationsFor", "recalculate"], // recalculate rewrites a derived cache: never synced
    meta: ["get", "all"],
    cycles: ["get", "list", "latest", "getPlan", "locks", "previousRecipeIds", "portionsFor"],
    pantry: ["list", "forIngredient"],
    groceryState: ["get", "forCycle"],
    ingest: ["preview"],
  };
  it("every public method is either declared read-only or covered by the atomicity table", async () => {
    const { s } = await richState();
    const covered = new Set(mutations.map(([n]) => n.replace(/ \(.*\)$/, "")));
    for (const [repo, reads] of Object.entries(readOnly)) {
      const methods = Object.keys((s as unknown as Record<string, object>)[repo]!);
      for (const m of methods) {
        if (reads.includes(m)) continue;
        // saveJson/captureSurplus/applyRollResult delegate to a covered writer but are still listed explicitly
        expect(covered.has(`${repo}.${m}`), `${repo}.${m} is a mutation with no atomicity test`).toBe(true);
      }
      for (const r of reads) expect(methods, `${repo}.${r} listed read-only but missing`).toContain(r);
    }
  });
});
