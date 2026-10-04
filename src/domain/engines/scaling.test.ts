import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { makeItem, makeRecipe, pkg } from "../testing/factories";
import { allocatePortions, totalDispatch } from "./allocation";
import { scalePrepItem, scaleRecipe } from "./scaling";

const ctx = { recipeId: "r", recipeName: "R", week: 1 as const, stovePriority: "PRIORITY_1_SLOW_BRAISE" as const };

describe("allocatePortions", () => {
  it("10 portions → 8 home in two 4-cavity trays + 2 dispatch", () => {
    expect(allocatePortions(10)).toEqual({ home: 8, dispatch: 2, trays: 2, emptyCavities: 0 });
  });
  it("fewer than 8 leaves empty cavities; more overflows to dispatch", () => {
    expect(allocatePortions(5)).toEqual({ home: 5, dispatch: 0, trays: 2, emptyCavities: 3 });
    expect(allocatePortions(3)).toEqual({ home: 3, dispatch: 0, trays: 1, emptyCavities: 1 });
    expect(allocatePortions(14)).toEqual({ home: 8, dispatch: 6, trays: 2, emptyCavities: 0 });
  });
  it("rejects non-positive or fractional portions", () => {
    for (const n of [0, -1, 2.5, Number.NaN]) expect(() => allocatePortions(n)).toThrow(RangeError);
  });
  it("home + dispatch always equals n", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 30 }), (n) => {
      const a = allocatePortions(n);
      expect(a.home + a.dispatch).toBe(n);
      expect(a.home).toBeLessThanOrEqual(8);
    }));
  });
  it("totalDispatch sums containers across dishes (6 dishes × 2 = 12)", () => {
    expect(totalDispatch([10, 10, 10, 10, 10, 10])).toBe(12);
    expect(totalDispatch([8, 12])).toBe(4);
  });
});

describe("scalePrepItem", () => {
  it("discrete: exact integer cuts = pieces_per_portion × portions", () => {
    const s = scalePrepItem(makeItem({ ingredient_id: "pork", granularity: "discrete", pieces_per_portion: 3, quantity_per_portion: 90 }), 10, ctx);
    expect(s.totalPieces).toBe(30);
    expect(s.grossQuantity).toBe(900);
    expect(s.perVessel).toBe(90);
    expect(s.warnings).toEqual([]);
  });
  it("discrete: invalid piece counts warn and produce no piece total", () => {
    for (const ppp of [null, 7, 2.5]) {
      const s = scalePrepItem(makeItem({ ingredient_id: "x", granularity: "discrete", pieces_per_portion: ppp }), 10, ctx);
      expect(s.totalPieces).toBeNull();
      expect(s.warnings.map((w) => w.code)).toContain("DISCRETE_PIECES_INVALID");
    }
  });
  it("discrete totals scale linearly with portions", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 6 }), fc.integer({ min: 1, max: 30 }), (n, p) => {
      const s = scalePrepItem(makeItem({ ingredient_id: "x", granularity: "discrete", pieces_per_portion: n }), p, ctx);
      expect(s.totalPieces).toBe(n * p);
      expect(Number.isInteger(s.totalPieces)).toBe(true);
    }));
  });
  it("granular rounds UP to the unit step so the shopper is never short", () => {
    expect(scalePrepItem(makeItem({ ingredient_id: "c", quantity_per_portion: 3 }), 7, ctx).grossQuantity).toBe(25); // 21 g → 25
    expect(scalePrepItem(makeItem({ ingredient_id: "c", quantity_per_portion: 30 }), 10, ctx).grossQuantity).toBe(300);
    expect(scalePrepItem(makeItem({ ingredient_id: "h", unit: "head", quantity_per_portion: 0.1 }), 7, ctx).grossQuantity).toBe(1);
  });
  it("continuous is net mass/volume, gross never below the ratio", () => {
    fc.assert(fc.property(fc.double({ min: 0.1, max: 200, noNaN: true }), fc.integer({ min: 1, max: 30 }), (q, p) => {
      const s = scalePrepItem(makeItem({ ingredient_id: "s", granularity: "continuous", quantity_per_portion: q }), p, ctx);
      expect(s.grossQuantity).toBeGreaterThanOrEqual(q * p - 1e-6);
      expect(s.grossQuantity - q * p).toBeLessThan(5 + 1e-6);
    }));
  });
  it("converts kg and scales packaging into the canonical unit", () => {
    const s = scalePrepItem(makeItem({ ingredient_id: "m", unit: "kg", quantity_per_portion: 0.1, packaging: pkg("1 kg bag", 1) }), 10, ctx);
    expect(s.unit).toBe("g");
    expect(s.grossQuantity).toBe(1000);
    expect(s.packaging?.pack_size).toBe(1000);
  });
  it("unknown units are flagged, not guessed, and kept under their raw label", () => {
    const s = scalePrepItem(makeItem({ ingredient_id: "x", unit: "Handful", quantity_per_portion: 0.3 }), 10, ctx);
    expect(s.unit).toBeNull();
    expect(s.unitLabel).toBe("handful");
    expect(s.grossQuantity).toBe(3);
    expect(s.warnings[0]?.code).toBe("UNKNOWN_UNIT");
  });
});

describe("scaleRecipe", () => {
  it("scales every item and attaches the allocation", () => {
    const r = makeRecipe({ id: "a", prep_items: [makeItem({ ingredient_id: "x" }), makeItem({ ingredient_id: "y" })] });
    const d = scaleRecipe(r, 10, 2);
    expect(d.items).toHaveLength(2);
    expect(d.week).toBe(2);
    expect(d.allocation).toEqual({ home: 8, dispatch: 2, trays: 2, emptyCavities: 0 });
    expect(d.items[0]).toMatchObject({ recipeId: "a", week: 2, portions: 10 });
  });
});
