// Bindings (keep in sync with wrangler.jsonc).
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./index");
  }
  interface Env {
    DB: D1Database;
    ASSETS: Fetcher;
    TEST_MIGRATIONS: import("@cloudflare/vitest-pool-workers").D1Migration[]; // injected by vitest.workers.config.ts
  }
}
