// Test-only: deterministic storage over an isolated fake-indexeddb factory.
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { createStorage, type Storage, type StorageOptions } from "../index";

export type Harness = {
  idb: IDBFactory;
  clock: { ms: number };
  open: (over?: Partial<StorageOptions>) => Promise<Storage>;
};

/** One harness = one fake IndexedDB. Calling `open()` again simulates a page reload on the same data. */
export function makeHarness(start = 1_790_000_000_000): Harness {
  const idb = new IDBFactory();
  const clock = { ms: start };
  let n = 0;
  return {
    idb,
    clock,
    open: (over = {}) =>
      createStorage({ name: "t", indexedDB: idb, IDBKeyRange, now: () => clock.ms, newId: () => `id-${String(++n).padStart(4, "0")}`, ...over }),
  };
}

export const outboxOf = (s: Storage) => s.db.outbox.orderBy("seq").toArray();
