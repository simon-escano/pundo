import type { SyncStatus } from "../../storage/sync";

export type IndicatorState = "auth" | "offline" | "syncing" | "synced" | "pending" | "unreachable" | "blocked" | "error" | "local";
export type IndicatorTone = "ok" | "info" | "warn" | "danger" | "muted";
export type Indicator = { state: IndicatorState; label: string; tone: IndicatorTone; detail: string };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * What the header dot says. `status` is null when no sync engine runs (dev, fixtures): the app is then
 * "Local only" and the outbox count is not meaningful to the user.
 */
export function describeSync(input: { online: boolean; pending: number; status: SyncStatus | null }): Indicator {
  const { online, pending, status } = input;
  const queued = pending > 0 ? ` · ${plural(pending, "change")} queued` : "";
  if (!online) return { state: "offline", label: `Offline${queued}`, tone: "warn", detail: "No connection. Everything still works and is saved on this device." };
  if (!status) return { state: "local", label: "Local only", tone: "muted", detail: "Sync is off in this build. Data is saved on this device." };
  if (status.auth) return { state: "auth", label: `Sign in again${queued}`, tone: "danger", detail: status.lastError ?? "Your session expired." };
  if (status.blocked) {
    return { state: "blocked", label: `Check device clock${queued}`, tone: "danger", detail: status.blocked };
  }
  if (status.state === "syncing") return { state: "syncing", label: "Syncing…", tone: "info", detail: "Sending and receiving changes." };
  if (status.state === "error") return { state: "error", label: `Sync error${queued}`, tone: "danger", detail: status.lastError ?? "The server reported a problem." };
  if (status.state === "offline") return { state: "unreachable", label: `Server unreachable${queued}`, tone: "warn", detail: status.lastError ?? "Will retry automatically." };
  if (pending > 0) return { state: "pending", label: `${plural(pending, "change")} to sync`, tone: "info", detail: "Waiting for the next sync." };
  return { state: "synced", label: "Synced", tone: "ok", detail: status.lastSyncAt ? `Last synced ${status.lastSyncAt}` : "Up to date." };
}
