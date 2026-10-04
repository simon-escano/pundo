import type { IngredientPriceRecord, Recipe } from "../domain/schemas/blueprint";
import type { Aisle, IngredientMeta, StorageClass } from "../domain/schemas/app";
import { ingestRecipe, type IngestIssue } from "../domain/ingest/parse";
import { reconcileRegistry, suggestPricingUnit } from "../domain/ingest/reconcile";
import type { MissingIngredient } from "../domain/ingest/reconcile";
import type { PundoDB } from "./db";
import { writeTx, type Ctx } from "./outbox";
import type { metaRepo } from "./repositories/meta";
import type { recipesRepo } from "./repositories/recipes";
import type { registryRepo } from "./repositories/registry";

type PricingUnit = IngredientPriceRecord["pricing_unit"];

/** One inline "New Ingredient Detected" row for the UI (M4). */
export type IngredientAction = {
  ingredient_id: string;
  display_name: string;
  needsPrice: boolean; // not in the Global Price Registry: needs pricing_unit (+ optional seed price)
  needsMeta: boolean; // no aisle / storage class yet
  suggestedPricingUnit: PricingUnit | null;
};

export type IngestPreview =
  | { ok: true; recipe: Recipe; warnings: IngestIssue[]; actions: IngredientAction[]; willUpdate: boolean }
  | { ok: false; errors: IngestIssue[]; warnings: IngestIssue[] };

export type IngredientResolution = {
  ingredient_id: string;
  pricing_unit?: PricingUnit;
  price?: number; // omit to continue with PHP 0
  aisle?: Aisle;
  storage_class?: StorageClass;
  surface_prep?: string | null;
  avg_unit_mass_g?: number | null;
};

export type CommitResult =
  | { ok: true; recipe: Recipe; created: boolean; warnings: IngestIssue[] }
  | { ok: false; code: "INVALID"; errors: IngestIssue[]; warnings: IngestIssue[] }
  | { ok: false; code: "UNRESOLVED_INGREDIENTS"; actions: IngredientAction[]; missingFields: Record<string, string[]> };

type Repos = { recipes: ReturnType<typeof recipesRepo>; registry: ReturnType<typeof registryRepo>; meta: ReturnType<typeof metaRepo> };

function buildActions(recipe: Recipe, missing: readonly MissingIngredient[], knownIds: readonly string[]): IngredientAction[] {
  return missing.map((m) => {
    const item = recipe.prep_items.find((p) => p.ingredient_id === m.ingredient_id)!;
    return {
      ingredient_id: m.ingredient_id,
      display_name: m.display_name,
      needsPrice: !knownIds.includes(m.ingredient_id),
      needsMeta: m.needsMeta,
      suggestedPricingUnit: suggestPricingUnit(item.unit),
    };
  });
}

/**
 * Ingest-to-save pipeline: raw JSON → Zod → domain invariants → reconcile against the stored
 * registry and ingredient meta. `preview` is read-only and returns the action items the UI must
 * collect; `commit` writes recipe + registry + meta + outbox in ONE transaction (all or nothing).
 */
export function ingestPipeline(ctx: Ctx, db: PundoDB, repos: Repos) {
  async function preview(text: string): Promise<IngestPreview> {
    const res = ingestRecipe(text);
    if (!res.ok) return res;
    const [registry, meta, willUpdate] = await Promise.all([repos.registry.snapshot(), repos.meta.all(), repos.recipes.has(res.recipe.id)]);
    const rec = reconcileRegistry(res.recipe, registry, meta);
    return { ok: true, recipe: res.recipe, warnings: res.warnings, actions: buildActions(res.recipe, rec.missing, rec.known), willUpdate };
  }

  async function commit(text: string, resolutions: readonly IngredientResolution[] = []): Promise<CommitResult> {
    const p = await preview(text);
    if (!p.ok) return { ok: false, code: "INVALID", errors: p.errors, warnings: p.warnings };

    const byId = new Map(resolutions.map((r) => [r.ingredient_id, r]));
    const missingFields: Record<string, string[]> = {};
    for (const a of p.actions) {
      const r = byId.get(a.ingredient_id);
      const need: string[] = [];
      if (a.needsPrice && !r?.pricing_unit) need.push("pricing_unit");
      if (a.needsMeta && !r?.aisle) need.push("aisle");
      if (a.needsMeta && !r?.storage_class) need.push("storage_class");
      if (need.length > 0) missingFields[a.ingredient_id] = need;
    }
    if (Object.keys(missingFields).length > 0) return { ok: false, code: "UNRESOLVED_INGREDIENTS", actions: p.actions, missingFields };

    await writeTx(ctx, [db.recipes, db.priceRegistry, db.priceObservations, db.ingredientMeta], async () => {
      for (const a of p.actions) {
        const r = byId.get(a.ingredient_id)!;
        if (a.needsPrice) {
          await repos.registry.ensure({
            ingredient_id: a.ingredient_id,
            display_name: a.display_name,
            pricing_unit: r.pricing_unit!,
            ...(r.price !== undefined ? { price: r.price } : {}),
          });
        }
        if (a.needsMeta) {
          await repos.meta.put({
            ingredient_id: a.ingredient_id,
            aisle: r.aisle!,
            storage_class: r.storage_class!,
            surface_prep: r.surface_prep ?? null,
            avg_unit_mass_g: r.avg_unit_mass_g ?? null,
          } satisfies Omit<IngredientMeta, "updated_at">);
        }
      }
      await repos.recipes.put(p.recipe);
    });
    return { ok: true, recipe: p.recipe, created: !p.willUpdate, warnings: p.warnings };
  }

  return { preview, commit };
}
