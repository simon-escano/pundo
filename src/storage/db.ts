import Dexie, { type DexieOptions, type Table } from "dexie";
import type { IngredientPriceRecord, Recipe } from "../domain/schemas/blueprint";
import type {
  Cycle,
  CycleDish,
  GroceryLineState,
  IngredientMeta,
  PantryEntry,
  PriceObservation,
} from "../domain/schemas/app";
import type { HlcState } from "./hlc";

import type { Entity } from "../domain/sync/protocol";
export type { Entity };

// Rows that can conflict across devices carry their last-write HLC (`_hlc`, or `updated_at` where the schema has it).
export type RecipeRow = Recipe & { _hlc: string; _deleted: boolean };
export type DishRow = CycleDish & { _hlc: string };
/** Registry identity (name + pricing unit) is LWW by `_hlc`; the price itself is derived from observations. */
export type RegistryRow = IngredientPriceRecord & { _hlc?: string };

export type OutboxRow = {
  seq?: number; // auto-increment: the push cursor
  entity: Entity;
  entity_key: string;
  hlc: string;
  device_id: string;
  payload: unknown | null; // JSON document, null = delete
};

export type SyncMetaRow =
  | { key: "deviceId"; value: string }
  | { key: "hlc"; value: HlcState }
  | { key: "seedVersion"; value: number }
  | { key: "pullCursor"; value: number };

export class PundoDB extends Dexie {
  // `declare` (not `!`) so class-field semantics never overwrite the tables Dexie installs.
  declare recipes: Table<RecipeRow, string>;
  declare priceRegistry: Table<RegistryRow, string>;
  declare priceObservations: Table<PriceObservation, string>;
  declare ingredientMeta: Table<IngredientMeta, string>;
  declare cycles: Table<Cycle, string>;
  declare cycleDishes: Table<DishRow, [string, number, number]>;
  declare pantry: Table<PantryEntry, [string, string]>;
  declare groceryLineState: Table<GroceryLineState, [string, string]>;
  declare outbox: Table<OutboxRow, number>;
  declare syncMeta: Table<SyncMetaRow, string>;

  constructor(name: string, options?: DexieOptions) {
    super(name, options);
    this.version(1).stores({
      recipes: "id, perishability_tier, protein_category",
      priceRegistry: "ingredient_id",
      priceObservations: "id, [ingredient_id+observed_at]",
      ingredientMeta: "ingredient_id",
      cycles: "id, start_date",
      cycleDishes: "[cycle_id+week+slot], cycle_id, recipe_id",
      pantry: "[ingredient_id+state], ingredient_id",
      groceryLineState: "[cycle_id+line_key], cycle_id",
      outbox: "++seq, entity",
      syncMeta: "key",
    });
  }
}
