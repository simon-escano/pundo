import { useEffect, useRef } from "react";
import { HOLD, MIN_SPIN_MS, SPOKES, pullProgress, rubberBand, spinnerOpacity, spokeOpacity, THRESHOLD } from "../lib/pullToRefresh";

const SETTLE_MS = 460;
const SETTLE_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
const SIZE = 22;
/** Drag past this (px) before the gesture counts, and how much more vertical than horizontal it must be. */
const SLOP = 8;

const spokeLines = Array.from({ length: SPOKES }, (_, i) => {
  const a = (i / SPOKES) * 2 * Math.PI;
  const [sin, cos] = [Math.sin(a), Math.cos(a)];
  return { x1: 11 + sin * 5.2, y1: 11 - cos * 5.2, x2: 11 + sin * 9, y2: 11 - cos * 9 };
});

/** True if the touch began inside something that is itself scrolled down (a sheet, a list): that scroll wins. */
function inScrolledContainer(el: EventTarget | null): boolean {
  for (let n = el instanceof Element ? el : null; n && n !== document.documentElement; n = n.parentElement) {
    if (n.scrollTop > 0) return true;
  }
  return false;
}

/**
 * iOS-style pull-to-refresh. Standalone iOS web apps have no native one, so we draw it: pull down at the top of the page
 * and the content follows your finger with rubber-band resistance while a 12-spoke indicator fills in; release past the
 * threshold and the content settles to a resting offset while the indicator spins, then springs back.
 * Everything is driven straight from touch events onto two elements (no React state per frame).
 */
export function PullToRefresh({ onRefresh }: { onRefresh: () => Promise<unknown> }) {
  const indicator = useRef<HTMLDivElement>(null);
  const spinner = useRef<SVGSVGElement>(null);
  const live = useRef<HTMLSpanElement>(null);
  const refresh = useRef(onRefresh);
  useEffect(() => {
    refresh.current = onRefresh;
  }, [onRefresh]);

  useEffect(() => {
    const ind = indicator.current!;
    const svg = spinner.current!;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let startX = 0;
    let startY = 0;
    let baseY = 0;
    let tracking = false;
    let pulling = false;
    let refreshing = false;
    let offset = 0;
    let settleTimer: number | undefined;

    const paint = (o: number, settle: boolean, spinning = false) => {
      offset = o;
      const main = document.getElementById("main");
      const move = reduceMotion.matches ? 0 : o;
      const p = spinning ? 1 : pullProgress(o);
      const t = settle ? `${SETTLE_MS}ms ${SETTLE_EASE}` : "0s";
      if (main) {
        main.style.transition = `transform ${t}`;
        main.style.transform = o > 0 || settle ? `translate3d(0, ${move}px, 0)` : "";
      }
      ind.style.transition = `transform ${t}, opacity ${settle ? "220ms ease-out" : "0s"}`;
      ind.style.opacity = String(spinning ? 1 : Math.min(1, p * 1.4));
      ind.style.transform = `translate3d(0, ${move / 2 - SIZE / 2}px, 0) scale(${0.6 + 0.4 * Math.min(1, p)})`;
      svg.classList.toggle("ptr-spin", spinning);
      // The tail only shows while refreshing; while dragging, spokes appear one by one.
      [...svg.children].forEach((c, i) => ((c as SVGElement).style.opacity = String(spinning ? spinnerOpacity(i) : spokeOpacity(i, p))));
    };
    const clearAfterSettle = () => {
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => {
        if (offset === 0 && !refreshing) {
          const main = document.getElementById("main");
          if (main) {
            main.style.transition = "";
            main.style.transform = ""; // no lingering transform: it would trap position:fixed children
          }
        }
      }, SETTLE_MS + 60);
    };
    const rest = () => {
      paint(0, true);
      clearAfterSettle();
    };

    const finish = async () => {
      refreshing = true;
      paint(HOLD, true, true);
      if (live.current) live.current.textContent = "Refreshing";
      await Promise.all([refresh.current().catch(() => undefined), new Promise((r) => window.setTimeout(r, MIN_SPIN_MS))]);
      refreshing = false;
      if (live.current) live.current.textContent = "";
      rest();
    };

    const onStart = (e: TouchEvent) => {
      tracking = false;
      pulling = false;
      if (refreshing || e.touches.length !== 1) return;
      if (document.getElementById("root")?.hasAttribute("inert")) return; // a sheet / dialog is open
      if (window.scrollY > 0 || inScrolledContainer(e.target)) return;
      if (e.target instanceof Element && e.target.closest("input, textarea, select, [contenteditable]")) return;
      tracking = true;
      startX = e.touches[0]!.clientX;
      startY = e.touches[0]!.clientY;
    };
    const onMove = (e: TouchEvent) => {
      if (!tracking) return;
      if (e.touches.length !== 1) {
        tracking = false;
        if (pulling) rest();
        pulling = false;
        return;
      }
      const t = e.touches[0]!;
      if (!pulling) {
        const dx = t.clientX - startX;
        const dy = t.clientY - startY;
        if (Math.abs(dx) > SLOP && Math.abs(dx) > Math.abs(dy)) return void (tracking = false); // a horizontal swipe
        if (dy < -SLOP) return void (tracking = false); // scrolling down the page
        if (dy <= SLOP) return;
        if (window.scrollY > 0) return void (tracking = false);
        pulling = true;
        baseY = t.clientY; // the pull starts from here, so there is no jump when the slop is crossed
        window.clearTimeout(settleTimer);
      }
      if (e.cancelable) e.preventDefault(); // stop the native bounce; we draw our own
      paint(rubberBand(t.clientY - baseY), false);
    };
    const onEnd = () => {
      tracking = false;
      if (!pulling) return;
      pulling = false;
      if (offset >= THRESHOLD) void finish();
      else rest();
    };

    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onEnd, { passive: true });
    document.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onEnd);
      document.removeEventListener("touchcancel", onEnd);
      window.clearTimeout(settleTimer);
    };
  }, []);

  return (
    <>
      <div
        ref={indicator}
        aria-hidden
        data-testid="ptr-indicator"
        className="pointer-events-none fixed inset-x-0 top-[calc(4rem+env(safe-area-inset-top))] z-20 flex justify-center text-muted will-change-transform"
        style={{ opacity: 0, transform: `translate3d(0, ${-SIZE / 2}px, 0) scale(0.6)` }}
      >
        <svg ref={spinner} width={SIZE} height={SIZE} viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          {spokeLines.map((l, i) => (
            <line key={i} {...l} style={{ opacity: 0 }} />
          ))}
        </svg>
      </div>
      <span ref={live} aria-live="polite" className="sr-only" />
    </>
  );
}
