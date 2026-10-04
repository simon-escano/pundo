import { useLiveQuery } from "dexie-react-hooks";
import { AnimatePresence, m } from "motion/react";
import { Cloud, CloudCheck, CloudOff, Clock, LogIn, RefreshCw, TriangleAlert, type LucideIcon } from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import { useApp } from "../app-context";
import { useOnline } from "../hooks/useOnline";
import { describeSync, type Indicator, type IndicatorState, type IndicatorTone } from "../lib/syncLabel";
import { cx } from "./ui";

const EMPTY = { subscribe: () => () => undefined, status: () => null } as const;
const ICON: Record<IndicatorState, LucideIcon> = {
  auth: LogIn, offline: CloudOff, syncing: RefreshCw, synced: CloudCheck, pending: Cloud, unreachable: CloudOff, blocked: Clock, error: TriangleAlert, local: Cloud,
};
const TONE: Record<IndicatorTone, string> = {
  ok: "text-accent", info: "text-info", warn: "text-warn", danger: "text-danger", muted: "text-muted",
};

/** Online / offline / syncing state from useOnline(), the Dexie outbox count and the sync engine. */
export type SyncPill = Indicator & { pending: number };
export function useSyncIndicator(): SyncPill {
  const { s, sync } = useApp();
  const online = useOnline();
  const pending = useLiveQuery(() => s.db.outbox.count(), [s], 0);
  const engine = sync ?? EMPTY;
  const status = useSyncExternalStore(engine.subscribe, engine.status, engine.status);
  return { ...describeSync({ online, pending, status }), pending };
}

/** Header pill: icon + short label; tap for the longer explanation (or, when signed out, to sign in). */
export function SyncIndicator({ onSignIn }: { onSignIn: () => void }) {
  const ind = useSyncIndicator();
  const [open, setOpen] = useState(false);
  const Icon = ICON[ind.state];
  return (
    <div role="status" aria-live="polite" data-testid="sync-indicator" data-state={ind.state} data-pending={ind.pending} className="relative">
      <button
        type="button"
        aria-expanded={ind.state === "auth" ? undefined : open}
        title={ind.detail}
        onClick={() => (ind.state === "auth" ? onSignIn() : setOpen((o) => !o))}
        className={cx("inline-flex min-h-[44px] max-w-[11.5rem] items-center gap-1.5 rounded-xl px-2.5 text-xs font-medium transition-colors duration-150 hover:bg-sunken", TONE[ind.tone])}
      >
        <Icon aria-hidden className={cx("size-4 shrink-0", ind.state === "syncing" && "animate-spin")} />
        <span className="truncate">{ind.label}</span>
      </button>
      <AnimatePresence>
        {open && (
          <m.div
            initial={{ opacity: 0, y: -4, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.97 }}
            transition={{ duration: 0.14 }}
            className="absolute right-0 top-full z-50 mt-1 w-60 rounded-2xl border border-line bg-raised p-3 text-sm shadow-lift"
          >
            <p className="font-semibold">{ind.label}</p>
            <p className="mt-1 text-muted">{ind.detail}</p>
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
}
