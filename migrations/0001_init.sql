-- Meal Prep Engine: edge schema (Cloudflare D1 / SQLite).
-- Mirrors the blueprint Zod schemas: every enum below must equal its Zod enum (worker/ddl.test.ts enforces this).
-- Sync columns (`hlc` / `updated_at`) hold Hybrid Logical Clock stamps: lexicographic order = causal order.
-- Cycle status TRANSITIONS are validated by the client; the DB constrains the set of states only (a trigger
-- would reject legitimate last-write-wins outcomes and make devices diverge permanently).

-- ───── Global Ingredient Price Registry (materialised cache; source of truth = price_observations) ─────
CREATE TABLE price_registry (
  ingredient_id   TEXT PRIMARY KEY CHECK (length(ingredient_id) > 0),
  display_name    TEXT NOT NULL,
  price_per_unit  REAL NOT NULL DEFAULT 0 CHECK (price_per_unit >= 0),
  pricing_unit    TEXT NOT NULL CHECK (pricing_unit IN ('kg','piece','can','pouch','pack','head','bottle')),
  last_updated    TEXT NOT NULL,                      -- ISO 8601
  hlc             TEXT NOT NULL CHECK (hlc GLOB '[0-9]*-[0-9]*-*')   -- LWW stamp of the identity (name + unit)
) STRICT;

-- ───── Cycles ─────
CREATE TABLE cycles (
  id              TEXT PRIMARY KEY,
  start_date      TEXT NOT NULL CHECK (start_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  seed            INTEGER NOT NULL CHECK (seed BETWEEN 0 AND 4294967295),
  global_portions INTEGER NOT NULL DEFAULT 10 CHECK (global_portions BETWEEN 1 AND 30),
  status          TEXT NOT NULL CHECK (status IN ('draft','locked','shopped','w1_cooked','complete')),
  updated_at      TEXT NOT NULL CHECK (updated_at GLOB '[0-9]*-[0-9]*-*')
) STRICT;

CREATE TABLE price_observations (                     -- append-only; the EMA is a deterministic fold over this
  id              TEXT PRIMARY KEY,
  ingredient_id   TEXT NOT NULL REFERENCES price_registry(ingredient_id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('seed','observed','receipt_allocated','override')),
  price           REAL NOT NULL CHECK (price >= 0),   -- per pricing_unit
  observed_at     TEXT NOT NULL,                      -- ISO 8601
  cycle_id        TEXT REFERENCES cycles(id) ON DELETE SET NULL,
  device_id       TEXT NOT NULL
) STRICT;
CREATE INDEX idx_obs_fold ON price_observations(ingredient_id, observed_at, id);

CREATE TABLE ingredient_meta (
  ingredient_id   TEXT PRIMARY KEY REFERENCES price_registry(ingredient_id) ON DELETE CASCADE,
  aisle           TEXT NOT NULL CHECK (aisle IN ('produce','fresh_meat','canned_dry','disposable')),
  storage_class   TEXT NOT NULL CHECK (storage_class IN
                    ('loose_produce','fresh_meat','perishable_once_opened','shelf_stable_sealed','disposable')),
  surface_prep    TEXT,
  avg_unit_mass_g REAL CHECK (avg_unit_mass_g IS NULL OR avg_unit_mass_g > 0),
  updated_at      TEXT NOT NULL CHECK (updated_at GLOB '[0-9]*-[0-9]*-*')
) STRICT;

-- ───── Recipes (normalised mirror of RecipeSchema) ─────
CREATE TABLE recipes (
  id                       TEXT PRIMARY KEY,
  name                     TEXT NOT NULL,
  default_portions         INTEGER NOT NULL DEFAULT 10 CHECK (default_portions = 10),
  protein_category         TEXT NOT NULL CHECK (protein_category IN ('pork','chicken','beef','fish','vegetable')),
  sauce_base               TEXT NOT NULL CHECK (sauce_base IN
                             ('tomato','soy_vinegar','coconut','clear_broth','peanut','shrimp_paste')),
  perishability_tier       TEXT NOT NULL CHECK (perishability_tier IN ('TIER_1_FRESH','TIER_2_HARDY')),
  stove_priority           TEXT NOT NULL CHECK (stove_priority IN
                             ('PRIORITY_1_SLOW_BRAISE','PRIORITY_2_FAST_SAUTE','PRIORITY_3_FINISH_LAST')),
  estimated_base_cost_php  REAL NOT NULL CHECK (estimated_base_cost_php >= 0),
  pack_step                TEXT NOT NULL DEFAULT 'Fill solids first, sauce after.',
  updated_at               TEXT NOT NULL CHECK (updated_at GLOB '[0-9]*-[0-9]*-*'),   -- HLC, the LWW key
  deleted                  INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0,1))        -- soft delete keeps cycle history valid
) STRICT;
CREATE INDEX idx_recipes_roll ON recipes(perishability_tier, protein_category) WHERE deleted = 0;

CREATE TABLE recipe_videos (
  recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  ord       INTEGER NOT NULL CHECK (ord >= 0),
  title     TEXT NOT NULL,
  platform  TEXT NOT NULL CHECK (platform IN ('instagram_reel','tiktok','youtube_shorts','direct_mp4')),
  url       TEXT NOT NULL,
  PRIMARY KEY (recipe_id, ord)
) STRICT;

