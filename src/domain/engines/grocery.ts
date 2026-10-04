import type { GlobalPriceRegistry } from "../schemas/blueprint";
import type { Aisle, GroceryLineState, IngredientMeta, PantryEntry, StorageClass } from "../schemas/app";
import { compareBy, compareStrings } from "../math/compare";
import { roundDp } from "../math/precision";
import type { CanonicalUnit } from "../units/units";
import { CUT_LABELS } from "./cuts";
import { choosePackaging, isHighSurplus, snapToPacks } from "./packaging";
import { groceryEstimate, linePrice } from "./pricing";
import { netRequirement, type NetReason } from "./leftover";
import type { Packaging, ScaledDish, ScaledPrepItem, ScaleWarning, Week } from "./scaling";
import { totalDispatch } from "./allocation";

export const RE250_ID = "re250_container";
export type Bucket = "cycle" | "w1" | "w2";

export type GroceryWarning =
  | ScaleWarning
  | { code: "MISSING_META"; message: string };

export type GroceryLine = {
  key: string; // `${ingredient_id}|${unitLabel}|${bucket}`: stable id for UI state
  ingredient_id: string;
  display_name: string;
  aisle: Aisle;
  storageClass: StorageClass;
  bucket: Bucket;
  unit: CanonicalUnit | null;
  unitLabel: string;
  grossQuantity: number;
  deductedQuantity: number;
  netQuantity: number;
  packaging: Packaging | undefined;
  packs: number | null;
  purchaseQuantity: number;
  surplus: number;
  surplusRatio: number;
  highSurplus: boolean;
  deductStock: boolean;
  reason: NetReason;
  estimatedCost: number | null;
  butcherNotes: string[];
  sources: { recipeId: string; week: Week }[];
  bought: boolean;
  paidPhp: number | null;
  warnings: GroceryWarning[];
};

export type GroceryList = {
  cycleId: string;
  lines: GroceryLine[];
  aisles: { aisle: Aisle; lines: GroceryLine[] }[];
  estimate: { total: number; unresolved: string[] };
  containers: number; // RE-250 send-out containers
};

export type GroceryInput = {
  cycleId: string;
  dishes: readonly ScaledDish[];
  pantry: readonly PantryEntry[];
  meta: Readonly<Record<string, IngredientMeta>>;
  registry: GlobalPriceRegistry;
  lineState: readonly GroceryLineState[];
};

export const AISLE_ORDER: readonly Aisle[] = ["produce", "fresh_meat", "canned_dry", "disposable"];
const BUCKET_ORDER: Record<Bucket, number> = { w1: 0, w2: 1, cycle: 2 };
const FALLBACK_META = { aisle: "canned_dry", storage_class: "shelf_stable_sealed" } as const;

type Acc = {
  ingredient_id: string;
  display_name: string;
  unit: CanonicalUnit | null;
  unitLabel: string;
  bucket: Bucket;
  items: ScaledPrepItem[];
};

function butcherNote(it: ScaledPrepItem): string | null {
  const cut = it.item.cut_technique;
  const body = it.item.cut_note ?? (cut === "NONE" ? null : `${CUT_LABELS[cut].verb} ${CUT_LABELS[cut].noun}`);
  if (!body) return null;
  const pieces = it.totalPieces !== null ? ` (${it.totalPieces} pieces)` : "";
  return `${it.item.display_name} for ${it.recipeName}: ${body}${pieces}`;
}

/**
 * Scale → Bucket → Sum gross → Deduct leftovers → Snap packaging → Price → Butcher notes →
 * RE-250 disposables → Aisle sort. Opened perishables are snapped per week; everything else per cycle.
 */
