# Deploying Meal Prep Engine to Cloudflare

One Worker serves everything: the PWA (static assets from `dist/`), the sync API (`/api/*`, Hono) and
the D1 database. **Nothing below has been run for you.** Every command is run by you, in order.

`wrangler.jsonc` ships with a placeholder `database_id`; step 2 replaces it.

## 0. One-time setup

```bash
npx wrangler login          # opens a browser to authorise wrangler
npx wrangler whoami         # confirm the right account
```

## 1. Put Cloudflare Access in front FIRST (recommended)

The API has no login of its own. Until Access is on, anyone who knows the URL can read and write.
Your `workers.dev` hostname is predictable: `meal-prep-engine.<your-account-subdomain>.workers.dev`
(Dashboard → Workers & Pages → the subdomain shown on the right).

Dashboard → **Zero Trust → Access → Applications → Add → Self-hosted**
- Destination: that hostname, path left empty (covers the PWA *and* `/api/*`)
- Policy: **Allow**, include **Emails** → your address(es)
- Session duration: 1 month (the app stays usable offline between logins)

If you skip this step, deploy (step 5) and add the Access application immediately afterwards.

## 2. Create the remote D1 database and bind the real `database_id`

```bash
npx wrangler d1 create meal-prep-engine --location apac
```
(`--location` is a hint: `wnam enam weur eeur apac oc`. Pick the closest to you; `apac` for the Philippines.)

The command prints something like:
```
database_name = "meal-prep-engine"
database_id   = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```
Edit `wrangler.jsonc` and replace the placeholder (keep `binding` as `DB`):
```jsonc
"d1_databases": [{
  "binding": "DB",
  "database_name": "meal-prep-engine",
  "database_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",   // <- paste here
  "migrations_dir": "migrations"
}]
```
(`wrangler d1 create ... --binding DB --update-config` can write this for you, but it may reformat the
file and drop the comments, so editing by hand is the safer route.)

## 3. Apply the migrations to the REMOTE database

```bash
npx wrangler d1 migrations apply meal-prep-engine --remote
```
This applies `0001_init.sql` (schema) and `0002_seed.sql` (the 15 fixture recipes, 39 ingredients and
their seed prices). Confirm:
```bash
npx wrangler d1 execute meal-prep-engine --remote \
  --command "SELECT (SELECT COUNT(*) FROM recipes) AS recipes, (SELECT COUNT(*) FROM price_registry) AS ingredients, (SELECT COUNT(*) FROM change_log) AS changes"
# expected: recipes 15, ingredients 39, changes 0
```

## 4. Build the production bundle

```bash
npm ci --legacy-peer-deps      # (or `npm install --legacy-peer-deps`); the flag is required, see CLAUDE.md
npm run typecheck && npm test  # optional but cheap: app + worker typecheck, Node + workerd tests
npm run build                  # tsc + vite build -> dist/ (shell, split chunks, sw.js, manifest, icons)
npx wrangler deploy --dry-run  # local only: bundles the Worker and lists bindings, uploads nothing
```

## 5. Deploy

```bash
npx wrangler deploy
```
Output ends with the live URL, e.g. `https://meal-prep-engine.<subdomain>.workers.dev`.

## 6. Smoke test

```bash
curl -s https://meal-prep-engine.<subdomain>.workers.dev/api/health
# {"ok":true,"service":"meal-prep-engine","schema":1,"cursor":0}   (Access will ask you to log in first
#  if enabled: open the URL in a browser once, or use a service token for curl)
npx wrangler tail              # live Worker logs while you tap around
```
Then on your phone: open the URL, log in via Access, wait for **"Ready to work offline."**, and use the
browser menu → **Add to Home Screen**. Switch to airplane mode and reopen the app: it should load,
and the header dot should say **Offline**. Turn the network back on: it should return to **Synced**.

## Updating later

| Change | What to do |
|---|---|
| App/Worker code only | `npm run build && npx wrangler deploy`. Users see "A new version is ready" with a Reload button. |
| Database schema | Add `migrations/0003_<name>.sql`, run `npx wrangler d1 migrations apply meal-prep-engine --remote` **before** deploying the Worker that needs it. |
| Fixture data (new bundled recipes) | **Never edit `0002_seed.sql` once applied remotely.** Write a new migration; `tests/seed-sql.test.ts` guards the file against the fixtures for local development. |

## Rollback

```bash
npx wrangler versions list                 # find the previous Worker version
npx wrangler rollback                      # roll the Worker back (add a version id to pick one)
npx wrangler d1 time-travel info meal-prep-engine    # D1 point-in-time restore window / bookmark
```

## Known limitations of this deployment

- **Access session expiry:** when the Access session expires, API calls return a login page instead of
  JSON. The app treats that as a sync error ("Sync error" in the header), keeps all data on the device,
  and recovers after you reload the page and log in again.
- **No Worker-side JWT check:** protection relies on Access in front of the hostname. For defence in depth,
  validate the `Cf-Access-Jwt-Assertion` header in the Worker (not implemented).
- **Clock skew:** the server refuses changes stamped more than 60 s ahead of its own clock. A device whose
  clock is wrong shows **"Check device clock"**; its changes stay queued until the clock is fixed.
