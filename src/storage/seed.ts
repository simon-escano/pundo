import { RecipeSchema } from "../domain/schemas/blueprint";
import { validateRecipe } from "../domain/ingest/parse";
import { replayObservations } from "../domain/engines/pricing";
import { compareStrings } from "../domain/math/compare";
import type { PriceObservation } from "../domain/schemas/app";
import { StorageError } from "./errors";
import { bootstrapTx, type Ctx } from "./outbox";
import { SEED_HLC } from "./hlc";
import type { SeedData } from "./fixtures";

/**
 * Cold-start bootstrap. Runs once (guarded by syncMeta.seedVersion) in a single transaction.
 * Seed rows are stamped with SEED_HLC and are NOT queued in the outbox: every device bootstraps
 * identical data, and a later device's seed must never overwrite another device's edits.
 * Prices enter as deterministic `seed:<id>` observations so the registry stays a pure fold.
 */
export async function seedIfEmpty(ctx: Ctx, data: SeedData): Promise<boolean> {
  const { db } = ctx;
  const done = await db.syncMeta.get("seedVersion");
  if (done?.key === "seedVersion" && done.value >= data.version) return false;

  const recipes = data.recipes.map((raw) => {
    const res = validateRecipe(raw);
    if (!res.ok) throw new StorageError("VALIDATION", `Seed recipe invalid: ${res.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`, res.errors);
    return RecipeSchema.parse(res.recipe);
  });

  const ids = Object.keys(data.registry).sort(compareStrings);
  const observations: PriceObservation[] = ids.map((id) => ({
    id: `seed:${id}`,
    ingredient_id: id,
    kind: "seed",
    price: data.registry[id]!.price_per_unit,
    observed_at: data.registry[id]!.last_updated,
    cycle_id: null,
    device_id: "seed",
  }));
  const base = Object.fromEntries(ids.map((id) => [id, { ...data.registry[id]!, price_per_unit: 0 }]));
  const registry = replayObservations(base, observations);

  await bootstrapTx(ctx, [db.recipes, db.priceRegistry, db.priceObservations, db.ingredientMeta], async () => {
    await db.priceRegistry.bulkPut(Object.values(registry).map((r) => ({ ...r, _hlc: SEED_HLC })));
    await db.priceObservations.bulkPut(observations);
    await db.ingredientMeta.bulkPut(Object.values(data.meta).map((m) => ({ ...m, updated_at: SEED_HLC })));
    // Never clobber a recipe a user already has under the same id.
    const existing = new Set((await db.recipes.bulkGet(recipes.map((r) => r.id))).flatMap((r) => (r ? [r.id] : [])));
    await db.recipes.bulkPut(recipes.filter((r) => !existing.has(r.id)).map((r) => ({ ...r, _hlc: SEED_HLC, _deleted: false })));
    await db.syncMeta.put({ key: "seedVersion", value: data.version });
  });
  return true;
}
