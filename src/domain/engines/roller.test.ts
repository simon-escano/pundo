import fc from "fast-check";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Recipe } from "../schemas/blueprint";
import { makeRecipe } from "../testing/factories";
import { deriveSeed, rerollSlot, rollCycle, slotKey, SLOT_KEYS, type RollInput, type RollResult } from "./roller";

const none = new Set<string>();
const fixtures: Recipe[] = readdirSync("fixtures/recipes").map((f) => JSON.parse(readFileSync(`fixtures/recipes/${f}`, "utf8")));
const base = (over: Partial<RollInput> = {}): RollInput => ({ pool: fixtures, seed: 1, locks: {}, previousCycleRecipeIds: none, ...over });
const ok = (r: RollResult) => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.detail}`);
  return r;
};
const err = (r: RollResult) => {
  if (r.ok) throw new Error("expected error");
  return r.error;
};

type Spec = [tier: "T1" | "T2", protein: Recipe["protein_category"], sauce: Recipe["sauce_base"]];
const mk = (specs: Spec[]) =>
  specs.map(([t, p, s], i) =>
    makeRecipe({ id: `r${i}`, name: `R${i}`, perishability_tier: t === "T1" ? "TIER_1_FRESH" : "TIER_2_HARDY", protein_category: p, sauce_base: s }),
  );

function checkInvariants(r: Extract<RollResult, { ok: true }>, cfg = { protein: 2, tomato: 1 }) {
  const all = [...r.week1, ...r.week2];
  expect(r.week1).toHaveLength(3);
  expect(r.week2).toHaveLength(3);
  expect(new Set(all.map((x) => x.id)).size).toBe(6); // intra-cycle exclusion
  for (const x of r.week2) expect(x.perishability_tier).toBe("TIER_2_HARDY");
  for (const wk of [r.week1, r.week2]) {
    const counts = new Map<string, number>();
    for (const x of wk) counts.set(x.protein_category, (counts.get(x.protein_category) ?? 0) + 1);
    for (const n of counts.values()) expect(n).toBeLessThanOrEqual(cfg.protein);
    expect(wk.filter((x) => x.sauce_base === "tomato").length).toBeLessThanOrEqual(cfg.tomato);
  }
}

describe("rollCycle", () => {
  it("rolls a valid cycle from the fixture pool for many seeds", () => {
    for (let seed = 0; seed < 200; seed++) checkInvariants(ok(rollCycle(base({ seed }))));
  });

  it("is deterministic and independent of pool order", () => {
    const a = ok(rollCycle(base({ seed: 42 })));
    const b = ok(rollCycle(base({ seed: 42, pool: [...fixtures].reverse() })));
    expect(b).toEqual(a);
    expect(ok(rollCycle(base({ seed: 42 })))).toEqual(a);
  });

  it("different seeds produce different plans", () => {
    const plans = new Set<string>();
    for (let s = 0; s < 30; s++) {
      const r = ok(rollCycle(base({ seed: s })));
      plans.add([...r.week1, ...r.week2].map((x) => x.id).join(","));
    }
    expect(plans.size).toBeGreaterThan(10);
  });

  it("soft cooldown: previous-cycle dishes appear less often but are not banned", () => {
    const prev = new Set(["pork-adobo", "chicken-adobo", "pork-nilaga"]);
    let withPrev = 0, without = 0;
    for (let s = 0; s < 400; s++) {
      const ids = (r: RollResult) => { const x = ok(r); return [...x.week1, ...x.week2].map((d) => d.id); };
      withPrev += ids(rollCycle(base({ seed: s, previousCycleRecipeIds: prev }))).filter((i) => prev.has(i)).length;
      without += ids(rollCycle(base({ seed: s }))).filter((i) => prev.has(i)).length;
    }
    expect(withPrev).toBeLessThan(without);
    expect(withPrev).toBeGreaterThan(0);
  });

  it("dedupes repeated pool entries and honours exclude", () => {
    const r = ok(rollCycle(base({ pool: [...fixtures, ...fixtures], exclude: new Set(["pork-adobo"]) })));
    expect([...r.week1, ...r.week2].map((x) => x.id)).not.toContain("pork-adobo");
    checkInvariants(r);
  });

  it("keeps locked dishes in their slots", () => {
    const r = ok(rollCycle(base({ locks: { "1-1": "pinakbet", "2-2": "pork-adobo" } })));
    expect(r.week1[1]!.id).toBe("pinakbet");
    expect(r.week2[2]!.id).toBe("pork-adobo");
    checkInvariants(r);
  });

  it("all six slots locked returns exactly the locks", () => {
    const locks = { "1-0": "pinakbet", "1-1": "chicken-tinola", "1-2": "pork-giniling", "2-0": "pork-adobo", "2-1": "kare-kare", "2-2": "chicken-afritada" } as const;
    const r = ok(rollCycle(base({ locks })));
    expect(r.week1.map((x) => x.id)).toEqual(["pinakbet", "chicken-tinola", "pork-giniling"]);
    expect(r.week2.map((x) => x.id)).toEqual(["pork-adobo", "kare-kare", "chicken-afritada"]);
  });

  describe("errors", () => {
    it("LOCK_CONFLICT: unknown slot, missing recipe, duplicate, fresh dish in W2", () => {
      expect(err(rollCycle(base({ locks: { "3-0": "x" } as never }))).code).toBe("LOCK_CONFLICT");
      expect(err(rollCycle(base({ locks: { "1-0": "nope" } }))).detail).toContain("not in the recipe pool");
      expect(err(rollCycle(base({ locks: { "1-0": "pork-adobo", "2-0": "pork-adobo" } }))).detail).toContain("once per cycle");
      expect(err(rollCycle(base({ locks: { "2-0": "pinakbet" } }))).detail).toContain("Week 2");
    });
    it("LOCK_CONFLICT: protein cap and tomato cap", () => {
      const e1 = err(rollCycle(base({ locks: { "1-0": "pork-adobo", "1-1": "pork-nilaga", "1-2": "pork-giniling" } })));
      expect(e1.code).toBe("LOCK_CONFLICT");
      expect(e1.detail).toContain("pork");
      const e2 = err(rollCycle(base({ locks: { "1-0": "pork-kaldereta", "1-1": "chicken-afritada" } })));
      expect(e2.code).toBe("LOCK_CONFLICT");
      expect(e2.detail).toContain("tomato");
    });
    it("INSUFFICIENT_HARDY_POOL reports have/need", () => {
      const pool = mk([["T2", "pork", "soy_vinegar"], ["T2", "beef", "soy_vinegar"], ["T1", "fish", "coconut"], ["T1", "chicken", "coconut"], ["T1", "vegetable", "coconut"], ["T1", "pork", "clear_broth"]]);
      const e = err(rollCycle(base({ pool })));
      expect(e).toMatchObject({ code: "INSUFFICIENT_HARDY_POOL", have: 2, need: 3 });
      expect((e as { detail: string }).detail).toContain("Add 1 more");
    });
    it("a locked W2 dish reduces the hardy requirement", () => {
      const pool = mk([["T2", "pork", "soy_vinegar"], ["T2", "beef", "soy_vinegar"], ["T2", "fish", "coconut"], ["T1", "chicken", "coconut"], ["T1", "vegetable", "coconut"], ["T1", "pork", "clear_broth"]]);
      const r = ok(rollCycle(base({ pool, locks: { "2-0": "r0" } })));
      checkInvariants(r);
    });
    it("UNSATISFIABLE: not enough distinct dishes", () => {
      const e = err(rollCycle(base({ pool: mk([["T2", "pork", "clear_broth"], ["T2", "beef", "clear_broth"], ["T2", "fish", "clear_broth"], ["T1", "chicken", "clear_broth"]]) })));
      expect(e.code).toBe("UNSATISFIABLE");
      expect(e).toHaveProperty("detail", expect.stringContaining("distinct dishes"));
    });
    it("UNSATISFIABLE: Week 2 protein cap explained", () => {
      const pool = mk([...Array(4).fill(["T2", "pork", "soy_vinegar"]), ...Array(2).fill(["T1", "beef", "coconut"])] as Spec[]);
      const e = err(rollCycle(base({ pool })));
      expect(e.code).toBe("UNSATISFIABLE");
      expect((e as { detail: string }).detail).toMatch(/Week 2 can fill only 2 of 3.*pork: 4/);
    });
    it("UNSATISFIABLE: Week 2 tomato cap explained", () => {
      const pool = mk([["T2", "pork", "tomato"], ["T2", "beef", "tomato"], ["T2", "fish", "tomato"], ["T1", "chicken", "coconut"], ["T1", "vegetable", "coconut"], ["T1", "pork", "coconut"]]);
      const e = err(rollCycle(base({ pool })));
      expect((e as { detail: string }).detail).toMatch(/Week 2 can fill only 1 of 3.*tomato/);
    });
    it("UNSATISFIABLE: Week 1 caps explained when W2 is fully locked", () => {
      const pool = mk([["T2", "beef", "soy_vinegar"], ["T2", "chicken", "soy_vinegar"], ["T2", "fish", "soy_vinegar"], ["T1", "pork", "coconut"], ["T1", "pork", "coconut"], ["T1", "pork", "coconut"], ["T1", "pork", "coconut"]]);
      const e = err(rollCycle(base({ pool, locks: { "2-0": "r0", "2-1": "r1", "2-2": "r2", "1-0": "r3", "1-1": "r4" } })));
      expect(e.code).toBe("UNSATISFIABLE");
      expect((e as { detail: string }).detail).toMatch(/Week 1 can fill only 0 of 1/);
    });
    it("UNSATISFIABLE: weeks compete for the same dishes", () => {
      const pool = mk([["T2", "beef", "soy_vinegar"], ["T2", "chicken", "soy_vinegar"], ["T2", "fish", "soy_vinegar"], ["T1", "pork", "coconut"], ["T1", "pork", "coconut"], ["T1", "pork", "coconut"]]);
      const e = err(rollCycle(base({ pool })));
      expect((e as { detail: string }).detail).toContain("compete");
    });
    it("UNSATISFIABLE: search budget exceeded", () => {
      const e = err(rollCycle(base({ config: { nodeBudget: 1 } })));
      expect(e.code).toBe("UNSATISFIABLE");
      expect((e as { detail: string }).detail).toContain("budget");
    });
  });

  it("config can relax the tomato cap", () => {
    const pool = mk([["T2", "pork", "tomato"], ["T2", "beef", "tomato"], ["T2", "fish", "tomato"], ["T1", "chicken", "coconut"], ["T1", "vegetable", "coconut"], ["T1", "pork", "coconut"]]);
    checkInvariants(ok(rollCycle(base({ pool, config: { maxTomatoPerWeek: 3 } }))), { protein: 2, tomato: 3 });
  });
});

describe("rerollSlot", () => {
  it("changes only the target slot and excludes its occupant", () => {
    const first = ok(rollCycle(base({ seed: 7 })));
    const current = Object.fromEntries(SLOT_KEYS.map((k) => [k, (k[0] === "1" ? first.week1 : first.week2)[Number(k[2])]!.id])) as Record<(typeof SLOT_KEYS)[number], string>;
    const target = { week: 2, slot: 1 } as const;
    const r = ok(rerollSlot({ ...base({ seed: deriveSeed(7, 1) }), current }, target));
    for (const k of SLOT_KEYS) {
      const got = (k[0] === "1" ? r.week1 : r.week2)[Number(k[2])]!.id;
      if (k === slotKey(target)) expect(got).not.toBe(current[k]);
      else expect(got).toBe(current[k]);
    }
    checkInvariants(r);
  });
});

describe("roller properties", () => {
  const specArb = fc.tuple(fc.constantFrom("T1", "T2"), fc.constantFrom("pork", "chicken", "beef", "fish", "vegetable"), fc.constantFrom("tomato", "soy_vinegar", "coconut", "clear_broth", "peanut", "shrimp_paste")) as fc.Arbitrary<Spec>;
  const poolArb = fc.array(specArb, { minLength: 0, maxLength: 9 });

  function* combos<T>(xs: T[], k: number, start = 0, cur: T[] = []): Generator<T[]> {
    if (cur.length === k) return yield [...cur];
    for (let i = start; i < xs.length; i++) { cur.push(xs[i]!); yield* combos(xs, k, i + 1, cur); cur.pop(); }
  }
  const validWeek = (w: Recipe[]) => {
    const c = new Map<string, number>();
    for (const r of w) c.set(r.protein_category, (c.get(r.protein_category) ?? 0) + 1);
    return [...c.values()].every((n) => n <= 2) && w.filter((r) => r.sauce_base === "tomato").length <= 1;
  };
  const feasible = (pool: Recipe[]) => {
    for (const w2 of combos(pool.filter((r) => r.perishability_tier === "TIER_2_HARDY"), 3)) {
      if (!validWeek(w2)) continue;
      const rest = pool.filter((r) => !w2.includes(r));
      for (const w1 of combos(rest, 3)) if (validWeek(w1)) return true;
    }
    return false;
  };

  it("succeeds exactly when a valid cycle exists (brute-force oracle) and always satisfies every invariant", () => {
    fc.assert(
      fc.property(poolArb, fc.nat(0xffffffff), (specs, seed) => {
        const pool = mk(specs);
        const res = rollCycle({ pool, seed, locks: {}, previousCycleRecipeIds: none });
        expect(res.ok).toBe(feasible(pool));
        if (res.ok) checkInvariants(res);
        else expect(["INSUFFICIENT_HARDY_POOL", "UNSATISFIABLE"]).toContain(res.error.code);
      }),
      { numRuns: 400 },
    );
  });

  it("the oracle property is not vacuous: generated pools include both feasible and infeasible cases", () => {
    const outcomes = fc.sample(poolArb, { numRuns: 400, seed: 7 }).map((specs) => feasible(mk(specs)));
    const yes = outcomes.filter(Boolean).length;
    expect(yes).toBeGreaterThan(20);
    expect(outcomes.length - yes).toBeGreaterThan(20);
  });

  it("identical seeds give identical plans, whatever the pool order", () => {
    fc.assert(
      fc.property(fc.array(specArb, { minLength: 6, maxLength: 12 }), fc.nat(0xffffffff), (specs, seed) => {
        const pool = mk(specs);
        const a = rollCycle({ pool, seed, locks: {}, previousCycleRecipeIds: none });
        const b = rollCycle({ pool: [...pool].reverse(), seed, locks: {}, previousCycleRecipeIds: none });
        expect(b).toEqual(a);
      }),
      { numRuns: 200 },
    );
  });
});
