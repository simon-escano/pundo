import { MealPrepDB } from "./db";
import { HlcClock } from "./hlc";
import { cryptoRandomBytes, uuidv7 } from "./ids";
import { loadFixtureData, type SeedData } from "./fixtures";
import { ingestPipeline } from "./ingest";
import type { Ctx } from "./outbox";
import { cyclesRepo } from "./repositories/cycles";
import { groceryStateRepo } from "./repositories/grocery";
import { metaRepo } from "./repositories/meta";
import { pantryRepo } from "./repositories/pantry";
import { recipesRepo } from "./repositories/recipes";
import { registryRepo } from "./repositories/registry";
import { seedIfEmpty } from "./seed";
import { createSyncEngine, type SyncOptions } from "./sync";

export type StorageOptions = {
  name?: string;
  indexedDB?: IDBFactory; // inject for tests (fake-indexeddb)
  IDBKeyRange?: typeof IDBKeyRange;
  now?: () => number;
  newId?: () => string;
  seed?: SeedData | false; // default: bundled fixtures
};

/** Composition root: opens the database, restores device id + HLC, bootstraps on first run, wires repositories. */
export async function createStorage(opts: StorageOptions = {}) {
  const now = opts.now ?? Date.now;
  const db = new MealPrepDB(opts.name ?? "meal-prep-engine", {
    ...(opts.indexedDB ? { indexedDB: opts.indexedDB } : {}),
    ...(opts.IDBKeyRange ? { IDBKeyRange: opts.IDBKeyRange } : {}),
  });
  await db.open();

  const newId = opts.newId ?? (() => uuidv7(now(), cryptoRandomBytes));
  const savedDevice = await db.syncMeta.get("deviceId");
  const deviceId = savedDevice?.key === "deviceId" ? savedDevice.value : newId();
  if (!savedDevice) await db.syncMeta.put({ key: "deviceId", value: deviceId });
  const savedHlc = await db.syncMeta.get("hlc");
  const clock = new HlcClock(deviceId, now, savedHlc?.key === "hlc" ? savedHlc.value : undefined);

  const ctx: Ctx = { db, clock, newId, deviceId, nowIso: () => new Date(now()).toISOString() };
  if (opts.seed !== false) await seedIfEmpty(ctx, opts.seed ?? loadFixtureData());

  const recipes = recipesRepo(ctx);
  const registry = registryRepo(ctx);
  const meta = metaRepo(ctx);
  return {
    db,
    ctx,
    deviceId,
    clock,
    recipes,
    registry,
    meta,
    cycles: cyclesRepo(ctx),
    pantry: pantryRepo(ctx),
    groceryState: groceryStateRepo(ctx),
    ingest: ingestPipeline(ctx, db, { recipes, registry, meta }),
    /** Edge sync engine (push outbox → pull remote). Call `.start()` to run the loop. */
    sync: (opts?: SyncOptions) => createSyncEngine(ctx, opts),
    close: () => db.close(),
  };
}

export type Storage = Awaited<ReturnType<typeof createStorage>>;
