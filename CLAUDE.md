# pundo

Spec: `product_blueprint_pundo.md`. Approved plan: `~/.claude/plans/pasted-content-id-68e2-read-and-joyful-curry.md`.

## Invariants
- **Zero LLM runtime.** `src/domain` is pure deterministic TS: no `Math.random`, `Date.now`, `new Date()`, `localeCompare`, and no dexie/react/storage/ui/worker imports. ESLint enforces this (`tests/lint-gate.test.ts`).
- `src/domain/schemas/blueprint.ts` is a **verbatim** copy of blueprint §5B; never edit it (`tests/blueprint-drift.test.ts`). App-only data (aisle, storage class, etc.) goes in `schemas/app.ts`.
- Hardware: 10 portions/dish = 8 home (two 4-cavity trays) + 2 RE-250 send-out. Constants in `constants/hardware.ts`.
- Roller rules: max 2 dishes per protein per week, **max 1 `tomato` sauce_base per week** (approved addition), W2 strictly TIER_2_HARDY, no repeats within a cycle.
- Flat UI only: no carousels, wizards or multi-step modals (the Add recipe modal is one scrolling screen, not steps). Tailwind v4 tokens live in `src/index.css` `@theme` (no tailwind.config.js).
- Layering: `ui → storage → domain`, `worker → domain`.

## Commands
`npm run verify` = typecheck + lint + vitest + playwright (4 viewports, Chromium only). `npm run dev` for the app.

