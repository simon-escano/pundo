// Pull-to-refresh maths and the refresh action. Pure and DOM-free so it is unit-tested; the touch handling is in
// components/PullToRefresh.tsx.

export const SPOKES = 12;
/** Visual pull distance (px) at which releasing starts a refresh. */
export const THRESHOLD = 60;
/** Where the content rests while refreshing. */
export const HOLD = 52;
/** The content can never be dragged further than this, however far the finger goes. */
export const LIMIT = 110;
/** Initial finger-to-content ratio; it falls off as the pull approaches LIMIT. */
const GRIP = 0.9;
/** Minimum time the spinner is shown, so a fast sync still reads as "refreshed". */
export const MIN_SPIN_MS = 700;

/** Rubber-band: 1:1-ish at first, then increasingly resistant (UIScrollView's curve), asymptotic to LIMIT. */
export function rubberBand(fingerDy: number): number {
  if (!(fingerDy > 0)) return 0;
  return LIMIT * (1 - 1 / ((GRIP * fingerDy) / LIMIT + 1));
}

/** 0..1 progress towards the release threshold. */
export const pullProgress = (offset: number): number => Math.min(1, Math.max(0, offset / THRESHOLD));

/** Spokes fade in one after another as the pull progresses (the iOS activity indicator while dragging). */
export function spokeOpacity(index: number, progress: number): number {
  return Math.min(1, Math.max(0, progress * SPOKES - index));
}

/** While refreshing the spokes form a tail: the newest is solid, the oldest faint. */
export const spinnerOpacity = (index: number): number => 0.25 + (0.75 * index) / (SPOKES - 1);

export type RefreshDeps = {
  sync: { syncOnce: () => Promise<unknown> } | null;
  /** Ask the service worker to look for a new app version (the update prompt appears if one is found). */
  checkUpdate: () => Promise<unknown>;
  reload: () => void;
};

/**
 * What a pull does. With sync on: pull the latest plan from the server and check for a new app version; the UI
 * updates itself from the local DB, so nothing flickers. Without sync (local only) there is nothing to fetch, so a
 * real reload is the refresh. Never throws.
 */
export async function refreshApp({ sync, checkUpdate, reload }: RefreshDeps): Promise<void> {
  if (!sync) {
    reload();
    return;
  }
  await Promise.allSettled([sync.syncOnce(), checkUpdate()]);
}
