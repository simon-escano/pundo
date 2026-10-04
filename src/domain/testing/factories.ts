// Test-only builders. Pure and deterministic; excluded from coverage.
import type { GlobalPriceRegistry, IngredientPriceRecord, PrepItem, Recipe } from "../schemas/blueprint";
import type { IngredientMeta, PantryEntry } from "../schemas/app";

export function makeItem(over: Partial<PrepItem> & { ingredient_id: string }): PrepItem {
  return {
    display_name: over.ingredient_id.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()),
    cut_technique: "NONE",
    cut_note: null,
    granularity: "granular",
    pieces_per_portion: null,
    quantity_per_portion: 10,
    unit: "g",
    ...over,
  };
}

export function makeRecipe(over: Partial<Recipe> & { id: string }): Recipe {
  return {
    name: over.id,
    default_portions: 10,
    protein_category: "pork",
    sauce_base: "clear_broth",
    perishability_tier: "TIER_2_HARDY",
    stove_priority: "PRIORITY_2_FAST_SAUTE",
    estimated_base_cost_php: 100,
    videos: [],
    prep_items: [],
    cook_steps: ["Stir until fragrant."],
    pack_step: "Fill solids first, sauce after.",
    ...over,
  };
}

export function makeMeta(id: string, over: Partial<IngredientMeta> = {}): IngredientMeta {
  return {
    ingredient_id: id,
    aisle: "produce",
    storage_class: "loose_produce",
    surface_prep: null,
    avg_unit_mass_g: null,
    updated_at: "2026-10-04T00:00:00.000Z",
    ...over,
  };
}

export function makePrice(id: string, pricing_unit: IngredientPriceRecord["pricing_unit"], price: number): IngredientPriceRecord {
  return { ingredient_id: id, display_name: id, price_per_unit: price, pricing_unit, last_updated: "2026-10-04T00:00:00.000Z" };
}

export function makeRegistry(entries: [string, IngredientPriceRecord["pricing_unit"], number][]): GlobalPriceRegistry {
  return Object.fromEntries(entries.map(([id, u, p]) => [id, makePrice(id, u, p)]));
}

export function makePantry(over: Partial<PantryEntry> & { ingredient_id: string }): PantryEntry {
  return { state: "loose", quantity: 1, unit: "g", opened_cycle_id: null, updated_at: "2026-10-04T00:00:00.000Z", ...over };
}

export const pkg = (retail_unit: string, pack_size: number, snap_to_whole_pack = true) => ({ retail_unit, pack_size, snap_to_whole_pack });
