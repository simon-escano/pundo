import { Hono } from "hono";
import { MAX_PULL_PAGE, PushRequestSchema } from "../src/domain/sync/protocol";
import { currentCursor, pull, push } from "./sync";

export type Env = Cloudflare.Env;

const app = new Hono<{ Bindings: Env }>();

app.use("/api/*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});

app.get("/api/health", async (c) => {
  const cursor = await currentCursor(c.env.DB);
  return c.json({ ok: true, service: "meal-prep-engine", schema: 1, cursor });
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
