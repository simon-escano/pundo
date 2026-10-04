import { describe, expect, it } from "vitest";
import { rollCycle } from "../domain/engines/roller";
import { ingestRecipe } from "../domain/ingest/parse";
import type { PriceObservation } from "../domain/schemas/app";
import { StorageError } from "./errors";
import { makeHarness, outboxOf } from "./testing/harness";

const code = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return e instanceof StorageError ? e.code : `non-storage: ${String(e)}`; }
  return "no error";
};
const obs = (id: string, ingredient_id: string, price: number, day: number, kind: PriceObservation["kind"] = "observed"): PriceObservation => ({
  id, ingredient_id, kind, price, observed_at: `2026-10-${String(day).padStart(2, "0")}T00:00:00.000Z`, cycle_id: null, device_id: "d",
});

describe("recipes repo", () => {
  it("validates on write with field-path issues, and enforces the registry foreign key", async () => {
    const s = await makeHarness().open();
    const good = (await s.recipes.get("pinakbet"))!;
    await expect(s.recipes.put({ ...good, default_portions: 8 })).rejects.toMatchObject({ code: "VALIDATION", issues: [expect.objectContaining({ path: "default_portions" })] });
    expect(await code(s.recipes.put({ ...good, id: "x", prep_items: [{ ...good.prep_items[0]!, ingredient_id: "ghost_item" }] }))).toBe("UNRESOLVED_INGREDIENTS");
  });
  it("soft delete hides from list/get/has, keeps the row, and restore brings it back", async () => {
    const s = await makeHarness().open();
    await s.recipes.remove("pinakbet");
    expect(await s.recipes.get("pinakbet")).toBeUndefined();
    expect(await s.recipes.has("pinakbet")).toBe(false);
    expect((await s.recipes.list()).map((r) => r.id)).not.toContain("pinakbet");
    expect((await s.recipes.get("pinakbet", { includeDeleted: true }))?.id).toBe("pinakbet");
    expect(await s.recipes.list({ includeDeleted: true })).toHaveLength(15);
    await s.recipes.remove("pinakbet"); // idempotent: no extra outbox row
    await s.recipes.restore("pinakbet");
    expect(await s.recipes.has("pinakbet")).toBe(true);
    expect((await outboxOf(s)).map((r) => (r.payload as { deleted: boolean }).deleted)).toEqual([true, false]);
    expect(await code(s.recipes.remove("nope"))).toBe("NOT_FOUND");
  });
  it("re-saving a deleted id revives it; saves are stamped newer than the seed", async () => {
    const s = await makeHarness().open();
    await s.recipes.remove("pinakbet");
    await s.recipes.put((await s.recipes.get("pinakbet", { includeDeleted: true }))!);
    const row = (await s.db.recipes.get("pinakbet"))!;
    expect(row._deleted).toBe(false);
    expect(row._hlc > "000000000000000-00000-seed").toBe(true);
  });
  it("JSON round trip: every stored recipe survives toJson → ingest → put unchanged", async () => {
    const s = await makeHarness().open();
    for (const r of await s.recipes.list()) {
      const text = await s.recipes.toJson(r.id);
      const parsed = ingestRecipe(text);
      expect(parsed.ok && parsed.recipe).toEqual(r);
      const saved = await s.recipes.saveJson(text);
      expect(saved.recipe).toEqual(r);
      expect(await s.recipes.get(r.id)).toEqual(r);
    }
  });
  it("saveJson reports syntax errors with location, validation errors, and warnings", async () => {
    const s = await makeHarness().open();
    await expect(s.recipes.saveJson('{\n "a": }')).rejects.toMatchObject({ code: "VALIDATION", message: expect.stringContaining("line 2") });
    await expect(s.recipes.saveJson("{}")).rejects.toMatchObject({ code: "VALIDATION" });
    const r = (await s.recipes.get("pinakbet"))!;
    const odd = { ...r, prep_items: r.prep_items.map((p, i) => (i === 0 ? { ...p, unit: "handful" } : p)) };
    const out = await s.recipes.saveJson(JSON.stringify(odd));
    expect(out.warnings.map((w) => w.path)).toContain("prep_items[0].unit");
    expect(await code(s.recipes.toJson("nope"))).toBe("NOT_FOUND");
  });
  it("listAll exposes the soft-delete flag", async () => {
    const s = await makeHarness().open();
    await s.recipes.remove("pinakbet");
    const all = await s.recipes.listAll();
    expect(all).toHaveLength(15);
    expect(all.filter((x) => x.deleted).map((x) => x.recipe.id)).toEqual(["pinakbet"]);
  });
  it("detects corrupted rows on read instead of leaking them to the engines", async () => {
    const s = await makeHarness().open();
    await s.db.recipes.update("pinakbet", { default_portions: 3 as never });
    expect(await code(s.recipes.get("pinakbet"))).toBe("CORRUPT");
    expect(await code(s.recipes.list())).toBe("CORRUPT");
  });
  it("outbox carries the full document", async () => {
    const s = await makeHarness().open();
    const r = (await s.recipes.get("pinakbet"))!;
    await s.recipes.put({ ...r, name: "Pinakbet v2" });
    const [row] = await outboxOf(s);
    expect(row).toMatchObject({ entity: "recipe", entity_key: "pinakbet", payload: { recipe: { name: "Pinakbet v2" }, deleted: false } });
  });
});

