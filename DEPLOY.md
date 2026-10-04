# Deploying pundo to Cloudflare

One Worker serves everything: the PWA (static assets from `dist/`), the sync API (`/api/*`, Hono) and
the D1 database. **Nothing below has been run for you.** Every command is run by you, in order.

`wrangler.jsonc` ships with a placeholder `database_id`; step 2 replaces it.

## 0. One-time setup

```bash
npx wrangler login          # opens a browser to authorise wrangler
npx wrangler whoami         # confirm the right account
```

## 1. Put Cloudflare Access in front FIRST (required)

The Worker **validates the `Cf-Access-Jwt-Assertion` header itself** (RS256, standard Web Crypto, against your
team's public keys) and **fails closed**: with Access unconfigured, every `/api/*` request answers
`500 {"error":"access not configured"}`. So Access is not optional, and you need two values from it (step 1b).
Your `workers.dev` hostname is predictable: `pundo.<your-account-subdomain>.workers.dev`
(Dashboard → Workers & Pages → the subdomain shown on the right).

Dashboard → **Zero Trust → Access → Applications → Add → Self-hosted**
- Destination: that hostname, path left empty (covers the PWA *and* `/api/*`)
- Policy: **Allow**, include **Emails** → your address(es)
- Session duration: 1 month (the app stays usable offline between logins)

### 1b. Give the Worker its two Access settings

Collect:
- **Team domain**: Zero Trust → Settings → General → *Team domain*, e.g. `myteam.cloudflareaccess.com`
- **AUD tag**: Zero Trust → Access → Applications → your app → Overview → *Application Audience (AUD) Tag*

Put them in `wrangler.jsonc` (they are identifiers, not secrets):
```jsonc
"vars": {
  "ACCESS_TEAM_DOMAIN": "myteam.cloudflareaccess.com",
  "ACCESS_AUD": "<the AUD tag>"
}
```
What the Worker enforces: RS256 only, `iss` = your team, `aud` contains your AUD tag, `exp` required and
unexpired (30 s leeway), signature verified before any claim is trusted. Signing keys are fetched from
`https://<team>/cdn-cgi/access/certs`, cached for an hour, and re-fetched at most once a minute when an unknown
key id appears (key rotation).

The static app files are protected by Access at the edge; the Worker's own check guards the **API** even if the
Access policy is later loosened by mistake.

> Never set `ACCESS_DEV_BYPASS` in `wrangler.jsonc` or the dashboard. It exists only for local development
> (`npm run worker:dev` passes it on the command line) and is additionally ignored for any non-loopback hostname.

## 2. Create the remote D1 database and bind the real `database_id`

```bash
npx wrangler d1 create pundo --location apac
```
(`--location` is a hint: `wnam enam weur eeur apac oc`. Pick the closest to you; `apac` for the Philippines.)

The command prints something like:
```
database_name = "pundo"
database_id   = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```
Edit `wrangler.jsonc` and replace the placeholder (keep `binding` as `DB`):
```jsonc
"d1_databases": [{
  "binding": "DB",
  "database_name": "pundo",
  "database_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",   // <- paste here
  "migrations_dir": "migrations"
}]
```
(`wrangler d1 create ... --binding DB --update-config` can write this for you, but it may reformat the
file and drop the comments, so editing by hand is the safer route.)

## 3. Apply the migrations to the REMOTE database

```bash
npx wrangler d1 migrations apply pundo --remote
```
This applies `0001_init.sql` (schema) and `0002_seed.sql` (the 15 fixture recipes, 39 ingredients and
their seed prices). Confirm:
```bash
npx wrangler d1 execute pundo --remote \
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
Output ends with the live URL, e.g. `https://pundo.<subdomain>.workers.dev`.

## 6. Smoke test

```bash
curl -s https://pundo.<subdomain>.workers.dev/api/health
# Without a valid Access session: {"error":"unauthorized"}  (HTTP 401) -- that is the correct answer.
# Open the URL in a browser, log in, then visit /api/health there. Expect:
# {"ok":true,"service":"pundo","schema":1,"cursor":0,"auth":"access"}
# ("auth":"dev-bypass" in production would be a serious misconfiguration; it cannot occur on a real hostname.)
npx wrangler tail              # live Worker logs while you tap around
```
Then on your phone: open the URL, log in via Access, wait for **"Ready to work offline."**, and use the
browser menu → **Add to Home Screen**. Switch to airplane mode and reopen the app: it should load,
and the header dot should say **Offline**. Turn the network back on: it should return to **Synced**.

## Updating later

| Change | What to do |
|---|---|
| App/Worker code only | `npm run build && npx wrangler deploy`. Users see "A new version is ready" with a Reload button. |
| Database schema | Add `migrations/0003_<name>.sql`, run `npx wrangler d1 migrations apply pundo --remote` **before** deploying the Worker that needs it. |
| Fixture data (new bundled recipes) | **Never edit `0002_seed.sql` once applied remotely.** Write a new migration; `tests/seed-sql.test.ts` guards the file against the fixtures for local development. |

## Rollback

```bash
npx wrangler versions list                 # find the previous Worker version
npx wrangler rollback                      # roll the Worker back (add a version id to pick one)
npx wrangler d1 time-travel info pundo    # D1 point-in-time restore window / bookmark
```

## Troubleshooting the API gate

| Response from `/api/*` | Meaning |
|---|---|
| `500 access not configured` | `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` are empty or the domain is not `<team>.cloudflareaccess.com`. |
| `401 unauthorized` | No/invalid/expired token, or the AUD tag is wrong. `npx wrangler tail` shows the reason (`wrong audience`, `expired`, ...); it is never sent to the caller. |
| `503 access keys unavailable` | The Worker could not fetch the team's signing keys. Transient; the app retries with backoff. |

## Known limitations of this deployment

- **Access session expiry:** when the Access session expires the API answers 401 or redirects to the login page.
  The app shows **"Sign in again"** in the header, keeps every change on the device, and resumes syncing after you
  reload the page and log in.
- **Clock skew:** the server refuses changes stamped more than 60 s ahead of its own clock. A device whose
  clock is wrong shows **"Check device clock"**; its changes stay queued until the clock is fixed.
