import type { NewIngredient } from "../repositories/registry";
import type { AppRecipeInput, IngredientMeta } from "../../domain/schemas/app";
import type { PrepItem } from "../../domain/schemas/blueprint";
import type { CycleShape } from "../../domain/engines/shape";

// One-time content update shipped with the Nov 2026 release: two high-protein recipes built around the user's S&R
// pork pata (1.370 kg at PHP 436/kg) and beef stew cubes (1.035 kg at PHP 555/kg), tags on the existing Filipino
// recipes, and a locked 1-week, 2-dish plan starting Sunday 2026-11-22. Applied by ../contentUpdates.ts as ordinary
// synced mutations. Non-meat prices are SM supermarket estimates; receipt calibration corrects them.

export const CONTENT_ID = "2026-11-22";

type Ingredient = NewIngredient & Omit<IngredientMeta, "ingredient_id" | "updated_at">;
const meat = { aisle: "fresh_meat", storage_class: "fresh_meat", surface_prep: null, avg_unit_mass_g: null } as const;
const pantry = { aisle: "canned_dry", storage_class: "shelf_stable_sealed", surface_prep: null, avg_unit_mass_g: null } as const;

export const INGREDIENTS: readonly Ingredient[] = [
  { ingredient_id: "pork_pata", display_name: "Pork pata slices", pricing_unit: "kg", price: 436, ...meat },
  { ingredient_id: "beef_stew", display_name: "Beef stew cubes", pricing_unit: "kg", price: 555, ...meat },
  { ingredient_id: "tokwa", display_name: "Firm tokwa", pricing_unit: "piece", price: 14, aisle: "produce", storage_class: "loose_produce", surface_prep: "Drain and pat dry", avg_unit_mass_g: 150 },
  { ingredient_id: "pechay", display_name: "Pechay Tagalog", pricing_unit: "pack", price: 25, aisle: "produce", storage_class: "loose_produce", surface_prep: "Wash, separate stems from leaves", avg_unit_mass_g: null },
  { ingredient_id: "baguio_beans", display_name: "Baguio beans", pricing_unit: "kg", price: 120, aisle: "produce", storage_class: "loose_produce", surface_prep: "Wash and trim", avg_unit_mass_g: null },
  { ingredient_id: "calamansi", display_name: "Calamansi", pricing_unit: "kg", price: 100, aisle: "produce", storage_class: "loose_produce", surface_prep: "Wash and halve", avg_unit_mass_g: 10 },
  { ingredient_id: "star_anise", display_name: "Star anise", pricing_unit: "pack", price: 25, ...pantry },
  { ingredient_id: "brown_sugar", display_name: "Brown sugar", pricing_unit: "pack", price: 45, ...pantry },
  { ingredient_id: "black_pepper", display_name: "Black pepper", pricing_unit: "pack", price: 30, ...pantry },
  { ingredient_id: "oyster_sauce", display_name: "Oyster sauce", pricing_unit: "bottle", price: 80, aisle: "canned_dry", storage_class: "perishable_once_opened", surface_prep: null, avg_unit_mass_g: null },
  { ingredient_id: "cornstarch", display_name: "Cornstarch", pricing_unit: "pack", price: 30, ...pantry },
];

const g = (ingredient_id: string, display_name: string, cut_technique: PrepItem["cut_technique"], quantity_per_portion: number, unit = "g", cut_note: string | null = null) =>
  ({ ingredient_id, display_name, cut_technique, cut_note, granularity: "granular", pieces_per_portion: null, quantity_per_portion, unit }) as const;
const liquid = (ingredient_id: string, display_name: string, quantity_per_portion: number, unit: string, retail_unit: string, pack_size: number) =>
  ({ ingredient_id, display_name, cut_technique: "NONE", cut_note: null, granularity: "continuous", pieces_per_portion: null, quantity_per_portion, unit, packaging: { retail_unit, pack_size, snap_to_whole_pack: true } }) as const;

const SOY = liquid("soy_sauce", "Soy sauce", 0, "ml", "385 mL bottle", 385);
const PEPPER = liquid("black_pepper", "Black pepper, cracked", 0, "g", "25 g pack", 25);

export const PORK_PATA_ID = "pork-pata-tokwa-braise";
export const BEEF_ID = "beef-oyster-pepper-glaze";

