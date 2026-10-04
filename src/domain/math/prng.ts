import { compareStrings } from "./compare";

/** mulberry32: tiny, fast, fully deterministic PRNG. Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Derive a new uint32 seed (e.g. re-roll counter → fresh seed). */
export function deriveSeed(seed: number, salt: number): number {
  let h = (seed ^ Math.imul(salt + 0x9e3779b9, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Weighted random permutation (Efraimidis–Spirakis): key = u^(1/w), descending.
 * Items are id-sorted first so the result never depends on input order.
 */
export function weightedOrder<T>(
  items: readonly T[],
  idOf: (t: T) => string,
  weightOf: (t: T) => number,
  rng: () => number,
): T[] {
  const sorted = [...items].sort((a, b) => compareStrings(idOf(a), idOf(b)));
  const keyed = sorted.map((item) => {
    const u = rng() || Number.MIN_VALUE;
    return { item, key: Math.pow(u, 1 / weightOf(item)) };
  });
  keyed.sort((a, b) => b.key - a.key || compareStrings(idOf(a.item), idOf(b.item)));
  return keyed.map((k) => k.item);
}
