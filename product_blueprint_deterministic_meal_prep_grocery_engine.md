# Product Blueprint: Deterministic Meal Prep & Grocery Engine

## 1. System Overview & Core Principles

A high-density, zero-LLM web application designed to plan, buy, prep, and batch-cook meals on a rolling 2-week cycle (3 distinct dishes per week). The runtime operates entirely on deterministic mathematics, strictly typed domain models, and physical kitchen hardware constraints to systematically eliminate cognitive load and food waste.

### Physical System Hardware Specifications

* **Cooking Yield Target:** Default $10$ portions per dish (dynamically scalable).
* **Portion Allocation Breakdown:**
  * **$8$ Portions (Home Stock):** Fills two 4-grid silicone freezer cube trays ($250\text{ mL}$ per cavity) for staggered home consumption.
  * **$2$ Portions (Immediate Dispatch):** Packed on cook day into disposable RE-250 ($250\text{ mL}$ rectangular polypropylene) takeout containers for immediate send-out.
* **Freezer Footprint Allocation:** Exactly $6$ trays ($4$-grid, $250\text{ mL}$ volume per cavity):
  * **Dish 1:** $2$ trays ($8$ frozen slots)
  * **Dish 2:** $2$ trays ($8$ frozen slots)
  * **Dish 3:** $2$ trays ($8$ frozen slots)
* **Physical Invariant:** Zero cross-dish contamination; standard freezer trays stack uniformly with zero overflow.

---

## 2. Core Logical Engines (Zero-LLM Runtime)

```text
[ Master Recipe Pool ]
         │
         ├── Hard Filters (Protein Diversity, Anti-Collision, Historical Cooldown)
         ├── Shelf-Life Gate (Week 1: All | Week 2: Strictly TIER_2_HARDY)
         ▼
[ 2-Week Plan Generator ] ──> Dynamic Scaling (Base 10 Multiplier)
         │
         ├── Packaging Snapping Engine (Cook Units vs. Retail Buy Packs)
         ├── Leftover Delta Subtraction (Pantry Stock vs. Net Need)
         ▼
[ Aisle-Sorted Grocery List ] (Offline IndexedDB Cached)
         │
         ├── "Mark as Bought" Trigger ──> Dynamic EMA Price Calibration ──> [ Global Price Registry ]
         ▼
[ Unified Mise en Place ] ──> Aggregated by Raw Prep & CutTechniqueEnum
         │
         ▼
[ Flat Stovetop Execution ] ──> Stove Priority Tagging (Zero Timers)
```

### A. The 2-Week Rolling & Collision Engine

* **Week 1 (Fresh / Open Pool):** Can draw from both `TIER_1_FRESH` (fragile produce, leafy greens, soft herbs) and `TIER_2_HARDY`.
* **Week 2 (Hardy Pool):** Strictly restricted to `TIER_2_HARDY` (root crops, hearty tubers, squash, canned goods, dried pulses, and raw meats portioned and frozen on Day 1).
* **Collision Invariants:**
  * **Intra-Cycle Exclusion:** A dish selected in Week 1 cannot appear in Week 2.
  * **Protein Diversity Rule:** Maximum of $2$ dishes sharing the same primary protein category per week (e.g., $2\text{ Pork} + 1\text{ Chicken}$ is valid; $3\text{ Pork}$ is blocked).
  * **Historical Cooldown:** A soft probability penalty is applied to dishes cooked during the preceding 2-week cycle to guarantee longitudinal variety.

### B. Atomic Portion Scaling Engine

Recipes do not scale via naïve floating-point multipliers on aggregate ingredient masses. Instead, scaling is derived from **Atomic Portion Primitives**:

#### Portion Granularity Tiers

1. **Discrete:** High piece-count specificity ($N \le 6$ pieces/portion; e.g., $3$ pork belly cubes, $2$ potato wedges). Enforces strict integer cuts:

   $$\text{Total Cuts} = N_{\text{pieces}} \times N_{\text{portions}}$$

