import { IngredientMetaSchema, type IngredientMeta } from "../../domain/schemas/app";
import { compareStrings } from "../../domain/math/compare";
import { StorageError } from "../errors";
import { writeTx, type Ctx } from "../outbox";

export type MetaInput = Omit<IngredientMeta, "updated_at">;
const InputSchema = IngredientMetaSchema.omit({ updated_at: true });

/** Aisle / storage class / surface prep / piece mass: the data the blueprint schema doesn't carry. */
export function metaRepo(ctx: Ctx) {
  const { db } = ctx;
  return {
    get: (id: string) => db.ingredientMeta.get(id),

    async all(): Promise<Record<string, IngredientMeta>> {
      const rows = await db.ingredientMeta.toArray();
      return Object.fromEntries(rows.sort((a, b) => compareStrings(a.ingredient_id, b.ingredient_id)).map((r) => [r.ingredient_id, r]));
    },

    /** Upsert. The ingredient must already exist in the price registry (mirrors the D1 foreign key). */
    async put(input: MetaInput): Promise<IngredientMeta> {
      const res = InputSchema.safeParse(input);
      if (!res.success) throw new StorageError("VALIDATION", `Invalid ingredient meta: ${res.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
      return writeTx(ctx, [db.ingredientMeta, db.priceRegistry], async (tx) => {
        if (!(await db.priceRegistry.get(res.data.ingredient_id))) {
          throw new StorageError("MISSING_REGISTRY", `No registry record for "${res.data.ingredient_id}".`, [], [res.data.ingredient_id]);
        }
        const hlc = tx.stamp();
        const row: IngredientMeta = { ...res.data, updated_at: hlc };
        await db.ingredientMeta.put(row);
        await tx.log("ingredientMeta", row.ingredient_id, hlc, row);
        return row;
      });
    },
  };
}
