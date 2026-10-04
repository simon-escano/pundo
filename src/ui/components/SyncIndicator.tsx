import { useLiveQuery } from "dexie-react-hooks";
import { useSyncExternalStore } from "react";
import { useApp } from "../app-context";
import { useOnline } from "../hooks/useOnline";
import { describeSync, type IndicatorTone } from "../lib/syncLabel";

const DOT: Record<IndicatorTone, string> = { ok: "bg-ok", info: "bg-sky-600", warn: "bg-accent", danger: "bg-danger", muted: "bg-stone-400" };
const EMPTY = { subscribe: () => () => undefined, status: () => null } as const;

/** Header status: online/offline/syncing dot + label, from useOnline(), the Dexie outbox count and the sync engine. */
export function SyncIndicator() {
  const { s, sync } = useApp();
  const online = useOnline();
  const pending = useLiveQuery(() => s.db.outbox.count(), [s], 0);
  const engine = sync ?? EMPTY;
  const status = useSyncExternalStore(engine.subscribe, engine.status, engine.status);
  const ind = describeSync({ online, pending, status });
  return (
    <div role="status" aria-live="polite" title={ind.detail} data-testid="sync-indicator" data-state={ind.state} data-pending={pending} className="flex items-center gap-1.5 text-xs font-bold">
      <span aria-hidden className={`inline-block h-2.5 w-2.5 rounded-full ${DOT[ind.tone]}`} />
      <span>{ind.label}</span>
    </div>
  );
}
