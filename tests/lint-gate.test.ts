import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint({ cwd: process.cwd() });
async function messages(code: string, filePath: string) {
  const [res] = await eslint.lintText(code, { filePath });
  return res!.messages.map((m) => m.ruleId);
}

describe("domain determinism + layering lint gate", () => {
  it("fails Math.random in src/domain", async () => {
    expect(await messages("export const x = Math.random();\n", "src/domain/x.ts")).toContain("no-restricted-properties");
  });
  it("fails Date.now, new Date() and localeCompare in src/domain", async () => {
    expect(await messages("export const x = Date.now();\n", "src/domain/x.ts")).toContain("no-restricted-properties");
    expect(await messages("export const x = new Date();\n", "src/domain/x.ts")).toContain("no-restricted-syntax");
    expect(await messages("export const x = 'a'.localeCompare('b');\n", "src/domain/x.ts")).toContain("no-restricted-properties");
  });
  it("fails dexie/react imports in src/domain", async () => {
    expect(await messages("import Dexie from 'dexie';\nexport const d = Dexie;\n", "src/domain/x.ts")).toContain("no-restricted-imports");
    expect(await messages("import { useState } from 'react';\nexport const u = useState;\n", "src/domain/x.ts")).toContain("no-restricted-imports");
  });
  it("allows the same constructs outside src/domain", async () => {
    expect(await messages("export const x = Math.random();\n", "src/ui/x.ts")).not.toContain("no-restricted-properties");
  });
  it("allows new Date(arg) with an explicit argument in src/domain", async () => {
    expect(await messages("export const x = (s: string) => new Date(s);\n", "src/domain/x.ts")).not.toContain("no-restricted-syntax");
  });
});
