import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { PriceObservation } from "../schemas/app";
import { makeItem, makeRecipe, makeRegistry, pkg } from "../testing/factories";
import { calibrateFromReceipt, calibrateLine, emaUpdate, groceryEstimate, linePrice, recipeCost, replayObservations, toPricingUnits } from "./pricing";

const obs = (id: string, ingredient_id: string, price: number, observed_at: string, kind: PriceObservation["kind"] = "observed"): PriceObservation => ({
  id, ingredient_id, kind, price, observed_at, cycle_id: null, device_id: "d",
});
let n = 0;
const cctx = { at: "2026-10-05T00:00:00.000Z", newId: () => `id${++n}`, deviceId: "d", cycleId: "c1" };

describe("emaUpdate", () => {
  it("EMA(100 → obs 120) = 108 with α = 0.4", () => expect(emaUpdate(100, 120)).toBe(108));
  it("cold start: observed takes over when previous is missing or 0", () => {
    expect(emaUpdate(undefined, 120)).toBe(120);
    expect(emaUpdate(0, 120)).toBe(120);
  });
  it("custom alpha", () => expect(emaUpdate(100, 200, 0.5)).toBe(150));
  it("result lies between previous and observed", () => {
    fc.assert(fc.property(fc.double({ min: 1, max: 1000, noNaN: true }), fc.double({ min: 1, max: 1000, noNaN: true }), (prev, o) => {
      const e = emaUpdate(prev, o);
      expect(e).toBeGreaterThanOrEqual(Math.min(prev, o) - 1e-3);
      expect(e).toBeLessThanOrEqual(Math.max(prev, o) + 1e-3);
    }));
  });
});

describe("replayObservations", () => {
  const base = makeRegistry([["pork", "kg", 0], ["onion", "kg", 100]]);
  const list = [
    obs("a", "pork", 300, "2026-10-01T00:00:00Z", "seed"),
    obs("b", "pork", 350, "2026-10-02T00:00:00Z"),
    obs("c", "pork", 320, "2026-10-03T00:00:00Z", "receipt_allocated"),
    obs("d", "onion", 120, "2026-10-01T00:00:00Z"),
  ];
  it("folds seed → EMA in time order", () => {
    const r = replayObservations(base, list);
    expect(r.pork!.price_per_unit).toBe(0.4 * 320 + 0.6 * (0.4 * 350 + 0.6 * 300));
    expect(r.pork!.last_updated).toBe("2026-10-03T00:00:00Z");
    expect(r.onion!.price_per_unit).toBe(108);
  });
  it("a seed always applies first, even when a skewed clock stamps it after real observations", () => {
    const r = replayObservations(base, [obs("late-seed", "onion", 100, "2026-10-20T00:00:00Z", "seed"), obs("early-obs", "onion", 120, "2026-10-05T00:00:00Z")]);
    expect(r.onion!.price_per_unit).toBe(108); // seed 100, then observation 120 → EMA 108 (not reset by the seed)
  });
  it("cold start from a PHP 0 record: the first observation becomes the price", () => {
    expect(replayObservations(base, [obs("x", "pork", 280, "2026-10-01T00:00:00Z")]).pork!.price_per_unit).toBe(280);
  });
  it("override replaces the price outright", () => {
    expect(replayObservations(base, [obs("x", "onion", 90, "2026-10-01T00:00:00Z", "override")]).onion!.price_per_unit).toBe(90);
  });
  it("ignores duplicate ids and unknown ingredients; does not mutate the base", () => {
    const r = replayObservations(base, [...list, list[1]!, obs("z", "ghost", 5, "2026-10-01T00:00:00Z")]);
    expect(r).toEqual(replayObservations(base, list));
    expect(r.ghost).toBeUndefined();
    expect(base.onion!.price_per_unit).toBe(100);
  });
  it("property: commutative — any arrival order yields the same registry", () => {
    const arb = fc.array(
      fc.record({ id: fc.uuid(), ing: fc.constantFrom("pork", "onion"), price: fc.integer({ min: 1, max: 900 }), day: fc.integer({ min: 1, max: 28 }), kind: fc.constantFrom("observed", "receipt_allocated", "override", "seed") }),
      { maxLength: 25 },
    );
    fc.assert(fc.property(arb, fc.nat(1000), (rows, rot) => {
      const all = rows.map((r) => obs(r.id, r.ing, r.price, `2026-10-${String(r.day).padStart(2, "0")}T00:00:00Z`, r.kind));
      const shuffled = [...all.slice(rot % (all.length || 1)), ...all.slice(0, rot % (all.length || 1))].reverse();
      expect(replayObservations(base, shuffled)).toEqual(replayObservations(base, all));
    }));
  });
});

describe("toPricingUnits", () => {
  const u = (unit: Parameters<typeof toPricingUnits>[1], p: Parameters<typeof makeRegistry>[0][number][1], pk?: ReturnType<typeof pkg>) =>
    toPricingUnits(500, unit, pk, { pricing_unit: p });
  it("kg / piece / head", () => {
    expect(u("g", "kg")).toEqual({ amount: 0.5 });
    expect(u("ml", "kg")).toEqual({ unresolved: "UNIT_MISMATCH" });
    expect(u("pc", "piece")).toEqual({ amount: 500 });
    expect(u("g", "piece")).toEqual({ unresolved: "UNIT_MISMATCH" });
    expect(u("head", "head")).toEqual({ amount: 500 });
    expect(u("g", "head")).toEqual({ unresolved: "UNIT_MISMATCH" });
  });
  it("containers: via pack size, or unit equal to the pricing unit", () => {
    expect(u("g", "pouch", pkg("250 g pouch", 250))).toEqual({ amount: 2 });
    expect(u("can", "can")).toEqual({ amount: 500 });
    expect(u("g", "bottle")).toEqual({ unresolved: "UNIT_MISMATCH" });
  });
});

