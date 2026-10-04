import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { CutTechniqueEnum, IngredientPriceRecordSchema, RecipeSchema, VideoRefSchema, PrepItemSchema } from "../src/domain/schemas/blueprint";
import { AisleEnum, CycleStatusEnum, PantryEntrySchema, PriceObservationSchema, StorageClassEnum } from "../src/domain/schemas/app";
import { ENTITIES } from "../src/domain/sync/protocol";

const db = env.DB;
const H = "001791100800000-00000-test";
let n = 0;
const id = (p: string) => `${p}-${Date.now()}-${++n}`;

const run = (sql: string, ...p: unknown[]) => db.prepare(sql).bind(...p).run();
const all = async <T>(sql: string, ...p: unknown[]) => (await db.prepare(sql).bind(...p).all<T>()).results;
const first = <T>(sql: string, ...p: unknown[]) => db.prepare(sql).bind(...p).first<T>();
async function rejects(sql: string, params: unknown[], pattern: RegExp) {
  let err: unknown;
  try { await run(sql, ...params); } catch (e) { err = e; }
  expect(err, `expected failure for: ${sql.slice(0, 60)}`).toBeDefined();
  expect(String((err as Error).message) + String((err as Error).cause ?? "")).toMatch(pattern);
}

// Minimal valid rows.
const mkCycle = async (over: Partial<{ id: string; status: string; start: string; seed: number; gp: number; upd: string }> = {}) => {
  const cid = over.id ?? id("c");
  await run("INSERT INTO cycles (id, start_date, seed, global_portions, status, updated_at) VALUES (?,?,?,?,?,?)", cid, over.start ?? "2026-10-04", over.seed ?? 7, over.gp ?? 10, over.status ?? "draft", over.upd ?? H);
  return cid;
};
const recipeSql = "INSERT INTO recipes (id, name, default_portions, protein_category, sauce_base, perishability_tier, stove_priority, estimated_base_cost_php, updated_at) VALUES (?,?,?,?,?,?,?,?,?)";
const mkRecipe = async (over: Partial<Record<"portions" | "protein" | "sauce" | "tier" | "stove" | "cost" | "upd", string | number>> = {}) => {
  const rid = id("r");
  await run(recipeSql, rid, "R", over.portions ?? 10, over.protein ?? "pork", over.sauce ?? "tomato", over.tier ?? "TIER_2_HARDY", over.stove ?? "PRIORITY_1_SLOW_BRAISE", over.cost ?? 100, over.upd ?? H);
  return rid;
};
const prepSql = "INSERT INTO recipe_prep_items (recipe_id, ord, ingredient_id, display_name, cut_technique, cut_note, granularity, pieces_per_portion, quantity_per_portion, unit, pkg_retail_unit, pkg_pack_size, pkg_snap_to_whole_pack) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)";

