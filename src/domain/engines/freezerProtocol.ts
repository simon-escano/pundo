import type { IngredientMeta } from "../schemas/app";
import { compareStrings } from "../math/compare";
import { CUT_LABELS } from "./cuts";
import type { ScaledDish } from "./scaling";

export type Day1Task = {
  id: string;
  kind: "bag_label_meat" | "store_produce";
  ingredient_id: string;
  recipeIds: string[];
  text: string;
};

/**
 * Day 1 freezer prep (blueprint Stage 3): bag, label and flat-freeze Week 2 meats to piece specs;
 * store hardy loose produce unwashed in paper towels. Meats first, then produce, each by name.
 */
export function buildDay1Protocol(week2: readonly ScaledDish[], meta: Readonly<Record<string, IngredientMeta>>): Day1Task[] {
  const meats: Day1Task[] = [];
  const produce = new Map<string, { name: string; recipeIds: string[] }>();

  for (const dish of week2) {
    for (const it of dish.items) {
      const cls = meta[it.item.ingredient_id]?.storage_class;
      if (cls === "fresh_meat") {
        const cut = CUT_LABELS[it.item.cut_technique];
        const how =
          it.totalPieces !== null
            ? `cut ${it.totalPieces} ${cut.noun}`
            : `portion ${it.grossQuantity}${it.unitLabel}`;
        const note = it.item.cut_note ? ` (${it.item.cut_note})` : "";
        meats.push({
          id: `meat:${dish.recipe.id}:${it.item.ingredient_id}`,
          kind: "bag_label_meat",
          ingredient_id: it.item.ingredient_id,
          recipeIds: [dish.recipe.id],
          text: `Bag and label ${it.item.display_name.toLowerCase()} for ${dish.recipe.name}: ${how}${note}, freeze flat`,
        });
      } else if (cls === "loose_produce") {
        const e = produce.get(it.item.ingredient_id) ?? { name: it.item.display_name, recipeIds: [] };
        if (!e.recipeIds.includes(dish.recipe.id)) e.recipeIds.push(dish.recipe.id);
        produce.set(it.item.ingredient_id, e);
      }
    }
  }

  meats.sort((a, b) => compareStrings(a.text, b.text) || compareStrings(a.id, b.id));
  const produceTasks: Day1Task[] = [...produce]
    .sort((a, b) => compareStrings(a[1].name, b[1].name) || compareStrings(a[0], b[0]))
    .map(([id, e]) => ({
      id: `produce:${id}`,
      kind: "store_produce" as const,
      ingredient_id: id,
      recipeIds: e.recipeIds.sort(compareStrings),
      text: `Store ${e.name.toLowerCase()} unwashed in paper towels`,
    }));
  return [...meats, ...produceTasks];
}
