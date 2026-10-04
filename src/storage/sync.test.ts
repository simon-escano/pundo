/* eslint-disable @typescript-eslint/no-explicit-any -- scripted fetch bodies and canned payloads are loosely typed on purpose */
import { describe, expect, it, vi } from "vitest";
import type { Change } from "../domain/sync/protocol";
import { applyChanges, backoffDelay, browserEnv, createSyncEngine, type SyncEnv, type SyncOptions } from "./sync";
import type { Storage } from "./index";
import { makeHarness } from "./testing/harness";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const quiet = () => ({ warn: vi.fn() });
const W = 1_800_000_000_000; // newer than the harness clock (1.79e12)
const H = (n: number, dev = "remote") => `${String(W + n).padStart(15, "0")}-00000-${dev}`;

type Handler = (url: string, body: unknown) => Response | Promise<Response>;
function scripted(push: Handler, pull: Handler) {
  const calls: { url: string; body: any }[] = [];
  const fetch = (async (input: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: String(input), body });
    return String(input).includes("/push") ? push(String(input), body) : pull(String(input), body);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls, pushes: () => calls.filter((c) => c.url.includes("/push")), pulls: () => calls.filter((c) => c.url.includes("/pull")) };
}
const allApplied = (_u: string, b: any) => json({ results: b.mutations.map((m: any) => ({ client_seq: m.client_seq, status: "applied" })), cursor: 1 });
const emptyPull = (_u: string, _b: unknown) => json({ changes: [], cursor: 0, has_more: false });
const engine = (s: Storage, o: SyncOptions) => createSyncEngine(s.ctx, { log: quiet(), ...o });
const ch = (seq: number, entity: Change["entity"], entity_key: string, hlc: string, payload: unknown, device_id = "remote"): Change => ({ seq, entity, entity_key, hlc, device_id, payload });

async function withOutbox(n: number) {
  const h = makeHarness();
  const s = await h.open({ seed: false });
  for (let i = 0; i < n; i++) await s.cycles.create({ start_date: "2026-10-04", seed: i });
  return { h, s };
}

describe("push phase", () => {
  it("sends the outbox in batches, in order, and clears acknowledged rows", async () => {
    const { s } = await withOutbox(5);
    const net = scripted(allApplied, emptyPull);
    const r = await engine(s, { fetch: net.fetch, batchSize: 2 }).syncOnce();
    expect(r).toMatchObject({ ok: true, pushed: 5 });
    expect(net.pushes().map((p) => p.body.mutations.length)).toEqual([2, 2, 1]);
    const seqs = net.pushes().flatMap((p) => p.body.mutations.map((m: any) => m.client_seq));
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(net.pushes()[0]!.body.device_id).toBe(s.deviceId);
    expect(net.pushes()[0]!.body.mutations[0]).toMatchObject({ entity: "cycle", device_id: s.deviceId, entity_key: expect.any(String), hlc: expect.any(String) });
    expect(await s.db.outbox.count()).toBe(0);
  });

  it("drops applied, stale and invalid rows; keeps 'retry' rows and does not re-send them within the run", async () => {
    const { s } = await withOutbox(4);
    const log = quiet();
    const status = ["applied", "stale", "invalid", "retry"] as const;
    const net = scripted((_u, b: any) => json({ results: b.mutations.map((m: any, i: number) => ({ client_seq: m.client_seq, status: status[i], message: "bad" })), cursor: 1 }), emptyPull);
    const r = await createSyncEngine(s.ctx, { fetch: net.fetch, log }).syncOnce();
    expect(r).toMatchObject({ ok: true, pushed: 3, rejected: 1 });
    expect(net.pushes()).toHaveLength(1); // the retry row did not hot-loop
    expect(await s.db.outbox.count()).toBe(1);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("rejected cycle"));
  });

  it("surfaces why 'retry' rows are held (e.g. clock skew), warns once, and clears it when they land", async () => {
    const { s } = await withOutbox(1);
    const log = quiet();
    let held = true;
    const net = scripted((u, b: any) => held ? json({ results: b.mutations.map((m: any) => ({ client_seq: m.client_seq, status: "retry", message: "clock skew: 3600s ahead" })), cursor: 1 }) : allApplied(u, b), emptyPull);
    const e = createSyncEngine(s.ctx, { fetch: net.fetch, log });
    await e.syncOnce();
    await e.syncOnce();
    expect(e.status()).toMatchObject({ state: "idle", blocked: "clock skew: 3600s ahead", pending: 1 });
    expect(log.warn).toHaveBeenCalledTimes(1);
    held = false;
    await e.syncOnce();
    expect(e.status()).toMatchObject({ blocked: null, pending: 0 });
  });

  it("keeps rows the server gave no verdict for", async () => {
    const { s } = await withOutbox(2);
    const net = scripted((_u, b: any) => json({ results: [{ client_seq: b.mutations[0].client_seq, status: "applied" }], cursor: 1 }), emptyPull);
    await engine(s, { fetch: net.fetch }).syncOnce();
    expect(await s.db.outbox.count()).toBe(1);
  });

  it("rows written while a push is in flight are not lost", async () => {
    const { s } = await withOutbox(1);
    let wrote = false;
    const net = scripted(async (u, b) => {
      if (!wrote) { wrote = true; await s.cycles.create({ start_date: "2026-10-11", seed: 9 }); } // a local edit lands mid-push
      return allApplied(u, b);
    }, emptyPull);
    await engine(s, { fetch: net.fetch }).syncOnce();
    expect(await s.db.outbox.count()).toBe(0); // the late row was picked up in the same run, not lost
    expect(net.pushes().flatMap((p) => p.body.mutations)).toHaveLength(2);
  });
});

