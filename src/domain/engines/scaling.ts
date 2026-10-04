import type { PrepItem, Recipe } from "../schemas/blueprint";
import { allocatePortions, type Allocation } from "./allocation";
import { ceilTo, roundDp } from "../math/precision";
import { toCanonical, normalizeUnit, type CanonicalUnit } from "../units/units";

export type Week = 1 | 2;
export type Packaging = NonNullable<PrepItem["packaging"]>;
export type ScaleWarning = { code: "UNKNOWN_UNIT" | "DISCRETE_PIECES_INVALID"; message: string };

export type ScaledPrepItem = {
  recipeId: string;
  recipeName: string;
  week: Week;
  stovePriority: Recipe["stove_priority"];
  item: PrepItem;
  portions: number;
  unit: CanonicalUnit | null; // null ⇒ unrecognised unit: kept separate, never merged
  unitLabel: string; // canonical unit, or the raw string when unrecognised
  grossQuantity: number; // in the canonical unit
  totalPieces: number | null; // discrete only: exact integer cuts
  perVessel: number; // grossQuantity / portions, shown for visual distribution
  packaging: Packaging | undefined; // pack_size converted into the canonical unit
  warnings: ScaleWarning[];
};

export type ScaledDish = {
  recipe: Recipe;
  week: Week;
  portions: number;
  allocation: Allocation;
  items: ScaledPrepItem[];
};

// Rounding granularity for granular/continuous items (always rounds UP so the shopper is never short).
const STEP: Record<CanonicalUnit, number> = {
  g: 5, ml: 5, tbsp: 0.5, tsp: 0.5, pc: 0.5, clove: 0.5, bunch: 0.5, head: 0.5, pack: 0.5,
  can: 1, pouch: 1, bottle: 1,
};

/** Atomic scaling of one prep item: discrete = exact integer cuts, granular/continuous = ratio rounded up. */
export function scalePrepItem(
  item: PrepItem,
  portions: number,
  ctx: { recipeId: string; recipeName: string; week: Week; stovePriority: Recipe["stove_priority"] },
): ScaledPrepItem {
  const warnings: ScaleWarning[] = [];
  const canon = toCanonical(item.quantity_per_portion, item.unit);
  const norm = normalizeUnit(item.unit);
  const unit = canon?.unit ?? null;
  if (!canon) {
    warnings.push({ code: "UNKNOWN_UNIT", message: `Unrecognised unit "${item.unit}" on ${item.ingredient_id}.` });
  }
  const perPortion = canon ? canon.quantity : item.quantity_per_portion;
  const raw = perPortion * portions;

  let totalPieces: number | null = null;
  let gross: number;
  if (item.granularity === "discrete") {
    const n = item.pieces_per_portion;
    if (n === null || !Number.isInteger(n) || n < 1 || n > 6) {
      warnings.push({ code: "DISCRETE_PIECES_INVALID", message: `Discrete item ${item.ingredient_id} needs an integer piece count from 1 to 6.` });
    } else {
      totalPieces = n * portions;
    }
    gross = roundDp(raw, 6);
  } else {
    gross = unit ? ceilTo(roundDp(raw, 6), STEP[unit]) : roundDp(raw, 6);
  }

  const factor = norm?.factor ?? 1;
  const packaging = item.packaging
    ? { ...item.packaging, pack_size: roundDp(item.packaging.pack_size * factor, 6) }
    : undefined;

  return {
    recipeId: ctx.recipeId,
    recipeName: ctx.recipeName,
    week: ctx.week,
    stovePriority: ctx.stovePriority,
    item,
    portions,
    unit,
    unitLabel: unit ?? item.unit.trim().toLowerCase(),
    grossQuantity: gross,
    totalPieces,
    perVessel: roundDp(gross / portions, 4),
    packaging,
    warnings,
  };
}

export function scaleRecipe(recipe: Recipe, portions: number, week: Week): ScaledDish {
  const allocation = allocatePortions(portions);
  const ctx = { recipeId: recipe.id, recipeName: recipe.name, week, stovePriority: recipe.stove_priority };
  return { recipe, week, portions, allocation, items: recipe.prep_items.map((p) => scalePrepItem(p, portions, ctx)) };
}
