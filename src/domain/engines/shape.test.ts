import { describe, expect, it } from "vitest";
import { makeRecipe } from "../testing/factories";
import { cycleRanges, formatCycleRange } from "./dates";
import { rerollSlot, rollCycle } from "./roller";
import { fillOrder, hasSlot, LEGACY_SHAPE, NEW_PLAN_SHAPE, shapeOf, slotCount, slotKeysOf } from "./shape";

const ONE_WEEK = NEW_PLAN_SHAPE;

describe("plan shape", () => {
  it("cycles without shape fields are the legacy 2 weeks x 3 dishes", () => {
    expect(shapeOf({})).toEqual(LEGACY_SHAPE);
    expect(shapeOf({ weeks: 1, dishes_per_week: 2 })).toEqual(ONE_WEEK);
  });
  it("legacy fill order is unchanged (week 2 first), so existing seeds roll the same plans", () => {
    expect(fillOrder(LEGACY_SHAPE).map((s) => `${s.week}-${s.slot}`)).toEqual(["2-0", "2-1", "2-2", "1-0", "1-1", "1-2"]);
    expect(slotKeysOf(LEGACY_SHAPE)).toEqual(["1-0", "1-1", "1-2", "2-0", "2-1", "2-2"]);
  });
  it("1 week x 2 dishes has exactly slots 1-0 and 1-1", () => {
    expect(slotKeysOf(ONE_WEEK)).toEqual(["1-0", "1-1"]);
    expect(slotCount(ONE_WEEK)).toBe(2);
    expect(hasSlot(ONE_WEEK, 1, 1)).toBe(true);
    expect(hasSlot(ONE_WEEK, 1, 2)).toBe(false);
    expect(hasSlot(ONE_WEEK, 2, 0)).toBe(false);
  });
  it("date ranges follow the plan length", () => {
    expect(cycleRanges("2026-11-22", 1)).toMatchObject({ end: "2026-11-28", weeks: [{ start: "2026-11-22", end: "2026-11-28" }] });
    expect(formatCycleRange("2026-11-22", 1)).toBe("Nov 22 – Nov 28");
    expect(cycleRanges("2026-10-04").end).toBe("2026-10-17"); // default stays 2 weeks
    expect(formatCycleRange("2026-10-04")).toBe("Oct 4 – Oct 17");
  });
});

describe("roller with a 1-week, 2-dish shape", () => {
  // No hardy dish at all: a 1-week plan has no Week 2, so tiers do not matter.
  const pool = [
    makeRecipe({ id: "a", protein_category: "pork", perishability_tier: "TIER_1_FRESH" }),
    makeRecipe({ id: "b", protein_category: "beef", perishability_tier: "TIER_1_FRESH" }),
    makeRecipe({ id: "c", protein_category: "chicken", perishability_tier: "TIER_1_FRESH", sauce_base: "tomato" }),
    makeRecipe({ id: "d", protein_category: "fish", perishability_tier: "TIER_1_FRESH", sauce_base: "tomato" }),
  ];
  const base = { pool, locks: {}, previousCycleRecipeIds: new Set<string>(), shape: ONE_WEEK };

  it("fills two distinct dishes, Week 2 empty, caps respected, deterministic", () => {
    for (let seed = 0; seed < 200; seed++) {
      const r = rollCycle({ ...base, seed });
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.week2).toEqual([]);
      expect(r.week1).toHaveLength(2);
      expect(new Set(r.week1.map((x) => x.id)).size).toBe(2);
      expect(r.week1.filter((x) => x.sauce_base === "tomato").length).toBeLessThanOrEqual(1);
      expect(rollCycle({ ...base, seed })).toEqual(r);
    }
  });
  it("honours locks and rejects slots outside the shape", () => {
    const r = rollCycle({ ...base, seed: 1, locks: { "1-1": "b" } });
    expect(r.ok && r.week1[1]!.id).toBe("b");
    expect(rollCycle({ ...base, seed: 1, locks: { "2-0": "a" } })).toMatchObject({ ok: false, error: { code: "LOCK_CONFLICT" } });
    expect(rollCycle({ ...base, seed: 1, locks: { "1-2": "a" } })).toMatchObject({ ok: false, error: { code: "LOCK_CONFLICT" } });
  });
  it("re-rolls one slot and keeps the other", () => {
    const r = rerollSlot({ ...base, seed: 7, current: { "1-0": "a", "1-1": "b" } }, { week: 1, slot: 0 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.week1[1]!.id).toBe("b");
      expect(r.week1[0]!.id).not.toBe("a");
    }
  });
  it("explains a pool that is too small in plan days", () => {
    const r = rollCycle({ ...base, pool: pool.slice(0, 1), seed: 1 });
    expect(r).toMatchObject({ ok: false, error: { code: "UNSATISFIABLE", detail: expect.stringContaining("7 days") } });
  });
  it("two tomato dishes alone cannot fill a week", () => {
    const r = rollCycle({ ...base, pool: pool.slice(2), seed: 1 });
    expect(r).toMatchObject({ ok: false, error: { code: "UNSATISFIABLE", detail: expect.stringContaining("can fill only 1 of 2") } });
  });
});