describe("failure handling: never throws, never loses data", () => {
  const cases: [string, () => typeof fetch, string][] = [
    ["network failure", () => (async () => { throw new TypeError("Failed to fetch"); }) as never, "offline"],
    ["HTTP 500", () => (async () => json({ error: "x" }, 500)) as never, "error"],
    ["HTML instead of JSON (e.g. SPA fallback)", () => (async () => new Response("<html></html>", { status: 200 })) as never, "error"],
    ["JSON of the wrong shape", () => (async () => json({ nope: 1 })) as never, "error"],
  ];
  it.each(cases)("%s: resolves with ok=false, keeps the outbox, logs one warning", async (_n, mk, state) => {
    const { s } = await withOutbox(2);
    const log = quiet();
    const e = createSyncEngine(s.ctx, { fetch: mk(), log });
    const r = await e.syncOnce();
    expect(r.ok).toBe(false);
    expect(await s.db.outbox.count()).toBe(2);
    expect(e.status()).toMatchObject({ state, failures: 1, pending: 2 });
    await e.syncOnce();
    expect(e.status().failures).toBe(2);
    expect(log.warn).toHaveBeenCalledTimes(1); // identical consecutive failures don't spam
  });

  it("a failure during pull leaves the cursor untouched", async () => {
    const h = makeHarness();
    const s = await h.open({ seed: false });
    const net = scripted(allApplied, () => json({ changes: [{ bogus: true }], cursor: 5, has_more: false }));
    expect((await engine(s, { fetch: net.fetch }).syncOnce()).ok).toBe(false);
    expect(await s.db.syncMeta.get("pullCursor")).toBeUndefined();
  });

  it("recovers: failure then success resets the failure count and clears the error", async () => {
    const { s } = await withOutbox(1);
    let up = false;
    const net = scripted((u, b) => (up ? allApplied(u, b) : Promise.reject(new TypeError("down"))), emptyPull);
    const e = engine(s, { fetch: net.fetch });
    await e.syncOnce();
    expect(e.status().state).toBe("offline");
    up = true;
    await e.syncOnce();
    expect(e.status()).toMatchObject({ state: "idle", failures: 0, lastError: null, pending: 0 });
  });

  it("concurrent syncOnce calls share one run", async () => {
    const { s } = await withOutbox(1);
    const net = scripted(allApplied, emptyPull);
    const e = engine(s, { fetch: net.fetch });
    const [a, b] = await Promise.all([e.syncOnce(), e.syncOnce()]);
    expect(a).toBe(b);
    expect(net.pushes()).toHaveLength(1);
  });

  it("status subscribers are notified and can unsubscribe", async () => {
    const { s } = await withOutbox(1);
    const net = scripted(allApplied, emptyPull);
    const seen: string[] = [];
    const e = engine(s, { fetch: net.fetch });
    const off = e.subscribe((st) => seen.push(st.state));
    await e.syncOnce();
    off();
    await e.syncOnce();
    expect(seen).toEqual(["syncing", "idle"]);
  });
});

