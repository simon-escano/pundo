import type { Table } from "dexie";
import type { Entity, PundoDB } from "./db";
import type { HlcClock } from "./hlc";

export type Ctx = {
  db: PundoDB;
  clock: HlcClock;
  newId: () => string;
  nowIso: () => string;
  deviceId: string;
};

export type Tx = {
  /** A fresh HLC stamp: store it on the entity row and pass the same value to `log`. */
  stamp: () => string;
  /** Append to the outbox inside the current transaction. */
  log: (entity: Entity, key: string, hlc: string, payload: unknown | null) => Promise<void>;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Dexie tables are invariant in their row/key types
export type AnyTable = Table<any, any>;

/**
 * THE ATOMIC WRITE INVARIANT. Every repository mutation runs through here: one `rw` transaction
 * over the entity tables + outbox + syncMeta, so an entity write and its outbox entry commit or
 * roll back together. Nested calls join the surrounding transaction.
 */
export function writeTx<T>(ctx: Ctx, tables: readonly AnyTable[], fn: (tx: Tx) => Promise<T>): Promise<T> {
  const { db } = ctx;
  return db.transaction("rw", [...tables, db.outbox, db.syncMeta], async () => {
    const tx: Tx = {
      stamp: () => ctx.clock.tick(),
      log: async (entity, entity_key, hlc, payload) => {
        await db.outbox.add({ entity, entity_key, hlc, device_id: ctx.deviceId, payload });
      },
    };
    const out = await fn(tx);
    await db.syncMeta.put({ key: "hlc", value: ctx.clock.state() });
    return out;
  });
}

/** Seed/bootstrap writes: same single-transaction guarantee, but nothing is queued for sync. */
export function bootstrapTx<T>(ctx: Ctx, tables: readonly AnyTable[], fn: () => Promise<T>): Promise<T> {
  return ctx.db.transaction("rw", [...tables, ctx.db.syncMeta], fn);
}
