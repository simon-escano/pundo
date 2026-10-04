import { IDBKeyRange } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import { compareHlc, formatHlc, HlcClock, parseHlc, SEED_HLC } from "./hlc";
import { cryptoRandomBytes, uuidv7 } from "./ids";
import { StorageError } from "./errors";
import { writeTx } from "./outbox";
import { createStorage } from "./index";
import { makeHarness, outboxOf } from "./testing/harness";

describe("HLC", () => {
  it("tick is strictly monotonic even when the wall clock stalls or goes backwards", () => {
    let t = 1000;
    const c = new HlcClock("dev", () => t);
    const a = c.tick();
    const b = c.tick(); // same ms
    t = 500; // clock jumped backwards
    const d = c.tick();
    expect([a, b, d]).toEqual([...[a, b, d]].sort());
    expect(new Set([a, b, d]).size).toBe(3);
    expect(parseHlc(b)).toMatchObject({ wall: 1000, counter: 1, deviceId: "dev" });
  });
  it("tick resets the counter when the wall clock advances", () => {
    let t = 1000;
    const c = new HlcClock("d", () => t);
    c.tick(); c.tick();
    t = 2000;
    expect(parseHlc(c.tick())).toMatchObject({ wall: 2000, counter: 0 });
  });
  it("receive merges a remote stamp so later local stamps sort after it (all four branches)", () => {
    const mk = (wall: number, counter: number) => formatHlc({ wall, counter }, "remote");
    const t = 1000;
    const c = new HlcClock("me", () => t, { wall: 1000, counter: 3 });
    expect(parseHlc(c.receive(mk(1000, 7)))).toMatchObject({ wall: 1000, counter: 8 }); // equal walls
    expect(parseHlc(c.receive(mk(900, 1)))).toMatchObject({ wall: 1000, counter: 9 }); // local ahead
    const remote = mk(5000, 4);
    expect(parseHlc(c.receive(remote))).toMatchObject({ wall: 5000, counter: 5 }); // remote ahead
    expect(compareHlc(c.tick(), remote)).toBeGreaterThan(0);
    const fresh = new HlcClock("x", () => 9000, { wall: 100, counter: 5 });
    expect(parseHlc(fresh.receive(mk(200, 5)))).toMatchObject({ wall: 9000, counter: 0 }); // physical ahead
  });
  it("rejects malformed stamps and counter overflow", () => {
    expect(() => new HlcClock("d", () => 1).receive("nope")).toThrow(RangeError);
    const c = new HlcClock("d", () => 1, { wall: 1, counter: 99_999 });
    expect(() => c.tick()).toThrow("overflow");
    expect(() => new HlcClock("d", () => 1, { wall: 1, counter: 99_999 }).receive(formatHlc({ wall: 1, counter: 99_999 }, "r"))).toThrow("overflow");
  });
  it("device id breaks exact ties; the seed stamp is older than any real stamp", () => {
    expect(compareHlc(formatHlc({ wall: 5, counter: 0 }, "a"), formatHlc({ wall: 5, counter: 0 }, "b"))).toBeLessThan(0);
    expect(compareHlc(SEED_HLC, formatHlc({ wall: 1, counter: 0 }, "a"))).toBeLessThan(0);
    expect(parseHlc("garbage")).toBeNull();
  });
});

describe("ids", () => {
  it("uuidv7 is well-formed and time-ordered", () => {
    const a = uuidv7(1_700_000_000_000, cryptoRandomBytes);
    const b = uuidv7(1_700_000_001_000, cryptoRandomBytes);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });
});

describe("createStorage", () => {
  it("opens with default options, uuidv7 ids and the real clock (no injection)", async () => {
    const h = makeHarness();
    const s = await createStorage({ name: "defaults", indexedDB: h.idb, IDBKeyRange, seed: false });
    expect(s.deviceId).toMatch(/^[0-9a-f-]{36}$/);
    s.close();
  });
});

describe("atomic outbox (write invariant)", () => {
  it("an outbox row written in a transaction that later throws is rolled back together with the entity", async () => {
    const h = makeHarness();
    const s = await h.open({ seed: false });
    await expect(
      writeTx(s.ctx, [s.db.cycles], async (tx) => {
        const hlc = tx.stamp();
        await s.db.cycles.put({ id: "c", start_date: "2026-10-04", seed: 1, global_portions: 10, status: "draft", updated_at: hlc });
        await tx.log("cycle", "c", hlc, {});
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await s.db.cycles.count()).toBe(0);
    expect(await s.db.outbox.count()).toBe(0);
  });
  it("a failing outbox append rolls back the entity write (and the HLC checkpoint)", async () => {
    const h = makeHarness();
    const s = await h.open({ seed: false });
    const spy = vi.spyOn(s.db.outbox, "add").mockRejectedValueOnce(new Error("outbox down"));
    await expect(s.cycles.create({ start_date: "2026-10-04", seed: 1 })).rejects.toThrow("outbox down");
    spy.mockRestore();
    expect(await s.db.cycles.count()).toBe(0);
    expect(await s.db.outbox.count()).toBe(0);
    expect(await s.db.syncMeta.get("hlc")).toBeUndefined();
  });
  it("commits entity + outbox + HLC checkpoint together, with strictly increasing stamps", async () => {
    const h = makeHarness();
    const s = await h.open({ seed: false });
    const c = await s.cycles.create({ start_date: "2026-10-04", seed: 1 });
    await s.cycles.setGlobalPortions(c.id, 12);
    const rows = await outboxOf(s);
    expect(rows.map((r) => [r.entity, r.entity_key])).toEqual([["cycle", c.id], ["cycle", c.id]]);
    expect(rows.map((r) => r.hlc)).toEqual([...rows.map((r) => r.hlc)].sort());
    expect(rows[0]!.hlc).not.toBe(rows[1]!.hlc);
    expect(rows.every((r) => r.device_id === s.deviceId)).toBe(true);
    expect((await s.db.syncMeta.get("hlc"))?.value).toEqual(s.clock.state());
  });
});

describe("StorageError", () => {
  it("carries a code, issues and data", () => {
    const e = new StorageError("VALIDATION", "x", [{ path: "a", message: "m", severity: "error" }], 5);
    expect(e).toMatchObject({ name: "StorageError", code: "VALIDATION", data: 5 });
    expect(e.issues).toHaveLength(1);
  });
});