describe("recipeCost", () => {
  const reg = makeRegistry([["pork", "kg", 300], ["sauce", "pouch", 22], ["potato", "kg", 90]]);
  const recipe = makeRecipe({
    id: "k", estimated_base_cost_php: 500,
    prep_items: [
      makeItem({ ingredient_id: "pork", quantity_per_portion: 100 }),
      makeItem({ ingredient_id: "sauce", quantity_per_portion: 25, packaging: pkg("250 g pouch", 250) }),
      makeItem({ ingredient_id: "potato", unit: "kg", quantity_per_portion: 0.05 }),
    ],
  });
  it("warm: Σ quantity × registry price", () => {
    const c = recipeCost(recipe, 10, reg);
    expect(c).toMatchObject({ source: "registry", coverage: 1, unpriced: [] });
    expect(c.total).toBe(300 + 22 + 45); // 1 kg pork + 1 pouch + 0.5 kg potato
    expect(c.perPortion).toBe(36.7);
  });
  it("cold: falls back to estimated_base_cost_php scaled from 10 portions", () => {
    const c = recipeCost(recipe, 5, makeRegistry([["pork", "kg", 300]]));
    expect(c).toMatchObject({ source: "fallback", total: 250, perPortion: 50, unpriced: ["potato", "sauce"] });
    expect(c.coverage).toBeCloseTo(0.3333, 3);
  });
  it("PHP 0 prices and unit mismatches count as unpriced", () => {
    expect(recipeCost(recipe, 10, makeRegistry([["pork", "kg", 0], ["sauce", "pouch", 22], ["potato", "kg", 90]])).unpriced).toEqual(["pork"]);
    expect(recipeCost(makeRecipe({ id: "u", prep_items: [makeItem({ ingredient_id: "pork", unit: "handful" })] }), 10, reg).source).toBe("fallback");
  });
  it("empty recipes have zero coverage", () => {
    expect(recipeCost(makeRecipe({ id: "e", estimated_base_cost_php: 40 }), 10, reg)).toMatchObject({ source: "registry", coverage: 0, total: 0 });
  });
});

describe("grocery estimate & calibration", () => {
  const reg = makeRegistry([["pork", "kg", 300], ["sauce", "pouch", 22], ["free", "kg", 0]]);
  const lines = [
    { ingredient_id: "pork", unit: "g" as const, purchaseQuantity: 1000 },
    { ingredient_id: "sauce", unit: "g" as const, purchaseQuantity: 500, packaging: pkg("250 g pouch", 250) },
    { ingredient_id: "free", unit: "g" as const, purchaseQuantity: 100 },
    { ingredient_id: "ghost", unit: "g" as const, purchaseQuantity: 100 },
    { ingredient_id: "pork", unit: null, purchaseQuantity: 5 },
    { ingredient_id: "pork", unit: "g" as const, purchaseQuantity: 0 },
  ];
  it("linePrice returns null for unpriced lines", () => {
    expect(linePrice(lines[0]!, reg)).toBe(300);
    expect(linePrice(lines[1]!, reg)).toBe(44);
    for (const i of [2, 3, 4]) expect(linePrice(lines[i]!, reg)).toBeNull();
  });
  it("sums priced lines and reports the rest as unresolved (zero-quantity lines ignored)", () => {
    expect(groceryEstimate(lines, reg)).toEqual({ total: 344, unresolved: ["free", "ghost", "pork"] });
  });
  it("receipt allocation scales every priced ingredient by receipt / estimate", () => {
    const out = calibrateFromReceipt(lines.slice(0, 3), 430, reg, cctx); // estimate 344 → ratio 1.25
    expect(out.map((o) => [o.ingredient_id, o.price, o.kind, o.cycle_id])).toEqual([["pork", 375, "receipt_allocated", "c1"], ["sauce", 27.5, "receipt_allocated", "c1"]]);
  });
  it("receipt allocation emits one observation per ingredient and nothing when unusable", () => {
    expect(calibrateFromReceipt([lines[0]!, lines[0]!], 600, reg, cctx)).toHaveLength(1);
    expect(calibrateFromReceipt([lines[2]!], 100, reg, cctx)).toEqual([]);
    expect(calibrateFromReceipt([lines[0]!], 0, reg, cctx)).toEqual([]);
  });
  it("per-line calibration: P_obs = paid / purchased pricing units", () => {
    expect(calibrateLine(lines[0]!, 360, reg, cctx)).toMatchObject({ ingredient_id: "pork", price: 360, kind: "observed" });
    expect(calibrateLine(lines[1]!, 50, reg, cctx)?.price).toBe(25);
    expect(calibrateLine(lines[3]!, 50, reg, cctx)).toBeNull();
    expect(calibrateLine(lines[4]!, 50, reg, cctx)).toBeNull();
    expect(calibrateLine(lines[5]!, 50, reg, cctx)).toBeNull();
    expect(calibrateLine({ ingredient_id: "pork", unit: "ml", purchaseQuantity: 5 }, 50, reg, cctx)).toBeNull();
    expect(calibrateLine(lines[0]!, -1, reg, cctx)).toBeNull();
  });
  it("calibration observations feed straight into replay (EMA)", () => {
    const o = calibrateLine(lines[0]!, 360, reg, cctx)!;
    expect(replayObservations(reg, [o]).pork!.price_per_unit).toBe(0.4 * 360 + 0.6 * 300);
  });
});
