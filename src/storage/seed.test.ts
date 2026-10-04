import { describe, expect, it } from "vitest";
import { loadFixtureData } from "./fixtures";
import { RecipeSchema, GlobalPriceRegistrySchema } from "../domain/schemas/blueprint";
import { StorageError } from "./errors";
import { makeHarness, outboxOf } from "./testing/harness";

describe("cold-start bootstrap", () => {
  it("loads the 15 fixture recipes, the full registry and meta on first open", async () => {
    const s = await makeHarness().open();
    const recipes = await s.recipes.list();
    expect(recipes).toHaveLength(15);
    for (const r of recipes) expect(RecipeSchema.safeParse(r).success).toBe(true);
    expect(recipes.map((r) => r.name)).toContain("Ginisang Sayote with Ground Pork");

    const registry = await s.registry.snapshot();
    expect(GlobalPriceRegistrySchema.safeParse(registry).success).toBe(true);
    const seeded = loadFixtureData();
    expect(Object.keys(registry).sort()).toEqual(Object.keys(seeded.registry).sort());
    expect(registry.pork_shoulder).toMatchObject({ price_per_unit: 320, pricing_unit: "kg" });
    expect(Object.keys(await s.meta.all()).sort()).toEqual(Object.keys(seeded.meta).sort());
    expect((await s.meta.get("potato"))?.surface_prep).toBe("Wash and peel");
  });

  it("registry prices are the fold of deterministic seed observations", async () => {
    const s = await makeHarness().open();
    const obs = await s.registry.observationsFor("potato");
    expect(obs.map((o) => [o.id, o.kind, o.price])).toEqual([["seed:potato", "seed", 90]]);
  });

  it("bootstrap rows are NOT queued for sync and carry the seed HLC", async () => {
    const s = await makeHarness().open();
    expect(await outboxOf(s)).toEqual([]);
    expect((await s.db.recipes.toArray()).every((r) => r._hlc.endsWith("-seed"))).toBe(true);
  });

  it("is idempotent across reloads and never overwrites user edits", async () => {
    const h = makeHarness();
    const a = await h.open();
    const adobo = await a.recipes.get("pork-adobo");
    await a.recipes.put({ ...adobo!, name: "My Adobo" });
    a.close();
    const b = await h.open(); // reload: seedVersion already recorded
    expect((await b.recipes.get("pork-adobo"))?.name).toBe("My Adobo");
    expect(await b.recipes.list()).toHaveLength(15);
    expect((await b.db.syncMeta.get("seedVersion"))?.value).toBe(1);
  });

  it("a newer seed version adds missing recipes but keeps existing ones", async () => {
    const h = makeHarness();
    const base = loadFixtureData();
    const a = await h.open({ seed: { ...base, recipes: base.recipes.slice(0, 3) } });
    expect(await a.recipes.list()).toHaveLength(3);
    const edited = (await a.recipes.list())[0]!;
    await a.recipes.put({ ...edited, name: "Edited" });
    a.close();
    const b = await h.open({ seed: { ...base, version: 2 } });
    expect(await b.recipes.list()).toHaveLength(15);
    expect((await b.recipes.get(edited.id))?.name).toBe("Edited");
  });

  it("skips seeding when disabled, and rejects an invalid seed recipe atomically", async () => {
    expect(await (await makeHarness().open({ seed: false })).recipes.list()).toEqual([]);
    const base = loadFixtureData();
    const h = makeHarness();
    const bad = { ...(base.recipes[0] as object), default_portions: 8 };
    await expect(h.open({ seed: { ...base, recipes: [base.recipes[1], bad] } })).rejects.toBeInstanceOf(StorageError);
    const s = await h.open({ seed: false });
    expect(await s.recipes.list()).toEqual([]); // nothing partially written
    expect(await s.db.priceRegistry.count()).toBe(0);
  });
});