CREATE TABLE recipe_prep_items (
  recipe_id              TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  ord                    INTEGER NOT NULL CHECK (ord >= 0),
  ingredient_id          TEXT NOT NULL REFERENCES price_registry(ingredient_id),
  display_name           TEXT NOT NULL,
  cut_technique          TEXT NOT NULL CHECK (cut_technique IN
    ('WHOLE','HALVED','QUARTERED','WEDGES','LARGE_DICE','MEDIUM_DICE','SMALL_DICE','BRUNOISE','MINCED',
     'SLICED_ROUNDS','SLICED_RINGS','SLICED_THIN','BATONNET','JULIENNE','ROLL_CUT','CHIFFONADE_SHRED',
     'CRUSHED_SMASHED','ROUGH_CHOP','NONE','CUSTOM')),
  cut_note               TEXT,
  granularity            TEXT NOT NULL CHECK (granularity IN ('discrete','granular','continuous')),
  pieces_per_portion     REAL,
  quantity_per_portion   REAL NOT NULL CHECK (quantity_per_portion > 0),
  unit                   TEXT NOT NULL,
  pkg_retail_unit        TEXT,
  pkg_pack_size          REAL CHECK (pkg_pack_size IS NULL OR pkg_pack_size > 0),
  pkg_snap_to_whole_pack INTEGER CHECK (pkg_snap_to_whole_pack IS NULL OR pkg_snap_to_whole_pack IN (0,1)),
  CHECK ((pkg_retail_unit IS NULL) = (pkg_pack_size IS NULL)
     AND (pkg_pack_size  IS NULL) = (pkg_snap_to_whole_pack IS NULL)),        -- packaging is all-or-nothing
  CHECK (granularity <> 'discrete' OR (pieces_per_portion IS NOT NULL AND pieces_per_portion BETWEEN 1 AND 6)),
  CHECK (granularity <> 'continuous' OR pieces_per_portion IS NULL),
  PRIMARY KEY (recipe_id, ord)
) STRICT;
CREATE INDEX idx_prep_ingredient ON recipe_prep_items(ingredient_id);

CREATE TABLE recipe_cook_steps (
  recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  ord       INTEGER NOT NULL CHECK (ord >= 0),
  text      TEXT NOT NULL,
  PRIMARY KEY (recipe_id, ord)
) STRICT;

-- ───── Plan, pantry, grocery state ─────
CREATE TABLE cycle_dishes (
  cycle_id         TEXT NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
  week             INTEGER NOT NULL CHECK (week IN (1,2)),
  slot             INTEGER NOT NULL CHECK (slot BETWEEN 0 AND 2),
  recipe_id        TEXT NOT NULL REFERENCES recipes(id),
  locked           INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0,1)),
  portion_override INTEGER CHECK (portion_override IS NULL OR portion_override BETWEEN 1 AND 30),
  hlc              TEXT NOT NULL CHECK (hlc GLOB '[0-9]*-[0-9]*-*'),
  PRIMARY KEY (cycle_id, week, slot),
  UNIQUE (cycle_id, recipe_id)                        -- intra-cycle exclusion, enforced by the database itself
) STRICT;

CREATE TABLE pantry_stock (
  ingredient_id   TEXT NOT NULL REFERENCES price_registry(ingredient_id),
  state           TEXT NOT NULL CHECK (state IN ('loose','sealed','opened')),
  quantity        REAL NOT NULL CHECK (quantity >= 0),
  unit            TEXT NOT NULL,                      -- canonical unit (g, ml, pc, can, ...)
  opened_cycle_id TEXT REFERENCES cycles(id) ON DELETE SET NULL,
  updated_at      TEXT NOT NULL CHECK (updated_at GLOB '[0-9]*-[0-9]*-*'),
  deleted         INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0,1)),   -- tombstone: a late older write must not resurrect stock
  PRIMARY KEY (ingredient_id, state)
) STRICT;

CREATE TABLE grocery_line_state (
  cycle_id     TEXT NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
  line_key     TEXT NOT NULL,                         -- `${ingredient_id}|${unit}|${bucket}`
  deduct_stock INTEGER NOT NULL DEFAULT 1 CHECK (deduct_stock IN (0,1)),  -- 0 = [Spoiled / Tossed]
  bought       INTEGER NOT NULL DEFAULT 0 CHECK (bought IN (0,1)),
  paid_php     REAL CHECK (paid_php IS NULL OR paid_php >= 0),
  updated_at   TEXT NOT NULL CHECK (updated_at GLOB '[0-9]*-[0-9]*-*'),
  PRIMARY KEY (cycle_id, line_key)
) STRICT;

-- ───── Sync ─────
CREATE TABLE change_log (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,       -- monotonic pull cursor
  entity     TEXT NOT NULL CHECK (entity IN
               ('recipe','priceRegistry','priceObservation','ingredientMeta','cycle','cycleDish','pantry','groceryLineState')),
  entity_key TEXT NOT NULL,
  hlc        TEXT NOT NULL CHECK (hlc GLOB '[0-9]*-[0-9]*-*'),
  device_id  TEXT NOT NULL,
  payload    TEXT                                     -- JSON document, NULL = delete
) STRICT;
CREATE INDEX idx_change_entity ON change_log(entity, entity_key);
CREATE UNIQUE INDEX idx_change_unique ON change_log(entity, entity_key, hlc);   -- replays never double-log
