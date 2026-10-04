import { useEffect } from "react";

/** Keep the screen awake while a view is mounted (used only by /prep and /cook). Re-acquires after tab switches. */
export function useWakeLock(active = true): void {
  useEffect(() => {
    if (!active || !("wakeLock" in navigator)) return;
    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;
    const acquire = async () => {
      try {
        const s = await navigator.wakeLock.request("screen");
        if (cancelled) void s.release().catch(() => undefined);
        else sentinel = s;
      } catch {
        /* denied or unsupported: the app still works */
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible" && (!sentinel || sentinel.released)) void acquire();
    };
    void acquire();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      void sentinel?.release().catch(() => undefined);
    };
  }, [active]);
}
