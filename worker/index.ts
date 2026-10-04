import { Hono } from "hono";
import { MAX_PULL_PAGE, PushRequestSchema } from "../src/domain/sync/protocol";
import { createAccessVerifier, devBypassActive, parseAccessConfig, type AccessVerifier } from "./access";
import { currentCursor, pull, push } from "./sync";

export type Env = Cloudflare.Env;
type Vars = { auth: "access" | "dev-bypass"; identity: { email: string | null; sub: string | null } | null };

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

// One verifier (and JWKS cache) per team + audience for the life of the isolate.
const verifiers = new Map<string, AccessVerifier>();
let warnedBypass = false;

app.use("/api/*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});

/**
 * Cloudflare Access gate for the whole API. Order: local dev bypass → fail closed if unconfigured →
 * verify `Cf-Access-Jwt-Assertion`. Rejections are deliberately terse (no reason leaks to the caller; it is logged).
 */
app.use("/api/*", async (c, next) => {
  if (devBypassActive(c.env, c.req.url)) {
    if (!warnedBypass) {
      warnedBypass = true;
      console.warn("[access] DEV BYPASS ACTIVE: Cloudflare Access validation is skipped for loopback requests");
    }
    c.set("auth", "dev-bypass");
    c.set("identity", null);
    return next();
  }
  const cfg = parseAccessConfig(c.env);
  if (!cfg) {
    console.error("[access] ACCESS_TEAM_DOMAIN / ACCESS_AUD are not configured: refusing all API requests (fail closed)");
    return c.json({ error: "access not configured" }, 500);
  }
  const k = `${cfg.teamDomain}|${cfg.aud}`;
  let verifier = verifiers.get(k);
  if (!verifier) verifiers.set(k, (verifier = createAccessVerifier(cfg)));
  const result = await verifier.verify(c.req.header("Cf-Access-Jwt-Assertion"));
  if (!result.ok) {
    console.warn(`[access] rejected: ${result.reason}`);
    return c.json({ error: result.status === 401 ? "unauthorized" : "access keys unavailable" }, result.status);
  }
  c.set("auth", "access");
  c.set("identity", { email: result.claims.email, sub: result.claims.sub });
  return next();
});

app.get("/api/health", async (c) => {
  const cursor = await currentCursor(c.env.DB);
  return c.json({ ok: true, service: "pundo", schema: 1, cursor, auth: c.get("auth") });
});

/**
 * Sign-in bounce. The signed-out screen navigates here: /api/* is outside the service worker's navigation fallback, so the
 * request reaches Cloudflare's edge and Access issues its login redirect. After login Access returns here, and we send the
 * user back to the page they were on (same-origin paths only, so this is not an open redirect).
 */
app.get("/api/login", (c) => {
  const next = c.req.query("next") ?? "/";
  return c.redirect(/^\/(?![/\\])/.test(next) ? next : "/", 302);
});

app.post("/api/sync/push", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "body must be JSON" }, 400);
  }
  const req = PushRequestSchema.safeParse(body);
  if (!req.success) return c.json({ error: "invalid push request", detail: req.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`) }, 400);
  return c.json(await push(c.env.DB, req.data.mutations, Date.now())); // server time is the only clock we trust
});

app.get("/api/sync/pull", async (c) => {
  const since = Number(c.req.query("since") ?? "0");
  const limit = Number(c.req.query("limit") ?? String(MAX_PULL_PAGE));
  if (!Number.isInteger(since) || since < 0 || !Number.isInteger(limit) || limit < 1) return c.json({ error: "since and limit must be non-negative integers" }, 400);
  return c.json(await pull(c.env.DB, since, limit));
});

app.notFound((c) => c.json({ error: "not found" }, 404));
app.onError((e, c) => {
  console.error("[worker] unhandled", e);
  return c.json({ error: "internal error" }, 500);
});

export default app;
