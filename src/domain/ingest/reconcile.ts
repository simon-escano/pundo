import type { GlobalPriceRegistry, IngredientPriceRecord, Recipe } from "../schemas/blueprint";
import type { IngredientMeta } from "../schemas/app";
import { compareStrings } from "../math/compare";
import { normalizeUnit } from "../units/units";

export type MissingIngredient = { ingredient_id: string; display_name: string; needsMeta: boolean };
export type Reconciliation = { known: string[]; missing: MissingIngredient[] };

/** Blueprint §5C: find prep-item ingredient_ids absent from the registry (or lacking aisle/storage meta). */
export function reconcileRegistry(
  recipe: Recipe,
  registry: GlobalPriceRegistry,
  meta: Readonly<Record<string, IngredientMeta>>,
): Reconciliation {
  const seen = new Map<string, string>();
  for (const p of recipe.prep_items) if (!seen.has(p.ingredient_id)) seen.set(p.ingredient_id, p.display_name);

  const known: string[] = [];
  const missing: MissingIngredient[] = [];
  for (const [id, name] of [...seen].sort((a, b) => compareStrings(a[0], b[0]))) {
    const inRegistry = id in registry;
    const hasMeta = id in meta;
    if (inRegistry) known.push(id);
    if (!inRegistry || !hasMeta) missing.push({ ingredient_id: id, display_name: name, needsMeta: !hasMeta });
  }
  return { known, missing };
}

/** One-time seed: entered price initialises the record; skipping defaults to PHP 0 until calibrated. */
export function newRegistryRecord(
  input: { ingredient_id: string; display_name: string; pricing_unit: IngredientPriceRecord["pricing_unit"]; price?: number },
  nowIso: string,
): IngredientPriceRecord {
  return {
    ingredient_id: input.ingredient_id,
    display_name: input.display_name,
    price_per_unit: input.price ?? 0,
    pricing_unit: input.pricing_unit,
    last_updated: nowIso,
  };
}

type PricingUnit = IngredientPriceRecord["pricing_unit"];

/** Best-guess registry pricing unit for a prep-item unit, to prefill the inline "New Ingredient" row. */
export function suggestPricingUnit(rawUnit: string): PricingUnit | null {
  const n = normalizeUnit(rawUnit);
  if (!n) return null;
  switch (n.unit) {
    case "g":
      return "kg";
    case "pc":
      return "piece";
    case "head":
    case "clove":
      return "head";
    case "can":
    case "pouch":
    case "pack":
    case "bottle":
      return n.unit;
    case "ml":
    case "tbsp":
    case "tsp":
      return "bottle";
    case "bunch":
      return "pack";
  }
}