## Storage (src/storage)
- Dexie 4 over IndexedDB; every mutation goes through `writeTx` (`outbox.ts`): entity write + outbox row + HLC checkpoint in ONE rw transaction. `atomicity.test.ts` proves it for every repo method and fails if a new public method is not classified.
- Bootstrap fixtures use `SEED_HLC` and are never outboxed (a later device's seed must not overwrite edits). Prices are `seed:<id>` observations; registry rows are a cached `replayObservations` fold and are never synced as values.
- Tests use `makeHarness()` (fake-indexeddb, injected clock/ids); calling `open()` again simulates a page reload.

## UI (src/ui)
- Look: warm paper neutrals + the pundo orange (#b45309), flat protein tints (beef/pork/chicken/fish/veg) for dishes and recipes, Bricolage Grotesque for display type as CSS variables in `src/index.css` (`:root`, redefined under `prefers-color-scheme: dark`, mapped by `@theme inline`). Geist Sans/Mono self-hosted via `@fontsource-variable`. Icons are Lucide only (no emoji). Liquid glass (`.glass`, `.glass-strong`, `.glass-ctl`, `.glass-lens` in `index.css`) is for the control layer only (stage bar, header buttons, sheets, popovers), never content; it falls back to opaque under `prefers-reduced-transparency`/`prefers-contrast: more`. Rules are thin semi-transparent hairlines (`--line`), never heavy ink-coloured bars. Design rules we hold ourselves to: avoid card-per-block (use rules, whitespace and type; containers only for real objects like dish tiles), no pill-badge soup, no nested cards, one orange accent; the logo is Lucide `CookingPot` (`components/Logo.tsx`, `public/icons/icon.svg`).
- Hash routes: four stages `#/plan #/grocery #/prep #/cook` plus `#/recipes` (header book button, not a stage). Sub-routes live in the URL: `#/prep/day-1|week-1|week-2`, `#/cook/week-1|week-2`; legacy `#/day-1` is rewritten to `#/prep/day-1`. One `<nav aria-label="Main">`: the floating `StageBar` (progress track, bottom centre, offset from the edge; every stage is a direct link, not next/prev). The header holds the logo, sync pill and a labelled Recipes button.
- Plan layout: weeks stacked vertically, three dishes side by side. Below `md` a dish is a compact tile that opens a bottom sheet (`useMediaQuery`); from `md` it is a full card. Tests use `openDish()` in `e2e/helpers.ts` to hide that difference.
- Labels are plain language and live in `ui/lib/format.ts` (`STOVE_ORDER`, `TIER_LABEL`, `STATUS_LABEL`, ...). Domain enums/`STOVE_LABEL` are untouched; never show raw enum values.
- Data: one `useLiveQuery(loadWorld)` feeds a pure `derive()` (engines) in `ui/lib`; views never touch Dexie directly except through repos. Mutations go through `run()` so failures show as an alert toast.
- Overlays: `Modal` (dialog on desktop, bottom sheet on phones; portal, `#root` goes `inert`, Esc closes, focus returns) is used by calibration (Enter receipt), the JSON editor, Add recipe, and the dish sheet. `SignInScreen` is the full-screen signed-out page shown when `status.auth` is set (Cloudflare hosts the real login).
- Motion: `motion/react` (`m.*` under `MotionProvider`, LazyMotion `domMax`, `reducedMotion="user"`). Animations are feedback only (page fade, sliding nav/segmented pill, dish flip on roll, sheets, height reveals). `navigator.webdriver` sets `MotionGlobalConfig.skipAnimations` so Playwright sees final frames. React Bits sources are adapted in `components/bits/` (CountUp, SpotlightCard, ClickSpark; no gsap/three).
- Dev-only fixture: `/?fixture=demo[&state=locked][&signin=1]` = fresh DB, fixed clock/ids/seed (Playwright relies on it). Ignored in production builds.
- Layout contract enforced by `e2e/helpers.ts#assertLayout` (no overflow/snap, 44px targets; a checkbox's target is its label). The root font size is 15px, so use `min-h-[44px]`/`size-[44px]`, never `min-h-11`. Wake Lock only in Prep and Cook (`useWakeLock`).
- Visual baselines live in `e2e/visual.spec.ts-snapshots` (Linux/Chromium, light + dark + signed-out); regenerate with `npx playwright test e2e/visual.spec.ts --update-snapshots` only for intended UI changes.

## Edge sync (worker/, src/storage/sync.ts, src/domain/sync/)
- Wire contract lives in `src/domain/sync/protocol.ts` (shared by client and Worker): mutation envelope, per-entity payload validation, key derivation, integrity checks.
- Worker (Hono, D1): `POST /api/sync/push`, `GET /api/sync/pull?since=&limit=`, `GET /api/health`. Every write is LWW **in SQL** (`ON CONFLICT ... WHERE excluded.hlc > stored.hlc`) so it is atomic under interleaved requests; only winners reach `change_log`. Statuses: applied | stale | invalid | retry (FK). Registry prices are re-folded with the shared `replayObservations`.
- Server evictions (intra-cycle exclusion) are logged with `device_id = "server"`; clients skip only their OWN echoes, so they must still apply those.
- Server seed = generated `migrations/0002_seed.sql` (guarded by `tests/seed-sql.test.ts`; regenerate with `npx vitest run tests/seed-sql.test.ts -u` after changing fixtures).
- Client engine pushes then pulls, applies each pull page + cursor in ONE Dexie transaction; a pending local mutation with a newer HLC beats an incoming change. Starts only in production builds or with `VITE_ENABLE_SYNC=true` (needs `npm run worker:dev`).
- Cycle status transitions are enforced by the client; the DB only constrains the set of states (a trigger would reject legitimate LWW outcomes and cause permanent divergence).

## Toolchain gotchas
- **Vitest is pinned to 4.1.x**: `@cloudflare/vitest-pool-workers@0.22` peer-requires `^4.1`. npm's resolver crashes on this tree (`edgesOut`), so install with `npm install --legacy-peer-deps`.
- Tests: `npm run test:node` (Node + fake-indexeddb), `npm run test:worker` (workerd + real D1 + two real clients), `npm test` runs both. v8 coverage cannot instrument workerd, so `npm run coverage` covers the Node project only.
- `wrangler.jsonc` `compatibility_date` must not exceed what the bundled workerd supports (currently 2026-08-22). `database_id` is a placeholder until `wrangler d1 create`.
- Conflict tests must make the "later" writer genuinely later (`outpace()` in `worker/sync-e2e.test.ts`): after syncing, device HLCs share a high-water mark.

## PWA / offline / delivery
- `vite-plugin-pwa` (Workbox generateSW, `registerType: "prompt"`): precaches the shell, every JS/CSS chunk (lazy views and bundled fixtures included) and icons; `navigateFallback` excludes `/api/*` and `/cdn-cgi/*`; `clientsClaim` so the first load is already controlled. The service worker exists ONLY in production builds (`devOptions.enabled: false`).
- Bundle: entry ~164 kB (46 kB gz); React/Dexie/Zod/motion are separate vendor chunks (codeSplitting groups in `vite.config.ts`) so app-code updates don't invalidate them. Plan + Grocery are eager; Prep (incl. Day 1), Cook, Recipes, `JsonEditorModal` and `VideoDrawer` are `React.lazy`. Fonts (`woff2`) are precached.
- `navigator.storage.persist()` is requested at boot (`src/ui/persist.ts`). Header `SyncIndicator` (a pill; tap for detail, or to reopen the sign-in screen) shows Offline / Syncing / Synced / N queued / Check device clock / Local only (`ui/lib/syncLabel.ts`).
- The sync engine also pushes ~1.5 s after any local write (debounced outbox hook), not only on the poll.
- Worker clock-skew guard: stamps > 60 s ahead of server time are held (`retry`, never written or logged), surfaced to the client as `status.blocked`.
- `e2e/offline.spec.ts` runs the `offline` Playwright project against `npm run e2e:offline-server` (production build + `wrangler dev` + fresh local D1 on :8787). Other projects ignore it. Selector tip: the header indicator and banners are all `role="status"`, so scope `getByRole("status")` with `.filter({ hasText })`.
- **Access gate** (`worker/access.ts`, middleware in `worker/index.ts`): all `/api/*` requires a valid `Cf-Access-Jwt-Assertion` (RS256 pinned, iss/aud/exp checked, JWKS cached with cooldown'd refetch). Fails closed (500) if `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD` are unset. Local dev bypass needs BOTH `--var ACCESS_DEV_BYPASS:true` (CLI only, never in wrangler.jsonc; `npm run worker:dev`, `e2e:offline-server`, and the workerd test config set it) AND a loopback hostname. Worker tests use `http://localhost`; to test the real gate call `app.fetch(req, customEnv)` (see `worker/access.test.ts`). Client shows "Sign in again" on 401/403/login-redirect (`status.auth`).
- Deploying: see `DEPLOY.md` (exact wrangler commands; nothing is run automatically).

## Status
M1-M6 complete. Deployed (see memory `deployment-state`): live at https://pundo.gitlore.workers.dev (Access app destination still to be pointed at the new hostname by the user); remote D1 `pundo` migrated; Access vars set; old `meal-prep-engine` D1 kept as a safety copy until the user confirms (see memory deployment-state). Not done / known: a device whose clock was stamped far in the future keeps those changes queued until server time catches up (they are never dropped).
