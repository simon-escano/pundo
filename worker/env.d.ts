// Bindings (keep in sync with wrangler.jsonc).
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./index");
  }
  interface Env {
    DB: D1Database;
    ASSETS: Fetcher;
    /** Zero Trust team domain, e.g. "myteam.cloudflareaccess.com". Empty = not configured (API fails closed). */
    ACCESS_TEAM_DOMAIN?: string;
    /** The Access application's Audience (AUD) tag. */
    ACCESS_AUD?: string;
    /** "true" only via `wrangler dev --var ACCESS_DEV_BYPASS:true`, and only honoured for loopback hostnames. */
    ACCESS_DEV_BYPASS?: string;
    TEST_MIGRATIONS: import("@cloudflare/vitest-pool-workers").D1Migration[]; // injected by vitest.workers.config.ts
  }
}
