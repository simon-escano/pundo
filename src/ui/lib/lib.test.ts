import { describe, expect, it } from "vitest";
import type { GroceryLine } from "../../domain/engines/grocery";
import { makeHarness } from "../../storage/testing/harness";
import { applyCalibration, ensureCycle, lockWeek, randomSeed, rerollOne, rollPlan, todayIso } from "./actions";
import { planCalibration } from "./calibration";
import { derive } from "./derive";
import { describeBuy, describeNeed, formatMoney, formatQuantity } from "./format";
import { loadWorld } from "./world";

const line = (over: Partial<GroceryLine>): GroceryLine => ({
  key: "k", ingredient_id: "pork_belly", display_name: "Pork belly", aisle: "fresh_meat", storageClass: "fresh_meat", bucket: "cycle", unit: "g", unitLabel: "g",
  grossQuantity: 1000, deductedQuantity: 0, netQuantity: 1000, packaging: undefined, packs: null, purchaseQuantity: 1000, surplus: 0, surplusRatio: 0, highSurplus: false,
  deductStock: true, reason: "OK", estimatedCost: 380, butcherNotes: [], sources: [], bought: false, paidPhp: null, warnings: [], ...over,
});

describe("format", () => {
  it("formatMoney groups thousands and keeps cents only for small amounts", () => {
    expect([formatMoney(0), formatMoney(4), formatMoney(4.5), formatMoney(99.99), formatMoney(1234.56), formatMoney(1234567)]).toEqual(["₱0", "₱4", "₱4.50", "₱99.99", "₱1,235", "₱1,234,567"]);
  });
  it("formatQuantity switches to kg / L at 1000", () => {
    expect([formatQuantity(1200, "g"), formatQuantity(250, "ml"), formatQuantity(2500, "ml"), formatQuantity(4, "pc"), formatQuantity(0.5, "head")]).toEqual(["1.2 kg", "250 ml", "2.5 L", "4 pc", "0.5 head"]);
  });
  it("describeBuy / describeNeed", () => {
    const pouch = { retail_unit: "250 g pouch", pack_size: 250, snap_to_whole_pack: true };
    expect(describeBuy(line({ packaging: pouch, packs: 2, purchaseQuantity: 500 }))).toBe("2 × 250 g pouch");
    expect(describeBuy(line({ packaging: { ...pouch, snap_to_whole_pack: false }, packs: 1.2 }))).toBe("1 kg");
    expect(describeBuy(line({ purchaseQuantity: 0, netQuantity: 0 }))).toBe("Covered by stock");
    expect(describeNeed(line({}))).toBe("Need 1 kg");
    expect(describeNeed(line({ deductedQuantity: 200 }))).toBe("Need 1 kg − 200 g stock");
  });
});

describe("calibration plan", () => {
  const registry = { pork_belly: { ingredient_id: "pork_belly", display_name: "Pork belly", price_per_unit: 380, pricing_unit: "kg" as const, last_updated: "t" } };
  let n = 0;
  const ctx = { at: "2026-10-05T00:00:00.000Z", newId: () => `o${++n}`, deviceId: "d", cycleId: "c" };
  it("per-line paid prices win over a receipt total", () => {
    const p = planCalibration([line({})], registry, { receiptTotal: 999, paid: { k: 400 } }, ctx);
    expect(p.mode).toBe("per_line");
    expect(p.observations.map((o) => [o.kind, o.price])).toEqual([["observed", 400]]);
    expect(p.paidUpdates).toEqual([{ key: "k", paid: 400 }]);
  });
  it("a receipt total is spread by ratio across priced lines", () => {
    const p = planCalibration([line({})], registry, { receiptTotal: 760, paid: {} }, ctx);
    expect(p.mode).toBe("receipt");
    expect(p.observations.map((o) => [o.kind, o.price])).toEqual([["receipt_allocated", 760]]); // estimate 380 → ratio 2
  });
  it("ignores unknown keys / invalid inputs and reports 'none' when empty", () => {
    expect(planCalibration([line({})], registry, { receiptTotal: null, paid: {} }, ctx).mode).toBe("none");
    expect(planCalibration([line({})], registry, { receiptTotal: 0, paid: {} }, ctx).mode).toBe("none");
    expect(planCalibration([line({})], registry, { receiptTotal: null, paid: { ghost: 5, k: Number.NaN } }, ctx).observations).toEqual([]);
  });
});

