import { useLiveQuery } from "dexie-react-hooks";
import { Cloud, CloudCheck, CloudOff, Clock, LogIn, RefreshCw, TriangleAlert, type LucideIcon } from "lucide-react";
import { useSyncExternalStore } from "react";
import { useApp } from "../app-context";
import { useOnline } from "../hooks/useOnline";
import { describeSync, type Indicator, type IndicatorState, type IndicatorTone } from "../lib/syncLabel";
import { cx } from "./ui";

const EMPTY = { subscribe: () => () => undefined, status: () => null } as const;
const ICON: Record<IndicatorState, LucideIcon> = {
  auth: LogIn, offline: CloudOff, syncing: RefreshCw, synced: CloudCheck, pending: Cloud, unreachable: CloudOff, blocked: Clock, error: TriangleAlert, local: Cloud,
};
const TONE: Record<IndicatorTone, string> = {
  ok: "text-ok", info: "text-accent", warn: "text-accent", danger: "text-danger", muted: "text-muted",
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

/** Header status: icon + short label as plain text (not a control); the longer explanation is its tooltip. Sign in / Log out live in `SessionButton`. */
export function SyncIndicator() {
  const ind = useSyncIndicator();
  const Icon = ICON[ind.state];
  return (
    <div role="status" aria-live="polite" data-testid="sync-indicator" data-state={ind.state} data-pending={ind.pending} title={ind.detail} className={cx("inline-flex max-w-[9.5rem] items-center gap-1.5 px-1.5 text-xs font-semibold max-[420px]:min-w-[28px] max-[420px]:justify-center", TONE[ind.tone])}>
      <Icon aria-hidden className={cx("size-4 shrink-0", ind.state === "syncing" && "animate-spin")} />
      <span className="max-[420px]:sr-only truncate">{ind.label}</span>
    </div>
  );
}
