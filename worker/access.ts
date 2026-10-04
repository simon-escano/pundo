// Cloudflare Access JWT validation using only standard Web Crypto (RS256). No dependencies.
//
// Access injects `Cf-Access-Jwt-Assertion` on every request it proxies. We re-verify it inside the Worker so the
// API stays protected even if the Access policy is later misconfigured or the Worker is reached another way.
//
// Security properties (each is covered by a test):
//  - the algorithm is PINNED to RS256 before any key is touched (no `alg: none`, no HMAC-with-public-key confusion)
//  - the signature is verified BEFORE any claim is trusted
//  - `iss` must be our team, `aud` must contain our application's AUD tag, `exp` is mandatory, `nbf` is honoured
//  - unknown `kid`s cause at most one JWKS refetch per cooldown (an attacker cannot make us hammer the certs URL)
//  - a failed JWKS refresh falls back to previously fetched keys (bounded staleness) instead of locking everyone out

export type AccessClaims = { sub: string | null; email: string | null; iss: string; aud: string[]; exp: number };
export type AccessResult =
  | { ok: true; claims: AccessClaims }
  | { ok: false; reason: string; status: 401 | 503 }; // 401 = refuse; 503 = could not fetch signing keys (retryable)

export type AccessConfig = { teamDomain: string; aud: string };

const TEAM_DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.cloudflareaccess\.com$/;
const MAX_TOKEN_CHARS = 8_192;

