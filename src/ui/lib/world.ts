import type { Recipe, GlobalPriceRegistry } from "../../domain/schemas/blueprint";
import type { Cycle, GroceryLineState, IngredientMeta, PantryEntry } from "../../domain/schemas/app";
import type { DishRow } from "../../storage/db";
import type { Storage } from "../../storage";

/** Everything the views need, read in one live query so screens never see a half-updated state. */
export type World = {
  cycle: Cycle | undefined;
  dishes: DishRow[];
  recipes: { recipe: Recipe; deleted: boolean }[];
  meta: Record<string, IngredientMeta>;
  registry: GlobalPriceRegistry;
  pantry: PantryEntry[];
  lineState: GroceryLineState[];
};

export async function loadWorld(s: Storage): Promise<World> {
  const cycle = await s.cycles.latest();
  const dishes = cycle ? (await s.cycles.getPlan(cycle.id)).dishes : [];
  const lineState = cycle ? await s.groceryState.forCycle(cycle.id) : [];
  const recipes = await s.recipes.listAll();
  const meta = await s.meta.all();
  const registry = await s.registry.snapshot();
  const pantry = await s.pantry.list();
  return { cycle, dishes, recipes, meta, registry, pantry, lineState };
}
