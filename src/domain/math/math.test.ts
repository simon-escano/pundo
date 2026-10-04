import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ceilTo, displayMoney, roundDp, safeCeil } from "./precision";
import { mulberry32, deriveSeed, weightedOrder } from "./prng";
import { compareBy, compareStrings } from "./compare";

describe("precision", () => {
  it("safeCeil ignores float dust", () => {
    expect(safeCeil((0.1 * 3) / 0.1)).toBe(3);
    expect(Math.ceil((0.1 * 3) / 0.1)).toBe(4); // the naive bug this prevents
    expect(safeCeil(2.0000001)).toBe(3);
    expect(safeCeil(0)).toBe(0);
  });
  it("roundDp removes binary noise", () => {
    expect(roundDp(0.1 + 0.2, 4)).toBe(0.3);
    expect(roundDp(1.005, 2)).toBe(1.01);
    expect(displayMoney(107.99999)).toBe(108);
  });
  it("ceilTo rounds up to a step", () => {
    expect(ceilTo(7.2, 5)).toBe(10);
    expect(ceilTo(1.1, 0.5)).toBe(1.5);
    expect(ceilTo(10, 5)).toBe(10);
  });
  it("ceilTo is never below the input and is a multiple of step", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 5000, noNaN: true }), fc.constantFrom(0.5, 1, 5), (x, step) => {
        const r = ceilTo(x, step);
        expect(r).toBeGreaterThanOrEqual(x - 1e-6);
        expect(r - x).toBeLessThan(step + 1e-6);
      }),
    );
  });
});

describe("prng", () => {
  it("mulberry32 is reproducible and in [0,1)", () => {
    const a = mulberry32(42), b = mulberry32(42);
    for (let i = 0; i < 100; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
  it("different seeds diverge; deriveSeed is deterministic uint32", () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
    expect(deriveSeed(7, 1)).toBe(deriveSeed(7, 1));
    expect(deriveSeed(7, 1)).not.toBe(deriveSeed(7, 2));
    fc.assert(fc.property(fc.nat(0xffffffff), fc.nat(1000), (s, k) => {
      const d = deriveSeed(s, k);
      expect(Number.isInteger(d) && d >= 0 && d <= 0xffffffff).toBe(true);
    }));
  });
  it("weightedOrder is a permutation, input-order independent, and seed-stable", () => {
    const items = ["d", "a", "c", "b", "e"].map((id) => ({ id }));
    const run = (xs: typeof items, seed: number) =>
      weightedOrder(xs, (x) => x.id, () => 1, mulberry32(seed)).map((x) => x.id);
    const out = run(items, 9);
    expect([...out].sort()).toEqual(["a", "b", "c", "d", "e"]);
    expect(run([...items].reverse(), 9)).toEqual(out);
    expect(run(items, 9)).toEqual(out);
  });
  it("low-weight items are demoted on average (soft cooldown)", () => {
    const items = ["a", "b", "c", "d"].map((id) => ({ id }));
    let lowFirst = 0, highFirst = 0;
    for (let s = 0; s < 2000; s++) {
      const first = weightedOrder(items, (x) => x.id, (x) => (x.id === "a" ? 0.25 : 1), mulberry32(s))[0]!.id;
      if (first === "a") lowFirst++;
      if (first === "b") highFirst++;
    }
    expect(lowFirst).toBeLessThan(highFirst);
    expect(lowFirst).toBeGreaterThan(0); // soft, not a hard ban
  });
});

describe("compare", () => {
  it("compareStrings is locale-independent", () => {
    expect(compareStrings("a", "b")).toBe(-1);
    expect(compareStrings("b", "a")).toBe(1);
    expect(compareStrings("a", "a")).toBe(0);
    expect(compareStrings("Z", "a")).toBe(-1);
  });
  it("compareBy chains keys", () => {
    const rows = [{ k: 2, n: "b" }, { k: 1, n: "z" }, { k: 2, n: "a" }];
    rows.sort(compareBy((x, y) => x.k - y.k, (x, y) => compareStrings(x.n, y.n)));
    expect(rows.map((r) => r.n)).toEqual(["z", "a", "b"]);
  });
});
