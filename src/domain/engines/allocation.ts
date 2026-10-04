import { HARDWARE } from "../constants/hardware";
import { safeCeil } from "../math/precision";

export type Allocation = {
  home: number; // portions that go to the freezer trays
  dispatch: number; // portions packed into RE-250 containers on cook day
  trays: number; // 4-cavity trays actually filled
  emptyCavities: number; // unused cavities in the filled trays (warning when n < 8)
};

/** 10 portions → 8 home (two 4-cavity trays) + 2 dispatch. Fewer than 8 leaves empty cavities; extra overflows to dispatch. */
export function allocatePortions(n: number, hw: typeof HARDWARE = HARDWARE): Allocation {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`Portions must be a positive integer, got ${n}`);
  const home = Math.min(n, hw.HOME_SLOTS);
  const trays = safeCeil(home / hw.TRAY_CAVITIES);
  return { home, dispatch: n - home, trays, emptyCavities: trays * hw.TRAY_CAVITIES - home };
}

/** Total RE-250 containers needed across dishes. */
export function totalDispatch(portionsPerDish: readonly number[]): number {
  return portionsPerDish.reduce((sum, n) => sum + allocatePortions(n).dispatch, 0);
}
