import type { Recipe } from "../schemas/blueprint";
import { compareBy, compareStrings } from "../math/compare";

type StovePriority = Recipe["stove_priority"];

export const STOVE_RANK: Record<StovePriority, 1 | 2 | 3> = {
  PRIORITY_1_SLOW_BRAISE: 1,
  PRIORITY_2_FAST_SAUTE: 2,
  PRIORITY_3_FINISH_LAST: 3,
};

export const STOVE_LABEL: Record<StovePriority, string> = {
  PRIORITY_1_SLOW_BRAISE: "Braise",
  PRIORITY_2_FAST_SAUTE: "Sauté",
  PRIORITY_3_FINISH_LAST: "Finish",
};

export const compareStovePriority = (a: StovePriority, b: StovePriority): number => STOVE_RANK[a] - STOVE_RANK[b];

type Stoveable = { stove_priority: StovePriority; name: string; id: string };

/** Burner order: Priority 1 first, then name, then id (stable and total). */
export function orderByStovePriority<T extends Stoveable>(dishes: readonly T[]): T[] {
  return [...dishes].sort(
    compareBy<T>(
      (a, b) => compareStovePriority(a.stove_priority, b.stove_priority),
      (a, b) => compareStrings(a.name, b.name),
      (a, b) => compareStrings(a.id, b.id),
    ),
  );
}
