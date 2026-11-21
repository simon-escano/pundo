import { describe, expect, it } from "vitest";
import type { Change } from "../domain/sync/protocol";
import { NEW_PLAN_SHAPE } from "../domain/engines/shape";
import { applyContentUpdate } from "./contentUpdates";
import { BEEF_ID, FILIPINO_IDS, INGREDIENTS, PLAN, PORK_PATA_ID } from "./content/2026-11-22";
import { applyChanges } from "./sync";
import { makeHarness, outboxOf } from "./testing/harness";

const ok = { syncOnce: async () => ({ ok: true }) };

describe("cycles: plan size", () => {
  it("stores the shape, accepts only its slots, and locks with all of them filled", async () => {
    const s = await makeHarness().open();
    const c = await s.cycles.create({ start_date: "2026-11-22", seed: 1, shape: NEW_PLAN_SHAPE });
    expect(c).toMatchObject({ weeks: 1, dishes_per_week: 2 });
    const [a, b, x] = (await s.recipes.list()).map((r) => r.id);
    await expect(s.cycles.setDishes(c.id, [{ week: 1, slot: 2, recipe_id: x! }])).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(s.cycles.setDishes(c.id, [{ week: 2, slot: 0, recipe_id: x! }])).rejects.toMatchObject({ code: "VALIDATION" });
    await s.cycles.setDishes(c.id, [{ week: 1, slot: 0, recipe_id: a! }]);
    await expect(s.cycles.transition(c.id, "locked")).rejects.toThrow("Fill all 2 slots before locking (1/2)");
    await s.cycles.setDishes(c.id, [{ week: 1, slot: 1, recipe_id: b! }]);
    expect((await s.cycles.transition(c.id, "locked")).status).toBe("locked");
  });
  it("defaults to the legacy 2 x 3 and refuses a duplicate id", async () => {
    const s = await makeHarness().open();
    expect(await s.cycles.create({ start_date: "2026-10-04", seed: 1 })).toMatchObject({ weeks: 2, dishes_per_week: 3 });
    await s.cycles.create({ start_date: "2026-11-22", seed: 1, id: "fixed" });
    await expect(s.cycles.create({ start_date: "2026-11-29", seed: 1, id: "fixed" })).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("a pulled cycle change without shape fields keeps the local shape (old clients)", async () => {
    const s = await makeHarness().open();
    const c = await s.cycles.create({ start_date: "2026-11-22", seed: 1, shape: NEW_PLAN_SHAPE });
    const hlc = "001799999999999-00000-old";
    const { weeks: _w, dishes_per_week: _d, ...legacy } = { ...c, status: "locked" as const, updated_at: hlc };
    const change: Change = { seq: 1, entity: "cycle", entity_key: c.id, hlc, device_id: "old", payload: legacy };
    await applyChanges(s.ctx, [change], 1);
    expect(await s.cycles.get(c.id)).toMatchObject({ status: "locked", weeks: 1, dishes_per_week: 2 });
  });
});

describe("recipe tags", () => {
  it("round-trip through put/get and the outbox payload; old rows read as []", async () => {
    const s = await makeHarness().open();
    const r = (await s.recipes.get("pork-adobo"))!;
    expect(r.tags).toEqual(["Filipino"]); // from the fixture
    await s.recipes.put({ ...r, tags: ["Filipino", "Comfort"] });
    expect((await s.recipes.get("pork-adobo"))!.tags).toEqual(["Filipino", "Comfort"]);
    const last = (await outboxOf(s)).at(-1)!;
    expect((last.payload as { recipe: { tags: string[] } }).recipe.tags).toEqual(["Filipino", "Comfort"]);
    const { tags: _t, ...untagged } = (await s.db.recipes.get("pork-adobo"))!;
    await s.db.recipes.put(untagged);
    expect((await s.recipes.get("pork-adobo"))!.tags).toEqual([]);
  });
});

describe("content update 2026-11-22", () => {
  it("adds the ingredients, both recipes, Filipino tags and the locked 1-week plan as synced writes", async () => {
    const s = await makeHarness().open();
    // A device that already had untagged recipes and the old Oct 4 plan.
    for (const id of FILIPINO_IDS) {
      const { tags: _t, ...row } = (await s.db.recipes.get(id))!;
      await s.db.recipes.put(row);
    }
    await s.cycles.create({ start_date: "2026-10-04", seed: 1 });
    const before = (await outboxOf(s)).length;

    expect(await applyContentUpdate(s, ok)).toBe(true);

    for (const i of INGREDIENTS) expect(await s.registry.get(i.ingredient_id)).toMatchObject({ pricing_unit: i.pricing_unit, price_per_unit: i.price });
    expect((await s.meta.all())["pork_pata"]).toMatchObject({ aisle: "fresh_meat", storage_class: "fresh_meat" });
    expect((await s.recipes.get(PORK_PATA_ID))!.tags).toEqual(["Filipino", "High-Protein"]);
    expect((await s.recipes.get(BEEF_ID))!.protein_category).toBe("beef");
    for (const id of FILIPINO_IDS) expect((await s.recipes.get(id))!.tags).toEqual(["Filipino"]);

    const latest = (await s.cycles.latest())!;
    expect(latest).toMatchObject({ id: PLAN.id, start_date: "2026-11-22", status: "locked", weeks: 1, dishes_per_week: 2 });
    expect((await s.cycles.getPlan(PLAN.id)).dishes.map((d) => [d.week, d.slot, d.recipe_id])).toEqual([[1, 0, PORK_PATA_ID], [1, 1, BEEF_ID]]);

    const entities = new Set((await outboxOf(s)).slice(before).map((o) => o.entity));
    expect([...entities].sort()).toEqual(["cycle", "cycleDish", "ingredientMeta", "priceObservation", "priceRegistry", "recipe"]);
  });
  it("runs once, never re-tags or re-locks afterwards, and resumes after a crash", async () => {
    const s = await makeHarness().open();
    await applyContentUpdate(s, ok);
    await s.recipes.put({ ...(await s.recipes.get("pork-adobo"))!, tags: [] });
    await s.cycles.transition(PLAN.id, "draft");
    const n = (await outboxOf(s)).length;
    expect(await applyContentUpdate(s, ok)).toBe(true);
    expect((await outboxOf(s)).length).toBe(n); // nothing written again
    expect((await s.recipes.get("pork-adobo"))!.tags).toEqual([]);
    expect((await s.cycles.get(PLAN.id))!.status).toBe("draft");

    // Crash halfway: the cycle exists as an empty draft and the flag was never written.
    const t = await makeHarness().open();
    await applyContentUpdate(t, ok);
    await t.db.syncMeta.delete("content:2026-11-22");
    await t.cycles.transition(PLAN.id, "draft");
    await expect(applyContentUpdate(t, ok)).resolves.toBe(true);
    expect((await t.cycles.get(PLAN.id))!.status).toBe("locked");
  });
  it("waits for a successful sync and skips the plan when a newer plan exists", async () => {
    const s = await makeHarness().open();
    expect(await applyContentUpdate(s, null)).toBe(false);
    expect(await applyContentUpdate(s, { syncOnce: async () => ({ ok: false }) })).toBe(false);
    expect(await s.recipes.get(PORK_PATA_ID)).toBeUndefined();

    await s.cycles.create({ start_date: "2026-11-29", seed: 1 });
    expect(await applyContentUpdate(s, ok)).toBe(true);
    expect(await s.cycles.get(PLAN.id)).toBeUndefined();
    expect(await s.recipes.get(PORK_PATA_ID)).toBeDefined();
  });
});
