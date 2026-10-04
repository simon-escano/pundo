import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("blueprint schema drift guard", () => {
  it("src/domain/schemas/blueprint.ts is a verbatim copy of blueprint §5B", () => {
    const md = readFileSync("product_blueprint_deterministic_meal_prep_grocery_engine.md", "utf8");
    const block = /```typescript\n([\s\S]*?)\n```/.exec(md)?.[1];
    expect(block).toBeTruthy();
    const ts = readFileSync("src/domain/schemas/blueprint.ts", "utf8");
    const [header, ...rest] = ts.split("\n");
    expect(header).toMatch(/^\/\/ VERBATIM/);
    expect(rest.join("\n").trimEnd()).toBe(block);
  });
});
