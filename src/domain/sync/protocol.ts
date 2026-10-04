import { z } from "zod";
import { IngredientPriceRecordSchema, RecipeSchema } from "../schemas/blueprint";
import {
  CycleDishSchema,
  CycleSchema,
  GroceryLineStateSchema,
  IngredientMetaSchema,
  PantryEntrySchema,
  PriceObservationSchema,
} from "../schemas/app";

// The wire contract shared by the client sync engine and the edge Worker. Pure: no I/O, no clock.

export const ENTITIES = ["recipe", "priceRegistry", "priceObservation", "ingredientMeta", "cycle", "cycleDish", "pantry", "groceryLineState"] as const;
export type Entity = (typeof ENTITIES)[number];

export const MAX_PUSH_BATCH = 200;
/** A stamp whose physical time is further than this ahead of server time is refused (future-dated LWW poisoning). */
export const MAX_CLOCK_SKEW_MS = 60_000;
export const MAX_PULL_PAGE = 500;

/** "<wall ms, 15 digits>-<counter, 5 digits>-<deviceId>" (see storage/hlc). Lexicographic order = causal order. */
export const HLC_RE = /^\d{15}-\d{5}-.+$/;
/** Stamp carried by bootstrap (fixture) data on every device and on the server: older than any real write. */
export const SEED_HLC = `${"0".repeat(15)}-${"0".repeat(5)}-seed`;
/** Physical time (ms) encoded in an HLC. */
export const hlcWall = (hlc: string): number => Number(hlc.slice(0, 15));
export const hlcToIso = (hlc: string): string => new Date(Number(hlc.slice(0, 15))).toISOString();

export const MutationSchema = z.object({
  client_seq: z.number().int().nonnegative(),
  entity: z.enum(ENTITIES),
  entity_key: z.string().min(1).max(512),
  hlc: z.string().regex(HLC_RE).max(160),
  device_id: z.string().min(1).max(128),
  payload: z.unknown().nullable(),
});
export type Mutation = z.infer<typeof MutationSchema>;

export const PushRequestSchema = z.object({
  device_id: z.string().min(1).max(128),
  mutations: z.array(MutationSchema).max(MAX_PUSH_BATCH),
});
export type PushRequest = z.infer<typeof PushRequestSchema>;

/**
 * applied: took effect (or was already applied; replays are idempotent)
 * stale:   a newer write already won (LWW), safe to drop
 * invalid: permanently unacceptable (schema/constraint); safe to drop, surfaced to the user
 * retry:   depends on something not on the server yet (foreign key); keep and resend later
 */
export const MUTATION_STATUSES = ["applied", "stale", "invalid", "retry"] as const;
export type MutationStatus = (typeof MUTATION_STATUSES)[number];

export const PushResponseSchema = z.object({
  results: z.array(z.object({ client_seq: z.number().int(), status: z.enum(MUTATION_STATUSES), message: z.string().optional() })),
  cursor: z.number().int().nonnegative(),
});
export type PushResponse = z.infer<typeof PushResponseSchema>;

export const ChangeSchema = z.object({
  seq: z.number().int().positive(),
  entity: z.enum(ENTITIES),
  entity_key: z.string(),
  hlc: z.string().regex(HLC_RE),
  device_id: z.string(),
  payload: z.unknown().nullable(),
});
export type Change = z.infer<typeof ChangeSchema>;

export const PullResponseSchema = z.object({
  changes: z.array(ChangeSchema),
  cursor: z.number().int().nonnegative(),
  has_more: z.boolean(),
});
export type PullResponse = z.infer<typeof PullResponseSchema>;

// ── Payloads ──────────────────────────────────────────────────────────────────────────────
const PayloadSchemas = {
  recipe: z.object({ recipe: RecipeSchema, deleted: z.boolean() }),
  priceRegistry: z.object({
    ingredient_id: z.string().min(1),
    display_name: z.string(),
    pricing_unit: IngredientPriceRecordSchema.shape.pricing_unit,
  }),
  priceObservation: PriceObservationSchema,
  ingredientMeta: IngredientMetaSchema,
  cycle: CycleSchema,
  cycleDish: CycleDishSchema.extend({ _hlc: z.string() }),
  pantry: PantryEntrySchema,
  groceryLineState: GroceryLineStateSchema,
} as const;

export type Payload = { [E in Entity]: z.infer<(typeof PayloadSchemas)[E]> };

/** Entities whose change may be a delete (payload = null). */
export const DELETABLE: ReadonlySet<Entity> = new Set<Entity>(["pantry", "cycleDish"]);

/** Canonical entity_key for a payload. Must match storage's outbox keys exactly. */
export function entityKey<E extends Entity>(entity: E, p: Payload[E]): string {
  const x = p as Payload[Entity];
  switch (entity) {
    case "recipe":
      return (x as Payload["recipe"]).recipe.id;
    case "priceRegistry":
    case "ingredientMeta":
      return (x as Payload["priceRegistry"]).ingredient_id;
    case "priceObservation":
    case "cycle":
      return (x as Payload["cycle"]).id;
    case "cycleDish": {
      const d = x as Payload["cycleDish"];
      return `${d.cycle_id}|${d.week}|${d.slot}`;
    }
    case "pantry": {
      const d = x as Payload["pantry"];
      return `${d.ingredient_id}|${d.state}`;
    }
    case "groceryLineState": {
      const d = x as Payload["groceryLineState"];
      return `${d.cycle_id}|${d.line_key}`;
    }
  }
}

/** Split a key into its first segment and the rest ("cycle|potato|g|cycle" → ["cycle", "potato|g|cycle"]). */
export function splitKey(key: string, parts: number): string[] | null {
  const out: string[] = [];
  let rest = key;
  for (let i = 0; i < parts - 1; i++) {
    const at = rest.indexOf("|");
    if (at < 0) return null;
    out.push(rest.slice(0, at));
    rest = rest.slice(at + 1);
  }
  out.push(rest);
  return out.every((s) => s.length > 0) ? out : null;
}

/** The HLC a payload embeds about itself, where the schema carries one. */
function embeddedHlc(entity: Entity, p: Payload[Entity]): string | null {
  switch (entity) {
    case "ingredientMeta":
    case "cycle":
    case "pantry":
    case "groceryLineState":
      return (p as Payload["cycle"]).updated_at;
    case "cycleDish":
      return (p as Payload["cycleDish"])._hlc;
    default:
      return null;
  }
}

export type Validated<E extends Entity> = { ok: true; payload: Payload[E] | null } | { ok: false; message: string };

/** Validate a mutation's payload and its internal consistency (key and embedded stamp must agree with the envelope). */
export function validatePayload<E extends Entity>(entity: E, entity_key: string, hlc: string, payload: unknown): Validated<E> {
  if (payload === null) {
    if (!DELETABLE.has(entity)) return { ok: false, message: `${entity} cannot be deleted` };
    const want = entity === "cycleDish" ? 3 : 2;
    return splitKey(entity_key, want) ? { ok: true, payload: null } : { ok: false, message: `malformed ${entity} key` };
  }
  const parsed = PayloadSchemas[entity].safeParse(payload);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return { ok: false, message: `${entity} payload invalid at ${i?.path.join(".") || "(root)"}: ${i?.message}` };
  }
  const data = parsed.data as Payload[E];
  if (entityKey(entity, data) !== entity_key) return { ok: false, message: `${entity} key does not match payload` };
  const own = embeddedHlc(entity, data as Payload[Entity]);
  if (own !== null && own !== hlc) return { ok: false, message: `${entity} stamp does not match mutation hlc` };
  return { ok: true, payload: data };
}
