// Deterministic unit alias + conversion table. Unknown units are flagged, never guessed.
export const CANONICAL_UNITS = [
  "g", "ml", "pc", "can", "pouch", "pack", "bottle", "head", "tbsp", "tsp", "clove", "bunch",
] as const;
export type CanonicalUnit = (typeof CANONICAL_UNITS)[number];
export type Dimension = "mass" | "volume" | "count";

const DIMENSION: Record<CanonicalUnit, Dimension> = {
  g: "mass", ml: "volume", tbsp: "volume", tsp: "volume",
  pc: "count", can: "count", pouch: "count", pack: "count",
  bottle: "count", head: "count", clove: "count", bunch: "count",
};

// Factor to the dimension base (g for mass, ml for volume). Count units are 1:1 only with themselves.
const TO_BASE: Partial<Record<CanonicalUnit, number>> = { g: 1, ml: 1, tbsp: 15, tsp: 5 };

// alias → [canonical, multiplier applied to the quantity]
const ALIASES: Record<string, [CanonicalUnit, number]> = {
  g: ["g", 1], gm: ["g", 1], gram: ["g", 1], grams: ["g", 1],
  kg: ["g", 1000], kilo: ["g", 1000], kilos: ["g", 1000], kilogram: ["g", 1000], kilograms: ["g", 1000],
  ml: ["ml", 1], milliliter: ["ml", 1], milliliters: ["ml", 1],
  l: ["ml", 1000], liter: ["ml", 1000], liters: ["ml", 1000], litre: ["ml", 1000], litres: ["ml", 1000],
  pc: ["pc", 1], pcs: ["pc", 1], piece: ["pc", 1], pieces: ["pc", 1],
  can: ["can", 1], cans: ["can", 1],
  pouch: ["pouch", 1], pouches: ["pouch", 1],
  pack: ["pack", 1], packs: ["pack", 1], packet: ["pack", 1], packets: ["pack", 1], sachet: ["pack", 1], sachets: ["pack", 1],
  bottle: ["bottle", 1], bottles: ["bottle", 1],
  head: ["head", 1], heads: ["head", 1],
  tbsp: ["tbsp", 1], tablespoon: ["tbsp", 1], tablespoons: ["tbsp", 1],
  tsp: ["tsp", 1], teaspoon: ["tsp", 1], teaspoons: ["tsp", 1],
  clove: ["clove", 1], cloves: ["clove", 1],
  bunch: ["bunch", 1], bunches: ["bunch", 1],
};

export type NormalizedUnit = { unit: CanonicalUnit; factor: number };

/** Map a free-form unit string to a canonical unit, or null if unrecognised. */
export function normalizeUnit(raw: string): NormalizedUnit | null {
  const hit = ALIASES[raw.trim().toLowerCase()];
  return hit ? { unit: hit[0], factor: hit[1] } : null;
}

/** Quantity in a raw unit → canonical unit quantity, or null when the unit is unknown. */
export function toCanonical(quantity: number, rawUnit: string): { quantity: number; unit: CanonicalUnit } | null {
  const n = normalizeUnit(rawUnit);
  return n ? { quantity: quantity * n.factor, unit: n.unit } : null;
}

export const dimensionOf = (u: CanonicalUnit): Dimension => DIMENSION[u];

/** Convert between canonical units of the same measurable dimension; null otherwise. */
export function convert(quantity: number, from: CanonicalUnit, to: CanonicalUnit): number | null {
  if (from === to) return quantity;
  const df = DIMENSION[from];
  if (df === "count" || df !== DIMENSION[to]) return null;
  return (quantity * TO_BASE[from]!) / TO_BASE[to]!;
}
