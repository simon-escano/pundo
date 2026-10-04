import { z } from "zod";

// App-level schemas that sit beside (never inside) the blueprint schemas.
// Fills blueprint gaps: aisle, storage class, surface prep, piece mass.

export const AisleEnum = z.enum(["produce", "fresh_meat", "canned_dry", "disposable"]);
export const StorageClassEnum = z.enum([
  "loose_produce",
  "fresh_meat",
  "perishable_once_opened",
  "shelf_stable_sealed",
  "disposable",
]);

export const IngredientMetaSchema = z.object({
  ingredient_id: z.string(),
  aisle: AisleEnum,
  storage_class: StorageClassEnum,
  surface_prep: z.string().nullable(), // "Wash and peel"
  avg_unit_mass_g: z.number().positive().nullable(),
  updated_at: z.string(),
});

export const PriceObservationSchema = z.object({
  id: z.string(),
  ingredient_id: z.string(),
  kind: z.enum(["seed", "observed", "receipt_allocated", "override"]),
  price: z.number().nonnegative(), // per pricing_unit
  observed_at: z.string(),
  cycle_id: z.string().nullable(),
  device_id: z.string(),
});

export const CycleStatusEnum = z.enum(["draft", "locked", "shopped", "w1_cooked", "complete"]);

export const CycleSchema = z.object({
  id: z.string(),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  seed: z.number().int().min(0).max(0xffffffff),
  global_portions: z.number().int().min(1).max(30),
  status: CycleStatusEnum,
  updated_at: z.string(),
});

export const CycleDishSchema = z.object({
  cycle_id: z.string(),
  week: z.union([z.literal(1), z.literal(2)]),
  slot: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  recipe_id: z.string(),
  locked: z.boolean(),
  portion_override: z.number().int().min(1).max(30).nullable(),
});

export const PantryEntrySchema = z.object({
  ingredient_id: z.string(),
  state: z.enum(["loose", "sealed", "opened"]),
  quantity: z.number().nonnegative(),
  unit: z.string(),
  opened_cycle_id: z.string().nullable(),
  updated_at: z.string(),
});

export const GroceryLineStateSchema = z.object({
  cycle_id: z.string(),
  line_key: z.string(),
  deduct_stock: z.boolean(), // false = [Spoiled / Tossed]
  bought: z.boolean(),
  paid_php: z.number().nonnegative().nullable(),
  updated_at: z.string(),
});

export type Aisle = z.infer<typeof AisleEnum>;
export type StorageClass = z.infer<typeof StorageClassEnum>;
export type IngredientMeta = z.infer<typeof IngredientMetaSchema>;
export type PriceObservation = z.infer<typeof PriceObservationSchema>;
export type Cycle = z.infer<typeof CycleSchema>;
export type CycleDish = z.infer<typeof CycleDishSchema>;
export type PantryEntry = z.infer<typeof PantryEntrySchema>;
export type GroceryLineState = z.infer<typeof GroceryLineStateSchema>;
