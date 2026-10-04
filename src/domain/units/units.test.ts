import { describe, expect, it } from "vitest";
import { convert, normalizeUnit, toCanonical } from "./units";

describe("units", () => {
  it("normalises aliases", () => {
    expect(normalizeUnit("grams")).toEqual({ unit: "g", factor: 1 });
    expect(normalizeUnit(" KG ")).toEqual({ unit: "g", factor: 1000 });
    expect(normalizeUnit("pieces")?.unit).toBe("pc");
    expect(normalizeUnit("sachet")?.unit).toBe("pack");
    expect(normalizeUnit("handful")).toBeNull();
  });
  it("toCanonical scales into the canonical unit", () => {
    expect(toCanonical(1.5, "kg")).toEqual({ quantity: 1500, unit: "g" });
    expect(toCanonical(2, "liters")).toEqual({ quantity: 2000, unit: "ml" });
    expect(toCanonical(1, "fistful")).toBeNull();
  });
  it("convert works within mass/volume and refuses across dimensions or count units", () => {
    expect(convert(2, "tbsp", "ml")).toBe(30);
    expect(convert(3, "tsp", "tbsp")).toBe(1);
    expect(convert(5, "g", "g")).toBe(5);
    expect(convert(1, "g", "ml")).toBeNull();
    expect(convert(1, "can", "pouch")).toBeNull();
    expect(convert(2, "can", "can")).toBe(2);
  });
});
