import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ENTITIES, entityKey, hlcToIso, HLC_RE, MutationSchema, PullResponseSchema, PushRequestSchema, PushResponseSchema, splitKey, validatePayload } from "./protocol";

const H = "000001791100800000-00000-dev-a".replace("000001791100800000", "001791100800000"); // 15-digit wall
const recipe = JSON.parse(readFileSync("fixtures/recipes/pinakbet.json", "utf8"));
const obs = { id: "o1", ingredient_id: "potato", kind: "observed", price: 100, observed_at: "2026-10-05T00:00:00.000Z", cycle_id: null, device_id: "d" };
const cycle = { id: "c1", start_date: "2026-10-04", seed: 1, global_portions: 10, status: "draft", updated_at: H };

describe("sync protocol", () => {
  it("HLC format and ISO conversion", () => {
    expect(HLC_RE.test(H)).toBe(true);
    expect(HLC_RE.test("nope")).toBe(false);
    expect(hlcToIso("001791100800000-00000-x")).toBe("2026-10-04T08:00:00.000Z");
  });

  it("every entity key matches the shape storage writes to the outbox", () => {
    expect(ENTITIES).toHaveLength(8);
    expect(entityKey("recipe", { recipe, deleted: false })).toBe("pinakbet");
    expect(entityKey("priceRegistry", { ingredient_id: "potato", display_name: "Potato", pricing_unit: "kg" })).toBe("potato");
    expect(entityKey("priceObservation", obs as never)).toBe("o1");
    expect(entityKey("cycle", cycle as never)).toBe("c1");
    expect(entityKey("cycleDish", { cycle_id: "c1", week: 2, slot: 1, recipe_id: "r", locked: false, portion_override: null, _hlc: H })).toBe("c1|2|1");
    expect(entityKey("pantry", { ingredient_id: "potato", state: "loose", quantity: 1, unit: "g", opened_cycle_id: null, updated_at: H })).toBe("potato|loose");
    expect(entityKey("groceryLineState", { cycle_id: "c1", line_key: "potato|g|cycle", deduct_stock: true, bought: false, paid_php: null, updated_at: H })).toBe("c1|potato|g|cycle");
    expect(entityKey("ingredientMeta", { ingredient_id: "potato", aisle: "produce", storage_class: "loose_produce", surface_prep: null, avg_unit_mass_g: null, updated_at: H })).toBe("potato");
  });

  it("splitKey keeps pipes in the final segment", () => {
    expect(splitKey("c1|potato|g|cycle", 2)).toEqual(["c1", "potato|g|cycle"]);
    expect(splitKey("c1|2|1", 3)).toEqual(["c1", "2", "1"]);
    expect(splitKey("nopipe", 2)).toBeNull();
    expect(splitKey("|x", 2)).toBeNull();
  });

  it("accepts valid payloads", () => {
    expect(validatePayload("recipe", "pinakbet", H, { recipe, deleted: false }).ok).toBe(true);
    expect(validatePayload("cycle", "c1", H, cycle).ok).toBe(true);
    expect(validatePayload("priceObservation", "o1", H, obs).ok).toBe(true);
    expect(validatePayload("pantry", "potato|loose", H, null)).toEqual({ ok: true, payload: null });
  });

  it("rejects schema violations with a located message", () => {
    const bad = validatePayload("recipe", "pinakbet", H, { recipe: { ...recipe, default_portions: 8 }, deleted: false });
    expect(bad).toMatchObject({ ok: false, message: expect.stringContaining("default_portions") });
    expect(validatePayload("cycle", "c1", H, { ...cycle, status: "weird" })).toMatchObject({ ok: false });
    expect(validatePayload("priceObservation", "o1", H, { ...obs, price: -1 })).toMatchObject({ ok: false });
  });

  it("rejects key / stamp mismatches (integrity check)", () => {
    expect(validatePayload("cycle", "other", H, cycle)).toMatchObject({ ok: false, message: expect.stringContaining("key") });
    expect(validatePayload("cycle", "c1", "001791100800001-00000-dev-a", cycle)).toMatchObject({ ok: false, message: expect.stringContaining("stamp") });
  });

  it("only pantry and cycleDish may be deleted, and delete keys must be well-formed", () => {
    expect(validatePayload("recipe", "x", H, null)).toMatchObject({ ok: false });
    expect(validatePayload("cycleDish", "c1|1|0", H, null).ok).toBe(true);
    expect(validatePayload("cycleDish", "c1|1", H, null)).toMatchObject({ ok: false, message: expect.stringContaining("key") });
    expect(validatePayload("pantry", "bad", H, null)).toMatchObject({ ok: false });
  });

  it("envelope schemas enforce limits", () => {
    const m = { client_seq: 1, entity: "cycle", entity_key: "c1", hlc: H, device_id: "d", payload: cycle };
    expect(MutationSchema.safeParse(m).success).toBe(true);
    expect(MutationSchema.safeParse({ ...m, hlc: "bad" }).success).toBe(false);
    expect(MutationSchema.safeParse({ ...m, entity: "nope" }).success).toBe(false);
    expect(PushRequestSchema.safeParse({ device_id: "d", mutations: Array(201).fill(m) }).success).toBe(false);
    expect(PushResponseSchema.safeParse({ results: [{ client_seq: 1, status: "applied" }], cursor: 3 }).success).toBe(true);
    expect(PushResponseSchema.safeParse({ results: [{ client_seq: 1, status: "weird" }], cursor: 3 }).success).toBe(false);
    expect(PullResponseSchema.safeParse({ changes: [{ seq: 1, entity: "cycle", entity_key: "c1", hlc: H, device_id: "d", payload: null }], cursor: 1, has_more: false }).success).toBe(true);
  });
});
