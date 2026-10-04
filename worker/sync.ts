import { replayObservations } from "../src/domain/engines/pricing";
import type { GlobalPriceRegistry } from "../src/domain/schemas/blueprint";
import type { PriceObservation } from "../src/domain/schemas/app";
import {
  hlcWall,
  MAX_CLOCK_SKEW_MS,
  MAX_PULL_PAGE,
  validatePayload,
  type Change,
  type Entity,
  type Mutation,
  type MutationStatus,
  type PullResponse,
  type PushResponse,
} from "../src/domain/sync/protocol";
import { classifyError, planFor } from "./sql";

type Result = PushResponse["results"][number];

/**
 * Clock-skew guard. A stamp more than MAX_CLOCK_SKEW_MS ahead of server time would win every future
 * last-write-wins comparison for that row, so it is refused: nothing is written or logged. The status is
 * `retry` (not `invalid`): the stamp is immutable and the data is the user's, so it stays queued on the device
 * instead of being dropped, and it is accepted automatically once server time catches up.
 */
export function skewVerdict(hlc: string, nowMs: number): string | null {
  const ahead = hlcWall(hlc) - nowMs;
  return ahead > MAX_CLOCK_SKEW_MS ? `clock skew: this change is stamped ${Math.ceil(ahead / 1000)}s ahead of server time (limit ${MAX_CLOCK_SKEW_MS / 1000}s); fix the device clock` : null;
}

/** Apply one mutation atomically (one D1 batch). LWW, idempotent, and never throws for data problems. */
async function applyOne(db: D1Database, m: Mutation, nowMs: number): Promise<Result & { recompute?: string }> {
  const skew = skewVerdict(m.hlc, nowMs);
  if (skew) return { client_seq: m.client_seq, status: "retry", message: skew };
  const v = validatePayload(m.entity as Entity, m.entity_key, m.hlc, m.payload);
  if (!v.ok) return { client_seq: m.client_seq, status: "invalid", message: v.message };
  let plan;
  try {
    plan = planFor(db, m, v.payload);
  } catch (e) {
    const c = classifyError(e, m.entity);
    if (c) return { client_seq: m.client_seq, ...c };
    throw e;
  }
  try {
    await db.batch(plan.stmts);
  } catch (e) {
    const c = classifyError(e, m.entity);
    if (c) return { client_seq: m.client_seq, ...c };
    throw e; // infrastructure failure: surface as 500 so the client keeps the outbox and retries
  }
  const status: MutationStatus = await plan.outcome();
  return { client_seq: m.client_seq, status, ...(plan.recompute ? { recompute: plan.recompute } : {}) };
}

/**
 * Re-fold registry prices with the SAME engine the client uses (replayObservations). Optimistic
 * concurrency: the write only lands if no observation was added since we read, otherwise we re-read.
 */
export async function recomputeRegistry(db: D1Database, ingredientId: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const reg = await db.prepare("SELECT ingredient_id, display_name, pricing_unit, last_updated FROM price_registry WHERE ingredient_id = ?").bind(ingredientId).first<Omit<GlobalPriceRegistry[string], "price_per_unit">>();
    if (!reg) return;
    const rows = await db.prepare("SELECT id, ingredient_id, kind, price, observed_at, cycle_id, device_id FROM price_observations WHERE ingredient_id = ?").bind(ingredientId).all<PriceObservation>();
    const next = replayObservations({ [ingredientId]: { ...reg, price_per_unit: 0 } }, rows.results)[ingredientId]!;
    const res = await db
      .prepare("UPDATE price_registry SET price_per_unit = ?1, last_updated = ?2 WHERE ingredient_id = ?3 AND (SELECT COUNT(*) FROM price_observations WHERE ingredient_id = ?3) = ?4")
      .bind(next.price_per_unit, next.last_updated, ingredientId, rows.results.length)
      .run();
    if (res.meta.changes > 0 || (await db.prepare("SELECT price_per_unit AS p FROM price_registry WHERE ingredient_id = ?").bind(ingredientId).first<{ p: number }>())?.p === next.price_per_unit) return;
  }
}

export async function currentCursor(db: D1Database): Promise<number> {
  return (await db.prepare("SELECT COALESCE(MAX(seq), 0) AS c FROM change_log").first<{ c: number }>())?.c ?? 0;
}

export async function push(db: D1Database, mutations: readonly Mutation[], nowMs: number = Date.now()): Promise<PushResponse> {
  const results: Result[] = [];
  const touched = new Set<string>();
  for (const m of mutations) {
    const { recompute, ...r } = await applyOne(db, m, nowMs);
    results.push(r);
    if (recompute && r.status === "applied") touched.add(recompute);
  }
  for (const id of [...touched].sort()) await recomputeRegistry(db, id);
  return { results, cursor: await currentCursor(db) };
}

export async function pull(db: D1Database, since: number, limit: number): Promise<PullResponse> {
  const n = Math.min(Math.max(1, limit), MAX_PULL_PAGE);
  const rows = await db
    .prepare("SELECT seq, entity, entity_key, hlc, device_id, payload FROM change_log WHERE seq > ?1 ORDER BY seq ASC LIMIT ?2")
    .bind(since, n + 1)
    .all<{ seq: number; entity: Entity; entity_key: string; hlc: string; device_id: string; payload: string | null }>();
  const page = rows.results.slice(0, n);
  const changes: Change[] = page.map((r) => ({ ...r, payload: r.payload === null ? null : (JSON.parse(r.payload) as unknown) }));
  return { changes, cursor: page.length > 0 ? page[page.length - 1]!.seq : since, has_more: rows.results.length > n };
}
