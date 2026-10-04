import {
  hlcToIso,
  MAX_PULL_PAGE,
  MAX_PUSH_BATCH,
  PullResponseSchema,
  PushResponseSchema,
  SEED_HLC,
  splitKey,
  validatePayload,
  type Change,
  type Entity,
  type Payload,
} from "../domain/sync/protocol";
import { parseHlc } from "./hlc";
import type { Ctx } from "./outbox";
import { registryRepo } from "./repositories/registry";

// Client sync engine: PUSH the outbox, then PULL remote changes. Offline-first: every failure is
// caught, logged once and retried with backoff; nothing here can throw into the UI or leave a
// partially applied state (pull pages and outbox clears are each a single Dexie transaction).

export type SyncState = "idle" | "syncing" | "offline" | "error";
export type SyncStatus = {
  state: SyncState;
  pending: number; // outbox rows not yet acknowledged
  lastSyncAt: string | null;
  lastError: string | null;
  failures: number; // consecutive failed runs (drives backoff)
  blocked: string | null; // why queued changes are being held by the server (e.g. clock skew), else null
  auth: boolean; // the session needs renewing (Cloudflare Access returned 401/403 or a login redirect)
  rejected: number; // mutations the server permanently refused (dropped, logged)
};
export type SyncResult = { ok: boolean; pushed: number; pulled: number; rejected: number; error?: string };

export type SyncEnv = {
  online: () => boolean;
  listen: (event: "online" | "visible", cb: () => void) => () => void;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  random: () => number;
};

export type SyncOptions = {
  baseUrl?: string;
  fetch?: typeof fetch;
  batchSize?: number;
  pullLimit?: number;
  intervalMs?: number; // steady-state poll period
  debounceMs?: number; // after a local change, wait this long (batching bursts) then sync
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  env?: SyncEnv;
  log?: Pick<Console, "warn">;
  onStatus?: (s: SyncStatus) => void;
};

export function browserEnv(): SyncEnv {
  return {
    online: () => navigator.onLine,
    listen: (event, cb) => {
      if (event === "online") {
        window.addEventListener("online", cb);
        return () => window.removeEventListener("online", cb);
      }
      const h = () => document.visibilityState === "visible" && cb();
      document.addEventListener("visibilitychange", h);
      return () => document.removeEventListener("visibilitychange", h);
    },
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    random: () => Math.random(),
  };
}

class SyncError extends Error {
  constructor(message: string, readonly network = false, readonly auth = false) {
    super(message);
  }
}

/** Exponential backoff with jitter: base·2^(n−1), capped, scaled into [50%, 100%]. */
export function backoffDelay(failures: number, base: number, max: number, random: number): number {
  return Math.round(Math.min(max, base * 2 ** Math.max(0, failures - 1)) * (0.5 + random / 2));
}

const TABLES = (c: Ctx) => [c.db.recipes, c.db.priceRegistry, c.db.priceObservations, c.db.ingredientMeta, c.db.cycles, c.db.cycleDishes, c.db.pantry, c.db.groceryLineState, c.db.outbox, c.db.syncMeta];

/**
 * Apply a page of remote changes in ONE transaction and advance the cursor with it.
 * Rules: last-write-wins by HLC per entity; a pending local mutation with a newer stamp wins;
 * our own echoed changes are skipped; the local HLC merges the newest remote stamp.
 */
