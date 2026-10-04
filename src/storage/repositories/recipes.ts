import { RecipeSchema, type Recipe } from "../../domain/schemas/blueprint";
import { validateRecipe, parseJson, type IngestIssue } from "../../domain/ingest/parse";
import { compareStrings } from "../../domain/math/compare";
import type { RecipeRow } from "../db";
import { StorageError } from "../errors";
import { writeTx, type Ctx } from "../outbox";

/** Strip sync metadata and re-validate: corrupted rows fail loudly instead of reaching the engines. */
function toRecipe(row: RecipeRow): Recipe {
  const { _hlc, _deleted, ...rest } = row;
  const res = RecipeSchema.safeParse(rest);
  if (!res.success) {
    throw new StorageError("CORRUPT", `Stored recipe "${row.id}" no longer matches RecipeSchema: ${res.error.issues.map((i) => i.message).join("; ")}`);
  }
  return res.data;
}

export function recipesRepo(ctx: Ctx) {
  const { db } = ctx;
  return {
    async get(id: string, opts: { includeDeleted?: boolean } = {}): Promise<Recipe | undefined> {
      const row = await db.recipes.get(id);
      return row && (opts.includeDeleted || !row._deleted) ? toRecipe(row) : undefined;
    },

    async has(id: string): Promise<boolean> {
      const row = await db.recipes.get(id);
      return !!row && !row._deleted;
    },

    /** Active recipes (the roller pool), sorted by id. */
    async list(opts: { includeDeleted?: boolean } = {}): Promise<Recipe[]> {
      const rows = await db.recipes.toArray();
      return rows
        .filter((r) => opts.includeDeleted || !r._deleted)
        .sort((a, b) => compareStrings(a.id, b.id))
        .map(toRecipe);
    },

    /** Every recipe with its soft-delete flag (for the Recipes screen). */
    async listAll(): Promise<{ recipe: Recipe; deleted: boolean }[]> {
      const rows = await db.recipes.toArray();
      return rows.sort((a, b) => compareStrings(a.id, b.id)).map((r) => ({ recipe: toRecipe(r), deleted: r._deleted }));
    },

    /** Validate (Zod + domain invariants) then upsert. Re-saving a soft-deleted id revives it. */
    async put(input: unknown): Promise<Recipe> {
      const res = validateRecipe(input);
      if (!res.ok) throw new StorageError("VALIDATION", "Recipe failed validation.", res.errors);
      const recipe = res.recipe;
      await writeTx(ctx, [db.recipes, db.priceRegistry], async (tx) => {
        const ids = [...new Set(recipe.prep_items.map((p) => p.ingredient_id))].sort(compareStrings);
        const found = await db.priceRegistry.bulkGet(ids);
        const missing = ids.filter((_, i) => !found[i]);
        if (missing.length > 0) {
          throw new StorageError("UNRESOLVED_INGREDIENTS", `Unknown ingredient_id(s): ${missing.join(", ")}. Add them to the price registry first.`, [], missing);
        }
        const hlc = tx.stamp();
        await db.recipes.put({ ...recipe, _hlc: hlc, _deleted: false });
        await tx.log("recipe", recipe.id, hlc, { recipe, deleted: false });
      });
      return recipe;
    },

    /** Soft delete: cycle history and cooldown keep resolving the id. */
    async remove(id: string): Promise<void> {
      await setDeleted(id, true);
    },
    async restore(id: string): Promise<void> {
      await setDeleted(id, false);
    },

    /** Raw JSON for the in-app editor modal. */
    async toJson(id: string): Promise<string> {
      const r = await this.get(id, { includeDeleted: true });
      if (!r) throw new StorageError("NOT_FOUND", `Recipe "${id}" not found.`);
      return JSON.stringify(r, null, 2);
    },

    /** Editor save: JSON text → validation → upsert. Returns non-blocking warnings. */
    async saveJson(text: string): Promise<{ recipe: Recipe; warnings: IngestIssue[] }> {
      const parsed = parseJson(text);
      if (!parsed.ok) throw new StorageError("VALIDATION", parsed.error.message, [parsed.error]);
      const res = validateRecipe(parsed.value);
      if (!res.ok) throw new StorageError("VALIDATION", "Recipe failed validation.", res.errors);
      return { recipe: await this.put(res.recipe), warnings: res.warnings };
    },
  };

  async function setDeleted(id: string, deleted: boolean): Promise<void> {
    await writeTx(ctx, [db.recipes], async (tx) => {
      const row = await db.recipes.get(id);
      if (!row) throw new StorageError("NOT_FOUND", `Recipe "${id}" not found.`);
      if (row._deleted === deleted) return;
      const hlc = tx.stamp();
      await db.recipes.put({ ...row, _hlc: hlc, _deleted: deleted });
      await tx.log("recipe", id, hlc, { recipe: toRecipe(row), deleted });
    });
  }
}
