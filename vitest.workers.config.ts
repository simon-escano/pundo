import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Runs worker/**/*.test.ts inside workerd (Miniflare) against a real D1 with the real migrations.
export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  return {
    plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" }, miniflare: { bindings: { TEST_MIGRATIONS: migrations, ACCESS_DEV_BYPASS: "true" } } })],
    test: {
      name: "workers",
      include: ["worker/**/*.test.ts"],
      setupFiles: ["./worker/test/apply-migrations.ts"],
    },
  };
});
