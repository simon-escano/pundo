import type { PantryEntry, StorageClass } from "../schemas/app";
import { EPS, roundDp } from "../math/precision";
import { convert, toCanonical, type CanonicalUnit } from "../units/units";
import type { SnapResult } from "./packaging";
import type { Packaging } from "./scaling";

export type NetReason = "OK" | "TOSSED" | "OPENED_EXPIRED" | "UNIT_MISMATCH";
export type NetResult = { deducted: number; net: number; reason: NetReason };

export type NetContext = {
  ingredientId: string;
  cycleId: string;
  deductStock: boolean; // false = the [Spoiled / Tossed] override
  storageClass: StorageClass;
  alreadyDeducted?: number; // stock already claimed by another bucket of the same ingredient
};

/**
 * Net Requirement = max(0, Gross − Pantry Stock).
 * Loose produce and sealed stock deduct cleanly. Opened perishables are assumed expired across
 * cycle boundaries. [Spoiled / Tossed] ignores stock and restores the gross buy quantity.
 */
export function netRequirement(
  gross: number,
  unit: CanonicalUnit | null,
  pantry: readonly PantryEntry[],
  ctx: NetContext,
): NetResult {
  if (!ctx.deductStock) return { deducted: 0, net: roundDp(gross, 6), reason: "TOSSED" };

  const entries = pantry.filter((e) => e.ingredient_id === ctx.ingredientId);
  if (unit === null) return { deducted: 0, net: roundDp(gross, 6), reason: entries.length > 0 ? "UNIT_MISMATCH" : "OK" };

  let available = 0;
  let convertible = 0;
  let expired = false;
  let mismatched = false;
  for (const e of entries) {
    if (e.state === "opened" && ctx.storageClass === "perishable_once_opened" && e.opened_cycle_id !== ctx.cycleId) {
      expired = true;
      continue;
    }
    const canon = toCanonical(e.quantity, e.unit);
    const qty = canon ? convert(canon.quantity, canon.unit, unit) : null;
    if (qty === null) {
      mismatched = true;
      continue;
    }
    available += qty;
    convertible++;
  }
  available = Math.max(0, available - (ctx.alreadyDeducted ?? 0));
  const deducted = roundDp(Math.min(gross, available), 6);
  const net = roundDp(Math.max(0, gross - deducted), 6);
  const reason: NetReason = mismatched && convertible === 0 ? "UNIT_MISMATCH" : expired ? "OPENED_EXPIRED" : "OK";
  return { deducted, net, reason };
}

/** After shopping/cooking: the surplus from a snapped purchase, offered for pantry write-back. */
export function projectedSurplus(
  snap: SnapResult,
  pkg: Packaging | undefined,
  ctx: { ingredientId: string; unit: CanonicalUnit; cycleId: string; storageClass: StorageClass; at: string },
): PantryEntry | null {
  if (!pkg || !pkg.snap_to_whole_pack || snap.surplus <= EPS) return null;
  const base = { ingredient_id: ctx.ingredientId, quantity: snap.surplus, unit: ctx.unit, updated_at: ctx.at };
  switch (ctx.storageClass) {
    case "perishable_once_opened":
      return { ...base, state: "opened", opened_cycle_id: ctx.cycleId };
    case "shelf_stable_sealed":
    case "disposable":
      return { ...base, state: "sealed", opened_cycle_id: null };
    case "loose_produce":
      return { ...base, state: "loose", opened_cycle_id: null };
    case "fresh_meat":
      return null; // raw meat is portioned and frozen per dish, never carried as pantry stock
  }
}