2. **Granular:** Medium specificity (e.g., sliced carrots, sitaw green bean segments). Calculated by ratio and distributed visually across target vessels.
3. **Continuous:** Zero piece count (e.g., ground meat, shredded cabbage, broths, emulsion sauces). Managed strictly by net mass ($g$) or volume ($\text{mL}$); ladled directly to the container fill line.

### C. Packaging Snapping & Leftover Delta

#### Buy Units vs. Cook Units

* **Cook Unit:** The exact culinary requirement (e.g., $180\text{ g}$ tomato sauce).
* **Buy Unit:** Snapped upward to commercial retail form factors:

  $$\text{Packs To Buy} = \left\lceil \frac{\text{Net Required Quantity}}{\text{Retail Pack Size}} \right\rceil$$

#### Leftover Delta Calculation

$$\text{Net Requirement} = \max\left(0, \text{Gross Recipe Need} - \text{Pantry Stock}\right)$$

* **Loose Bulk Items:** Loose produce subtracts cleanly (e.g., $\text{Need } 6\text{ potatoes} - 2\text{ in stock} = \text{Buy } 4$).
* **Packaged Perishables:** Partially opened perishables (creams, pastes, open sauces) are assumed expired across multi-week cycle boundaries; unopened shelf-stable cans deduct cleanly.
* **Instant Overrides:** A single-tap `[Spoiled / Tossed]` action on the grocery UI clears stock deduction and restores the gross buy quantity.

### D. Dynamic Price Calibration & Registry Architecture

Pricing is strictly decoupled from individual recipe files to prevent redundancy and cross-recipe update desync. Pricing operates on a two-tier architecture:

#### 1. Global Ingredient Price Registry (Source of Truth)

Dynamic pricing and calibrations live in a normalized database table or key-value store, keyed uniquely by `ingredient_id`:

* **Grocery Estimation:** The total estimated grocery expenditure aggregates snapped packaging quantities across all rolled dishes against the global price registry:

  $$\text{Grocery Estimate} = \sum_{j} \left( \text{Snapped Packs}_{j} \times \text{RegistryPrice}(\text{ingredient\_id}_{j}) \right)$$

* **Exponential Moving Average Calibration:** When completing the post-shopping review, market prices update the global registry record directly via an Exponential Moving Average ($\alpha = 0.4$):

  $$\text{EMA}_{t} = \alpha \cdot P_{\text{observed}} + (1 - \alpha) \cdot \text{EMA}_{t-1}$$

  where $P_{\text{observed}}$ is the latest recorded retail unit or per-kg price.

#### 2. Recipe Root Baseline (`estimated_base_cost_php`) as Cold-Start Fallback

The `estimated_base_cost_php` property stored at the recipe root serves strictly as a temporary static fallback:

* **Cold-Start Phase:** When a recipe is newly added or the app is installed fresh with no historical price records in the registry, this static baseline provides immediate rough cost visibility in the rolling engine.
* **Warm State (Calibrated):** Once items exist in the Global Ingredient Price Registry, the app computes real-time recipe costs dynamically:

  $$\text{Real Recipe Cost} = \sum_{i \in \text{prep\_items}} \left( \text{Quantity}_{i} \times \text{RegistryPrice}(\text{ingredient\_id}_{i}) \right)$$

* **True Cost Per Portion:**

  $$\text{Cost Per Portion} = \frac{\text{Dish Dynamic Cost}}{N_{\text{portions}}}$$

---

## 3. End-to-End User Experience & Flow

