// Epsilon-safe numeric helpers. All engines round through these, never ad hoc.
export const EPS = 1e-9;

/** Ceil that ignores float dust: safeCeil(0.1*3/0.1) === 3, not 4. */
export function safeCeil(x: number): number {
  return Math.ceil(x - EPS) + 0; // + 0 normalises -0 to 0
}

/** Round to a fixed number of decimal places without binary noise (0.1+0.2 → 0.3). */
export function roundDp(x: number, dp: number): number {
  if (!Number.isFinite(x)) return x;
  const s = String(x);
  if (s.includes("e")) return Number(x.toFixed(dp));
  return Number(`${Math.round(Number(`${s}e${dp}`))}e-${dp}`);
}

/** Round up to the next multiple of `step`. */
export function ceilTo(x: number, step: number): number {
  return roundDp(safeCeil(x / step) * step, 6);
}

/** Money is stored at 4 dp and displayed at 2 dp. */
export const roundMoney = (x: number): number => roundDp(x, 4);
export const displayMoney = (x: number): number => roundDp(x, 2);
