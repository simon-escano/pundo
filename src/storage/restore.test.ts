import { describe, expect, it } from "vitest";
import { buildGroceryList } from "../domain/engines/grocery";
import { rollCycle } from "../domain/engines/roller";
import { scaleRecipe } from "../domain/engines/scaling";
import { cycleRanges } from "../domain/engines/dates";
import type { Storage } from "./index";
import { makeHarness } from "./testing/harness";

/** Rebuild the grocery list purely from what is persisted: what the UI does after a reload. */
async function groceryFromStorage(s: Storage, cycleId: string) {
  const { cycle, dishes } = await s.cycles.getPlan(cycleId);
  const recipes = new Map((await s.recipes.list()).map((r) => [r.id, r]));
  return buildGroceryList({
    cycleId,
    dishes: dishes.map((d) => scaleRecipe(recipes.get(d.recipe_id)!, s.cycles.portionsFor(cycle, d), d.week)),
    pantry: await s.pantry.list(),
    meta: await s.meta.all(),
    registry: await s.registry.snapshot(),
    lineState: await s.groceryState.forCycle(cycleId),
  });
}

describe("state restoration across a simulated page reload", () => {
  it("restores locked slots, cycle seed, portions, status and checked grocery items; list is identical", async () => {
    const h = makeHarness();
    const a = await h.open();

    // Plan: roll, persist, lock two slots, tweak portions, lock the cycle.
    const cycle = await a.cycles.create({ start_date: "2026-10-04", seed: 424242 });
    const roll = rollCycle({ pool: await a.recipes.list(), seed: cycle.seed, locks: {}, previousCycleRecipeIds: await a.cycles.previousRecipeIds(cycle.id) });
    if (!roll.ok) throw new Error(roll.error.detail);
    await a.cycles.applyRollResult(cycle.id, roll);
    await a.cycles.setLocked(cycle.id, 1, 1, true);
    await a.cycles.setLocked(cycle.id, 2, 0, true);
    await a.cycles.setPortionOverride(cycle.id, 2, 2, 8);
    await a.cycles.setGlobalPortions(cycle.id, 12);
    await a.cycles.transition(cycle.id, "locked");

    // Grocery: check off, toss one, record paid, plus pantry stock.
    await a.pantry.add({ ingredient_id: "potato", state: "loose", quantity: 400, unit: "g" });
    const before = await groceryFromStorage(a, cycle.id);
    const [first, second, third] = before.lines;
    await a.groceryState.setBought(cycle.id, first!.key, true);
    await a.groceryState.setBought(cycle.id, second!.key, true);
    await a.groceryState.setDeductStock(cycle.id, third!.key, false);
    await a.groceryState.setPaid(cycle.id, first!.key, 123.45);
    const listBefore = await groceryFromStorage(a, cycle.id);
    const planBefore = await a.cycles.getPlan(cycle.id);
    const locksBefore = await a.cycles.locks(cycle.id);
    const deviceBefore = a.deviceId;
    const lastHlc = (await a.db.outbox.orderBy("seq").last())!.hlc; // newest stamp that reached storage
    a.close();

    h.clock.ms += 60_000; // time passes while the tab is closed

    // ── reload ──
    const b = await h.open();
    expect(b.deviceId).toBe(deviceBefore);
    const restored = (await b.cycles.latest())!;
    expect(restored).toMatchObject({ id: cycle.id, seed: 424242, global_portions: 12, status: "locked", start_date: "2026-10-04" });
    expect(cycleRanges(restored.start_date).end).toBe("2026-10-17");

    const planAfter = await b.cycles.getPlan(cycle.id);
    expect(planAfter).toEqual(planBefore);
    expect(await b.cycles.locks(cycle.id)).toEqual(locksBefore);
    expect(Object.keys(locksBefore).sort()).toEqual(["1-1", "2-0"]);
    expect(planAfter.dishes.find((d) => d.week === 2 && d.slot === 2)!.portion_override).toBe(8);

    const listAfter = await groceryFromStorage(b, cycle.id);
    expect(listAfter).toEqual(listBefore);
    expect(listAfter.lines.filter((l) => l.bought).map((l) => l.key)).toEqual([first!.key, second!.key].sort((x, y) => listAfter.lines.findIndex((l) => l.key === x) - listAfter.lines.findIndex((l) => l.key === y)));
    expect(listAfter.lines.find((l) => l.key === third!.key)).toMatchObject({ deductStock: false, reason: "TOSSED" });
    expect(listAfter.lines.find((l) => l.key === first!.key)!.paidPhp).toBe(123.45);
    expect(await b.pantry.list()).toHaveLength(1);

    // The HLC resumes ahead of everything produced before the reload.
    expect(b.clock.tick() > lastHlc).toBe(true);
    // The roll is reproducible from the persisted seed and locks.
    const reroll = rollCycle({ pool: await b.recipes.list(), seed: restored.seed, locks: await b.cycles.locks(cycle.id), previousCycleRecipeIds: new Set() });
    if (!reroll.ok) throw new Error("reroll");
    expect(reroll.week1[1]!.id).toBe(roll.week1[1]!.id);
    expect(reroll.week2[0]!.id).toBe(roll.week2[0]!.id);
  });

  it("the HLC never regresses across reloads even if the wall clock moves backwards", async () => {
    const h = makeHarness();
    const a = await h.open({ seed: false });
    await a.cycles.create({ start_date: "2026-10-04", seed: 1 });
    const last = (await a.db.outbox.orderBy("seq").last())!.hlc; // newest persisted stamp
    a.close();
    h.clock.ms -= 3_600_000; // clock went back an hour
    const b = await h.open({ seed: false });
    expect(b.clock.tick() > last).toBe(true);
  });

  it("recipes, registry observations and meta edits persist across reloads", async () => {
    const h = makeHarness();
    const a = await h.open();
    await a.recipes.put({ ...(await a.recipes.get("pinakbet"))!, name: "Pinakbet (mine)" });
    await a.registry.appendObservations([{ id: "o1", ingredient_id: "potato", kind: "observed", price: 120, observed_at: "2026-10-05T00:00:00.000Z", cycle_id: null, device_id: "d" }]);
    await a.meta.put({ ingredient_id: "potato", aisle: "produce", storage_class: "loose_produce", surface_prep: "Scrub", avg_unit_mass_g: 160 });
    await a.recipes.remove("pork-adobo");
    a.close();
    const b = await h.open();
    expect((await b.recipes.get("pinakbet"))!.name).toBe("Pinakbet (mine)");
    expect((await b.registry.get("potato"))!.price_per_unit).toBe(0.4 * 120 + 0.6 * 90);
    expect((await b.meta.get("potato"))!.surface_prep).toBe("Scrub");
    expect(await b.recipes.has("pork-adobo")).toBe(false);
    expect(await b.recipes.list()).toHaveLength(14);
    expect(await b.db.outbox.count()).toBeGreaterThanOrEqual(4); // pending sync survives the reload too
  });
});