describe("actions + derive over real storage", () => {
  async function fresh() {
    const s = await makeHarness().open();
    const cycle = await s.cycles.create({ start_date: "2026-10-04", seed: 20261004 });
    return { s, cycle };
  }
  it("first roll uses the cycle seed; later rolls derive and persist a new one", async () => {
    const { s, cycle } = await fresh();
    const a = await rollPlan(s, cycle, false);
    expect(a.ok && a.seed).toBe(20261004);
    const again = await rollPlan(s, (await s.cycles.latest())!, true);
    expect(again.ok && again.seed).not.toBe(20261004);
    expect((await s.cycles.latest())!.seed).toBe(again.ok ? again.seed : -1);
  });
  it("is deterministic: same cycle seed → same plan", async () => {
    const [a, b] = await Promise.all([fresh(), fresh()]);
    await rollPlan(a.s, a.cycle, false);
    await rollPlan(b.s, b.cycle, false);
    const ids = async (s: typeof a.s, id: string) => (await s.cycles.getPlan(id)).dishes.map((d) => d.recipe_id);
    expect(await ids(a.s, a.cycle.id)).toEqual(await ids(b.s, b.cycle.id));
  });
  it("locked weeks survive a full re-roll; single re-roll changes only its slot", async () => {
    const { s, cycle } = await fresh();
    await rollPlan(s, cycle, false);
    const before = (await s.cycles.getPlan(cycle.id)).dishes.map((d) => d.recipe_id);
    await lockWeek(s, cycle.id, 1, true);
    await rollPlan(s, (await s.cycles.latest())!, true);
    const after = (await s.cycles.getPlan(cycle.id)).dishes.map((d) => d.recipe_id);
    expect(after.slice(0, 3)).toEqual(before.slice(0, 3));
    const r = await rerollOne(s, (await s.cycles.latest())!, { week: 2, slot: 1 });
    expect(r.ok).toBe(true);
    const last = (await s.cycles.getPlan(cycle.id)).dishes.map((d) => d.recipe_id);
    expect(last.filter((x, i) => x !== after[i])).toHaveLength(1);
    expect(last[4]).not.toBe(after[4]);
  });
  it("re-roll before any roll explains itself instead of throwing", async () => {
    const { s, cycle } = await fresh();
    expect(await rerollOne(s, cycle, { week: 1, slot: 0 })).toMatchObject({ ok: false, error: { detail: expect.stringContaining("Roll the cycle") } });
  });
  it("surfaces infeasible rolls with an actionable message", async () => {
    const { s, cycle } = await fresh();
    for (const r of await s.recipes.list()) if (r.perishability_tier === "TIER_2_HARDY") await s.recipes.remove(r.id);
    const res = await rollPlan(s, cycle, false);
    expect(res).toMatchObject({ ok: false, error: { code: "INSUFFICIENT_HARDY_POOL" } });
  });
  it("derive: six slots, cost per dish, grocery list only when the plan is complete", async () => {
    const { s, cycle } = await fresh();
    let d = derive(await loadWorld(s));
    expect(d).toMatchObject({ complete: false, grocery: null });
    expect(d.slots).toHaveLength(6);
    await rollPlan(s, cycle, false);
    d = derive(await loadWorld(s));
    expect(d.complete).toBe(true);
    expect(d.scaled).toHaveLength(6);
    expect(d.slots.every((x) => x.cost?.source === "registry" && x.portions === 10)).toBe(true);
    expect(d.grocery!.containers).toBe(12);
    expect(d.activeRecipes).toHaveLength(15);
  });
  it("derive tolerates a plan dish whose recipe was later soft-deleted", async () => {
    const { s, cycle } = await fresh();
    await rollPlan(s, cycle, false);
    const first = (await s.cycles.getPlan(cycle.id)).dishes[0]!.recipe_id;
    await s.recipes.remove(first);
    const d = derive(await loadWorld(s));
    expect(d.complete).toBe(true);
    expect(d.activeRecipes.map((r) => r.id)).not.toContain(first);
  });
  it("applyCalibration marks everything bought and moves prices toward the receipt (EMA)", async () => {
    const { s, cycle } = await fresh();
    await rollPlan(s, cycle, false);
    const w = await loadWorld(s);
    const g = derive(w).grocery!;
    const plan = await applyCalibration(s, cycle.id, g.lines, w.registry, { receiptTotal: g.estimate.total * 2, paid: {} });
    expect(plan.mode).toBe("receipt");
    const after = derive(await loadWorld(s)).grocery!;
    expect(after.lines.every((l) => l.bought)).toBe(true);
    expect(after.estimate.total).toBeGreaterThan(g.estimate.total);
    expect(after.estimate.total).toBeLessThan(g.estimate.total * 2); // smoothed, not jumped
  });
  it("ensureCycle creates one dated today with a random uint32 seed, once", async () => {
    const s = await makeHarness().open();
    await ensureCycle(s);
    await ensureCycle(s);
    const all = await s.cycles.list();
    expect(all).toHaveLength(1);
    expect(all[0]!.start_date).toBe(todayIso());
    expect(todayIso(new Date(2026, 0, 5))).toBe("2026-01-05");
    expect(Number.isInteger(randomSeed())).toBe(true);
  });
});