describe("registry repo", () => {
  it("ensure creates a record with a PHP 0 seed when the price is skipped, and returns existing records untouched", async () => {
    const s = await makeHarness().open();
    const rec = await s.registry.ensure({ ingredient_id: "sili", display_name: "Sili", pricing_unit: "kg" });
    expect(rec.price_per_unit).toBe(0);
    const n = (await outboxOf(s)).length;
    expect(await s.registry.ensure({ ingredient_id: "sili", display_name: "Other", pricing_unit: "pack", price: 99 })).toEqual(rec);
    expect((await outboxOf(s)).length).toBe(n);
    expect((await outboxOf(s)).map((r) => r.entity)).toEqual(["priceRegistry", "priceObservation"]);
    expect(await code(s.registry.ensure({ ingredient_id: "bad", display_name: "x", pricing_unit: "kg", price: -1 }))).toBe("VALIDATION");
  });
  it("cold start: the first observation takes over a PHP 0 seed, then EMA (α = 0.4) applies", async () => {
    const s = await makeHarness().open();
    await s.registry.ensure({ ingredient_id: "sili", display_name: "Sili", pricing_unit: "kg" });
    await s.registry.appendObservations([obs("a", "sili", 100, 5)]);
    expect((await s.registry.get("sili"))!.price_per_unit).toBe(100);
    await s.registry.appendObservations([obs("b", "sili", 120, 6)]);
    expect((await s.registry.get("sili"))!.price_per_unit).toBe(108);
    expect((await s.registry.get("sili"))!.last_updated).toBe("2026-10-06T00:00:00.000Z");
  });
  it("appending is idempotent by observation id", async () => {
    const s = await makeHarness().open();
    expect(await s.registry.appendObservations([obs("a", "potato", 120, 5), obs("a", "potato", 999, 5)])).toEqual({ added: 1 });
    expect(await s.registry.appendObservations([obs("a", "potato", 120, 5)])).toEqual({ added: 0 });
    expect((await s.registry.get("potato"))!.price_per_unit).toBe(0.4 * 120 + 0.6 * 90);
  });
  it("late-arriving older observations re-fold into the same registry (commutative across devices)", async () => {
    const list = [obs("1", "potato", 100, 5), obs("2", "potato", 130, 6), obs("3", "pork_belly", 400, 5), obs("4", "potato", 80, 7, "override")];
    const a = await makeHarness().open();
    await a.registry.appendObservations(list);
    const b = await makeHarness().open();
    for (const o of [...list].reverse()) await b.registry.appendObservations([o]); // one at a time, reversed
    expect(await b.registry.snapshot()).toEqual(await a.registry.snapshot());
  });
  it("rejects unknown ingredients and malformed observations without writing anything", async () => {
    const s = await makeHarness().open();
    expect(await code(s.registry.appendObservations([obs("a", "ghost", 5, 5)]))).toBe("MISSING_REGISTRY");
    expect(await code(s.registry.appendObservations([{ ...obs("b", "potato", 5, 5), price: -1 }]))).toBe("VALIDATION");
    expect(await s.db.priceObservations.get("a")).toBeUndefined();
  });
  it("recalculate rebuilds tampered cache rows from observations (all or selected)", async () => {
    const s = await makeHarness().open();
    await s.registry.appendObservations([obs("a", "potato", 120, 5)]);
    const good = (await s.registry.get("potato"))!;
    await s.db.priceRegistry.update("potato", { price_per_unit: 1 });
    await s.db.priceRegistry.update("carrot", { price_per_unit: 1 });
    await s.registry.recalculate(["potato"]);
    expect(await s.registry.get("potato")).toEqual(good);
    expect((await s.registry.get("carrot"))!.price_per_unit).toBe(1);
    await s.registry.recalculate();
    expect((await s.registry.get("carrot"))!.price_per_unit).toBe(80);
    expect((await outboxOf(s)).map((r) => r.entity)).toEqual(["priceObservation"]); // derived rows are never queued
  });
  it("snapshot flags a corrupted registry", async () => {
    const s = await makeHarness().open();
    await s.db.priceRegistry.update("potato", { pricing_unit: "stone" as never });
    expect(await code(s.registry.snapshot())).toBe("CORRUPT");
  });
});

