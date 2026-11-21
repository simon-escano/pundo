import type { AppRecipe as Recipe } from "../../domain/schemas/app";
import { LEGACY_SHAPE, shapeOf, slotsOf, type CycleShape } from "../../domain/engines/shape";
import { buildGroceryList, type GroceryList } from "../../domain/engines/grocery";
import { recipeCost, type RecipeCost } from "../../domain/engines/pricing";
import { scaleRecipe, type ScaledDish } from "../../domain/engines/scaling";
import type { DishRow } from "../../storage/db";
import type { World } from "./world";

export type SlotView = {
  week: 1 | 2;
  slot: 0 | 1 | 2;
  dish: DishRow | undefined;
  recipe: Recipe | undefined;
  portions: number;
  cost: RecipeCost | undefined;
};

export type Derived = {
  activeRecipes: Recipe[];
  shape: CycleShape; // plan size of the active cycle
  slots: SlotView[]; // every slot of the shape, in display order
  complete: boolean; // every slot filled
  scaled: ScaledDish[];
  grocery: GroceryList | null;
};

/** Pure projection of stored state through the domain engines. */
export function derive(world: World): Derived {
  const byId = new Map(world.recipes.map((r) => [r.recipe.id, r.recipe]));
  const cycle = world.cycle;
  const shape = cycle ? shapeOf(cycle) : LEGACY_SHAPE;
  const slots: SlotView[] = slotsOf(shape).map(({ week, slot }) => {
    const dish = world.dishes.find((d) => d.week === week && d.slot === slot);
    const recipe = dish ? byId.get(dish.recipe_id) : undefined;
    const portions = dish?.portion_override ?? cycle?.global_portions ?? 10;
    return { week, slot, dish, recipe, portions, cost: recipe ? recipeCost(recipe, portions, world.registry) : undefined };
  });
  const complete = slots.every((s) => s.recipe);
  const scaled = slots.flatMap((s) => (s.recipe ? [scaleRecipe(s.recipe, s.portions, s.week)] : []));
  const grocery =
    complete && cycle
      ? buildGroceryList({ cycleId: cycle.id, dishes: scaled, pantry: world.pantry, meta: world.meta, registry: world.registry, lineState: world.lineState })
      : null;
  return { activeRecipes: world.recipes.filter((r) => !r.deleted).map((r) => r.recipe), shape, slots, complete, scaled, grocery };
}
