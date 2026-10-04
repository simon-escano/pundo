import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { makePantry, pkg } from "../testing/factories";
import { choosePackaging, HIGH_SURPLUS_RATIO, isHighSurplus, snapToPacks } from "./packaging";
import { netRequirement, projectedSurplus } from "./leftover";

describe("snapToPacks", () => {
  it("180 g of sauce → 1 × 250 g pouch", () => {
    expect(snapToPacks(180, pkg("250 g pouch", 250))).toEqual({ packs: 1, purchaseQuantity: 250, surplus: 70, surplusRatio: 0.28 });
  });
  it("snaps up across pack boundaries", () => {
    expect(snapToPacks(250, pkg("p", 250)).packs).toBe(1);
    expect(snapToPacks(250.1, pkg("p", 250)).packs).toBe(2);
    expect(snapToPacks(260, pkg("p", 250))).toMatchObject({ packs: 2, purchaseQuantity: 500, surplus: 240 });
  });
  it("is epsilon-safe: 0.1×3 against a 0.1 pack is 3 packs, not 4", () => {
    expect(snapToPacks(0.1 * 3, pkg("p", 0.1)).packs).toBe(3);
  });
  it("non-snapping packaging buys exactly the need (fractional packs)", () => {
    expect(snapToPacks(300, pkg("per kg", 1000, false))).toEqual({ packs: 0.3, purchaseQuantity: 300, surplus: 0, surplusRatio: 0 });
  });
  it("loose items and zero needs", () => {
    expect(snapToPacks(6)).toEqual({ packs: null, purchaseQuantity: 6, surplus: 0, surplusRatio: 0 });
    expect(snapToPacks(0)).toEqual({ packs: null, purchaseQuantity: 0, surplus: 0, surplusRatio: 0 });
    expect(snapToPacks(0, pkg("p", 250))).toEqual({ packs: 0, purchaseQuantity: 0, surplus: 0, surplusRatio: 0 });
  });
  it("flags high surplus above the threshold", () => {
    expect(HIGH_SURPLUS_RATIO).toBe(0.4);
    expect(isHighSurplus(snapToPacks(260, pkg("p", 250)))).toBe(true);
    expect(isHighSurplus(snapToPacks(180, pkg("p", 250)))).toBe(false);
  });
  it("property: packs × size ≥ need, packs minimal, surplus ≥ 0", () => {
    fc.assert(fc.property(fc.double({ min: 0.5, max: 5000, noNaN: true }), fc.integer({ min: 1, max: 1000 }), (net, size) => {
      const s = snapToPacks(net, pkg("p", size));
      expect(s.purchaseQuantity).toBeGreaterThanOrEqual(net - 1e-6);
      expect(s.purchaseQuantity - size).toBeLessThan(net + 1e-6); // one fewer pack would not cover
      expect(s.surplus).toBeGreaterThanOrEqual(-1e-6);
    }));
  });
});

describe("choosePackaging", () => {
  it("picks the smallest surplus, then fewest packs, then retail_unit, then size", () => {
    expect(choosePackaging(180, [pkg("1 kg", 1000), pkg("250 g", 250), pkg("85 g", 85)])?.retail_unit).toBe("250 g"); // surplus 70 vs 75 vs 820
    expect(choosePackaging(165, [pkg("1 kg", 1000), pkg("250 g", 250), pkg("85 g", 85)])?.retail_unit).toBe("85 g"); // 2×85 = 170, surplus 5
    expect(choosePackaging(170, [pkg("85 g", 85), pkg("170 g", 170)])?.retail_unit).toBe("170 g"); // equal surplus, fewer packs
    expect(choosePackaging(170, [pkg("b", 85), pkg("a", 85)])?.retail_unit).toBe("a");
    expect(choosePackaging(100, [pkg("x", 200), pkg("x", 100)])?.pack_size).toBe(100);
    expect(choosePackaging(100, [])).toBeUndefined();
  });
  it("is independent of candidate order", () => {
    const c = [pkg("a", 250), pkg("b", 100), pkg("c", 1000)];
    expect(choosePackaging(180, [...c].reverse())).toEqual(choosePackaging(180, c));
  });
});