export async function applyChanges(ctx: Ctx, changes: readonly Change[], cursor: number, warn: (m: string) => void = () => undefined): Promise<number> {
  const { db } = ctx;
  let applied = 0;
  await db.transaction("rw", TABLES(ctx), async () => {
    const pending = new Map<string, string>();
    for (const o of await db.outbox.toArray()) {
      const k = `${o.entity}|${o.entity_key}`;
      if ((pending.get(k) ?? "") < o.hlc) pending.set(k, o.hlc);
    }
    const recalc = new Set<string>();
    let newest = "";

    for (const c of changes) {
      if (c.hlc > newest) newest = c.hlc;
      if (c.device_id === ctx.deviceId) continue;
      if ((pending.get(`${c.entity}|${c.entity_key}`) ?? "") > c.hlc) continue; // our newer, unsent write wins
      const v = validatePayload(c.entity, c.entity_key, c.hlc, c.payload);
      if (!v.ok) {
        warn(`[sync] ignored invalid remote change #${c.seq} (${c.entity}): ${v.message}`);
        continue;
      }
      if (await applyOne(ctx, c.entity, c.entity_key, c.hlc, v.payload, recalc)) applied++;
    }

    if (recalc.size > 0) await registryRepo(ctx).recalculate([...recalc].sort());
    if (newest && parseHlc(newest)) ctx.clock.receive(newest);
    await db.syncMeta.put({ key: "hlc", value: ctx.clock.state() });
    await db.syncMeta.put({ key: "pullCursor", value: cursor });
  });
  return applied;
}

async function applyOne(ctx: Ctx, entity: Entity, key: string, hlc: string, payload: unknown, recalc: Set<string>): Promise<boolean> {
  const { db } = ctx;
  switch (entity) {
    case "recipe": {
      const p = payload as Payload["recipe"];
      const local = await db.recipes.get(p.recipe.id);
      if (local && local._hlc >= hlc) return false;
      await db.recipes.put({ ...p.recipe, _hlc: hlc, _deleted: p.deleted });
      return true;
    }
    case "priceRegistry": {
      const p = payload as Payload["priceRegistry"];
      const local = await db.priceRegistry.get(p.ingredient_id);
      if (!local) {
        await db.priceRegistry.put({ ingredient_id: p.ingredient_id, display_name: p.display_name, price_per_unit: 0, pricing_unit: p.pricing_unit, last_updated: hlcToIso(hlc), _hlc: hlc });
        recalc.add(p.ingredient_id);
        return true;
      }
      if ((local._hlc ?? SEED_HLC) >= hlc) return false;
      await db.priceRegistry.put({ ...local, display_name: p.display_name, pricing_unit: p.pricing_unit, _hlc: hlc });
      return true;
    }
    case "priceObservation": {
      const o = payload as Payload["priceObservation"];
      if (await db.priceObservations.get(o.id)) return false;
      await db.priceObservations.put(o);
      recalc.add(o.ingredient_id);
      return true;
    }
    case "ingredientMeta": {
      const m = payload as Payload["ingredientMeta"];
      const local = await db.ingredientMeta.get(m.ingredient_id);
      if (local && local.updated_at >= hlc) return false;
      await db.ingredientMeta.put(m);
      return true;
    }
    case "cycle": {
      const c = payload as Payload["cycle"];
      const local = await db.cycles.get(c.id);
      if (local && local.updated_at >= hlc) return false;
      await db.cycles.put(c);
      return true;
    }
    case "cycleDish": {
      if (payload === null) {
        const [cycle, week, slot] = splitKey(key, 3)!;
        const k: [string, number, number] = [cycle!, Number(week), Number(slot)];
        const local = await db.cycleDishes.get(k);
        if (!local || local._hlc >= hlc) return false;
        await db.cycleDishes.delete(k);
        return true;
      }
      const d = payload as Payload["cycleDish"];
      const local = await db.cycleDishes.get([d.cycle_id, d.week, d.slot]);
      if (local && local._hlc >= hlc) return false;
      // Intra-cycle exclusion: same recipe elsewhere in this cycle. Older placement loses; a newer one beats this change.
      const clashes = await db.cycleDishes.where("cycle_id").equals(d.cycle_id).filter((x) => x.recipe_id === d.recipe_id && !(x.week === d.week && x.slot === d.slot)).toArray();
      if (clashes.some((x) => x._hlc >= hlc)) return false;
      for (const x of clashes) await db.cycleDishes.delete([x.cycle_id, x.week, x.slot]);
      await db.cycleDishes.put({ ...d, _hlc: hlc });
      return true;
    }
    case "pantry": {
      if (payload === null) {
        const [ingredient, state] = splitKey(key, 2)!;
        const local = await db.pantry.get([ingredient!, state!]);
        if (!local || local.updated_at >= hlc) return false;
        await db.pantry.delete([ingredient!, state!]);
        return true;
      }
      const p = payload as Payload["pantry"];
      const local = await db.pantry.get([p.ingredient_id, p.state]);
      if (local && local.updated_at >= hlc) return false;
      await db.pantry.put(p);
      return true;
    }
    case "groceryLineState": {
      const g = payload as Payload["groceryLineState"];
      const local = await db.groceryLineState.get([g.cycle_id, g.line_key]);
      if (local && local.updated_at >= hlc) return false;
      await db.groceryLineState.put(g);
      return true;
    }
  }
}