```text
┌────────────────────────────────────────────────────────────────────────┐
│  STAGE 1: ROLLER DASHBOARD                                             │
│  • [Roll All] / [Lock W1] / [Lock W2] / Individual Dish [Re-roll]      │
│  • Global Portion Stepper: [-] 10 [+] (with per-dish overrides)        │
│  • Pinned Date Stamp (e.g., Oct 4–10 for W1 | Oct 11–17 for W2)        │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │ Lock Both Weeks
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│  STAGE 2: GROCERY MODE (Offline PWA / IndexedDB Cached)                │
│  • Grouped by Aisle: Produce -> Fresh Meat -> Canned/Dry -> Disposable │
│  • Inline Leftover Deltas: [Deduct Stock] vs [Tossed/Buy Full]         │
│  • Butcher Notes: "Ask for 1-inch adobo cuts", "Menudo strips"         │
│  • Action: Tap [Mark Groceries as Bought]                              │
│       └──> Optional Modal: Enter receipt total or calibrate items      │
│            └──> Writes new EMA values to Global Price Registry         │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │ Post-Grocery Return
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│  STAGE 3: DAY 1 FREEZER PREP PROTOCOL                                  │
│  • 5-minute task list before storing groceries:                        │
│    - Bag & label Week 2 meats (cut to piece specs, freeze flat)        │
│    - Store hardy root crops unwashed in paper towels                   │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │ Sunday Morning Cook Day
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│  STAGE 4: UNIFIED MISE EN PLACE (The Master Chopping Board)            │
│  • Wash/Peel level: Aggregated by raw ingredient across all 3 dishes   │
│  • Knife Station level: Filtered strictly by CutTechniqueEnum          │
│  • Bowl Routing: Displays exactly which bowl gets which cuts           │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │ All Bowled & Staged
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│  STAGE 5: STOVETOP EXECUTION (Flat UI, Zero Carousels)                 │
│  • Stove Priority Badges: Priority 1 (Braise), 2 (Sauté), 3 (Finish)   │
│  • Video Reel Drawer: Embedded Instagram Reels in floating frame       │
│  • Cooking Steps: 100% action verbs & sensory cues (zero numbers)      │
│  • Packing Step: "Fill solids first, sauce after."                     │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 4. UI & Screen Layout Specifications

The UI strictly rejects step-by-step modal wizards, slide carousels, and multi-page forms. All operational views are structured as flat, high-density, vertical layouts optimized for fast kitchen scanning.

### A. The Master Plan View

* **Top App Bar:** Active cycle dates (e.g., Oct 4 – Oct 17), Global Portion Stepper (`[-] 10 [+]`), and `[Re-roll Cycle]` action.
* **Split Week Grid:**
  * **Left Column (Week 1):** 3 dish cards featuring primary protein tags, stove priority indicators, and lock/unlock toggles.
  * **Right Column (Week 2):** 3 dish cards restricted exclusively to `TIER_2_HARDY` candidates.

### B. The Unified Mise en Place View (Prep Board)

Renders a single checklist aggregating identical knife operations across all 3 dishes before lighting any burner:

```text
========================================================================
                      MASTER PREP CHECKLIST
========================================================================

[ ] POTATOES (4 medium total / ~600g)
    • Surface Prep: Wash and peel all 4 potatoes
    • [LARGE_DICE / WEDGES]: Cut 2 medium into 24 chunks ──> [Kaldereta Bowl]
    • [SMALL_DICE]: Dice 2 medium finely (cubitos) ─────────> [Giniling Bowl]

[ ] RED ONIONS (4 medium total)
    • [MEDIUM_DICE]: Dice 1 medium ─────────────────────────> [Kaldereta Bowl]
    • [SMALL_DICE]: Dice 2 medium ──────────────────────────> [Giniling Bowl]
    • [SLICED_RINGS]: Slice 1 medium ───────────────────────> [Bistek Bowl]

[ ] CANNED & SAUCE STAGING
    • Open 1 can (85g) liver spread ────────────────────────> [Kaldereta Station]
    • Snip 1 pouch (250g) tomato sauce ─────────────────────> [Kaldereta Station]
