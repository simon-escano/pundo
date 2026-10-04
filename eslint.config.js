import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

// Determinism + layering gates for src/domain (pure engines, zero LLM, zero I/O).
export const domainRules = {
  "no-restricted-properties": [
    "error",
    { object: "Math", property: "random", message: "Domain must be deterministic: use the seeded PRNG (math/prng)." },
    { object: "Date", property: "now", message: "Domain must be deterministic: inject the clock." },
    { property: "localeCompare", message: "Locale-dependent: use compareStrings (math/compare)." },
  ],
  "no-restricted-syntax": [
    "error",
    {
      selector: "NewExpression[callee.name='Date'][arguments.length=0]",
      message: "Domain must be deterministic: inject the clock instead of new Date().",
    },
  ],
  "no-restricted-imports": [
    "error",
    {
      patterns: [
        { group: ["dexie", "dexie-*", "react", "react-*", "react/*"], message: "Domain must not import I/O or UI libraries." },
        { group: ["**/storage", "**/storage/*", "**/ui", "**/ui/*", "**/worker/*"], message: "Layering: domain may not import storage, ui or worker." },
      ],
    },
  ],
};

export const storageRules = {
  "no-restricted-imports": [
    "error",
    { patterns: [{ group: ["**/ui", "**/ui/*", "**/worker/*", "react", "react-*"], message: "Layering: storage may import domain only (never ui, worker or react)." }] },
  ],
};

export default tseslint.config(
  { ignores: ["dist", "node_modules", "test-results", "playwright-report", ".wrangler"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": ["error", { ignoreRestSiblings: true, argsIgnorePattern: "^_" }],
    },
  },
  { files: ["src/domain/**/*.ts"], rules: domainRules },
  { files: ["src/storage/**/*.ts"], rules: storageRules },
);
