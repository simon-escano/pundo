import type { GroceryLine } from "../../domain/engines/grocery";
import { calibrateFromReceipt, calibrateLine, type CalibrationContext, type PricedLine } from "../../domain/engines/pricing";
import type { GlobalPriceRegistry } from "../../domain/schemas/blueprint";
import type { PriceObservation } from "../../domain/schemas/app";

export type CalibrationInput = {
  receiptTotal: number | null;
  paid: Record<string, number>; // line key → PHP paid
};
export type CalibrationPlan = {
  mode: "per_line" | "receipt" | "none";
  observations: PriceObservation[];
  paidUpdates: { key: string; paid: number }[];
};

export const toPricedLine = (l: GroceryLine): PricedLine => ({
  ingredient_id: l.ingredient_id,
  unit: l.unit,
  purchaseQuantity: l.purchaseQuantity,
  packaging: l.packaging,
});

/**
 * Post-shopping calibration. Per-line paid prices win: each becomes an `observed` price.
 * Otherwise a single receipt total is spread over every priced line by ratio (`receipt_allocated`).
 */
export function planCalibration(
  lines: readonly GroceryLine[],
  registry: GlobalPriceRegistry,
  input: CalibrationInput,
  ctx: CalibrationContext,
): CalibrationPlan {
  const paidKeys = Object.keys(input.paid).filter((k) => Number.isFinite(input.paid[k]) && input.paid[k]! >= 0);
  if (paidKeys.length > 0) {
    const observations: PriceObservation[] = [];
    for (const k of paidKeys.sort()) {
      const line = lines.find((l) => l.key === k);
      const o = line && calibrateLine(toPricedLine(line), input.paid[k]!, registry, ctx);
      if (o) observations.push(o);
    }
    return { mode: "per_line", observations, paidUpdates: paidKeys.map((key) => ({ key, paid: input.paid[key]! })) };
  }
  if (input.receiptTotal !== null && input.receiptTotal > 0) {
    const priced = lines.filter((l) => l.purchaseQuantity > 0).map(toPricedLine);
    return { mode: "receipt", observations: calibrateFromReceipt(priced, input.receiptTotal, registry, ctx), paidUpdates: [] };
  }
  return { mode: "none", observations: [], paidUpdates: [] };
}