describe("migrations: schema and bootstrap", () => {
  it("creates every table as STRICT", async () => {
    const t = await all<{ name: string; strict: number }>("SELECT name, strict FROM pragma_table_list WHERE schema = 'main' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations'");
    expect(t.map((x) => x.name).sort()).toEqual(["change_log", "cycle_dishes", "cycles", "grocery_line_state", "ingredient_meta", "pantry_stock", "price_observations", "price_registry", "recipe_cook_steps", "recipe_prep_items", "recipe_videos", "recipes"]);
    expect(t.filter((x) => x.strict !== 1).map((x) => x.name)).toEqual([]);
  });

  it("creates the planned indexes", async () => {
    const names = (await all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index'")).map((r) => r.name);
    for (const i of ["idx_obs_fold", "idx_change_entity", "idx_change_unique", "idx_recipes_roll", "idx_prep_ingredient"]) expect(names).toContain(i);
  });

  it("idx_obs_fold serves the registry fold query", async () => {
    const plan = await all<{ detail: string }>("EXPLAIN QUERY PLAN SELECT * FROM price_observations WHERE ingredient_id = ? ORDER BY observed_at, id", "potato");
    expect(plan.map((p) => p.detail).join(" ")).toContain("idx_obs_fold");
  });

  it("bootstraps the seed: 15 recipes, matching registry/meta/seed observations, empty change_log", async () => {
    expect((await first<{ c: number }>("SELECT COUNT(*) AS c FROM recipes"))!.c).toBe(15);
    const reg = (await first<{ c: number }>("SELECT COUNT(*) AS c FROM price_registry"))!.c;
    expect(reg).toBeGreaterThanOrEqual(39);
    expect((await first<{ c: number }>("SELECT COUNT(*) AS c FROM ingredient_meta"))!.c).toBeGreaterThanOrEqual(39);
    expect((await first<{ c: number }>("SELECT COUNT(*) AS c FROM price_observations WHERE kind = 'seed'"))!.c).toBeGreaterThanOrEqual(39);
    expect((await first<{ c: number }>("SELECT COUNT(*) AS c FROM change_log"))!.c).toBe(0);
    expect(await first("SELECT price_per_unit AS p FROM price_registry WHERE ingredient_id = 'pork_shoulder'")).toEqual({ p: 320 });
    expect((await first<{ c: number }>("SELECT COUNT(*) AS c FROM recipe_prep_items WHERE recipe_id = 'pork-kaldereta'"))!.c).toBe(9);
  });
});

describe("CHECK constraints mirror the Zod enums exactly", () => {
  const cases: [table: string, column: string, options: readonly string[]][] = [
    ["price_registry", "pricing_unit", IngredientPriceRecordSchema.shape.pricing_unit.options],
    ["recipes", "protein_category", RecipeSchema.shape.protein_category.options],
    ["recipes", "sauce_base", RecipeSchema.shape.sauce_base.options],
    ["recipes", "perishability_tier", RecipeSchema.shape.perishability_tier.options],
    ["recipes", "stove_priority", RecipeSchema.shape.stove_priority.options],
    ["recipe_prep_items", "cut_technique", CutTechniqueEnum.options],
    ["recipe_prep_items", "granularity", PrepItemSchema.shape.granularity.options],
    ["recipe_videos", "platform", VideoRefSchema.shape.platform.options],
    ["ingredient_meta", "aisle", AisleEnum.options],
    ["ingredient_meta", "storage_class", StorageClassEnum.options],
    ["cycles", "status", CycleStatusEnum.options],
    ["price_observations", "kind", PriceObservationSchema.shape.kind.options],
    ["pantry_stock", "state", PantryEntrySchema.shape.state.options],
    ["change_log", "entity", ENTITIES],
  ];

  it.each(cases)("%s.%s lists exactly the Zod options", async (table, column, options) => {
    const sql = (await first<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", table))!.sql;
    const m = new RegExp(`${column}\\s+IN\\s*\\(([^)]*)\\)`, "s").exec(sql);
    expect(m, `no CHECK list for ${table}.${column}`).not.toBeNull();
    const inDb = m![1]!.split(",").map((s) => s.trim().replace(/^'|'$/g, "")).sort();
    expect(inDb).toEqual([...options].sort());
  });

  it("every Zod enum value is accepted and BOGUS is rejected (behavioural check on live tables)", async () => {
    for (const v of CutTechniqueEnum.options) {
      const rid = await mkRecipe();
      await run(prepSql, rid, 0, "potato", "Potato", v, null, "granular", null, 10, "g", null, null, null);
      await run("DELETE FROM recipes WHERE id = ?", rid);
    }
    const rid = await mkRecipe();
    await rejects(prepSql, [rid, 0, "potato", "Potato", "BOGUS", null, "granular", null, 10, "g", null, null, null], /CHECK/i);
    for (const s of CycleStatusEnum.options) { const c = await mkCycle({ status: s }); await run("DELETE FROM cycles WHERE id = ?", c); }
    await rejects("INSERT INTO cycles (id, start_date, seed, status, updated_at) VALUES (?,?,?,?,?)", [id("c"), "2026-10-04", 1, "BOGUS", H], /CHECK/i);
    await rejects(recipeSql, [id("r"), "R", 10, "BOGUS", "tomato", "TIER_2_HARDY", "PRIORITY_1_SLOW_BRAISE", 1, H], /CHECK/i);
    await rejects(recipeSql, [id("r"), "R", 10, "pork", "BOGUS", "TIER_2_HARDY", "PRIORITY_1_SLOW_BRAISE", 1, H], /CHECK/i);
    await rejects(recipeSql, [id("r"), "R", 10, "pork", "tomato", "TIER_3", "PRIORITY_1_SLOW_BRAISE", 1, H], /CHECK/i);
    await rejects(recipeSql, [id("r"), "R", 10, "pork", "tomato", "TIER_2_HARDY", "PRIORITY_9", 1, H], /CHECK/i);
    await rejects("INSERT INTO ingredient_meta (ingredient_id, aisle, storage_class, updated_at) VALUES ('potato', 'BOGUS', 'loose_produce', ?)", [H], /CHECK|UNIQUE|constraint/i);
    await rejects("INSERT INTO change_log (entity, entity_key, hlc, device_id) VALUES ('BOGUS', 'k', ?, 'd')", [H], /CHECK/i);
  });
});

describe("range, format and relational constraints", () => {
  it("recipes: default_portions must be 10; cost non-negative; HLC stamp format", async () => {
    await rejects(recipeSql, [id("r"), "R", 8, "pork", "tomato", "TIER_2_HARDY", "PRIORITY_1_SLOW_BRAISE", 1, H], /CHECK/i);
    await rejects(recipeSql, [id("r"), "R", 10, "pork", "tomato", "TIER_2_HARDY", "PRIORITY_1_SLOW_BRAISE", -1, H], /CHECK/i);
    await rejects(recipeSql, [id("r"), "R", 10, "pork", "tomato", "TIER_2_HARDY", "PRIORITY_1_SLOW_BRAISE", 1, "not-a-stamp"], /CHECK/i);
  });

  it("cycles: date format, seed uint32 range, portion range", async () => {
    const bad = (over: Parameters<typeof mkCycle>[0]) => mkCycle(over).then(() => "accepted", (e: Error) => e.message);
    expect(await bad({ start: "10/04/2026" })).toMatch(/CHECK/i);
    expect(await bad({ seed: -1 })).toMatch(/CHECK/i);
    expect(await bad({ seed: 4294967296 })).toMatch(/CHECK/i);
    expect(await bad({ gp: 0 })).toMatch(/CHECK/i);
    expect(await bad({ gp: 31 })).toMatch(/CHECK/i);
    const ok = await mkCycle({ seed: 4294967295, gp: 30 });
    await run("DELETE FROM cycles WHERE id = ?", ok);
  });

  it("prep items: quantity > 0, discrete needs 1..6 pieces, continuous has none, packaging is all-or-nothing", async () => {
    const rid = await mkRecipe();
    const ins = (over: Partial<Record<"gran" | "pieces" | "qty" | "retail" | "size" | "snap", unknown>>) =>
      [rid, Math.floor(Math.random() * 1e6), "potato", "Potato", "NONE", null, over.gran ?? "granular", over.pieces ?? null, over.qty ?? 10, "g", over.retail ?? null, over.size ?? null, over.snap ?? null];
    await rejects(prepSql, ins({ qty: 0 }), /CHECK/i);
    await rejects(prepSql, ins({ gran: "discrete", pieces: 7 }), /CHECK/i);
    await rejects(prepSql, ins({ gran: "discrete", pieces: null }), /CHECK/i);
    await rejects(prepSql, ins({ gran: "continuous", pieces: 2 }), /CHECK/i);
    await rejects(prepSql, ins({ retail: "250 g pouch" }), /CHECK/i); // retail without size/snap
    await rejects(prepSql, ins({ retail: "x", size: 0, snap: 1 }), /CHECK/i);
    await run(prepSql, ...ins({ gran: "discrete", pieces: 6 }));
    await run(prepSql, ...ins({ retail: "250 g pouch", size: 250, snap: 1 }));
    await run("DELETE FROM recipes WHERE id = ?", rid);
  });

  it("price observations / pantry / grocery state: non-negative values and boolean flags", async () => {
    const c = await mkCycle();
    await rejects("INSERT INTO price_observations (id, ingredient_id, kind, price, observed_at, device_id) VALUES (?, 'potato', 'observed', -1, 't', 'd')", [id("o")], /CHECK/i);
    await rejects("INSERT INTO pantry_stock (ingredient_id, state, quantity, unit, updated_at) VALUES ('potato', 'loose', -1, 'g', ?)", [H], /CHECK/i);
    await rejects("INSERT INTO grocery_line_state (cycle_id, line_key, deduct_stock, updated_at) VALUES (?, 'k', 2, ?)", [c, H], /CHECK/i);
    await rejects("INSERT INTO grocery_line_state (cycle_id, line_key, paid_php, updated_at) VALUES (?, 'k', -5, ?)", [c, H], /CHECK/i);
    await run("DELETE FROM cycles WHERE id = ?", c);
  });

  it("cycle_dishes: UNIQUE(cycle_id, recipe_id) blocks the same dish twice in one cycle", async () => {
    const c = await mkCycle();
    const r1 = await mkRecipe();
    const r2 = await mkRecipe();
    const dish = "INSERT INTO cycle_dishes (cycle_id, week, slot, recipe_id, hlc) VALUES (?,?,?,?,?)";
    await run(dish, c, 1, 0, r1, H);
    await rejects(dish, [c, 2, 1, r1, H], /UNIQUE/i); // same recipe, different slot
    await rejects(dish, [c, 1, 0, r2, H], /UNIQUE|PRIMARY/i); // same slot twice
    await run(dish, c, 2, 0, r2, H); // a different recipe is fine
    const other = await mkCycle();
    await run(dish, other, 1, 0, r1, H); // the same recipe in ANOTHER cycle is fine
    await rejects(dish, [c, 3, 0, r1, H], /CHECK/i); // week 1 or 2 only
    await rejects(dish, [c, 1, 3, id("x"), H], /CHECK|FOREIGN/i); // slot 0..2 only
    await run("DELETE FROM cycles WHERE id IN (?, ?)", c, other);
    await run("DELETE FROM recipes WHERE id IN (?, ?)", r1, r2);
  });

  it("foreign keys are enforced", async () => {
    const rid = await mkRecipe();
    await rejects(prepSql, [rid, 0, "no_such_ingredient", "X", "NONE", null, "granular", null, 1, "g", null, null, null], /FOREIGN/i);
    const c = await mkCycle();
    await rejects("INSERT INTO cycle_dishes (cycle_id, week, slot, recipe_id, hlc) VALUES (?, 1, 0, 'no-such-recipe', ?)", [c, H], /FOREIGN/i);
    await rejects("INSERT INTO price_observations (id, ingredient_id, kind, price, observed_at, device_id) VALUES (?, 'no_such', 'observed', 1, 't', 'd')", [id("o")], /FOREIGN/i);
    await rejects("INSERT INTO ingredient_meta (ingredient_id, aisle, storage_class, updated_at) VALUES ('no_such', 'produce', 'loose_produce', ?)", [H], /FOREIGN/i);
    await rejects("INSERT INTO grocery_line_state (cycle_id, line_key, updated_at) VALUES ('no-cycle', 'k', ?)", [H], /FOREIGN/i);
    await run("DELETE FROM recipes WHERE id = ?", rid);
    await run("DELETE FROM cycles WHERE id = ?", c);
  });

  it("cascades: recipe → children, cycle → dishes + grocery state, registry → observations + meta; cycle delete nulls observation links", async () => {
    const rid = await mkRecipe();
    await run(prepSql, rid, 0, "potato", "Potato", "NONE", null, "granular", null, 1, "g", null, null, null);
    await run("INSERT INTO recipe_cook_steps (recipe_id, ord, text) VALUES (?, 0, 'Stir.')", rid);
    await run("INSERT INTO recipe_videos (recipe_id, ord, title, platform, url) VALUES (?, 0, 't', 'tiktok', 'u')", rid);
    await run("DELETE FROM recipes WHERE id = ?", rid);
    for (const t of ["recipe_prep_items", "recipe_cook_steps", "recipe_videos"]) expect((await first<{ c: number }>(`SELECT COUNT(*) AS c FROM ${t} WHERE recipe_id = ?`, rid))!.c).toBe(0);

    const c = await mkCycle();
    const r = await mkRecipe();
    await run("INSERT INTO cycle_dishes (cycle_id, week, slot, recipe_id, hlc) VALUES (?, 1, 0, ?, ?)", c, r, H);
    await run("INSERT INTO grocery_line_state (cycle_id, line_key, updated_at) VALUES (?, 'k', ?)", c, H);
    const obs = id("o");
    await run("INSERT INTO price_observations (id, ingredient_id, kind, price, observed_at, cycle_id, device_id) VALUES (?, 'potato', 'observed', 1, 't', ?, 'd')", obs, c);
    await run("DELETE FROM cycles WHERE id = ?", c);
    expect((await first<{ c: number }>("SELECT COUNT(*) AS c FROM cycle_dishes WHERE cycle_id = ?", c))!.c).toBe(0);
    expect((await first<{ c: number }>("SELECT COUNT(*) AS c FROM grocery_line_state WHERE cycle_id = ?", c))!.c).toBe(0);
    expect(await first("SELECT cycle_id FROM price_observations WHERE id = ?", obs)).toEqual({ cycle_id: null });
    await run("DELETE FROM price_observations WHERE id = ?", obs);
    await run("DELETE FROM recipes WHERE id = ?", r);

    const ing = id("ing");
    await run("INSERT INTO price_registry (ingredient_id, display_name, pricing_unit, last_updated, hlc) VALUES (?, 'X', 'kg', 't', ?)", ing, H);
    await run("INSERT INTO ingredient_meta (ingredient_id, aisle, storage_class, updated_at) VALUES (?, 'produce', 'loose_produce', ?)", ing, H);
    await run("INSERT INTO price_observations (id, ingredient_id, kind, price, observed_at, device_id) VALUES (?, ?, 'observed', 1, 't', 'd')", id("o"), ing);
    await run("DELETE FROM price_registry WHERE ingredient_id = ?", ing);
    expect((await first<{ c: number }>("SELECT COUNT(*) AS c FROM ingredient_meta WHERE ingredient_id = ?", ing))!.c).toBe(0);
    expect((await first<{ c: number }>("SELECT COUNT(*) AS c FROM price_observations WHERE ingredient_id = ?", ing))!.c).toBe(0);
  });

  it("change_log: seq is monotonic and never reused; (entity, key, hlc) is unique", async () => {
    const key = id("k");
    const ins = "INSERT INTO change_log (entity, entity_key, hlc, device_id, payload) VALUES ('cycle', ?, ?, 'd', NULL)";
    const a = await run(ins, key, H);
    const b = await run(ins, key, "001791100800001-00000-test");
    expect(b.meta.last_row_id).toBeGreaterThan(a.meta.last_row_id as number);
    await rejects(ins, [key, H], /UNIQUE/i);
    await run("DELETE FROM change_log WHERE entity_key = ?", key);
    const c = await run(ins, key, H);
    expect(c.meta.last_row_id).toBeGreaterThan(b.meta.last_row_id as number); // AUTOINCREMENT: no reuse
    await run("DELETE FROM change_log WHERE entity_key = ?", key);
  });
});
