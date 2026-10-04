import type { GlobalPriceRegistry, IngredientPriceRecord, Recipe } from "../schemas/blueprint";
import type { PriceObservation } from "../schemas/app";
import { EMA_ALPHA } from "../constants/hardware";
import { compareBy, compareStrings } from "../math/compare";
import { roundDp, roundMoney } from "../math/precision";
import { normalizeUnit, toCanonical, type CanonicalUnit } from "../units/units";
import type { Packaging } from "./scaling";

/** EMA_t = α·P_obs + (1−α)·EMA_{t−1}. Cold start (no previous, or 0): the observation takes over. */
export function emaUpdate(prev: number | undefined, observed: number, alpha: number = EMA_ALPHA): number {
  if (prev === undefined || !(prev > 0)) return roundMoney(observed);
  return roundMoney(alpha * observed + (1 - alpha) * prev);
}

/**
 * Fold observations over a base registry. Observations are put in a total order
 * (ingredient_id, seed-first, observed_at, id) and de-duplicated by id, so the result is identical
 * on every device regardless of arrival order. A `seed` is the cold-start baseline, so it always
 * applies before real observations even when a skewed device clock stamps it later.
 * Observations for ingredients missing from the base are ignored.
 */
export function replayObservations(base: GlobalPriceRegistry, observations: readonly PriceObservation[]): GlobalPriceRegistry {
  const out: GlobalPriceRegistry = {};
  for (const [id, rec] of Object.entries(base)) out[id] = { ...rec };

  const seen = new Set<string>();
  const ordered = [...observations].sort(
    compareBy<PriceObservation>(
      (a, b) => compareStrings(a.ingredient_id, b.ingredient_id),
      (a, b) => Number(a.kind !== "seed") - Number(b.kind !== "seed"),
      (a, b) => compareStrings(a.observed_at, b.observed_at),
      (a, b) => compareStrings(a.id, b.id),
    ),
  );
  for (const o of ordered) {
    if (seen.has(o.id)) continue;
    seen.add(o.id);
    const rec = out[o.ingredient_id];
    if (!rec) continue;
    const price =
      o.kind === "seed" || o.kind === "override" ? roundMoney(o.price) : emaUpdate(rec.price_per_unit, o.price);
    out[o.ingredient_id] = { ...rec, price_per_unit: price, last_updated: o.observed_at };
  }
  return out;
}

export type PricingConversion = { amount: number } | { unresolved: "UNIT_MISMATCH" };

/** Convert a purchased/used quantity (canonical unit) into the registry's pricing unit. */
export function toPricingUnits(
  qty: number,
  unit: CanonicalUnit,
  pkg: Packaging | undefined,
  rec: Pick<IngredientPriceRecord, "pricing_unit">,
): PricingConversion {
  const mismatch: PricingConversion = { unresolved: "UNIT_MISMATCH" };
  switch (rec.pricing_unit) {
    case "kg":
      return unit === "g" ? { amount: qty / 1000 } : mismatch;
    case "piece":
      return unit === "pc" ? { amount: qty } : mismatch;
    case "head":
      return unit === "head" ? { amount: qty } : mismatch;
    case "can":
    case "pouch":
    case "pack":
    case "bottle":
      if (pkg) return { amount: qty / pkg.pack_size };
      return unit === rec.pricing_unit ? { amount: qty } : mismatch;
  }
}

export type PricedLine = {
  ingredient_id: string;
  unit: CanonicalUnit | null;
  purchaseQuantity: number;
  packaging?: Packaging | undefined;
};

/** Cost of one grocery line, or null when it cannot be priced (no record, PHP 0, or unit mismatch). */
export function linePrice(line: PricedLine, reg: GlobalPriceRegistry): number | null {
  const rec = reg[line.ingredient_id];
  if (!rec || !(rec.price_per_unit > 0) || line.unit === null) return null;
  const conv = toPricingUnits(line.purchaseQuantity, line.unit, line.packaging, rec);
  return "amount" in conv ? roundMoney(conv.amount * rec.price_per_unit) : null;
}

export type RecipeCost = {
  total: number;
  perPortion: number;
  source: "registry" | "fallback";
  coverage: number; // share of prep items priced from the registry (0..1)
  unpriced: string[];
};

