import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import app from "./index";
import { createAccessVerifier, devBypassActive, parseAccessConfig } from "./access";

const TEAM = "acme.cloudflareaccess.com";
const AUD = "app-aud-tag-123";
const ISS = `https://${TEAM}`;
const CERTS = `${ISS}/cdn-cgi/access/certs`;
const NOW = 1_800_000_000_000; // ms; fixed so expiry maths is exact
const sec = NOW / 1000;

const enc = new TextEncoder();
const b64u = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b instanceof Uint8Array ? b : new Uint8Array(b)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64uJson = (o: unknown) => b64u(enc.encode(JSON.stringify(o)));

type Pair = { kid: string; priv: CryptoKey; jwk: JsonWebKey };
async function makePair(kid: string): Promise<Pair> {
  const kp = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
  return { kid, priv: kp.privateKey, jwk: { ...jwk, kid } as JsonWebKey };
}
const claims = (over: Record<string, unknown> = {}) => ({ iss: ISS, aud: [AUD], sub: "user-1", email: "cook@example.com", iat: sec - 10, nbf: sec - 10, exp: sec + 3600, ...over });
async function sign(pair: Pair, payload: Record<string, unknown>, header: Record<string, unknown> = {}) {
  const h = b64uJson({ alg: "RS256", kid: pair.kid, typ: "JWT", ...header });
  const p = b64uJson(payload);
  const sig = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, pair.priv, enc.encode(`${h}.${p}`));
  return `${h}.${p}.${b64u(sig)}`;
}

let A: Pair, B: Pair;
beforeAll(async () => {
  A = await makePair("kid-A");
  B = await makePair("kid-B");
});

/** A verifier whose JWKS endpoint is a controllable fake. */
function harness(initial: Pair[] = [A]) {
  const state = { keys: initial, fetches: 0, fail: false, status: 200, t: NOW };
  const fetchFn = async (url: string) => {
    expect(url).toBe(CERTS);
    state.fetches++;
    if (state.fail) throw new TypeError("network down");
    return new Response(JSON.stringify({ keys: state.keys.map((k) => k.jwk) }), { status: state.status });
  };
  const verifier = createAccessVerifier({ teamDomain: TEAM, aud: AUD }, { fetch: fetchFn, now: () => state.t });
  return { state, verifier, verify: (t?: string | null) => verifier.verify(t) };
}
const refused = async (p: Promise<{ ok: boolean; reason?: string; status?: number }>, reason: RegExp, status = 401) => {
  const r = await p;
  expect(r.ok).toBe(false);
  expect(r.reason).toMatch(reason);
  expect(r.status).toBe(status);
};

describe("verifier: accepts a genuine Access token", () => {
  it("valid RS256 token → claims", async () => {
    const h = harness();
    const r = await h.verify(await sign(A, claims()));
    expect(r).toMatchObject({ ok: true, claims: { email: "cook@example.com", sub: "user-1", iss: ISS, aud: [AUD] } });
  });
  it("aud may be a string or an array containing ours", async () => {
    const h = harness();
    expect((await h.verify(await sign(A, claims({ aud: AUD })))).ok).toBe(true);
    expect((await h.verify(await sign(A, claims({ aud: ["other", AUD] })))).ok).toBe(true);
  });
  it("service tokens without email/sub are fine", async () => {
    const h = harness();
    const r = await h.verify(await sign(A, { iss: ISS, aud: [AUD], exp: sec + 60 }));
    expect(r).toMatchObject({ ok: true, claims: { email: null, sub: null } });
  });
});

