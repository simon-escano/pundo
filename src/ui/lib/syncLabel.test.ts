import { afterEach, describe, expect, it, vi } from "vitest";
import type { SyncStatus } from "../../storage/sync";
import { requestPersistentStorage } from "../persist";
import { describeSync } from "./syncLabel";

const st = (over: Partial<SyncStatus> = {}): SyncStatus => ({ state: "idle", pending: 0, lastSyncAt: "2026-10-04T08:00:00.000Z", lastError: null, failures: 0, blocked: null, rejected: 0, ...over });

describe("describeSync (header indicator)", () => {
  it("offline always wins, and shows what is queued on the device", () => {
    expect(describeSync({ online: false, pending: 0, status: st() })).toMatchObject({ state: "offline", label: "Offline", tone: "warn" });
    expect(describeSync({ online: false, pending: 1, status: st() }).label).toBe("Offline · 1 change queued");
    expect(describeSync({ online: false, pending: 3, status: null }).label).toBe("Offline · 3 changes queued");
  });

  it("without a sync engine (dev / fixtures) the app is simply 'Local only'", () => {
    expect(describeSync({ online: true, pending: 12, status: null })).toMatchObject({ state: "local", label: "Local only", tone: "muted" });
  });

  it("syncing, synced, and waiting-to-sync", () => {
    expect(describeSync({ online: true, pending: 2, status: st({ state: "syncing" }) })).toMatchObject({ state: "syncing", label: "Syncing…", tone: "info" });
    expect(describeSync({ online: true, pending: 0, status: st() })).toMatchObject({ state: "synced", label: "Synced", tone: "ok" });
    expect(describeSync({ online: true, pending: 0, status: st({ lastSyncAt: null }) }).detail).toBe("Up to date.");
    expect(describeSync({ online: true, pending: 4, status: st() })).toMatchObject({ state: "pending", label: "4 changes to sync" });
    expect(describeSync({ online: true, pending: 1, status: st() }).label).toBe("1 change to sync");
  });

  it("failures are named: unreachable server (retrying) vs a server-side error", () => {
    expect(describeSync({ online: true, pending: 2, status: st({ state: "offline", lastError: "network unreachable (x)" }) })).toMatchObject({ state: "unreachable", label: "Server unreachable · 2 changes queued", tone: "warn" });
    expect(describeSync({ online: true, pending: 0, status: st({ state: "offline", lastError: null }) }).detail).toBe("Will retry automatically.");
    expect(describeSync({ online: true, pending: 0, status: st({ state: "error", lastError: "server returned HTTP 500" }) })).toMatchObject({ state: "error", label: "Sync error", tone: "danger", detail: "server returned HTTP 500" });
    expect(describeSync({ online: true, pending: 0, status: st({ state: "error" }) }).detail).toBe("The server reported a problem.");
  });

  it("a server hold for clock skew tells the user what to fix", () => {
    const i = describeSync({ online: true, pending: 3, status: st({ blocked: "clock skew: 3600s ahead of server time" }) });
    expect(i).toMatchObject({ state: "blocked", label: "Check device clock · 3 changes queued", tone: "danger" });
    expect(i.detail).toContain("clock skew");
  });
});

describe("requestPersistentStorage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("asks the browser to persist and reports the answer", async () => {
    const persist = vi.fn().mockResolvedValue(true);
    vi.stubGlobal("navigator", { storage: { persist } });
    expect(await requestPersistentStorage()).toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
    vi.stubGlobal("navigator", { storage: { persist: vi.fn().mockResolvedValue(false) } });
    expect(await requestPersistentStorage()).toBe(false);
  });

  it("is best effort: unsupported browsers and thrown errors resolve to null", async () => {
    vi.stubGlobal("navigator", {});
    expect(await requestPersistentStorage()).toBeNull();
    vi.stubGlobal("navigator", { storage: { persist: () => Promise.reject(new Error("SecurityError")) } });
    expect(await requestPersistentStorage()).toBeNull();
    vi.stubGlobal("navigator", undefined);
    expect(await requestPersistentStorage()).toBeNull();
  });
});
