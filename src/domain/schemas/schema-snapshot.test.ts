import { describe, expect, it } from "vitest";
import { z } from "zod";
import { RecipeSchema, IngredientPriceRecordSchema, CutTechniqueEnum } from "./blueprint";

describe("schema drift snapshots", () => {
  it("RecipeSchema JSON Schema", () => expect(z.toJSONSchema(RecipeSchema)).toMatchSnapshot());
  it("IngredientPriceRecordSchema JSON Schema", () => expect(z.toJSONSchema(IngredientPriceRecordSchema)).toMatchSnapshot());
  it("CutTechniqueEnum has the 20 blueprint values", () => expect(CutTechniqueEnum.options).toHaveLength(20));
  it("RecipeSchema.default_portions only accepts 10", () => {
    const shape = RecipeSchema.shape.default_portions;
    expect(shape.safeParse(10).success).toBe(true);
    expect(shape.safeParse(8).success).toBe(false);
  });
});