describe("meta repo", () => {
  it("upserts with an HLC stamp and requires a registry record", async () => {
    const s = await makeHarness().open();
    const m = await s.meta.put({ ingredient_id: "potato", aisle: "produce", storage_class: "loose_produce", surface_prep: "Scrub", avg_unit_mass_g: 160 });
    expect(m.updated_at).toMatch(/^\d{15}-\d{5}-/);
    expect((await s.meta.get("potato"))!.surface_prep).toBe("Scrub");
    expect(await code(s.meta.put({ ingredient_id: "ghost", aisle: "produce", storage_class: "loose_produce", surface_prep: null, avg_unit_mass_g: null }))).toBe("MISSING_REGISTRY");
    expect(await code(s.meta.put({ ingredient_id: "potato", aisle: "garage" as never, storage_class: "loose_produce", surface_prep: null, avg_unit_mass_g: null }))).toBe("VALIDATION");
    expect(Object.keys(await s.meta.all())).toHaveLength(39);
  });
});

describe("cycles repo", () => {
  async function drafted() {
    const s = await makeHarness().open();
    const cycle = await s.cycles.create({ start_date: "2026-10-04", seed: 99 });
    const roll = rollCycle({ pool: await s.recipes.list(), seed: 99, locks: {}, previousCycleRecipeIds: new Set() });
    if (!roll.ok) throw new Error("roll");
    await s.cycles.applyRollResult(cycle.id, roll);
    return { s, cycle, roll };
  }

  it("creates drafts with the blueprint defaults and validates input", async () => {
    const s = await makeHarness().open();
    const c = await s.cycles.create({ start_date: "2026-10-04", seed: 5 });
    expect(c).toMatchObject({ status: "draft", global_portions: 10, seed: 5 });
    expect(await code(s.cycles.create({ start_date: "2026-02-30", seed: 1 }))).toBe("VALIDATION");
    expect(await code(s.cycles.create({ start_date: "2026-10-04", seed: -1 }))).toBe("VALIDATION");
    expect(await code(s.cycles.get("x") as never)).toBe("no error");
  });
  it("persists a roll as six slots in order, and exposes locks for the roller", async () => {
    const { s, cycle, roll } = await drafted();
    const { dishes } = await s.cycles.getPlan(cycle.id);
    expect(dishes.map((d) => `${d.week}-${d.slot}`)).toEqual(["1-0", "1-1", "1-2", "2-0", "2-1", "2-2"]);
    expect(dishes.filter((d) => d.week === 1).map((d) => d.recipe_id)).toEqual(roll.week1.map((r) => r.id));
    expect(await s.cycles.locks(cycle.id)).toEqual({});
    await s.cycles.setLocked(cycle.id, 1, 1, true);
    await s.cycles.setLocked(cycle.id, 1, 1, true); // no-op
    expect(await s.cycles.locks(cycle.id)).toEqual({ "1-1": roll.week1[1]!.id });
    expect((await s.db.outbox.where("entity").equals("cycleDish").count())).toBe(7);
  });
  it("setWeekLocked flags exactly one week's dishes in one transaction, is a no-op when already set, and needs a draft", async () => {
    const { s, cycle, roll } = await drafted();
    expect(await s.cycles.setWeekLocked(cycle.id, 2, true)).toBe(3);
    expect(Object.keys(await s.cycles.locks(cycle.id)).sort()).toEqual(["2-0", "2-1", "2-2"]);
    const before = await s.db.outbox.count();
    expect(await s.cycles.setWeekLocked(cycle.id, 2, true)).toBe(0); // nothing to change: nothing logged
    expect(await s.db.outbox.count()).toBe(before);
    await s.cycles.setLocked(cycle.id, 1, 1, true);
    expect(await s.cycles.setWeekLocked(cycle.id, 1, true)).toBe(2); // only the two unlocked ones
    expect(await s.cycles.setWeekLocked(cycle.id, 1, false)).toBe(3);
    expect(Object.keys(await s.cycles.locks(cycle.id)).sort()).toEqual(["2-0", "2-1", "2-2"]);
    await s.cycles.transition(cycle.id, "locked");
    expect(await code(s.cycles.setWeekLocked(cycle.id, 1, true))).toBe("INVALID_STATE");
    expect(roll.week1).toHaveLength(3);
  });
  it("locked slots survive a re-roll that honours them, and cannot be overwritten", async () => {
    const { s, cycle, roll } = await drafted();
    await s.cycles.setLocked(cycle.id, 2, 0, true);
    const again = rollCycle({ pool: await s.recipes.list(), seed: 12345, locks: await s.cycles.locks(cycle.id), previousCycleRecipeIds: new Set() });
    if (!again.ok) throw new Error("roll");
    await s.cycles.applyRollResult(cycle.id, again);
    expect((await s.cycles.getPlan(cycle.id)).dishes.find((d) => d.week === 2 && d.slot === 0)!.recipe_id).toBe(roll.week2[0]!.id);
    const other = (await s.recipes.list()).find((r) => r.perishability_tier === "TIER_2_HARDY" && !again.week1.concat(again.week2).includes(r))!;
    expect(await code(s.cycles.setDishes(cycle.id, [{ week: 2, slot: 0, recipe_id: other.id }]))).toBe("CONFLICT");
  });
  it("setDishes enforces hardy-only Week 2, uniqueness, active recipes and valid slots", async () => {
    const { s, cycle, roll } = await drafted();
    expect(await code(s.cycles.setDishes(cycle.id, [{ week: 2, slot: 0, recipe_id: "pinakbet" }]))).toMatch(/VALIDATION|CONFLICT/);
    expect(await code(s.cycles.setDishes(cycle.id, [{ week: 1, slot: 0, recipe_id: roll.week1[1]!.id }]))).toBe("CONFLICT");
    expect(await code(s.cycles.setDishes(cycle.id, [{ week: 1, slot: 0, recipe_id: "nope" }]))).toBe("NOT_FOUND");
    expect(await code(s.cycles.setDishes(cycle.id, [{ week: 3 as never, slot: 0, recipe_id: roll.week1[0]!.id }]))).toBe("VALIDATION");
    const free = (await s.recipes.list()).find((r) => r.perishability_tier === "TIER_2_HARDY" && ![...roll.week1, ...roll.week2].includes(r))!;
    await s.recipes.remove(free.id);
    expect(await code(s.cycles.setDishes(cycle.id, [{ week: 1, slot: 0, recipe_id: free.id }]))).toBe("NOT_FOUND");
    expect(await s.cycles.setDishes(cycle.id, [{ week: 1, slot: 0, recipe_id: roll.week1[0]!.id }])).toEqual([]); // unchanged → nothing written
  });
  it("swapping two dishes between slots is allowed (uniqueness is checked on the final state)", async () => {
    const { s, cycle, roll } = await drafted();
    await s.cycles.setDishes(cycle.id, [{ week: 1, slot: 0, recipe_id: roll.week1[1]!.id }, { week: 1, slot: 1, recipe_id: roll.week1[0]!.id }]);
    const d = (await s.cycles.getPlan(cycle.id)).dishes;
    expect(d[0]!.recipe_id).toBe(roll.week1[1]!.id);
  });
  it("setSeed persists a uint32 seed (draft only)", async () => {
    const { s, cycle } = await drafted();
    expect((await s.cycles.setSeed(cycle.id, 4294967295)).seed).toBe(4294967295);
    expect(await code(s.cycles.setSeed(cycle.id, -1))).toBe("VALIDATION");
    expect(await code(s.cycles.setSeed(cycle.id, 1.5))).toBe("VALIDATION");
    await s.cycles.transition(cycle.id, "locked");
    expect(await code(s.cycles.setSeed(cycle.id, 5))).toBe("INVALID_STATE");
  });
  it("portion overrides and the global stepper; effective portions", async () => {
    const { s, cycle } = await drafted();
    await s.cycles.setPortionOverride(cycle.id, 1, 0, 6);
    await s.cycles.setPortionOverride(cycle.id, 1, 0, 6); // no-op
    const c2 = await s.cycles.setGlobalPortions(cycle.id, 12);
    const plan = await s.cycles.getPlan(cycle.id);
    expect(s.cycles.portionsFor(c2, plan.dishes[0]!)).toBe(6);
    expect(s.cycles.portionsFor(c2, plan.dishes[1]!)).toBe(12);
    await s.cycles.setPortionOverride(cycle.id, 1, 0, null);
    expect(s.cycles.portionsFor(c2, (await s.cycles.getPlan(cycle.id)).dishes[0]!)).toBe(12);
    expect(await code(s.cycles.setPortionOverride(cycle.id, 1, 0, 0))).toBe("VALIDATION");
    expect(await code(s.cycles.setGlobalPortions(cycle.id, 31))).toBe("VALIDATION");
    expect(await code(s.cycles.setLocked(cycle.id, 1, 0, true).then(() => s.cycles.setPortionOverride("ghost", 1, 0, 5)))).toBe("NOT_FOUND");
  });
  it("status machine: draft → locked → shopped → w1_cooked → complete, with guard rails", async () => {
    const { s, cycle } = await drafted();
    expect(await code(s.cycles.transition(cycle.id, "shopped"))).toBe("INVALID_STATE");
    expect((await s.cycles.transition(cycle.id, "locked")).status).toBe("locked");
    expect(await code(s.cycles.setGlobalPortions(cycle.id, 8))).toBe("INVALID_STATE"); // plan frozen
    expect(await code(s.cycles.setDishes(cycle.id, []))).toBe("INVALID_STATE");
    expect((await s.cycles.transition(cycle.id, "draft")).status).toBe("draft"); // unlock
    await s.cycles.transition(cycle.id, "locked");
    await s.cycles.transition(cycle.id, "shopped");
    await s.cycles.transition(cycle.id, "w1_cooked");
    expect((await s.cycles.transition(cycle.id, "complete")).status).toBe("complete");
    expect(await code(s.cycles.transition(cycle.id, "draft"))).toBe("INVALID_STATE");
    expect(await code(s.cycles.transition("ghost", "locked"))).toBe("NOT_FOUND");
  });
  it("shopped can jump straight to complete; locking needs all six slots", async () => {
    const s = await makeHarness().open();
    const c = await s.cycles.create({ start_date: "2026-10-04", seed: 1 });
    expect(await code(s.cycles.transition(c.id, "locked"))).toBe("INVALID_STATE");
    const d = await drafted();
    await d.s.cycles.transition(d.cycle.id, "locked");
    await d.s.cycles.transition(d.cycle.id, "shopped");
    expect((await d.s.cycles.transition(d.cycle.id, "complete")).status).toBe("complete");
  });
  it("lists newest first, finds the latest, and reports last cycle's dishes for cooldown", async () => {
    const { s, cycle: first, roll } = await drafted();
    const second = await s.cycles.create({ start_date: "2026-10-18", seed: 2 });
    expect((await s.cycles.list()).map((c) => c.id)).toEqual([second.id, first.id]);
    expect((await s.cycles.latest())!.id).toBe(second.id);
    expect(await s.cycles.previousRecipeIds(second.id)).toEqual(new Set([...roll.week1, ...roll.week2].map((r) => r.id)));
    expect(await s.cycles.previousRecipeIds(first.id)).toEqual(new Set());
    expect(await code(s.cycles.previousRecipeIds("ghost"))).toBe("NOT_FOUND");
  });
});

