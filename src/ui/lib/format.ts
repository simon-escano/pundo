import type { GroceryLine } from "../../domain/engines/grocery";
import type { Recipe } from "../../domain/schemas/blueprint";
import { roundDp } from "../../domain/math/precision";

/** ₱1,234 (no fractions at or above ₱100, two decimals below). Locale-independent. */
export function formatMoney(n: number): string {
  const v = n >= 100 ? Math.round(n) : roundDp(n, 2);
  const [int, frac] = String(v).split(".");
  return `₱${int!.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${frac ? `.${frac.padEnd(2, "0")}` : ""}`;
}

const trim = (n: number) => String(roundDp(n, 2));

/** 1200 g → "1.2 kg", 250 ml → "250 ml", 4 pc → "4 pc". */
export function formatQuantity(q: number, unit: string): string {
  if (unit === "g" && q >= 1000) return `${trim(q / 1000)} kg`;
  if (unit === "ml" && q >= 1000) return `${trim(q / 1000)} L`;
  return `${trim(q)} ${unit}`;
}

/** What to put in the basket for a grocery line. */
export function describeBuy(l: GroceryLine): string {
  if (l.purchaseQuantity <= 0) return "Covered by stock";
  if (l.packaging?.snap_to_whole_pack && l.packs !== null) return `${l.packs} × ${l.packaging.retail_unit}`;
  return formatQuantity(l.purchaseQuantity, l.unitLabel);
}

/** "Need 180 g − 100 g stock". */
export function describeNeed(l: GroceryLine): string {
  const need = formatQuantity(l.grossQuantity, l.unitLabel);
  return l.deductedQuantity > 0 ? `Need ${need} − ${formatQuantity(l.deductedQuantity, l.unitLabel)} stock` : `Need ${need}`;
}

export const PROTEIN_LABEL: Record<Recipe["protein_category"], string> = { pork: "Pork", chicken: "Chicken", beef: "Beef", fish: "Fish", vegetable: "Veg" };
export const TIER_LABEL: Record<Recipe["perishability_tier"], string> = { TIER_1_FRESH: "Fresh", TIER_2_HARDY: "Hardy" };
export const AISLE_LABEL = { produce: "Produce", fresh_meat: "Fresh Meat", canned_dry: "Canned/Dry", disposable: "Disposable" } as const;
export const SAUCE_LABEL: Record<Recipe["sauce_base"], string> = {
  tomato: "Tomato", soy_vinegar: "Soy-vinegar", coconut: "Coconut", clear_broth: "Clear broth", peanut: "Peanut", shrimp_paste: "Shrimp paste",
};
