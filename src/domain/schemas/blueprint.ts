// VERBATIM copy of blueprint §5B. Do not edit: tests/blueprint-drift.test.ts enforces equality.
import { z } from "zod";

export const CutTechniqueEnum = z.enum([
  "WHOLE",
  "HALVED",
  "QUARTERED",
  "WEDGES",
  "LARGE_DICE",
  "MEDIUM_DICE",
  "SMALL_DICE",
  "BRUNOISE",
  "MINCED",
  "SLICED_ROUNDS",
  "SLICED_RINGS",
  "SLICED_THIN",
  "BATONNET",
  "JULIENNE",
  "ROLL_CUT",
  "CHIFFONADE_SHRED",
  "CRUSHED_SMASHED",
  "ROUGH_CHOP",
  "NONE",
  "CUSTOM",
]);

export const VideoRefSchema = z.object({
  title: z.string(),
  platform: z.enum(["instagram_reel", "tiktok", "youtube_shorts", "direct_mp4"]),
  url: z.string().url(),
});

// Explicit Invariant: Zero pricing data attached to prep items
export const PrepItemSchema = z.object({
  ingredient_id: z.string(), // Normalized foreign key linking to Global Price Registry
  display_name: z.string(),
  cut_technique: CutTechniqueEnum,
  cut_note: z.string().nullable(),

  granularity: z.enum(["discrete", "granular", "continuous"]),
  pieces_per_portion: z.number().nullable(),
  quantity_per_portion: z.number(),
  unit: z.string(), // "grams", "pieces", "can", "pouch", "head", "tbsp"

  packaging: z
    .object({
      retail_unit: z.string(), // "250g pouch", "85g can", "1 kg bag", "per piece"
      pack_size: z.number(),
      snap_to_whole_pack: z.boolean(),
    })
    .optional(),
});

export const RecipeSchema = z.object({
  id: z.string(),
  name: z.string(),
  default_portions: z.literal(10),
  protein_category: z.enum(["pork", "chicken", "beef", "fish", "vegetable"]),
  sauce_base: z.enum([
    "tomato",
    "soy_vinegar",
    "coconut",
    "clear_broth",
    "peanut",
    "shrimp_paste",
  ]),

  perishability_tier: z.enum(["TIER_1_FRESH", "TIER_2_HARDY"]),
  stove_priority: z.enum([
    "PRIORITY_1_SLOW_BRAISE",
    "PRIORITY_2_FAST_SAUTE",
    "PRIORITY_3_FINISH_LAST",
  ]),

  estimated_base_cost_php: z.number(), // Static fallback baseline for 10 portions
  videos: z.array(VideoRefSchema),
  prep_items: z.array(PrepItemSchema),
  cook_steps: z.array(z.string()), // 100% action verbs & sensory cues
  pack_step: z.string().default("Fill solids first, sauce after."),
});

// Global Normalized Price Registry Schema
export const IngredientPriceRecordSchema = z.object({
  ingredient_id: z.string(),
  display_name: z.string(),
  price_per_unit: z.number(), // Current EMA-calibrated price
  pricing_unit: z.enum(["kg", "piece", "can", "pouch", "pack", "head", "bottle"]),
  last_updated: z.string(), // ISO Date String
});

export const GlobalPriceRegistrySchema = z.record(
  z.string(), // ingredient_id
  IngredientPriceRecordSchema
);

export type Recipe = z.infer<typeof RecipeSchema>;
export type PrepItem = z.infer<typeof PrepItemSchema>;
export type IngredientPriceRecord = z.infer<typeof IngredientPriceRecordSchema>;
export type GlobalPriceRegistry = z.infer<typeof GlobalPriceRegistrySchema>;