describe("netRequirement", () => {
  const ctx = { ingredientId: "potato", cycleId: "c1", deductStock: true, storageClass: "loose_produce" } as const;
  it("loose produce: need 6 − 2 in stock = buy 4", () => {
    const r = netRequirement(6, "pc", [makePantry({ ingredient_id: "potato", quantity: 2, unit: "pc" })], ctx);
    expect(r).toEqual({ deducted: 2, net: 4, reason: "OK" });
  });
  it("never goes negative when stock exceeds need", () => {
    expect(netRequirement(6, "pc", [makePantry({ ingredient_id: "potato", quantity: 10, unit: "pc" })], ctx)).toEqual({ deducted: 6, net: 0, reason: "OK" });
  });
  it("[Spoiled / Tossed] restores the gross quantity", () => {
    const r = netRequirement(6, "pc", [makePantry({ ingredient_id: "potato", quantity: 2, unit: "pc" })], { ...ctx, deductStock: false });
    expect(r).toEqual({ deducted: 0, net: 6, reason: "TOSSED" });
  });
  it("converts stock units (kg stock vs g need) and sums entries; ignores other ingredients", () => {
    const stock = [makePantry({ ingredient_id: "potato", quantity: 0.5, unit: "kg" }), makePantry({ ingredient_id: "potato", state: "sealed", quantity: 100, unit: "g" }), makePantry({ ingredient_id: "carrot", quantity: 999, unit: "g" })];
    expect(netRequirement(1000, "g", stock, ctx)).toEqual({ deducted: 600, net: 400, reason: "OK" });
  });
  it("opened perishables expire across cycle boundaries but count within the same cycle", () => {
    const opened = (cycle: string) => makePantry({ ingredient_id: "sauce", state: "opened", quantity: 100, unit: "g", opened_cycle_id: cycle });
    const c = { ...ctx, ingredientId: "sauce", storageClass: "perishable_once_opened" } as const;
    expect(netRequirement(180, "g", [opened("old")], c)).toEqual({ deducted: 0, net: 180, reason: "OPENED_EXPIRED" });
    expect(netRequirement(180, "g", [opened("c1")], c)).toEqual({ deducted: 100, net: 80, reason: "OK" });
  });
  it("unopened shelf-stable stock deducts cleanly; opened shelf-stable stock still counts", () => {
    const c = { ...ctx, ingredientId: "can", storageClass: "shelf_stable_sealed" } as const;
    expect(netRequirement(170, "g", [makePantry({ ingredient_id: "can", state: "sealed", quantity: 85, unit: "g" }), makePantry({ ingredient_id: "can", state: "opened", quantity: 40, unit: "g", opened_cycle_id: "old" })], c).net).toBe(45);
  });
  it("unit mismatches deduct nothing and say so", () => {
    expect(netRequirement(6, "pc", [makePantry({ ingredient_id: "potato", quantity: 500, unit: "g" })], ctx)).toEqual({ deducted: 0, net: 6, reason: "UNIT_MISMATCH" });
    expect(netRequirement(6, null, [makePantry({ ingredient_id: "potato" })], ctx).reason).toBe("UNIT_MISMATCH");
    expect(netRequirement(6, null, [], ctx).reason).toBe("OK");
    expect(netRequirement(6, "pc", [makePantry({ ingredient_id: "potato", quantity: 2, unit: "weird" })], ctx).reason).toBe("UNIT_MISMATCH");
  });
  it("alreadyDeducted prevents double-claiming shared stock", () => {
    const stock = [makePantry({ ingredient_id: "potato", quantity: 3, unit: "pc" })];
    expect(netRequirement(2, "pc", stock, { ...ctx, alreadyDeducted: 2 })).toEqual({ deducted: 1, net: 1, reason: "OK" });
    expect(netRequirement(2, "pc", stock, { ...ctx, alreadyDeducted: 5 }).deducted).toBe(0);
  });
  it("property: 0 ≤ net ≤ gross and deducted + net = gross", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 500 }), fc.integer({ min: 0, max: 500 }), (gross, stock) => {
      const r = netRequirement(gross, "g", [makePantry({ ingredient_id: "potato", quantity: stock, unit: "g" })], ctx);
      expect(r.net).toBeGreaterThanOrEqual(0);
      expect(r.net).toBeLessThanOrEqual(gross);
      expect(r.deducted + r.net).toBe(gross);
    }));
  });
});

describe("projectedSurplus", () => {
  const snap = snapToPacks(180, pkg("250 g pouch", 250));
  const c = { ingredientId: "sauce", unit: "g", cycleId: "c1", at: "t" } as const;
  it("opened perishables carry the current cycle; shelf-stable stays sealed; produce is loose", () => {
    expect(projectedSurplus(snap, pkg("p", 250), { ...c, storageClass: "perishable_once_opened" })).toMatchObject({ state: "opened", quantity: 70, opened_cycle_id: "c1" });
    expect(projectedSurplus(snap, pkg("p", 250), { ...c, storageClass: "shelf_stable_sealed" })).toMatchObject({ state: "sealed", opened_cycle_id: null });
    expect(projectedSurplus(snap, pkg("p", 250), { ...c, storageClass: "disposable" })?.state).toBe("sealed");
    expect(projectedSurplus(snap, pkg("p", 250), { ...c, storageClass: "loose_produce" })?.state).toBe("loose");
  });
  it("raw meat, no surplus, loose or non-snapping packaging produce nothing", () => {
    expect(projectedSurplus(snap, pkg("p", 250), { ...c, storageClass: "fresh_meat" })).toBeNull();
    expect(projectedSurplus(snapToPacks(250, pkg("p", 250)), pkg("p", 250), { ...c, storageClass: "shelf_stable_sealed" })).toBeNull();
    expect(projectedSurplus(snap, undefined, { ...c, storageClass: "shelf_stable_sealed" })).toBeNull();
    expect(projectedSurplus(snap, pkg("p", 250, false), { ...c, storageClass: "shelf_stable_sealed" })).toBeNull();
  });
});