export const RECIPES: readonly AppRecipeInput[] = [
  {
    id: PORK_PATA_ID,
    name: "Soy-Ginger Braised Pork Pata & Tokwa",
    tags: ["Filipino", "High-Protein"],
    default_portions: 10,
    protein_category: "pork",
    sauce_base: "soy_vinegar",
    perishability_tier: "TIER_2_HARDY",
    stove_priority: "PRIORITY_1_SLOW_BRAISE",
    estimated_base_cost_php: 750,
    videos: [],
    prep_items: [
      { ingredient_id: "pork_pata", display_name: "Pork pata slices", cut_technique: "WHOLE", cut_note: "Bone-in slices; debone and chop after braising", granularity: "discrete", pieces_per_portion: 1, quantity_per_portion: 137, unit: "g" },
      g("tokwa", "Firm tokwa", "LARGE_DICE", 0.4, "pc", "1-inch cubes"),
      g("carrot", "Carrot", "ROLL_CUT", 20),
      g("pechay", "Pechay Tagalog", "ROUGH_CHOP", 0.25, "pack", "Stems and leaves kept apart"),
      g("garlic", "Garlic", "CRUSHED_SMASHED", 4),
      g("ginger", "Ginger", "SLICED_THIN", 1.5),
      { ingredient_id: "star_anise", display_name: "Star anise", cut_technique: "WHOLE", cut_note: null, granularity: "discrete", pieces_per_portion: 1, quantity_per_portion: 0.1, unit: "pc", packaging: { retail_unit: "pack of 10 pods", pack_size: 10, snap_to_whole_pack: true } },
      { ...SOY, quantity_per_portion: 8 },
      liquid("vinegar", "Vinegar", 3, "ml", "385 mL bottle", 385),
      liquid("brown_sugar", "Brown sugar", 1.2, "g", "500 g pack", 500),
      { ...PEPPER, quantity_per_portion: 0.5 },
    ],
    cook_steps: [
      "Blanch the pata slices in boiling water for 5 minutes; drain and rinse off the scum.",
      "Return the pata to the pot with about 1.5 litres of water, the soy sauce, vinegar, brown sugar, garlic, ginger, star anise and pepper; cover and simmer until fork-tender.",
      "Add the carrots and tokwa cubes for the last 15 minutes so they soak up the braising liquid.",
      "Lift out the meat, pull out the bones and chop the meat into bite-sized chunks; skim the oil off the top of the liquid.",
      "Return the meat and boil the liquid down until glossy and thick, not soupy.",
      "Wilt the pechay stems, then the leaves, in the last 2 minutes so they stay bright green.",
    ],
    pack_step: "Fill each cavity about 85% with meat, tokwa and vegetables, then spoon 2–3 tbsp of glaze on top. Send-outs: pechay and carrots on top for colour.",
  },
  {
    id: BEEF_ID,
    name: "Garlic-Ginger Pepper & Oyster Glazed Beef",
    tags: ["Filipino", "High-Protein"],
    default_portions: 10,
    protein_category: "beef",
    sauce_base: "soy_vinegar",
    perishability_tier: "TIER_1_FRESH",
    stove_priority: "PRIORITY_2_FAST_SAUTE",
    estimated_base_cost_php: 705,
    videos: [],
    prep_items: [
      { ingredient_id: "beef_stew", display_name: "Beef stew cubes", cut_technique: "LARGE_DICE", cut_note: "Thawed and patted dry", granularity: "discrete", pieces_per_portion: 4, quantity_per_portion: 103.5, unit: "g" },
      g("baguio_beans", "Baguio beans", "BATONNET", 27.5, "g", "2-inch batons"),
      g("carrot", "Carrot", "SLICED_THIN", 20, "g", "Thin half-moons"),
      g("cabbage", "Cabbage", "CHIFFONADE_SHRED", 0.05, "head", "Thick ribbons"),
      g("bell_pepper", "Red bell pepper", "MEDIUM_DICE", 15),
      g("garlic", "Garlic", "MINCED", 4),
      g("ginger", "Ginger", "MINCED", 1),
      liquid("oyster_sauce", "Oyster sauce", 5, "g", "405 g bottle", 405),
      { ...SOY, quantity_per_portion: 3 },
      g("calamansi", "Calamansi", "HALVED", 3, "g", "Juiced"),
      { ...PEPPER, quantity_per_portion: 0.25 },
      liquid("cornstarch", "Cornstarch", 0.8, "g", "250 g pack", 250),
      liquid("cooking_oil", "Cooking oil", 1.5, "ml", "1 L bottle", 1000),
    ],
    cook_steps: [
      "Simmer the beef cubes in water to cover until tender (stew beef stays chewy if only seared); drain and pat dry.",
      "Sear the beef over high heat in 1 tbsp oil until browned on the edges; set aside.",
      "In the same pan, flash-sear the carrots, Baguio beans, cabbage and bell pepper for 2–3 minutes until crisp-tender.",
      "Toss in the garlic and ginger until fragrant, return the beef, then pour in the oyster sauce, soy sauce, calamansi juice and black pepper.",
      "Stir in the cornstarch slurry (1 tbsp in ¼ cup water) for about 30 seconds until it turns into a thick, glossy coating.",
    ],
    pack_step: "Fill each cavity about 85% with beef and vegetables, glaze on top. Send-outs: layer the beans, carrots and red pepper on top of the beef.",
  },
];

/** The existing fixture recipes, all Filipino dishes. Tagged only if they have no tags yet. */
export const FILIPINO_IDS: readonly string[] = [
  "beef-bistek", "chicken-adobo", "chicken-afritada", "chicken-tinola", "ginataang-kalabasa-sitaw", "ginisang-munggo",
  "ginisang-sayote-ground-pork", "kare-kare", "pinakbet", "pork-adobo", "pork-giniling", "pork-kaldereta", "pork-menudo",
  "pork-nilaga", "sinigang-baboy",
];

/** The locked plan for this week. A fixed id, so two devices applying the update converge on one cycle. */
export const PLAN = {
  id: "plan-2026-11-22",
  start_date: "2026-11-22",
  seed: 20261122,
  shape: { weeks: 1, dishesPerWeek: 2 } satisfies CycleShape,
  dishes: [
    { week: 1, slot: 0, recipe_id: PORK_PATA_ID },
    { week: 1, slot: 1, recipe_id: BEEF_ID },
  ],
} as const;
