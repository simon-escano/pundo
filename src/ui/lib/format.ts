import type { GroceryLine } from "../../domain/engines/grocery";
import type { Recipe } from "../../domain/schemas/blueprint";
import type { Cycle } from "../../domain/schemas/app";
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

export const PROTEIN_LABEL: Record<Recipe["protein_category"], string> = { pork: "Pork", chicken: "Chicken", beef: "Beef", fish: "Fish", vegetable: "Veggie" };
export const TIER_LABEL: Record<Recipe["perishability_tier"], string> = { TIER_1_FRESH: "Use first", TIER_2_HARDY: "Keeps 2 wks" };
export const AISLE_LABEL = { produce: "Produce", fresh_meat: "Meat", canned_dry: "Canned & dry", disposable: "Disposables" } as const;
export const SAUCE_LABEL: Record<Recipe["sauce_base"], string> = {
  tomato: "Tomato", soy_vinegar: "Soy-vinegar", coconut: "Coconut", clear_broth: "Clear broth", peanut: "Peanut", shrimp_paste: "Shrimp paste",
};

/** Plain-language cycle status (the stored value stays draft / locked / complete). */
export const STATUS_LABEL: Record<Cycle["status"], string> = { draft: "Planning", locked: "Locked", shopped: "Shopped", w1_cooked: "Week 1 cooked", complete: "Done" };

/** Stove order, spelled out: rank 1 cooks first. `short` fits a tag, `long` a card. */
export const STOVE_ORDER: Record<1 | 2 | 3, { short: string; long: string; how: string }> = {
  1: { short: "1st on stove", long: "Cook first", how: "Slow braise" },
  2: { short: "2nd on stove", long: "Cook second", how: "Quick sauté" },
  3: { short: "Cook last", long: "Cook last", how: "Finishing" },
};

export const WEEK_CAPTION = { 1: "Any dish", 2: "Only dishes that keep 2 weeks" } as const;

/** Human labels for stored enum values shown in forms. The stored values never change. */
export const STORAGE_CLASS_LABEL = {
  loose_produce: "Loose produce",
  fresh_meat: "Fresh meat",
  perishable_once_opened: "Perishable once opened",
  shelf_stable_sealed: "Shelf-stable, sealed",
  disposable: "Disposable",
} as const;
export const PRICING_UNIT_LABEL = { kg: "Per kg", piece: "Per piece", can: "Per can", pouch: "Per pouch", pack: "Per pack", head: "Per head", bottle: "Per bottle" } as const;
export const PANTRY_STATE_LABEL = { loose: "Loose", sealed: "Sealed", opened: "Opened" } as const;

/** "ONION (3 medium total / ~450g)" -> { name: "Onion", detail: "3 medium total / ~450g" }. */
export function splitGroupHeading(heading: string): { name: string; detail: string | null } {
  const m = /^(.*?)(?: \((.*)\))?$/.exec(heading);
  const raw = (m?.[1] ?? heading).toLowerCase();
  return { name: raw.charAt(0).toUpperCase() + raw.slice(1), detail: m?.[2] ?? null };
}