describe("pull phase", () => {
  it("applies changes, pages with has_more, and persists the cursor", async () => {
    const h = makeHarness();
    const s = await h.open({ seed: false });
    const cyc = (id: string, n: number) => ({ id, start_date: "2026-10-04", seed: 1, global_portions: 10, status: "draft", updated_at: H(n) });
    const net = scripted(allApplied, (u) =>
      u.includes("since=0")
        ? json({ changes: [ch(1, "cycle", "a", H(1), cyc("a", 1))], cursor: 1, has_more: true })
        : json({ changes: [ch(2, "cycle", "b", H(2), cyc("b", 2))], cursor: 2, has_more: false }),
    );
    const r = await engine(s, { fetch: net.fetch, pullLimit: 1 }).syncOnce();
    expect(r).toMatchObject({ ok: true, pulled: 2 });
    expect(net.pulls().map((p) => p.url)).toEqual(["/api/sync/pull?since=0&limit=1", "/api/sync/pull?since=1&limit=1"]);
    expect((await s.db.syncMeta.get("pullCursor"))?.value).toBe(2);
    expect((await s.cycles.list()).map((c) => c.id).sort()).toEqual(["a", "b"]);
    await engine(s, { fetch: net.fetch }).syncOnce();
    expect(net.pulls().at(-1)!.url).toContain("since=2");
  });

  it("merges the remote HLC so later local stamps sort after everything seen", async () => {
    const h = makeHarness();
    const s = await h.open({ seed: false });
    const future = H(5_000_000);
    const p = { id: "z", start_date: "2026-10-04", seed: 1, global_portions: 10, status: "draft", updated_at: future };
    await applyChanges(s.ctx, [ch(1, "cycle", "z", future, p)], 1);
    const mine = (await s.cycles.create({ start_date: "2026-10-11", seed: 1 })).updated_at;
    expect(mine > future).toBe(true);
    expect((await s.db.syncMeta.get("hlc"))?.value).toEqual(s.clock.state());
  });
});

