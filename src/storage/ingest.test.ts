import { describe, expect, it } from "vitest";
import type { Storage } from "./index";
import { makeHarness, outboxOf } from "./testing/harness";

async function recipeWith(s: Storage, id: string, extra: object[] = []) {
  const base = (await s.recipes.get("pinakbet"))!;
  return JSON.stringify({ ...base, id, name: `Recipe ${id}`, prep_items: [...base.prep_items, ...extra] });
}
const item = (ingredient_id: string, display_name: string, unit = "g") => ({
  ingredient_id, display_name, cut_technique: "MINCED", cut_note: null, granularity: "granular", pieces_per_portion: null, quantity_per_portion: 5, unit,
});
const resolution = { pricing_unit: "kg", aisle: "produce", storage_class: "loose_produce" } as const;

describe("ingest-to-save pipeline", () => {
  it("preview of an all-known recipe has no action items and flags updates", async () => {
    const s = await makeHarness().open();
    const p = await s.ingest.preview(await recipeWith(s, "fresh-one"));
    expect(p).toMatchObject({ ok: true, actions: [], willUpdate: false });
    const upd = await s.ingest.preview(await recipeWith(s, "pinakbet"));
    expect(upd).toMatchObject({ ok: true, willUpdate: true });
  });

  it("preview surfaces syntax, schema and invariant errors with field paths and writes nothing", async () => {
    const s = await makeHarness().open();
    expect(await s.ingest.preview('{"id": ')).toMatchObject({ ok: false, errors: [{ path: "(json)" }] });
    const bad = JSON.parse(await recipeWith(s, "x"));
    bad.prep_items[1].price_php = 10;
    bad.prep_items[0].cut_technique = "DICED";
    const p = await s.ingest.preview(JSON.stringify(bad));
    expect(p.ok).toBe(false);
    expect(!p.ok && p.errors.map((e) => e.path)).toEqual(expect.arrayContaining(["prep_items[1].price_php", "prep_items[0].cut_technique"]));
    expect(await outboxOf(s)).toEqual([]);
  });

  it("returns UI action items for ingredients missing from the registry and/or meta, with a unit suggestion", async () => {
    const s = await makeHarness().open();
    await s.registry.ensure({ ingredient_id: "calamansi", display_name: "Calamansi", pricing_unit: "kg", price: 120 }); // priced but no meta
    const p = await s.ingest.preview(await recipeWith(s, "new-dish", [item("sayote_new", "Sayote (new)"), item("calamansi", "Calamansi"), item("toyo", "Toyo", "ml"), item("mystery", "Mystery", "handful")]));
    expect(p.ok && p.actions).toEqual([
      { ingredient_id: "calamansi", display_name: "Calamansi", needsPrice: false, needsMeta: true, suggestedPricingUnit: "kg" },
      { ingredient_id: "mystery", display_name: "Mystery", needsPrice: true, needsMeta: true, suggestedPricingUnit: null },
      { ingredient_id: "sayote_new", display_name: "Sayote (new)", needsPrice: true, needsMeta: true, suggestedPricingUnit: "kg" },
      { ingredient_id: "toyo", display_name: "Toyo", needsPrice: true, needsMeta: true, suggestedPricingUnit: "bottle" },
    ]);
  });

  it("commit without resolutions returns exactly which fields are still needed and writes nothing", async () => {
    const s = await makeHarness().open();
    const text = await recipeWith(s, "new-dish", [item("labuyo", "Labuyo")]);
    const r = await s.ingest.commit(text, [{ ingredient_id: "labuyo", pricing_unit: "kg" }]);
    expect(r).toMatchObject({ ok: false, code: "UNRESOLVED_INGREDIENTS", missingFields: { labuyo: ["aisle", "storage_class"] } });
    expect(await s.recipes.has("new-dish")).toBe(false);
    expect(await s.registry.get("labuyo")).toBeUndefined();
    expect(await outboxOf(s)).toEqual([]);
    const none = await s.ingest.commit(text);
    expect(none).toMatchObject({ ok: false, missingFields: { labuyo: ["pricing_unit", "aisle", "storage_class"] } });
  });

  it("commit saves recipe + registry seed + meta together and makes the recipe instantly active", async () => {
    const s = await makeHarness().open();
    const text = await recipeWith(s, "new-dish", [item("labuyo", "Labuyo"), item("siling_haba", "Siling haba")]);
    const r = await s.ingest.commit(text, [
      { ingredient_id: "labuyo", ...resolution, price: 400, surface_prep: "Wash", avg_unit_mass_g: 3 },
      { ingredient_id: "siling_haba", ...resolution }, // price skipped → PHP 0
    ]);
    expect(r).toMatchObject({ ok: true, created: true });
    expect((await s.registry.get("labuyo"))!.price_per_unit).toBe(400);
    expect((await s.registry.get("siling_haba"))!.price_per_unit).toBe(0);
    expect(await s.meta.get("labuyo")).toMatchObject({ aisle: "produce", surface_prep: "Wash", avg_unit_mass_g: 3 });
    expect((await s.recipes.list()).map((x) => x.id)).toContain("new-dish"); // in the roller pool immediately
    const entities = (await outboxOf(s)).map((o) => o.entity);
    expect(entities.filter((e) => e === "recipe")).toHaveLength(1);
    expect(entities.filter((e) => e === "priceRegistry")).toHaveLength(2);
    expect(entities.filter((e) => e === "ingredientMeta")).toHaveLength(2);
    // re-ingesting the same id updates, with no further action items
    expect(await s.ingest.commit(text)).toMatchObject({ ok: true, created: false });
  });

  it("a PHP 0 skipped ingredient is calibrated by its first observation (cold-start rule)", async () => {
    const s = await makeHarness().open();
    await s.ingest.commit(await recipeWith(s, "d", [item("labuyo", "Labuyo")]), [{ ingredient_id: "labuyo", ...resolution }]);
    await s.registry.appendObservations([{ id: "o", ingredient_id: "labuyo", kind: "observed", price: 350, observed_at: "2027-01-01T00:00:00.000Z", cycle_id: null, device_id: "d" }]);
    expect((await s.registry.get("labuyo"))!.price_per_unit).toBe(350);
  });

  it("commit of an invalid recipe returns INVALID with errors and writes nothing", async () => {
    const s = await makeHarness().open();
    const r = await s.ingest.commit("{}");
    expect(r).toMatchObject({ ok: false, code: "INVALID" });
    expect(await outboxOf(s)).toEqual([]);
  });

  it("warnings (unknown unit) pass through without blocking", async () => {
    const s = await makeHarness().open();
    const r = await s.ingest.commit(await recipeWith(s, "w", [item("odd_thing", "Odd", "handful")]), [{ ingredient_id: "odd_thing", ...resolution }]);
    expect(r.ok && r.warnings.map((w) => w.path)).toEqual(expect.arrayContaining([expect.stringContaining("unit")]));
  });
});