/** Read and validate the Access settings. Null means "not (correctly) configured": callers must fail closed. */
export function parseAccessConfig(env: { ACCESS_TEAM_DOMAIN?: string; ACCESS_AUD?: string }): AccessConfig | null {
  const teamDomain = (env.ACCESS_TEAM_DOMAIN ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const aud = (env.ACCESS_AUD ?? "").trim();
  return TEAM_DOMAIN_RE.test(teamDomain) && aud.length > 0 ? { teamDomain, aud } : null;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Local development bypass. Requires BOTH an explicit opt-in var (pass it on the CLI: `wrangler dev --var
 * ACCESS_DEV_BYPASS:true`; it is deliberately not in wrangler.jsonc) AND a loopback hostname, so a leaked
 * variable cannot open a deployed Worker: its requests arrive on a real hostname.
 */
export function devBypassActive(env: { ACCESS_DEV_BYPASS?: string }, requestUrl: string): boolean {
  if (env.ACCESS_DEV_BYPASS !== "true") return false;
  try {
    return LOOPBACK.has(new URL(requestUrl).hostname);
  } catch {
    return false;
  }
}

function b64urlBytes(s: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function decodeJson(s: string): Record<string, unknown> | null {
  const bytes = b64urlBytes(s);
  if (!bytes) return null;
  try {
    const v: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export type VerifierOptions = {
  fetch?: (url: string) => Promise<Response>;
  now?: () => number; // ms
  jwksTtlMs?: number; // how long fetched keys are considered fresh
  refreshCooldownMs?: number; // minimum gap between JWKS fetch attempts
  maxStaleMs?: number; // keep using old keys this long if refreshing keeps failing
  leewaySec?: number; // clock tolerance for exp / nbf
};

type Jwk = JsonWebKey & { kid?: string };

export function createAccessVerifier(cfg: AccessConfig, opts: VerifierOptions = {}) {
  const fetchFn = opts.fetch ?? ((u: string) => fetch(u));
  const now = opts.now ?? Date.now;
  const ttl = opts.jwksTtlMs ?? 60 * 60_000;
  const cooldown = opts.refreshCooldownMs ?? 60_000;
  const maxStale = opts.maxStaleMs ?? 24 * 60 * 60_000;
  const leeway = opts.leewaySec ?? 30;
  const issuer = `https://${cfg.teamDomain}`;
  const certsUrl = `${issuer}/cdn-cgi/access/certs`;
  const enc = new TextEncoder();

  let keys = new Map<string, CryptoKey>();
  let fetchedAt = 0;
  let lastAttempt = Number.NEGATIVE_INFINITY;
  let inflight: Promise<void> | null = null;

  /** Fetch + import the team's signing keys. Single-flight; never throws; keeps old keys on failure. */
  function refresh(): Promise<void> {
    inflight ??= (async () => {
      lastAttempt = now();
      try {
        const res = await fetchFn(certsUrl);
        if (!res.ok) return;
        const body = (await res.json()) as { keys?: Jwk[] };
        const next = new Map<string, CryptoKey>();
        for (const jwk of body.keys ?? []) {
          if (jwk.kty !== "RSA" || typeof jwk.kid !== "string" || !jwk.n || !jwk.e) continue;
          try {
            next.set(jwk.kid, await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
          } catch {
            /* skip a malformed key, keep the others */
          }
        }
        if (next.size > 0) {
          keys = next;
          fetchedAt = now();
        }
      } catch {
        /* network failure: fall back to cached keys */
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  /** undefined = no keys available at all (retryable); null = keys exist but this kid is not among them. */
  async function keyFor(kid: string): Promise<CryptoKey | null | undefined> {
    if (inflight) await inflight; // join a fetch already running (cold-start bursts must not see "no keys")
    if (keys.size > 0 && now() - fetchedAt > maxStale) keys = new Map(); // too old to trust any more
    const stale = keys.size === 0 || now() - fetchedAt >= ttl;
    if (stale && now() - lastAttempt >= cooldown) await refresh();
    let key = keys.get(kid);
    if (!key && keys.size > 0 && now() - lastAttempt >= cooldown) {
      await refresh(); // possible key rotation: one refetch per cooldown, however many bad kids arrive
      key = keys.get(kid);
    }
    if (key) return key;
    return keys.size === 0 ? undefined : null;
  }

  const refuse = (reason: string): AccessResult => ({ ok: false, reason, status: 401 });

  async function verify(token: string | null | undefined): Promise<AccessResult> {
    if (!token) return refuse("missing token");
    if (token.length > MAX_TOKEN_CHARS) return refuse("oversized token");
    const parts = token.split(".");
    if (parts.length !== 3) return refuse("malformed token");
    const [h, p, s] = parts as [string, string, string];

    const header = decodeJson(h);
    if (!header) return refuse("malformed header");
    if (header.alg !== "RS256") return refuse(`unsupported alg ${JSON.stringify(header.alg)}`); // pinned BEFORE any key is used
    if (typeof header.kid !== "string" || header.kid.length === 0) return refuse("missing kid");
    const payload = decodeJson(p);
    const sig = b64urlBytes(s);
    if (!payload || !sig) return refuse("malformed token");

    const key = await keyFor(header.kid);
    if (key === undefined) return { ok: false, reason: "signing keys unavailable", status: 503 };
    if (key === null) return refuse("unknown kid");

    const valid = await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, sig, enc.encode(`${h}.${p}`)).catch(() => false);
    if (!valid) return refuse("bad signature");

    // Only now are the claims trustworthy.
    const nowSec = now() / 1000;
    if (payload.iss !== issuer) return refuse("wrong issuer");
    const aud = typeof payload.aud === "string" ? [payload.aud] : Array.isArray(payload.aud) ? payload.aud.filter((a): a is string => typeof a === "string") : [];
    if (!aud.includes(cfg.aud)) return refuse("wrong audience");
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) return refuse("missing exp");
    if (nowSec > payload.exp + leeway) return refuse("expired");
    if (payload.nbf !== undefined && (typeof payload.nbf !== "number" || nowSec + leeway < payload.nbf)) return refuse("not yet valid");

    return {
      ok: true,
      claims: {
        sub: typeof payload.sub === "string" ? payload.sub : null,
        email: typeof payload.email === "string" ? payload.email : null,
        iss: issuer,
        aud,
        exp: payload.exp,
      },
    };
  }

  return { verify };
}

export type AccessVerifier = ReturnType<typeof createAccessVerifier>;
