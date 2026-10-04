import type { GlobalPriceRegistry, Recipe } from "../domain/schemas/blueprint";
import type { IngredientMeta } from "../domain/schemas/app";
import { compareStrings } from "../domain/math/compare";
import ingredients from "../../fixtures/ingredients.json";

export type SeedData = {
  version: number;
  recipes: unknown[];
  registry: GlobalPriceRegistry;
  meta: Record<string, IngredientMeta>;
};

export const SEED_VERSION = 1;

const recipeModules = import.meta.glob("../../fixtures/recipes/*.json", { eager: true, import: "default" }) as Record<string, Recipe>;

/** The bundled baseline: 15 recipes + the initial Global Ingredient Price Registry + ingredient meta. */
export function loadFixtureData(): SeedData {
  return {
    version: SEED_VERSION,
    recipes: Object.entries(recipeModules)
      .sort((a, b) => compareStrings(a[0], b[0]))
      .map(([, r]) => r),
    registry: ingredients.registry as GlobalPriceRegistry,
    meta: ingredients.meta as Record<string, IngredientMeta>,
  };
}
