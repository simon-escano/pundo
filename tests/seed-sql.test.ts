import { describe, expect, it } from "vitest";
import { loadFixtureData } from "../src/storage/fixtures";
import { buildSeedSql } from "../worker/seedSql";

describe("server seed migration", () => {
  it("migrations/0002_seed.sql is exactly what the fixtures generate (update with -u)", async () => {
    await expect(buildSeedSql(loadFixtureData() as never)).toMatchFileSnapshot("../migrations/0002_seed.sql");
  });

  it("escapes quotes and is deterministic", () => {
    const data = loadFixtureData() as never;
    expect(buildSeedSql(data)).toBe(buildSeedSql(data));
    const sql = buildSeedSql({ recipes: [], registry: { x: { ingredient_id: "x", display_name: "Bird's nest", price_per_unit: 1, pricing_unit: "kg", last_updated: "t" } }, meta: {} });
    expect(sql).toContain("'Bird''s nest'");
  });
});