describe("pantry repo", () => {
  it("adds in canonical units, merges stock, and converts compatible units", async () => {
    const s = await makeHarness().open();
    expect((await s.pantry.add({ ingredient_id: "potato", state: "loose", quantity: 1, unit: "kg" }))).toMatchObject({ quantity: 1000, unit: "g" });
    expect((await s.pantry.add({ ingredient_id: "potato", state: "loose", quantity: 250, unit: "g" })).quantity).toBe(1250);
    expect(await code(s.pantry.add({ ingredient_id: "potato", state: "loose", quantity: 1, unit: "pieces" }))).toBe("UNIT_MISMATCH");
    expect(await code(s.pantry.add({ ingredient_id: "x", state: "loose", quantity: 1, unit: "handful" }))).toBe("VALIDATION");
    expect(await code(s.pantry.add({ ingredient_id: "x", state: "loose", quantity: 0, unit: "g" }))).toBe("VALIDATION");
  });
  it("tracks the opening cycle for opened perishables", async () => {
    const s = await makeHarness().open();
    await s.pantry.add({ ingredient_id: "tomato_sauce", state: "opened", quantity: 70, unit: "g", opened_cycle_id: "c1" });
    await s.pantry.add({ ingredient_id: "tomato_sauce", state: "opened", quantity: 30, unit: "g" });
    expect((await s.pantry.forIngredient("tomato_sauce"))[0]).toMatchObject({ quantity: 100, opened_cycle_id: "c1" });
  });
  it("captures projected surplus (and ignores null)", async () => {
    const s = await makeHarness().open();
    expect(await s.pantry.captureSurplus(null)).toBeNull();
    await s.pantry.captureSurplus({ ingredient_id: "liver_spread", state: "sealed", quantity: 75, unit: "g", opened_cycle_id: null, updated_at: "" });
    expect((await s.pantry.list())[0]).toMatchObject({ ingredient_id: "liver_spread", quantity: 75 });
  });
  it("deducts, removes empty rows, and refuses to overdraw", async () => {
    const s = await makeHarness().open();
    await s.pantry.add({ ingredient_id: "potato", state: "loose", quantity: 1, unit: "kg" });
    expect((await s.pantry.deduct("potato", "loose", 0.4, "kg"))!.quantity).toBe(600);
    expect(await code(s.pantry.deduct("potato", "loose", 700, "g"))).toBe("INSUFFICIENT_STOCK");
    expect(await code(s.pantry.deduct("potato", "loose", 1, "pieces"))).toBe("UNIT_MISMATCH");
    expect(await code(s.pantry.deduct("potato", "sealed", 1, "g"))).toBe("INSUFFICIENT_STOCK");
    expect(await code(s.pantry.deduct("potato", "loose", 1, "handful"))).toBe("VALIDATION");
    expect(await s.pantry.deduct("potato", "loose", 600, "g")).toBeNull();
    expect(await s.pantry.list()).toEqual([]);
    expect((await outboxOf(s)).at(-1)).toMatchObject({ entity: "pantry", payload: null });
  });
  it("[Spoiled / Tossed] removal, and a sorted list", async () => {
    const s = await makeHarness().open();
    await s.pantry.add({ ingredient_id: "b", state: "sealed", quantity: 1, unit: "can" });
    await s.pantry.add({ ingredient_id: "a", state: "opened", quantity: 1, unit: "g" });
    await s.pantry.add({ ingredient_id: "a", state: "loose", quantity: 1, unit: "g" });
    expect((await s.pantry.list()).map((p) => `${p.ingredient_id}:${p.state}`)).toEqual(["a:loose", "a:opened", "b:sealed"]);
    await s.pantry.remove("a", "opened");
    await s.pantry.remove("a", "opened"); // already gone: no-op
    expect((await s.pantry.list()).map((p) => p.state)).toEqual(["loose", "sealed"]);
  });
});