export function createSyncEngine(ctx: Ctx, opts: SyncOptions = {}) {
  const { db } = ctx;
  const fetchImpl = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const base = opts.baseUrl ?? "";
  const batchSize = Math.min(opts.batchSize ?? 100, MAX_PUSH_BATCH);
  const pullLimit = Math.min(opts.pullLimit ?? 200, MAX_PULL_PAGE);
  const intervalMs = opts.intervalMs ?? 30_000;
  const debounceMs = opts.debounceMs ?? 1_500;
  const backoffBase = opts.backoffBaseMs ?? 2_000;
  const backoffMax = opts.backoffMaxMs ?? 5 * 60_000;
  const log = opts.log ?? console;

  let status: SyncStatus = { state: "idle", pending: 0, lastSyncAt: null, lastError: null, failures: 0, blocked: null, auth: false, rejected: 0 };
  const listeners = new Set<(s: SyncStatus) => void>();
  if (opts.onStatus) listeners.add(opts.onStatus);
  const set = (patch: Partial<SyncStatus>) => {
    status = { ...status, ...patch };
    listeners.forEach((l) => l(status));
  };
  let lastWarned = "";
  const warnOnce = (m: string) => {
    if (m !== lastWarned) log.warn(`[sync] ${m}`);
    lastWarned = m;
  };

  async function request<T>(path: string, init: RequestInit | undefined, parse: (x: unknown) => T | null): Promise<T> {
    let res: Response;
    try {
      // `manual`: an expired Cloudflare Access session answers with a redirect to a cross-origin login page, which
      // fetch would otherwise report as an opaque network failure. We want to recognise it and say so.
      res = await fetchImpl(`${base}${path}`, { ...init, redirect: "manual" });
    } catch (e) {
      throw new SyncError(`network unreachable (${e instanceof Error ? e.message : String(e)})`, true);
    }
    if (res.type === "opaqueredirect" || res.status === 401 || res.status === 403) {
      throw new SyncError("sign-in required: reload the page and log in again (your data is safe on this device)", false, true);
    }
    if (!res.ok) throw new SyncError(`server returned HTTP ${res.status}`);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new SyncError("unexpected response (not the sync API)");
    }
    const parsed = parse(body);
    if (parsed === null) throw new SyncError("unexpected response shape");
    return parsed;
  }

  async function pushPhase(): Promise<{ pushed: number; rejected: number; blocked: string | null }> {
    let pushed = 0;
    let rejected = 0;
    let blocked: string | null = null;
    const skip = new Set<number>(); // 'retry' rows stay queued but are not re-sent within this run
    for (;;) {
      const rows = await db.outbox.orderBy("seq").filter((r) => !skip.has(r.seq!)).limit(batchSize).toArray();
      if (rows.length === 0) break;
      const body = { device_id: ctx.deviceId, mutations: rows.map((r) => ({ client_seq: r.seq!, entity: r.entity, entity_key: r.entity_key, hlc: r.hlc, device_id: r.device_id, payload: r.payload })) };
      const res = await request("/api/sync/push", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, (x) => {
        const p = PushResponseSchema.safeParse(x);
        return p.success ? p.data : null;
      });
      const done: number[] = [];
      const answered = new Set<number>();
      for (const r of res.results) {
        answered.add(r.client_seq);
        if (r.status === "retry") {
          skip.add(r.client_seq);
          blocked ??= r.message ?? "waiting on the server";
        } else {
          done.push(r.client_seq);
          if (r.status === "invalid") {
            rejected++;
            const row = rows.find((x) => x.seq === r.client_seq);
            log.warn(`[sync] server rejected ${row?.entity}:${row?.entity_key} permanently: ${r.message ?? "invalid"}`);
          }
        }
      }
      for (const row of rows) if (!answered.has(row.seq!)) skip.add(row.seq!); // no verdict: keep and try again later
      await db.outbox.bulkDelete(done); // one transaction: all acknowledged rows leave together
      pushed += done.length;
    }
    return { pushed, rejected, blocked };
  }

  async function pullPhase(): Promise<number> {
    let pulled = 0;
    for (;;) {
      const cursor = (await db.syncMeta.get("pullCursor")) as { value: number } | undefined;
      const page = await request(`/api/sync/pull?since=${cursor?.value ?? 0}&limit=${pullLimit}`, undefined, (x) => {
        const p = PullResponseSchema.safeParse(x);
        return p.success ? p.data : null;
      });
      pulled += await applyChanges(ctx, page.changes, page.cursor, (m) => log.warn(m));
      if (!page.has_more) return pulled;
    }
  }

  let inflight: Promise<SyncResult> | null = null;

  /** One full push-then-pull pass. Never throws; concurrent calls share one run. */
  function syncOnce(): Promise<SyncResult> {
    if (inflight) return inflight;
    inflight = (async (): Promise<SyncResult> => {
      set({ state: "syncing" });
      try {
        const { pushed, rejected, blocked } = await pushPhase();
        if (blocked) warnOnce(`changes are being held: ${blocked}`);
        const pulled = await pullPhase();
        lastWarned = blocked ? `changes are being held: ${blocked}` : ""; // keep warning once while the hold persists
        set({ state: "idle", failures: 0, blocked, auth: false, lastError: null, lastSyncAt: ctx.nowIso(), pending: await db.outbox.count(), rejected: status.rejected + rejected });
        return { ok: true, pushed, pulled, rejected };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        warnOnce(msg);
        set({ state: e instanceof SyncError && e.network ? "offline" : "error", auth: e instanceof SyncError && e.auth, failures: status.failures + 1, lastError: msg, pending: await db.outbox.count().catch(() => status.pending) });
        return { ok: false, pushed: 0, pulled: 0, rejected: 0, error: msg };
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  /** Start the loop: immediately, on `online`, when the tab becomes visible, and on a timer (backoff on failure). Returns stop(). */
  function start(): () => void {
    const env = opts.env ?? browserEnv();
    let timer: unknown = null;
    let stopped = false;
    const schedule = (ms: number) => {
      if (timer !== null) env.clearTimer(timer);
      timer = stopped ? null : env.setTimer(() => void tick(), ms);
    };
    const tick = async () => {
      if (stopped) return;
      if (!env.online()) {
        set({ state: "offline" });
        schedule(intervalMs);
        return;
      }
      const r = await syncOnce();
      schedule(r.ok ? intervalMs : backoffDelay(status.failures, backoffBase, backoffMax, env.random()));
    };
    const kick = () => {
      set({ failures: 0 });
      void tick();
    };
    // Push soon after a local change instead of waiting for the next poll. The hook fires inside the writing
    // transaction, so the delay also guarantees the row is committed before we read the outbox.
    let nudge: unknown = null;
    const onLocalChange = () => {
      if (stopped) return;
      if (nudge !== null) env.clearTimer(nudge);
      nudge = env.setTimer(() => {
        nudge = null;
        void tick();
      }, debounceMs);
    };
    db.outbox.hook("creating", onLocalChange);
    const offs = [env.listen("online", kick), env.listen("visible", kick)];
    void tick();
    return () => {
      stopped = true;
      if (timer !== null) env.clearTimer(timer);
      if (nudge !== null) env.clearTimer(nudge);
      db.outbox.hook("creating").unsubscribe(onLocalChange);
      offs.forEach((off) => off());
    };
  }

  return {
    syncOnce,
    start,
    status: () => status,
    subscribe: (cb: (s: SyncStatus) => void) => {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
  };
}

export type SyncEngine = ReturnType<typeof createSyncEngine>;
