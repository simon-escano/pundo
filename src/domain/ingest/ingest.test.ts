/* eslint-disable @typescript-eslint/no-explicit-any -- tests mutate loosely-typed fixture JSON */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatPath, ingestRecipe, locateJsonError, parseJson, validateRecipe } from "./parse";
import { reconcileRegistry, newRegistryRecord, suggestPricingUnit } from "./reconcile";
import { buildLlmPrompt } from "./llmPrompt";

const good = JSON.parse(readFileSync("fixtures/recipes/pork-kaldereta.json", "utf8"));
const run = (mutate: (r: any) => void) => {
  const r = structuredClone(good);
  mutate(r);
  return ingestRecipe(JSON.stringify(r));
};
const errPaths = (res: ReturnType<typeof ingestRecipe>) => (res.ok ? [] : res.errors.map((e) => e.path));

describe("ingest", () => {
  it("formats paths as prep_items[2].cut_technique", () => {
    expect(formatPath(["prep_items", 2, "cut_technique"])).toBe("prep_items[2].cut_technique");
    expect(formatPath(["name"])).toBe("name");
    expect(formatPath([])).toBe("");
  });
  it("accepts a valid recipe", () => expect(ingestRecipe(JSON.stringify(good)).ok).toBe(true));

  it("reports JSON syntax errors with line:col", () => {
    const res = parseJson('{\n  "a": 1,\n  "b": }\n');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toMatch(/line 3:\d+/);
  });
  it("locateJsonError agrees with JSON.parse on valid and invalid inputs", () => {
    for (const ok of ['{"a":[1,2.5e3,-0,{"b":null}],"c":"x\\n\\u00e9"}', "[]", " true ", '"s"']) {
      expect(() => JSON.parse(ok)).not.toThrow();
      expect(locateJsonError(ok)).toBeNull();
    }
    const bad: [string, number][] = [
      ['{"a":1,}', 7], ["[1,2", 4], ['{"a" 1}', 5], ["{'a':1}", 1], ['{"a":01}', 6], ['"abc', 4], ["tru", 0], ["[1] x", 4], ["", 0],
    ];
    for (const [text, pos] of bad) {
      expect(() => JSON.parse(text), text).toThrow();
      expect(locateJsonError(text)?.pos, text).toBe(pos);
    }
  });
  it("reports enum typos by field path", () => {
    expect(errPaths(run((r) => (r.prep_items[2].cut_technique = "DICED")))).toContain("prep_items[2].cut_technique");
  });
  it("rejects default_portions other than 10", () => {
    expect(errPaths(run((r) => (r.default_portions = 8)))).toContain("default_portions");
  });
  it("rejects price fields on prep items (Zod would silently strip them)", () => {
    const res = run((r) => (r.prep_items[1].price_php = 120));
    expect(errPaths(res)).toContain("prep_items[1].price_php");
  });
  it("enforces discrete piece counts (integer, 1 to 6)", () => {
    expect(errPaths(run((r) => (r.prep_items[0].pieces_per_portion = 7)))).toContain("prep_items[0].pieces_per_portion");
    expect(errPaths(run((r) => (r.prep_items[0].pieces_per_portion = 2.5)))).toContain("prep_items[0].pieces_per_portion");
    expect(errPaths(run((r) => (r.prep_items[0].pieces_per_portion = null)))).toContain("prep_items[0].pieces_per_portion");
  });
  it("continuous items must have null pieces_per_portion", () => {
    const i = good.prep_items.findIndex((p: any) => p.granularity === "continuous");
    expect(errPaths(run((r) => (r.prep_items[i].pieces_per_portion = 2)))).toContain(`prep_items[${i}].pieces_per_portion`);
  });
  it("rejects numbers in cook steps", () => {
    expect(errPaths(run((r) => (r.cook_steps[0] = "Sear for 5 minutes.")))).toContain("cook_steps[0]");
  });
  it("requires cut_note for CUSTOM and snake_case ingredient ids", () => {
    expect(errPaths(run((r) => { r.prep_items[2].cut_technique = "CUSTOM"; r.prep_items[2].cut_note = null; }))).toContain("prep_items[2].cut_note");
    expect(errPaths(run((r) => (r.prep_items[2].ingredient_id = "Red Onion")))).toContain("prep_items[2].ingredient_id");
  });
  it("rejects non-positive quantities and warns on unknown units", () => {
    expect(errPaths(run((r) => (r.prep_items[0].quantity_per_portion = 0)))).toContain("prep_items[0].quantity_per_portion");
    const res = run((r) => (r.prep_items[3].unit = "handful"));
    expect(res.ok).toBe(true);
    expect(res.warnings.map((w) => w.path)).toContain("prep_items[3].unit");
  });
});

describe("reconcile", () => {
  const registry = { potato: newRegistryRecord({ ingredient_id: "potato", display_name: "Potato", pricing_unit: "kg", price: 90 }, "2026-10-04T00:00:00.000Z") };
  it("flags ids missing from the registry, sorted and de-duplicated", () => {
    const rec = ingestRecipe(JSON.stringify(good));
    if (!rec.ok) throw new Error("fixture invalid");
    const out = reconcileRegistry(rec.recipe, registry, {});
    expect(out.known).toEqual(["potato"]);
    expect(out.missing.map((m) => m.ingredient_id)).toEqual([...out.missing.map((m) => m.ingredient_id)].sort());
    expect(out.missing.map((m) => m.ingredient_id)).toContain("pork_shoulder");
    expect(out.missing.find((m) => m.ingredient_id === "potato")?.needsMeta).toBe(true);
  });
  it("skipped seed defaults to PHP 0", () => {
    expect(newRegistryRecord({ ingredient_id: "sayote", display_name: "Sayote", pricing_unit: "kg" }, "t").price_per_unit).toBe(0);
  });
});

describe("llm prompt", () => {
  it("embeds the schema, forbids prices and lists every cut technique", () => {
    const p = buildLlmPrompt(["red_onion"]);
    expect(p).toContain("red_onion");
    expect(p).toContain("NEVER include price");
    expect(p).toContain("LARGE_DICE");
    expect(p).toContain('"default_portions"');
  });
});

describe("validateRecipe", () => {
  it("validates already-parsed values the same way as text", () => {
    expect(validateRecipe(good).ok).toBe(true);
    const bad = structuredClone(good);
    bad.default_portions = 8;
    expect(validateRecipe(bad)).toMatchObject({ ok: false });
  });
});

describe("suggestPricingUnit", () => {
  it("maps prep-item units to registry pricing units", () => {
    const cases: [string, string | null][] = [["grams", "kg"], ["kg", "kg"], ["pieces", "piece"], ["head", "head"], ["cloves", "head"], ["can", "can"], ["pouch", "pouch"], ["sachet", "pack"], ["bottle", "bottle"], ["ml", "bottle"], ["tbsp", "bottle"], ["bunch", "pack"], ["handful", null]];
    for (const [u, expected] of cases) expect(suggestPricingUnit(u), u).toBe(expected);
  });
});