```

### C. Stovetop Execution Cards

Each active dish is displayed as an un-paginated card containing an inline toggle for `[Prep Items]` vs. `[Cook Steps]`.

* **Video Player Drawer:** A collapsible header tab on each dish card embedding Instagram Reels, TikToks, or YouTube Shorts inside an aspect-ratio-locked ($9:16$) container.
* **Instructional Syntax:** Action verbs and sensory milestones only—measurements are handled entirely during the prep phase.
  * Sear pork in smoking oil until browned on all edges; transfer to plate.
  * Sauté prepped onions on medium until glassy, followed by garlic until golden.
  * Add tomato sauce, liver spread, browned pork, and water.
  * Drop heat to low, cover, and braise until fork-tender.
  * Add prepped potatoes and carrots; simmer covered until easily pierced.
* **Packing:** Fill solids first, sauce after.

---

## 5. Data Ingestion, Schema & Persistence Architecture

```text
[ App: "Add Recipe" ] 
       │
       ├── Tap [Copy Schema & LLM Prompt] ──> Sent to Clipboard
       │
       ▼ (User pastes into Gemini alongside Instagram link & notes)
[ Gemini outputs typed JSON (Zero Price Fields in Prep Items) ]
       │
       ▼ (User copies JSON string)
[ App: Paste into In-App Textarea ] ──> Zod Client-Side Validation
       │
       ├── Validation Fails ──> Inline syntax / field path error display
       └── Validation Passes
              │
              ├── Checks ingredient_id against [ Global Price Registry ]
              │     ├── Missing ID ──> Prompts seed unit price or defaults to PHP 0
              │     └── Existing ID ──> Links dynamically
              ▼
       Saved to Database + Instantly Active in Roller Engine
```

### A. Knife Cut Taxonomy (`CutTechniqueEnum`)

To ensure deterministic aggregation across disparate recipes, culinary knife cuts are strictly typed:

* `WHOLE`, `HALVED`, `QUARTERED`, `WEDGES`
* `LARGE_DICE` ($\approx 2\text{ cm} \ / \ \frac{3}{4}\text{ in}$ stew cuts)
* `MEDIUM_DICE` ($\approx 1.3\text{ cm} \ / \ \frac{1}{2}\text{ in}$ afritada/menudo cuts)
* `SMALL_DICE` ($\approx 0.6\text{ cm} \ / \ \frac{1}{4}\text{ in}$ giniling cubitos)
* `BRUNOISE` ($\approx 0.3\text{ cm}$ fine aromatics)
* `MINCED` (garlic, ginger)
* `SLICED_ROUNDS`, `SLICED_RINGS`, `SLICED_THIN`
* `BATONNET`, `JULIENNE`
* `ROLL_CUT` (angled root-crop cuts)
* `CHIFFONADE_SHRED` (cabbage, leafy greens)
* `CRUSHED_SMASHED` (smashed garlic cloves)
* `ROUGH_CHOP`, `NONE` (liquids, pastes, bulk ground meats), `CUSTOM`

### B. Production Zod Schema Definition

```typescript
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
```

### C. Ingestion & Seed Price Calibration Flow

When importing raw recipe JSON into the application:

1. **Schema Verification:** The client executes `RecipeSchema.safeParse(json)`.
2. **Registry Reconciliation:** The application scans all `ingredient_id` references inside `prep_items`.
3. **Missing Item Resolution:**
   * If an `ingredient_id` does not exist in the Global Price Registry, the app prompts a simple one-time input:
     `[New Ingredient Detected: "sayote" — Enter estimated unit price (PHP) or continue with PHP 0]`.
   * Newly entered values initialize the registry record; skipped values default to PHP 0 until calibrated via the first post-shopping review flow.

### D. Zero-Pause Persistence

* **Edge Database Tier:** Cloudflare D1 (serverless SQLite at edge nodes; zero sleep cycles, zero cold starts, zero inactivity pauses) or Firebase Firestore (native offline synchronization).
* **Local Fallback:** Application state, locked cycle configurations, and grocery checklists are mirrored to `localStorage` / `IndexedDB` on every mutation, enabling full offline reliability in low-reception grocery markets.
* **Direct Modifiers:** An in-app raw JSON editor modal allows on-the-fly corrections to portion ratios and step phrasing without necessitating database migrations or re-seeding.