export function buildGroceryList(input: GroceryInput): GroceryList {
  const stateByKey = new Map(input.lineState.filter((s) => s.cycle_id === input.cycleId).map((s) => [s.line_key, s]));

  // Bucket
  const accs = new Map<string, Acc>();
  for (const dish of input.dishes) {
    for (const it of dish.items) {
      const id = it.item.ingredient_id;
      const storage = input.meta[id]?.storage_class ?? FALLBACK_META.storage_class;
      const bucket: Bucket = storage === "perishable_once_opened" ? (`w${dish.week}` as Bucket) : "cycle";
      const key = `${id}|${it.unitLabel}|${bucket}`;
      const acc = accs.get(key) ?? { ingredient_id: id, display_name: it.item.display_name, unit: it.unit, unitLabel: it.unitLabel, bucket, items: [] };
      acc.items.push(it);
      accs.set(key, acc);
    }
  }

  // Process buckets of one ingredient in week order so shared stock is claimed once.
  const ordered = [...accs.entries()].sort(
    compareBy<[string, Acc]>(
      (a, b) => compareStrings(a[1].ingredient_id, b[1].ingredient_id),
      (a, b) => compareStrings(a[1].unitLabel, b[1].unitLabel),
      (a, b) => BUCKET_ORDER[a[1].bucket] - BUCKET_ORDER[b[1].bucket],
    ),
  );
  const claimed = new Map<string, number>();
  const lines: GroceryLine[] = [];

  for (const [key, acc] of ordered) {
    const meta = input.meta[acc.ingredient_id];
    const aisle = meta?.aisle ?? FALLBACK_META.aisle;
    const storageClass = meta?.storage_class ?? FALLBACK_META.storage_class;
    const warnings: GroceryWarning[] = [];
    if (!meta) warnings.push({ code: "MISSING_META", message: `No aisle/storage data for ${acc.ingredient_id}; defaulted to canned/dry.` });
    for (const it of acc.items) for (const w of it.warnings) if (!warnings.some((x) => x.code === w.code && x.message === w.message)) warnings.push(w);

    const gross = roundDp(acc.items.reduce((s, i) => s + i.grossQuantity, 0), 6);
    const state = stateByKey.get(key);
    const deductStock = state?.deduct_stock ?? true;
    const claimKey = `${acc.ingredient_id}|${acc.unitLabel}`;
    const net = netRequirement(gross, acc.unit, input.pantry, {
      ingredientId: acc.ingredient_id,
      cycleId: input.cycleId,
      deductStock,
      storageClass,
      alreadyDeducted: claimed.get(claimKey) ?? 0,
    });
    claimed.set(claimKey, (claimed.get(claimKey) ?? 0) + net.deducted);

    const packaging = choosePackaging(net.net, acc.items.flatMap((i) => (i.packaging ? [i.packaging] : [])));
    const snap = snapToPacks(net.net, packaging);
    const notes = storageClass === "fresh_meat" ? acc.items.map(butcherNote).filter((n): n is string => n !== null) : [];

    lines.push({
      key,
      ingredient_id: acc.ingredient_id,
      display_name: acc.display_name,
      aisle,
      storageClass,
      bucket: acc.bucket,
      unit: acc.unit,
      unitLabel: acc.unitLabel,
      grossQuantity: gross,
      deductedQuantity: net.deducted,
      netQuantity: net.net,
      packaging,
      packs: snap.packs,
      purchaseQuantity: snap.purchaseQuantity,
      surplus: snap.surplus,
      surplusRatio: snap.surplusRatio,
      highSurplus: isHighSurplus(snap),
      deductStock,
      reason: net.reason,
      estimatedCost: null,
      butcherNotes: notes,
      sources: acc.items.map((i) => ({ recipeId: i.recipeId, week: i.week })),
      bought: state?.bought ?? false,
      paidPhp: state?.paid_php ?? null,
      warnings,
    });
  }

  // RE-250 disposables: one container per dispatched portion across all dishes.
  const containers = totalDispatch(input.dishes.map((d) => d.portions));
  if (containers > 0) {
    const key = `${RE250_ID}|pc|cycle`;
    const state = stateByKey.get(key);
    lines.push({
      key,
      ingredient_id: RE250_ID,
      display_name: input.registry[RE250_ID]?.display_name ?? "RE-250 container",
      aisle: "disposable",
      storageClass: "disposable",
      bucket: "cycle",
      unit: "pc",
      unitLabel: "pc",
      grossQuantity: containers,
      deductedQuantity: 0,
      netQuantity: containers,
      packaging: undefined,
      packs: null,
      purchaseQuantity: containers,
      surplus: 0,
      surplusRatio: 0,
      highSurplus: false,
      deductStock: state?.deduct_stock ?? true,
      reason: "OK",
      estimatedCost: null,
      butcherNotes: [],
      sources: [],
      bought: state?.bought ?? false,
      paidPhp: state?.paid_php ?? null,
      warnings: [],
    });
  }

  // Price
  for (const l of lines) {
    l.estimatedCost = l.purchaseQuantity > 0 ? linePrice(l, input.registry) : 0;
  }

  // Aisle sort
  lines.sort(
    compareBy<GroceryLine>(
      (a, b) => AISLE_ORDER.indexOf(a.aisle) - AISLE_ORDER.indexOf(b.aisle),
      (a, b) => compareStrings(a.display_name, b.display_name),
      (a, b) => compareStrings(a.ingredient_id, b.ingredient_id),
      (a, b) => BUCKET_ORDER[a.bucket] - BUCKET_ORDER[b.bucket],
      (a, b) => compareStrings(a.unitLabel, b.unitLabel),
    ),
  );

  return {
    cycleId: input.cycleId,
    lines,
    aisles: AISLE_ORDER.map((aisle) => ({ aisle, lines: lines.filter((l) => l.aisle === aisle) })).filter((a) => a.lines.length > 0),
    estimate: groceryEstimate(lines, input.registry),
    containers,
  };
}