describe("verifier: refuses every kind of bad token", () => {
  it("missing, oversized and structurally malformed tokens", async () => {
    const h = harness();
    await refused(h.verify(undefined), /missing/);
    await refused(h.verify(""), /missing/);
    await refused(h.verify("x".repeat(9000)), /oversized/);
    await refused(h.verify("only.two"), /malformed/);
    await refused(h.verify("a.b.c.d"), /malformed/);
    await refused(h.verify("!!!.@@@.###"), /malformed/);
    await refused(h.verify(`${b64uJson({ alg: "RS256", kid: "kid-A" })}.${b64u(enc.encode("not json"))}.AAAA`), /malformed/);
    await refused(h.verify(`${b64u(enc.encode("[1,2]"))}.${b64uJson({})}.AAAA`), /malformed/);
  });

  it("the algorithm is pinned: alg none and HMAC (key-confusion) are refused before any key is used", async () => {
    const h = harness();
    const p = b64uJson(claims());
    await refused(h.verify(`${b64uJson({ alg: "none", kid: "kid-A" })}.${p}.`), /unsupported alg/);
    await refused(h.verify(`${b64uJson({ alg: "HS256", kid: "kid-A" })}.${p}.${b64u(enc.encode("x"))}`), /unsupported alg/);
    await refused(h.verify(`${b64uJson({ alg: "RS512", kid: "kid-A" })}.${p}.${b64u(enc.encode("x"))}`), /unsupported alg/);
    await refused(h.verify(`${b64uJson({ kid: "kid-A" })}.${p}.${b64u(enc.encode("x"))}`), /unsupported alg/);
    expect(h.state.fetches).toBe(0); // never even fetched keys
    // a real HS256 token whose "secret" is the public modulus
    const hmacKey = await crypto.subtle.importKey("raw", enc.encode(String(A.jwk.n)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const hh = b64uJson({ alg: "HS256", kid: "kid-A" });
    const sig = await crypto.subtle.sign("HMAC", hmacKey, enc.encode(`${hh}.${p}`));
    await refused(h.verify(`${hh}.${p}.${b64u(sig)}`), /unsupported alg/);
  });

  it("kid problems: missing, unknown", async () => {
    const h = harness();
    await refused(h.verify(await sign(A, claims(), { kid: undefined })), /missing kid/);
    await refused(h.verify(await sign(A, claims(), { kid: "" })), /missing kid/);
    await refused(h.verify(await sign({ ...A, kid: "kid-ZZZ" }, claims())), /unknown kid/);
  });

  it("signature problems: tampered payload, wrong key under a known kid, garbage signature", async () => {
    const h = harness();
    const good = await sign(A, claims());
    const [hh, , ss] = good.split(".") as [string, string, string];
    await refused(h.verify(`${hh}.${b64uJson(claims({ email: "attacker@example.com" }))}.${ss}`), /bad signature/);
    await refused(h.verify(await sign({ ...B, kid: "kid-A" }, claims())), /bad signature/); // B's key claiming A's kid
    await refused(h.verify(`${good.split(".").slice(0, 2).join(".")}.${b64u(new Uint8Array(256))}`), /bad signature/);
    await refused(h.verify(`${good.split(".").slice(0, 2).join(".")}.AAAA`), /bad signature/);
  });

  it("claims are checked only after the signature, and each one matters", async () => {
    const h = harness();
    await refused(h.verify(await sign(A, claims({ iss: "https://evil.cloudflareaccess.com" }))), /wrong issuer/);
    await refused(h.verify(await sign(A, claims({ iss: undefined }))), /wrong issuer/);
    await refused(h.verify(await sign(A, claims({ aud: ["someone-else"] }))), /wrong audience/);
    await refused(h.verify(await sign(A, claims({ aud: [] }))), /wrong audience/);
    await refused(h.verify(await sign(A, claims({ aud: undefined }))), /wrong audience/);
    await refused(h.verify(await sign(A, claims({ exp: undefined }))), /missing exp/);
    await refused(h.verify(await sign(A, claims({ exp: "tomorrow" }))), /missing exp/);
    await refused(h.verify(await sign(A, claims({ nbf: sec + 3600 }))), /not yet valid/);
    await refused(h.verify(await sign(A, claims({ nbf: "soon" }))), /not yet valid/);
  });

  it("expiry honours exactly a 30 s leeway", async () => {
    const h = harness();
    expect((await h.verify(await sign(A, claims({ exp: sec - 30 })))).ok).toBe(true); // 30 s past: tolerated
    await refused(h.verify(await sign(A, claims({ exp: sec - 31 }))), /expired/);
    await refused(h.verify(await sign(A, claims({ exp: sec - 86_400 }))), /expired/);
    expect((await h.verify(await sign(A, claims({ nbf: sec + 30 })))).ok).toBe(true); // 30 s early: tolerated
    await refused(h.verify(await sign(A, claims({ nbf: sec + 31 }))), /not yet valid/);
  });
});

describe("verifier: signing-key (JWKS) handling", () => {
  it("fetches once and caches; fresh keys are not refetched", async () => {
    const h = harness();
    for (let i = 0; i < 5; i++) expect((await h.verify(await sign(A, claims()))).ok).toBe(true);
    expect(h.state.fetches).toBe(1);
  });

  it("concurrent first requests share ONE fetch (single-flight)", async () => {
    const h = harness();
    const t = await sign(A, claims());
    const rs = await Promise.all(Array.from({ length: 8 }, () => h.verify(t)));
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(h.state.fetches).toBe(1);
  });

  it("refetches after the TTL", async () => {
    const h = harness();
    await h.verify(await sign(A, claims()));
    h.state.t += 59 * 60_000;
    await h.verify(await sign(A, claims({ exp: sec + 99_999 })));
    expect(h.state.fetches).toBe(1);
    h.state.t += 2 * 60_000; // now past the 1 h TTL
    await h.verify(await sign(A, claims({ exp: sec + 99_999 })));
    expect(h.state.fetches).toBe(2);
  });

  it("key rotation: a new kid triggers a refetch and is accepted", async () => {
    const h = harness([A]);
    await h.verify(await sign(A, claims()));
    h.state.keys = [A, B]; // Cloudflare rotated in a new key
    h.state.t += 61_000; // past the refetch cooldown
    expect((await h.verify(await sign(B, claims()))).ok).toBe(true);
    expect(h.state.fetches).toBe(2);
  });

  it("an attacker spamming random kids cannot make us hammer the certs endpoint", async () => {
    const h = harness();
    await h.verify(await sign(A, claims()));
    expect(h.state.fetches).toBe(1);
    h.state.t += 61_000;
    for (let i = 0; i < 25; i++) await refused(h.verify(await sign({ ...A, kid: `junk-${i}` }, claims())), /unknown kid/);
    expect(h.state.fetches).toBe(2); // exactly one extra fetch for all 25 bad kids
    h.state.t += 61_000;
    await refused(h.verify(await sign({ ...A, kid: "junk-later" }, claims())), /unknown kid/);
    expect(h.state.fetches).toBe(3); // and at most one per cooldown window
  });

  it("outage with no cached keys → 503 (retryable, not a 401), and recovers once the endpoint is back", async () => {
    const h = harness();
    h.state.fail = true;
    await refused(h.verify(await sign(A, claims())), /keys unavailable/, 503);
    await refused(h.verify(await sign(A, claims())), /keys unavailable/, 503);
    expect(h.state.fetches).toBe(1); // the cooldown also stops us retrying on every request
    h.state.fail = false;
    h.state.t += 61_000;
    expect((await h.verify(await sign(A, claims()))).ok).toBe(true);
  });

  it("outage after keys were cached: stale keys keep working (bounded), then stop being trusted", async () => {
    const h = harness();
    await h.verify(await sign(A, claims()));
    h.state.fail = true;
    h.state.t += 2 * 3_600_000; // stale, refresh fails
    expect((await h.verify(await sign(A, claims({ exp: sec + 999_999 })))).ok).toBe(true);
    h.state.t += 25 * 3_600_000; // beyond the 24 h stale limit
    await refused(h.verify(await sign(A, claims({ exp: sec + 999_999 }))), /keys unavailable/, 503);
  });

  it("non-200 and junk JWKS responses never poison the cache; non-RSA keys are ignored", async () => {
    const h = harness();
    h.state.status = 500;
    await refused(h.verify(await sign(A, claims())), /keys unavailable/, 503);
    h.state.status = 200;
    h.state.keys = [{ ...A, jwk: { kty: "EC", crv: "P-256", x: "x", y: "y", kid: "kid-A" } as JsonWebKey }, { ...A, kid: "no-n", jwk: { kty: "RSA", kid: "no-n" } as JsonWebKey }];
    h.state.t += 61_000;
    await refused(h.verify(await sign(A, claims())), /keys unavailable/, 503); // nothing usable
    h.state.keys = [A];
    h.state.t += 61_000;
    expect((await h.verify(await sign(A, claims()))).ok).toBe(true);
  });

  it("defaults: uses global fetch and the real clock when none are injected", async () => {
    const stub = vi.fn(async () => new Response(JSON.stringify({ keys: [A.jwk] })));
    vi.stubGlobal("fetch", stub);
    try {
      const v = createAccessVerifier({ teamDomain: TEAM, aud: AUD });
      const real = Date.now() / 1000;
      expect((await v.verify(await sign(A, claims({ iat: real, nbf: real - 5, exp: real + 600 })))).ok).toBe(true);
      expect(stub).toHaveBeenCalledWith(CERTS);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("config and dev-bypass rules", () => {
  it("parseAccessConfig normalises and validates the team domain; empty/invalid → null (fail closed)", () => {
    expect(parseAccessConfig({ ACCESS_TEAM_DOMAIN: "Acme.CloudflareAccess.com", ACCESS_AUD: " tag " })).toEqual({ teamDomain: TEAM, aud: "tag" });
    expect(parseAccessConfig({ ACCESS_TEAM_DOMAIN: "https://acme.cloudflareaccess.com/", ACCESS_AUD: "tag" })?.teamDomain).toBe(TEAM);
    for (const bad of [{}, { ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "" }, { ACCESS_TEAM_DOMAIN: TEAM }, { ACCESS_AUD: "tag" }, { ACCESS_TEAM_DOMAIN: "acme.example.com", ACCESS_AUD: "tag" }, { ACCESS_TEAM_DOMAIN: "evil.com/.cloudflareaccess.com", ACCESS_AUD: "tag" }, { ACCESS_TEAM_DOMAIN: "acme.cloudflareaccess.com.evil.com", ACCESS_AUD: "tag" }]) {
      expect(parseAccessConfig(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("the bypass needs the explicit opt-in AND a loopback host", () => {
    const on = { ACCESS_DEV_BYPASS: "true" };
    for (const u of ["http://localhost:8787/api/x", "http://127.0.0.1:8787/api/x", "http://[::1]:8787/api/x"]) expect(devBypassActive(on, u), u).toBe(true);
    for (const u of ["https://meal-prep-engine.acme.workers.dev/api/x", "https://localhost.evil.com/api/x", "http://10.0.0.5/api/x", "not a url"]) expect(devBypassActive(on, u), u).toBe(false);
    for (const v of [undefined, "", "false", "1", "TRUE", "yes"]) expect(devBypassActive({ ACCESS_DEV_BYPASS: v }, "http://localhost/api/x"), String(v)).toBe(false);
  });
});

describe("the Hono middleware, end to end (no bypass)", () => {
  const baseEnv = (over: Record<string, unknown> = {}) => ({ DB: env.DB, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ...over }) as never;
  const req = (path: string, headers: Record<string, string> = {}, host = "https://meal-prep-engine.acme.workers.dev", init: RequestInit = {}) => new Request(`${host}${path}`, { ...init, headers });
  const realClaims = () => { const t = Date.now() / 1000; return claims({ iat: t - 5, nbf: t - 5, exp: t + 3600 }); };
  let stub: ReturnType<typeof vi.fn>;
  const withJwks = async <T>(fn: () => Promise<T>) => {
    stub = vi.fn(async () => new Response(JSON.stringify({ keys: [A.jwk] })));
    vi.stubGlobal("fetch", stub);
    try { return await fn(); } finally { vi.unstubAllGlobals(); }
  };

  it("fails closed when Access is not configured", async () => {
    const res = await app.fetch(req("/api/health"), baseEnv({ ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "" }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "access not configured" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("401 without a token, with a junk token, and with a token for another app; reasons are not leaked", async () => {
    await withJwks(async () => {
      for (const headers of [{}, { "Cf-Access-Jwt-Assertion": "garbage" }, { "Cf-Access-Jwt-Assertion": await sign(A, claims({ aud: ["other-app"] })) }] as Record<string, string>[]) {
        const res = await app.fetch(req("/api/health", headers), baseEnv());
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: "unauthorized" });
      }
    });
  });

  it("a valid token opens the API (health, push, pull) and health reports auth=access", async () => {
    await withJwks(async () => {
      const h = { "Cf-Access-Jwt-Assertion": await sign(A, realClaims()) };
      const health = await app.fetch(req("/api/health", h), baseEnv());
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ ok: true, auth: "access" });
      expect((await app.fetch(req("/api/sync/pull?since=0&limit=1", h), baseEnv())).status).toBe(200);
      const push = await app.fetch(req("/api/sync/push", { ...h, "content-type": "application/json" }, undefined, { method: "POST", body: JSON.stringify({ device_id: "d", mutations: [] }) }), baseEnv());
      expect(push.status).toBe(200);
    });
  });

  it("every API route is gated, including unknown paths (no route enumeration) and write endpoints", async () => {
    await withJwks(async () => {
      for (const [path, method] of [["/api/health", "GET"], ["/api/sync/pull", "GET"], ["/api/sync/push", "POST"], ["/api/does-not-exist", "GET"], ["/api/sync/nope", "DELETE"]] as const) {
        const res = await app.fetch(req(path, {}, undefined, { method }), baseEnv());
        expect(res.status, `${method} ${path}`).toBe(401);
      }
    });
  });

  it("signing keys unreachable → 503 with a retryable message (not 401)", async () => {
    vi.stubGlobal("fetch", async () => { throw new TypeError("down"); });
    try {
      const res = await app.fetch(req("/api/health", { "Cf-Access-Jwt-Assertion": await sign(A, realClaims()) }), baseEnv({ ACCESS_TEAM_DOMAIN: "outage.cloudflareaccess.com" }));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "access keys unavailable" });
    } finally { vi.unstubAllGlobals(); }
  });

  it("the dev bypass works on loopback with the opt-in var, reports auth=dev-bypass, and needs no token", async () => {
    const res = await app.fetch(req("/api/health", {}, "http://localhost:8787"), baseEnv({ ACCESS_DEV_BYPASS: "true", ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, auth: "dev-bypass" });
  });

  it("the bypass is NOT honoured on a real hostname even if the var leaks into production", async () => {
    const res = await app.fetch(req("/api/health", {}, "https://meal-prep-engine.acme.workers.dev"), baseEnv({ ACCESS_DEV_BYPASS: "true" }));
    expect(res.status).toBe(401);
    const unconfigured = await app.fetch(req("/api/health", {}, "https://meal-prep-engine.acme.workers.dev"), baseEnv({ ACCESS_DEV_BYPASS: "true", ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "" }));
    expect(unconfigured.status).toBe(500); // still fail-closed, never open
  });

  it("without the opt-in var, loopback requests are validated like any other", async () => {
    const res = await app.fetch(req("/api/health", {}, "http://localhost:8787"), baseEnv());
    expect(res.status).toBe(401);
  });
});