/**
 * Warm: Σ quantity × registry price when every item is priced.
 * Cold: estimated_base_cost_php scaled from 10 portions. Never a blend, so partial data can't mislead.
 */
export function recipeCost(recipe: Recipe, portions: number, reg: GlobalPriceRegistry): RecipeCost {
  let total = 0;
  const unpriced: string[] = [];
  for (const p of recipe.prep_items) {
    const rec = reg[p.ingredient_id];
    const canon = toCanonical(p.quantity_per_portion * portions, p.unit);
    const pkg = p.packaging ? { ...p.packaging, pack_size: p.packaging.pack_size * (normalizeUnit(p.unit)?.factor ?? 1) } : undefined;
    const conv = rec && canon && rec.price_per_unit > 0 ? toPricingUnits(canon.quantity, canon.unit, pkg, rec) : null;
    if (conv && "amount" in conv) total += conv.amount * rec!.price_per_unit;
    else unpriced.push(p.ingredient_id);
  }
  const coverage = recipe.prep_items.length === 0 ? 0 : roundDp(1 - unpriced.length / recipe.prep_items.length, 4);
  if (unpriced.length === 0) {
    const t = roundMoney(total);
    return { total: t, perPortion: roundMoney(t / portions), source: "registry", coverage, unpriced };
  }
  const fb = roundMoney((recipe.estimated_base_cost_php * portions) / 10);
  return { total: fb, perPortion: roundMoney(fb / portions), source: "fallback", coverage, unpriced: [...new Set(unpriced)].sort(compareStrings) };
}

/** Grocery Estimate = Σ snapped packs × registry price; unpriced lines are reported, not guessed. */
export function groceryEstimate(
  lines: readonly PricedLine[],
  reg: GlobalPriceRegistry,
): { total: number; unresolved: string[] } {
  let total = 0;
  const unresolved = new Set<string>();
  for (const l of lines) {
    if (l.purchaseQuantity <= 0) continue;
    const p = linePrice(l, reg);
    if (p === null) unresolved.add(l.ingredient_id);
    else total += p;
  }
  return { total: roundMoney(total), unresolved: [...unresolved].sort(compareStrings) };
}

export type CalibrationContext = { at: string; newId: () => string; deviceId: string; cycleId: string | null };

function observation(ingredient_id: string, price: number, kind: PriceObservation["kind"], c: CalibrationContext): PriceObservation {
  return { id: c.newId(), ingredient_id, kind, price: roundMoney(price), observed_at: c.at, cycle_id: c.cycleId, device_id: c.deviceId };
}

/**
 * Receipt allocation: scale every priced ingredient by receiptTotal / estimatedTotal and emit one
 * observation per ingredient (price per pricing unit). Zero-priced lines are skipped.
 */
export function calibrateFromReceipt(
  lines: readonly PricedLine[],
  receiptTotal: number,
  reg: GlobalPriceRegistry,
  ctx: CalibrationContext,
): PriceObservation[] {
  const est = groceryEstimate(lines, reg).total;
  if (!(est > 0) || !(receiptTotal > 0)) return [];
  const ratio = receiptTotal / est;
  const ids = [...new Set(lines.filter((l) => l.purchaseQuantity > 0 && linePrice(l, reg) !== null).map((l) => l.ingredient_id))].sort(compareStrings);
  return ids.map((id) => observation(id, reg[id]!.price_per_unit * ratio, "receipt_allocated", ctx));
}

/** Per-line calibration: P_obs = paid / purchased amount in pricing units (e.g. PHP 180 / 1 kg). */
export function calibrateLine(
  line: PricedLine,
  paidPhp: number,
  reg: GlobalPriceRegistry,
  ctx: CalibrationContext,
): PriceObservation | null {
  const rec = reg[line.ingredient_id];
  if (!rec || line.unit === null || !(paidPhp >= 0) || !(line.purchaseQuantity > 0)) return null;
  const conv = toPricingUnits(line.purchaseQuantity, line.unit, line.packaging, rec);
  if (!("amount" in conv) || !(conv.amount > 0)) return null;
  return observation(line.ingredient_id, paidPhp / conv.amount, "observed", ctx);
}