describe("applyChanges: per-entity last-write-wins", () => {
  async function open() {
    const h = makeHarness();
    return h.open();
  }
  const cycleP = (id: string, h: string, over: object = {}) => ({ id, start_date: "2026-10-04", seed: 1, global_portions: 10, status: "draft", updated_at: h, ...over });

  it("newer remote wins, older remote is ignored; our own echoes are skipped", async () => {
    const s = await open();
    const c = await s.cycles.create({ start_date: "2026-10-04", seed: 1 });
    await s.db.outbox.clear();
    await applyChanges(s.ctx, [ch(1, "cycle", c.id, H(10), cycleP(c.id, H(10), { global_portions: 12 }))], 1);
    expect((await s.cycles.get(c.id))!.global_portions).toBe(12);
    await applyChanges(s.ctx, [ch(2, "cycle", c.id, H(5), cycleP(c.id, H(5), { global_portions: 7 }))], 2);
    expect((await s.cycles.get(c.id))!.global_portions).toBe(12);
    await applyChanges(s.ctx, [ch(3, "cycle", c.id, H(20, s.deviceId), cycleP(c.id, H(20, s.deviceId), { global_portions: 3 }), s.deviceId)], 3);
    expect((await s.cycles.get(c.id))!.global_portions).toBe(12); // own device echo: ignored
  });

  it("a pending local mutation with a newer stamp beats an incoming change", async () => {
    const s = await open();
    const c = await s.cycles.create({ start_date: "2026-10-04", seed: 1 });
    const mine = await s.cycles.setGlobalPortions(c.id, 14); // unsent, stamped ~1.79e12
    const older = H(-1_000_000_000_000 + 100); // below our stamp
    await applyChanges(s.ctx, [ch(1, "cycle", c.id, older, cycleP(c.id, older, { global_portions: 5 }))], 1);
    expect((await s.cycles.get(c.id))!.global_portions).toBe(14);
    expect(mine.updated_at > older).toBe(true);
  });

  it("recipes: remote edit applies with its stamp; soft-delete flag and revival follow LWW", async () => {
    const s = await open();
    const r = (await s.recipes.get("pinakbet"))!;
    await applyChanges(s.ctx, [ch(1, "recipe", "pinakbet", H(1), { recipe: { ...r, name: "Remote Pinakbet" }, deleted: false })], 1);
    expect((await s.recipes.get("pinakbet"))!.name).toBe("Remote Pinakbet");
    await applyChanges(s.ctx, [ch(2, "recipe", "pinakbet", H(2), { recipe: r, deleted: true })], 2);
    expect(await s.recipes.has("pinakbet")).toBe(false);
    await applyChanges(s.ctx, [ch(3, "recipe", "pinakbet", H(1), { recipe: { ...r, name: "zombie" }, deleted: false })], 3);
    expect(await s.recipes.has("pinakbet")).toBe(false);
    await applyChanges(s.ctx, [ch(4, "recipe", "pinakbet", H(3), { recipe: r, deleted: false })], 4);
    expect((await s.recipes.get("pinakbet"))!.name).toBe(r.name);
    await applyChanges(s.ctx, [ch(5, "recipe", "brand-new", H(4), { recipe: { ...r, id: "brand-new" }, deleted: false })], 5);
    expect(await s.recipes.has("brand-new")).toBe(true);
  });

  it("registry: new ingredients are created (price 0 until observations fold in); identity is LWW against seed rows", async () => {
    const s = await open();
    const o = (id: string, price: number, at: string) => ({ id, ingredient_id: "sili", kind: "observed", price, observed_at: at, cycle_id: null, device_id: "remote" });
    await applyChanges(s.ctx, [
      ch(1, "priceRegistry", "sili", H(1), { ingredient_id: "sili", display_name: "Sili", pricing_unit: "kg" }),
      ch(2, "priceObservation", "o1", H(2), o("o1", 100, "2026-10-05T00:00:00.000Z")),
      ch(3, "priceObservation", "o2", H(3), o("o2", 120, "2026-10-06T00:00:00.000Z")),
      ch(4, "priceObservation", "o2", H(3), o("o2", 999, "2026-10-06T00:00:00.000Z")), // duplicate id ignored
    ], 4);
    expect(await s.registry.get("sili")).toMatchObject({ display_name: "Sili", pricing_unit: "kg", price_per_unit: 108 });
    await applyChanges(s.ctx, [ch(5, "priceRegistry", "sili", H(9), { ingredient_id: "sili", display_name: "Siling labuyo", pricing_unit: "pack" })], 5);
    expect(await s.registry.get("sili")).toMatchObject({ display_name: "Siling labuyo", pricing_unit: "pack", price_per_unit: 108 });
    await applyChanges(s.ctx, [ch(6, "priceRegistry", "sili", H(2), { ingredient_id: "sili", display_name: "old", pricing_unit: "bottle" })], 6);
    expect((await s.registry.get("sili"))!.display_name).toBe("Siling labuyo");
    // a remote change to a SEEDED ingredient beats the seed stamp
    await applyChanges(s.ctx, [ch(7, "priceRegistry", "potato", H(1), { ingredient_id: "potato", display_name: "Patatas", pricing_unit: "kg" })], 7);
    expect((await s.registry.get("potato"))!.display_name).toBe("Patatas");
  });

  it("an observation that arrives before its registry row is folded in once the row arrives", async () => {
    const s = await open();
    const o = { id: "early", ingredient_id: "kalamansi", kind: "observed", price: 80, observed_at: "2026-10-05T00:00:00.000Z", cycle_id: null, device_id: "remote" };
    await applyChanges(s.ctx, [ch(1, "priceObservation", "early", H(1), o)], 1);
    await applyChanges(s.ctx, [ch(2, "priceRegistry", "kalamansi", H(2), { ingredient_id: "kalamansi", display_name: "Kalamansi", pricing_unit: "kg" })], 2);
    expect((await s.registry.get("kalamansi"))!.price_per_unit).toBe(80);
  });

  it("meta, grocery state and pantry (including deletes) follow LWW", async () => {
    const s = await open();
    const meta = (h: string, aisle: string) => ({ ingredient_id: "potato", aisle, storage_class: "loose_produce", surface_prep: null, avg_unit_mass_g: 150, updated_at: h });
    await applyChanges(s.ctx, [ch(1, "ingredientMeta", "potato", H(5), meta(H(5), "canned_dry")), ch(2, "ingredientMeta", "potato", H(4), meta(H(4), "produce"))], 2);
    expect((await s.meta.get("potato"))!.aisle).toBe("canned_dry");

    const c = await s.cycles.create({ start_date: "2026-10-04", seed: 1 });
    const g = (h: string, bought: boolean) => ({ cycle_id: c.id, line_key: "potato|g|cycle", deduct_stock: true, bought, paid_php: null, updated_at: h });
    await applyChanges(s.ctx, [ch(3, "groceryLineState", `${c.id}|potato|g|cycle`, H(5), g(H(5), true)), ch(4, "groceryLineState", `${c.id}|potato|g|cycle`, H(4), g(H(4), false))], 4);
    expect((await s.groceryState.get(c.id, "potato|g|cycle"))!.bought).toBe(true);

    const p = (h: string, q: number) => ({ ingredient_id: "potato", state: "loose", quantity: q, unit: "g", opened_cycle_id: null, updated_at: h });
    await applyChanges(s.ctx, [ch(5, "pantry", "potato|loose", H(1), p(H(1), 500))], 5);
    expect((await s.pantry.list())[0]!.quantity).toBe(500);
    await applyChanges(s.ctx, [ch(6, "pantry", "potato|loose", H(2), null)], 6);
    expect(await s.pantry.list()).toEqual([]);
    await applyChanges(s.ctx, [ch(7, "pantry", "potato|loose", H(1), null)], 7); // delete for a row we don't have: no-op
    await applyChanges(s.ctx, [ch(8, "pantry", "potato|loose", H(3), p(H(3), 250)), ch(9, "pantry", "potato|loose", H(2), p(H(2), 1))], 9);
    expect((await s.pantry.list())[0]!.quantity).toBe(250);
  });

  it("plan dishes: placement, eviction by a newer placement, server-originated deletes, and the clash rule", async () => {
    const s = await open();
    const c = await s.cycles.create({ start_date: "2026-10-04", seed: 1 });
    const d = (week: number, slot: number, recipe: string, h: string) => ({ cycle_id: c.id, week, slot, recipe_id: recipe, locked: false, portion_override: null, _hlc: h });
    const key = (w: number, sl: number) => `${c.id}|${w}|${sl}`;
    const slots = async () => (await s.cycles.getPlan(c.id)).dishes.map((x) => `${x.week}-${x.slot}:${x.recipe_id}`);

    await applyChanges(s.ctx, [ch(1, "cycleDish", key(1, 0), H(1), d(1, 0, "pinakbet", H(1)))], 1);
    await applyChanges(s.ctx, [ch(2, "cycleDish", key(1, 1), H(2), d(1, 1, "pinakbet", H(2)))], 2); // same recipe, newer slot: evicts 1-0
    expect(await slots()).toEqual(["1-1:pinakbet"]);
    await applyChanges(s.ctx, [ch(3, "cycleDish", key(2, 2), H(1), d(2, 2, "pinakbet", H(1)))], 3); // older clash: ignored
    expect(await slots()).toEqual(["1-1:pinakbet"]);
    await applyChanges(s.ctx, [ch(4, "cycleDish", key(1, 1), H(1), d(1, 1, "pork-adobo", H(1)))], 4); // older than local: ignored
    expect(await slots()).toEqual(["1-1:pinakbet"]);
    await applyChanges(s.ctx, [ch(5, "cycleDish", key(1, 0), H(5), d(1, 0, "pork-adobo", H(5)))], 5);
    expect(await slots()).toEqual(["1-0:pork-adobo", "1-1:pinakbet"]);
    await applyChanges(s.ctx, [ch(6, "cycleDish", key(1, 0), H(6), null)], 6); // server eviction
    expect(await slots()).toEqual(["1-1:pinakbet"]);
    await applyChanges(s.ctx, [ch(7, "cycleDish", key(2, 0), H(7), null)], 7); // delete of a row we don't have
    await applyChanges(s.ctx, [ch(8, "cycleDish", key(1, 1), H(1), null)], 8); // delete older than local: ignored
    expect(await slots()).toEqual(["1-1:pinakbet"]);
  });

  it("invalid remote payloads are skipped with a warning, not applied and not fatal", async () => {
    const s = await open();
    const warn = vi.fn();
    await applyChanges(s.ctx, [ch(1, "cycle", "c1", H(1), { id: "c1", status: "weird" }), ch(2, "cycle", "k", H(2), cycleP("other", H(2)))], 2, warn);
    expect(await s.cycles.list()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect((await s.db.syncMeta.get("pullCursor"))?.value).toBe(2); // the cursor still advances past poison
  });

  it("is atomic: a failure mid-page applies nothing and keeps the old cursor", async () => {
    const s = await open();
    const spy = vi.spyOn(s.db.cycles, "put").mockRejectedValueOnce(new Error("disk full"));
    await expect(applyChanges(s.ctx, [ch(1, "cycle", "a", H(1), cycleP("a", H(1))), ch(2, "cycle", "b", H(2), cycleP("b", H(2)))], 2)).rejects.toThrow("disk full");
    spy.mockRestore();
    expect(await s.cycles.list()).toEqual([]);
    expect(await s.db.syncMeta.get("pullCursor")).toBeUndefined();
  });
});

describe("the loop: triggers and backoff", () => {
  function fakeEnv(opts: { online?: boolean } = {}) {
    let online = opts.online ?? true;
    let nextId = 0;
    const timers = new Map<number, { fn: () => void; ms: number }>();
    const handlers: Record<"online" | "visible", Set<() => void>> = { online: new Set(), visible: new Set() };
    const env: SyncEnv = {
      online: () => online,
      listen: (e, cb) => { handlers[e]!.add(cb); return () => void handlers[e]!.delete(cb); },
      setTimer: (fn, ms) => { const id = ++nextId; timers.set(id, { fn, ms }); return id; },
      clearTimer: (h) => void timers.delete(h as number),
      random: () => 1,
    };
    return {
      env,
      setOnline: (v: boolean) => (online = v),
      fire: (e: "online" | "visible") => handlers[e]!.forEach((h) => h()),
      pending: () => [...timers.values()],
      runTimer: () => { const [id, t] = [...timers.entries()][0]!; timers.delete(id); t.fn(); },
      runTimerAt: (i: number) => { const [id, t] = [...timers.entries()][i]!; timers.delete(id); t.fn(); },
      listeners: () => handlers.online.size + handlers.visible.size,
    };
  }
  const settle = () => new Promise((r) => setTimeout(r, 20));

  it("syncs immediately, then on the interval; the timer is re-armed each run", async () => {
    const { s } = await withOutbox(1);
    const net = scripted(allApplied, emptyPull);
    const f = fakeEnv();
    const stop = engine(s, { fetch: net.fetch, env: f.env, intervalMs: 30_000 }).start();
    await settle();
    expect(net.pushes()).toHaveLength(1);
    expect(f.pending().map((t) => t.ms)).toEqual([30_000]);
    f.runTimer();
    await settle();
    expect(net.pulls()).toHaveLength(2);
    stop();
  });

  it("an 'online' event or the tab becoming visible triggers a sync and resets backoff", async () => {
    const { s } = await withOutbox(1);
    let up = false;
    const net = scripted((u, b) => (up ? allApplied(u, b) : Promise.reject(new TypeError("down"))), emptyPull);
    const f = fakeEnv();
    const e = engine(s, { fetch: net.fetch, env: f.env, backoffBaseMs: 1000, backoffMaxMs: 8000 });
    const stop = e.start();
    await settle();
    expect(e.status().failures).toBe(1);
    up = true;
    f.fire("online");
    await settle();
    expect(e.status()).toMatchObject({ state: "idle", failures: 0 });
    f.fire("visible");
    await settle();
    expect(net.pushes().length).toBeGreaterThanOrEqual(2);
    stop();
  });

  it("exponential backoff on consecutive failures, capped, with jitter bounds", async () => {
    const { s } = await withOutbox(1);
    const net = scripted(() => Promise.reject(new TypeError("down")), emptyPull);
    const f = fakeEnv();
    const stop = engine(s, { fetch: net.fetch, env: f.env, backoffBaseMs: 1000, backoffMaxMs: 5000 }).start();
    const delays: number[] = [];
    for (let i = 0; i < 5; i++) {
      await settle();
      delays.push(f.pending()[0]!.ms);
      f.runTimer();
    }
    expect(delays).toEqual([1000, 2000, 4000, 5000, 5000]); // random()=1 → full delay
    expect(backoffDelay(3, 1000, 60_000, 0)).toBe(2000); // jitter floor is half
    expect(backoffDelay(1, 1000, 60_000, 0.5)).toBe(750);
    expect(backoffDelay(0, 1000, 60_000, 1)).toBe(1000);
    stop();
  });

  it("while offline it makes no requests and just waits", async () => {
    const { s } = await withOutbox(1);
    const net = scripted(allApplied, emptyPull);
    const f = fakeEnv({ online: false });
    const e = engine(s, { fetch: net.fetch, env: f.env, intervalMs: 5000 });
    const stop = e.start();
    await settle();
    expect(net.calls).toHaveLength(0);
    expect(e.status().state).toBe("offline");
    expect(f.pending().map((t) => t.ms)).toEqual([5000]);
    f.setOnline(true);
    f.fire("online");
    await settle();
    expect(net.pushes()).toHaveLength(1);
    stop();
  });

  it("a local change triggers a sync after the debounce (bursts collapse into one), not at the next poll", async () => {
    const { s } = await withOutbox(0);
    const net = scripted(allApplied, emptyPull);
    const f = fakeEnv();
    const stop = engine(s, { fetch: net.fetch, env: f.env, intervalMs: 30_000, debounceMs: 1_500 }).start();
    await settle();
    expect(net.pushes()).toHaveLength(0); // nothing to push yet
    await s.cycles.create({ start_date: "2026-10-04", seed: 1 });
    await s.cycles.create({ start_date: "2026-10-11", seed: 2 });
    await s.cycles.setGlobalPortions((await s.cycles.latest())!.id, 12);
    const debounce = f.pending().filter((t) => t.ms === 1_500);
    expect(debounce).toHaveLength(1); // three writes, ONE pending nudge
    expect(net.pushes()).toHaveLength(0); // nothing sent until it fires
    const idx = f.pending().findIndex((t) => t.ms === 1_500);
    f.runTimerAt(idx);
    await settle();
    expect(net.pushes()).toHaveLength(1);
    expect(net.pushes()[0]!.body.mutations.length).toBe(3);
    expect(await s.db.outbox.count()).toBe(0);
    stop();
  });

  it("stop() also cancels a pending nudge and detaches the outbox hook", async () => {
    const { s } = await withOutbox(0);
    const net = scripted(allApplied, emptyPull);
    const f = fakeEnv();
    const stop = engine(s, { fetch: net.fetch, env: f.env, debounceMs: 1_500 }).start();
    await settle();
    await s.cycles.create({ start_date: "2026-10-04", seed: 1 });
    expect(f.pending().some((t) => t.ms === 1_500)).toBe(true);
    stop();
    expect(f.pending()).toEqual([]);
    await s.cycles.create({ start_date: "2026-10-11", seed: 2 });
    expect(f.pending()).toEqual([]); // hook is gone: no new nudge
  });

  it("stop() cancels the timer and removes listeners; later events do nothing", async () => {
    const { s } = await withOutbox(1);
    const net = scripted(allApplied, emptyPull);
    const f = fakeEnv();
    const stop = engine(s, { fetch: net.fetch, env: f.env }).start();
    await settle();
    const before = net.calls.length;
    stop();
    expect(f.pending()).toEqual([]);
    expect(f.listeners()).toBe(0);
    f.fire("online");
    await settle();
    expect(net.calls.length).toBe(before);
  });
});

describe("browser glue", () => {
  it("browserEnv wires online / visibility events, timers and randomness to the real browser APIs", () => {
    const win = new EventTarget();
    const doc = Object.assign(new EventTarget(), { visibilityState: "hidden" });
    vi.stubGlobal("window", win);
    vi.stubGlobal("document", doc);
    vi.stubGlobal("navigator", { onLine: false });
    try {
      const env = browserEnv();
      expect(env.online()).toBe(false);
      const online = vi.fn();
      const visible = vi.fn();
      const offOnline = env.listen("online", online);
      const offVisible = env.listen("visible", visible);
      win.dispatchEvent(new Event("online"));
      expect(online).toHaveBeenCalledTimes(1);
      doc.dispatchEvent(new Event("visibilitychange")); // hidden: ignored
      expect(visible).not.toHaveBeenCalled();
      doc.visibilityState = "visible";
      doc.dispatchEvent(new Event("visibilitychange"));
      expect(visible).toHaveBeenCalledTimes(1);
      offOnline();
      offVisible();
      win.dispatchEvent(new Event("online"));
      doc.dispatchEvent(new Event("visibilitychange"));
      expect(online).toHaveBeenCalledTimes(1);
      expect(visible).toHaveBeenCalledTimes(1);
      const r = env.random();
      expect(r >= 0 && r < 1).toBe(true);
      const fired = vi.fn();
      env.clearTimer(env.setTimer(fired, 5)); // cancelled before it can fire
      return new Promise<void>((done) => setTimeout(() => { expect(fired).not.toHaveBeenCalled(); done(); }, 20));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("defaults to the global fetch and a relative base URL", async () => {
    const h = makeHarness();
    const s = await h.open({ seed: false });
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (u: string) => { seen.push(u); return u.includes("pull") ? json({ changes: [], cursor: 0, has_more: false }) : json({ results: [], cursor: 0 }); });
    try {
      expect((await createSyncEngine(s.ctx, { log: quiet() }).syncOnce()).ok).toBe(true);
      expect(seen).toEqual(["/api/sync/pull?since=0&limit=200"]);
      await s.cycles.create({ start_date: "2026-10-04", seed: 1 });
      await createSyncEngine(s.ctx, { baseUrl: "https://edge.example", log: quiet() }).syncOnce();
      expect(seen).toContain("https://edge.example/api/sync/push");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
