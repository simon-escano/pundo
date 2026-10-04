import { describe, expect, it } from "vitest";
import { GlobalPriceRegistrySchema, RecipeSchema } from "../src/domain/schemas/blueprint";
import { IngredientMetaSchema } from "../src/domain/schemas/app";
import { ingestRecipe } from "../src/domain/ingest/parse";
import { reconcileRegistry } from "../src/domain/ingest/reconcile";
import { ROLLER_RULES } from "../src/domain/constants/hardware";

const recipeFiles = import.meta.glob("../fixtures/recipes/*.json", { eager: true, query: "?raw", import: "default" }) as Record<string, string>;
const seed = (await import("../fixtures/ingredients.json")).default;
const recipes = Object.entries(recipeFiles).map(([path, text]) => ({ path, text, json: JSON.parse(text) }));

describe("fixture recipes", () => {
  it("has at least 12 recipes with unique ids", () => {
    expect(recipes.length).toBeGreaterThanOrEqual(12);
    expect(new Set(recipes.map((r) => r.json.id)).size).toBe(recipes.length);
  });

  it.each(recipes.map((r) => [r.json.id, r] as const))("%s passes RecipeSchema and domain invariants", (_id, r) => {
    expect(RecipeSchema.safeParse(r.json).success).toBe(true);
    const res = ingestRecipe(r.text);
    expect(res.ok ? [] : res.errors).toEqual([]);
    expect(res.warnings).toEqual([]);
  });

  it("every ingredient_id resolves to registry + meta (zero missing)", () => {
    expect(GlobalPriceRegistrySchema.safeParse(seed.registry).success).toBe(true);
    for (const m of Object.values(seed.meta)) expect(IngredientMetaSchema.safeParse(m).success).toBe(true);
    for (const r of recipes) {
      const rec = RecipeSchema.parse(r.json);
      expect(reconcileRegistry(rec, seed.registry as never, seed.meta as never).missing).toEqual([]);
    }
  });

  it("includes the approved Ginisang Sayote with Ground Pork seed", () => {
    const r = recipes.find((x) => x.json.name === "Ginisang Sayote with Ground Pork")?.json;
    expect(r).toBeDefined();
    expect(r.perishability_tier).toBe("TIER_1_FRESH");
    expect(r.sauce_base).toBe("clear_broth");
    expect(r.protein_category).toBe("pork");
  });

  it("supports a feasible roll: enough hardy dishes, tomato cap and protein cap satisfiable", () => {
    const all = recipes.map((r) => r.json);
    const hardy = all.filter((r) => r.perishability_tier === "TIER_2_HARDY");
    const hardyNonTomato = hardy.filter((r) => r.sauce_base !== "tomato");
    expect(hardy.length).toBeGreaterThanOrEqual(6);
    expect(hardyNonTomato.length).toBeGreaterThanOrEqual(3 - ROLLER_RULES.MAX_TOMATO_BASE_PER_WEEK);
    expect(new Set(hardy.map((r) => r.protein_category)).size).toBeGreaterThanOrEqual(2);
  });
});
