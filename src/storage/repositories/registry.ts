import Dexie from "dexie";
import { GlobalPriceRegistrySchema, type GlobalPriceRegistry, type IngredientPriceRecord } from "../../domain/schemas/blueprint";
import { PriceObservationSchema, type PriceObservation } from "../../domain/schemas/app";
import { replayObservations } from "../../domain/engines/pricing";
import { compareStrings } from "../../domain/math/compare";
import { StorageError } from "../errors";
import { writeTx, type Ctx } from "../outbox";

type PricingUnit = IngredientPriceRecord["pricing_unit"];

/** Drop the sync stamp: callers see the plain blueprint record. */
const strip = (row: IngredientPriceRecord & { _hlc?: string }): IngredientPriceRecord => {
  const { _hlc, ...rest } = row;
  return rest;
};
export type NewIngredient = { ingredient_id: string; display_name: string; pricing_unit: PricingUnit; price?: number };

/**
 * Global Ingredient Price Registry. Observations are the source of truth; each registry row is a
 * cached deterministic fold (`replayObservations`) of its observations, so it can always be rebuilt.
 */
export function registryRepo(ctx: Ctx) {
  const { db } = ctx;

  async function recompute(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      const row = await db.priceRegistry.get(id);
      if (!row) continue;
      const obs = await db.priceObservations
        .where("[ingredient_id+observed_at]")
        .between([id, Dexie.minKey], [id, Dexie.maxKey])
        .toArray();
      const next = replayObservations({ [id]: { ...row, price_per_unit: 0 } }, obs)[id]!;
      if (next.price_per_unit !== row.price_per_unit || next.last_updated !== row.last_updated) {
        await db.priceRegistry.put(next);
      }
    }
  }

  return {
    /** Current registry, validated against GlobalPriceRegistrySchema. */
    async snapshot(): Promise<GlobalPriceRegistry> {
      const rows = await db.priceRegistry.toArray();
      const res = GlobalPriceRegistrySchema.safeParse(Object.fromEntries(rows.map((r) => [r.ingredient_id, r])));
      if (!res.success) throw new StorageError("CORRUPT", "Stored price registry no longer matches its schema.");
      return res.data;
    },

    async get(id: string): Promise<IngredientPriceRecord | undefined> {
      const row = await db.priceRegistry.get(id);
      return row && strip(row);
    },

    async observationsFor(id: string): Promise<PriceObservation[]> {
      return db.priceObservations.where("[ingredient_id+observed_at]").between([id, Dexie.minKey], [id, Dexie.maxKey]).toArray();
    },

    /**
     * One-time seed for a new ingredient: creates the record plus a `seed` observation
     * (PHP 0 when skipped, so the first real observation takes over). Existing ids are returned unchanged.
     */
    async ensure(input: NewIngredient): Promise<IngredientPriceRecord> {
      if (!(input.price === undefined || (Number.isFinite(input.price) && input.price >= 0))) {
        throw new StorageError("VALIDATION", "Seed price must be a non-negative number.");
      }
      return writeTx(ctx, [db.priceRegistry, db.priceObservations], async (tx) => {
        const existing = await db.priceRegistry.get(input.ingredient_id);
        if (existing) return strip(existing);
        const at = ctx.nowIso();
        const hlc = tx.stamp();
        const row = { ingredient_id: input.ingredient_id, display_name: input.display_name, price_per_unit: 0, pricing_unit: input.pricing_unit, last_updated: at, _hlc: hlc };
        const seed: PriceObservation = { id: ctx.newId(), ingredient_id: input.ingredient_id, kind: "seed", price: input.price ?? 0, observed_at: at, cycle_id: null, device_id: ctx.deviceId };
        await db.priceRegistry.put(row);
        await db.priceObservations.put(seed);
        await recompute([input.ingredient_id]);
        await tx.log("priceRegistry", input.ingredient_id, hlc, { ingredient_id: row.ingredient_id, display_name: row.display_name, pricing_unit: row.pricing_unit });
        await tx.log("priceObservation", seed.id, tx.stamp(), seed);
        return strip((await db.priceRegistry.get(input.ingredient_id))!);
      });
    },

    /** Append observations (idempotent by id), then re-fold the affected registry rows. */
    async appendObservations(input: readonly PriceObservation[]): Promise<{ added: number }> {
      const obs = input.map((o) => {
        const res = PriceObservationSchema.safeParse(o);
        if (!res.success) throw new StorageError("VALIDATION", `Invalid observation: ${res.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
        return res.data;
      });
      return writeTx(ctx, [db.priceRegistry, db.priceObservations], async (tx) => {
        const unique = [...new Map([...obs].reverse().map((o) => [o.id, o])).values()].reverse(); // first occurrence wins
        const existing = await db.priceObservations.bulkGet(unique.map((o) => o.id));
        const fresh = unique.filter((_, i) => !existing[i]);
        const ids = [...new Set(fresh.map((o) => o.ingredient_id))].sort(compareStrings);
        const known = await db.priceRegistry.bulkGet(ids);
        const unknown = ids.filter((_, i) => !known[i]);
        if (unknown.length > 0) throw new StorageError("MISSING_REGISTRY", `No registry record for: ${unknown.join(", ")}.`, [], unknown);
        for (const o of fresh) {
          await db.priceObservations.put(o);
          await tx.log("priceObservation", o.id, tx.stamp(), o);
        }
        await recompute(ids);
        return { added: fresh.length };
      });
    },

    /** Rebuild cached registry rows from observations (all rows, or the given ids). Derived, so not queued for sync. */
    async recalculate(ids?: readonly string[]): Promise<void> {
      await db.transaction("rw", [db.priceRegistry, db.priceObservations], async () => {
        await recompute(ids ?? (await db.priceRegistry.toCollection().primaryKeys()));
      });
    },
  };
}