describe("grocery state repo", () => {
  async function withCycle() {
    const s = await makeHarness().open();
    return { s, c: await s.cycles.create({ start_date: "2026-10-04", seed: 1 }) };
  }
  it("toggles bought, [Spoiled / Tossed] and paid amounts with sane defaults", async () => {
    const { s, c } = await withCycle();
    expect(await s.groceryState.setBought(c.id, "potato|g|cycle", true)).toMatchObject({ bought: true, deduct_stock: true, paid_php: null });
    expect(await s.groceryState.setDeductStock(c.id, "potato|g|cycle", false)).toMatchObject({ bought: true, deduct_stock: false });
    expect(await s.groceryState.setPaid(c.id, "potato|g|cycle", 55.5)).toMatchObject({ paid_php: 55.5 });
    expect(await s.groceryState.setPaid(c.id, "potato|g|cycle", null)).toMatchObject({ paid_php: null });
    expect(await s.groceryState.get(c.id, "potato|g|cycle")).toMatchObject({ bought: true, deduct_stock: false });
    expect(await s.groceryState.forCycle(c.id)).toHaveLength(1);
  });
  it("validates paid amounts and the cycle", async () => {
    const { s, c } = await withCycle();
    expect(() => s.groceryState.setPaid(c.id, "x", -5)).toThrow(StorageError);
    expect(() => s.groceryState.setPaid(c.id, "x", Number.NaN)).toThrow(StorageError);
    expect(await code(s.groceryState.setBought("ghost", "x", true))).toBe("NOT_FOUND");
    expect(await code(s.groceryState.markAllBought("ghost", ["x"]))).toBe("NOT_FOUND");
  });
  it("[Mark Groceries as Bought] checks off every line in one transaction, and can undo", async () => {
    const { s, c } = await withCycle();
    await s.groceryState.markAllBought(c.id, ["a|g|cycle", "b|pc|cycle"]);
    expect((await s.groceryState.forCycle(c.id)).every((l) => l.bought)).toBe(true);
    await s.groceryState.markAllBought(c.id, ["a|g|cycle"], false);
    expect((await s.groceryState.get(c.id, "a|g|cycle"))!.bought).toBe(false);
    expect((await s.groceryState.get(c.id, "b|pc|cycle"))!.bought).toBe(true);
  });
});
