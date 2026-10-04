import { EPS, roundDp, safeCeil } from "../math/precision";
import { compareStrings } from "../math/compare";
import type { Packaging } from "./scaling";

export type SnapResult = {
  packs: number | null; // whole packs when snapping, fractional when not, null for loose items
  purchaseQuantity: number; // what actually goes in the basket (same unit as the requirement)
  surplus: number; // purchased − needed
  surplusRatio: number; // surplus / purchased: the share of what you buy that goes unused
};

/** Flag a line when more than 40% of the purchase is surplus (e.g. need 260 g against a 250 g pouch). */
export const HIGH_SURPLUS_RATIO = 0.4;

export const isHighSurplus = (s: SnapResult): boolean => s.surplusRatio > HIGH_SURPLUS_RATIO;

/** Buy Unit snapping: Packs = ⌈Net / PackSize⌉ (epsilon-safe). */
export function snapToPacks(net: number, pkg?: Packaging): SnapResult {
  if (net <= EPS) return { packs: pkg ? 0 : null, purchaseQuantity: 0, surplus: 0, surplusRatio: 0 };
  if (!pkg) return { packs: null, purchaseQuantity: roundDp(net, 6), surplus: 0, surplusRatio: 0 };
  if (!pkg.snap_to_whole_pack) {
    return { packs: roundDp(net / pkg.pack_size, 6), purchaseQuantity: roundDp(net, 6), surplus: 0, surplusRatio: 0 };
  }
  const packs = safeCeil(net / pkg.pack_size);
  const purchase = roundDp(packs * pkg.pack_size, 6);
  const surplus = roundDp(purchase - net, 6);
  return { packs, purchaseQuantity: purchase, surplus, surplusRatio: roundDp(surplus / purchase, 6) };
}

/**
 * When recipes disagree on how an ingredient is sold, pick deterministically:
 * smallest surplus → fewest packs → retail_unit (code-unit order) → pack_size.
 */
export function choosePackaging(net: number, candidates: readonly Packaging[]): Packaging | undefined {
  let best: { pkg: Packaging; snap: SnapResult } | undefined;
  for (const pkg of candidates) {
    const snap = snapToPacks(net, pkg);
    if (!best || compare({ pkg, snap }, best) < 0) best = { pkg, snap };
  }
  return best?.pkg;
}

function compare(a: { pkg: Packaging; snap: SnapResult }, b: { pkg: Packaging; snap: SnapResult }): number {
  return (
    a.snap.surplus - b.snap.surplus ||
    (a.snap.packs ?? 0) - (b.snap.packs ?? 0) ||
    compareStrings(a.pkg.retail_unit, b.pkg.retail_unit) ||
    a.pkg.pack_size - b.pkg.pack_size
  );
}
