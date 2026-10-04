import { CycleSchema, type Cycle } from "../../domain/schemas/app";
import type { Recipe } from "../../domain/schemas/blueprint";
import { parseIsoDate } from "../../domain/engines/dates";
import { SLOT_KEYS, type RollResult, type SlotKey } from "../../domain/engines/roller";
import { compareBy } from "../../domain/math/compare";
import type { DishRow } from "../db";
import { StorageError } from "../errors";
import { writeTx, type Ctx } from "../outbox";

export type CycleStatus = Cycle["status"];
export type SlotAssignment = { week: 1 | 2; slot: 0 | 1 | 2; recipe_id: string };

/** draft → locked → shopped → (w1_cooked →) complete. A locked plan may be unlocked back to draft. */
export const STATUS_NEXT: Record<CycleStatus, readonly CycleStatus[]> = {
  draft: ["locked"],
  locked: ["draft", "shopped"],
  shopped: ["w1_cooked", "complete"],
  w1_cooked: ["complete"],
  complete: [],
};

const dishKey = (c: string, w: number, s: number) => `${c}|${w}|${s}`;

export function cyclesRepo(ctx: Ctx) {
  const { db } = ctx;

  async function requireCycle(id: string): Promise<Cycle> {
    const c = await db.cycles.get(id);
    if (!c) throw new StorageError("NOT_FOUND", `Cycle "${id}" not found.`);
    return c;
  }
  async function requireDraft(id: string): Promise<Cycle> {
    const c = await requireCycle(id);
    if (c.status !== "draft") throw new StorageError("INVALID_STATE", `Cycle is ${c.status}; unlock it to edit the plan.`);
    return c;
  }
  async function saveCycle(tx: { stamp: () => string; log: Parameters<Parameters<typeof writeTx>[2]>[0]["log"] }, c: Cycle): Promise<Cycle> {
    const hlc = tx.stamp();
    const row = { ...c, updated_at: hlc };
    await db.cycles.put(row);
    await tx.log("cycle", row.id, hlc, row);
    return row;
  }

  return {
    async create(input: { start_date: string; seed: number; global_portions?: number }): Promise<Cycle> {
      if (parseIsoDate(input.start_date) === null) throw new StorageError("VALIDATION", `Invalid start_date "${input.start_date}" (expected YYYY-MM-DD).`);
      const res = CycleSchema.safeParse({ id: ctx.newId(), start_date: input.start_date, seed: input.seed, global_portions: input.global_portions ?? 10, status: "draft", updated_at: "" });
      if (!res.success) throw new StorageError("VALIDATION", `Invalid cycle: ${res.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
      return writeTx(ctx, [db.cycles], (tx) => saveCycle(tx, res.data));
    },

    get: (id: string) => db.cycles.get(id),

    async list(): Promise<Cycle[]> {
      return db.cycles.orderBy("start_date").reverse().toArray();
    },

    /** The most recent cycle by start date, if any. */
    async latest(): Promise<Cycle | undefined> {
      return db.cycles.orderBy("start_date").last();
    },

    async getPlan(id: string): Promise<{ cycle: Cycle; dishes: DishRow[] }> {
      const cycle = await requireCycle(id);
      const dishes = (await db.cycleDishes.where("cycle_id").equals(id).toArray()).sort(compareBy<DishRow>((a, b) => a.week - b.week, (a, b) => a.slot - b.slot));
      return { cycle, dishes };
    },

    /** Locked slots as the roller's `locks` input. */
    async locks(id: string): Promise<Partial<Record<SlotKey, string>>> {
      const rows = await db.cycleDishes.where("cycle_id").equals(id).toArray();
      const out: Partial<Record<SlotKey, string>> = {};
      for (const r of rows) if (r.locked) out[`${r.week}-${r.slot}` as SlotKey] = r.recipe_id;
      return out;
    },

    /** Recipes cooked in the cycle immediately before this one (feeds the roller's soft cooldown). */
    async previousRecipeIds(id: string): Promise<Set<string>> {
      const cycle = await requireCycle(id);
      const prev = await db.cycles.where("start_date").below(cycle.start_date).last();
      if (!prev) return new Set();
      return new Set((await db.cycleDishes.where("cycle_id").equals(prev.id).toArray()).map((d) => d.recipe_id));
    },

    /**
     * Assign recipes to slots (draft only). Enforces: active recipes, hardy-only Week 2, no duplicate
     * recipe in the cycle, and locked slots cannot change. Locks and portion overrides are preserved.
     */
    async setDishes(id: string, assignments: readonly SlotAssignment[]): Promise<DishRow[]> {
      return writeTx(ctx, [db.cycles, db.cycleDishes, db.recipes], async (tx) => {
        await requireDraft(id);
        const rows = await db.cycleDishes.where("cycle_id").equals(id).toArray();
        const next = new Map(rows.map((r) => [dishKey(id, r.week, r.slot), r]));
        const recipeIds = [...new Set(assignments.map((a) => a.recipe_id))];
        const recipes = new Map<string, Recipe | undefined>();
        (await db.recipes.bulkGet(recipeIds)).forEach((r, i) => recipes.set(recipeIds[i]!, r && !r._deleted ? r : undefined));

        const changed: DishRow[] = [];
        for (const a of assignments) {
          if (![1, 2].includes(a.week) || ![0, 1, 2].includes(a.slot)) throw new StorageError("VALIDATION", `Invalid slot ${a.week}-${a.slot}.`);
          const recipe = recipes.get(a.recipe_id);
          if (!recipe) throw new StorageError("NOT_FOUND", `Recipe "${a.recipe_id}" not found or deleted.`);
          if (a.week === 2 && recipe.perishability_tier !== "TIER_2_HARDY") {
            throw new StorageError("VALIDATION", `"${recipe.name}" is ${recipe.perishability_tier}; Week 2 accepts hardy dishes only.`);
          }
          const old = next.get(dishKey(id, a.week, a.slot));
          if (old?.locked && old.recipe_id !== a.recipe_id) {
            throw new StorageError("CONFLICT", `Slot ${a.week}-${a.slot} is locked to "${old.recipe_id}".`);
          }
          if (old?.recipe_id === a.recipe_id) continue;
          const row: DishRow = { cycle_id: id, week: a.week, slot: a.slot, recipe_id: a.recipe_id, locked: old?.locked ?? false, portion_override: old?.portion_override ?? null, _hlc: "" };
          next.set(dishKey(id, a.week, a.slot), row);
          changed.push(row);
        }
        const seen = new Set<string>();
        for (const d of next.values()) {
          if (seen.has(d.recipe_id)) throw new StorageError("CONFLICT", `"${d.recipe_id}" would appear twice in the cycle.`);
          seen.add(d.recipe_id);
        }
        for (const row of changed) {
          row._hlc = tx.stamp();
          await db.cycleDishes.put(row);
          await tx.log("cycleDish", dishKey(id, row.week, row.slot), row._hlc, row);
        }
        return changed;
      });
    },

    /** Persist a successful roll (slot-ordered week arrays) into the cycle. */
    async applyRollResult(id: string, roll: Extract<RollResult, { ok: true }>): Promise<DishRow[]> {
      const a: SlotAssignment[] = [];
      for (const k of SLOT_KEYS) {
        const week = Number(k[0]) as 1 | 2;
        const slot = Number(k[2]) as 0 | 1 | 2;
        a.push({ week, slot, recipe_id: (week === 1 ? roll.week1 : roll.week2)[slot]!.id });
      }
      return this.setDishes(id, a);
    },

    async setLocked(id: string, week: 1 | 2, slot: 0 | 1 | 2, locked: boolean): Promise<void> {
      await patchDish(id, week, slot, (d) => (d.locked === locked ? null : { ...d, locked }));
    },

    /** [Lock Week N]: flag all of a week's dishes in ONE transaction, so a closed tab can never leave a week half-locked. */
    async setWeekLocked(id: string, week: 1 | 2, locked: boolean): Promise<number> {
      return writeTx(ctx, [db.cycles, db.cycleDishes], async (tx) => {
        await requireDraft(id);
        const rows = await db.cycleDishes.where("cycle_id").equals(id).filter((d) => d.week === week && d.locked !== locked).toArray();
        for (const d of rows) {
          const hlc = tx.stamp();
          const next = { ...d, locked, _hlc: hlc };
          await db.cycleDishes.put(next);
          await tx.log("cycleDish", dishKey(id, d.week, d.slot), hlc, next);
        }
        return rows.length;
      });
    },

    /** Per-dish portion override (null clears it). */
    async setPortionOverride(id: string, week: 1 | 2, slot: 0 | 1 | 2, portions: number | null): Promise<void> {
      if (portions !== null && !(Number.isInteger(portions) && portions >= 1 && portions <= 30)) {
        throw new StorageError("VALIDATION", "Portion override must be an integer from 1 to 30.");
      }
      await patchDish(id, week, slot, (d) => (d.portion_override === portions ? null : { ...d, portion_override: portions }));
    },

    /** Persist the roll seed (draft only) so the plan stays reproducible from (seed, locks). */
    async setSeed(id: string, seed: number): Promise<Cycle> {
      if (!(Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff)) throw new StorageError("VALIDATION", "Seed must be a uint32.");
      return writeTx(ctx, [db.cycles], async (tx) => saveCycle(tx, { ...(await requireDraft(id)), seed }));
    },

    async setGlobalPortions(id: string, portions: number): Promise<Cycle> {
      if (!(Number.isInteger(portions) && portions >= 1 && portions <= 30)) throw new StorageError("VALIDATION", "Portions must be an integer from 1 to 30.");
      return writeTx(ctx, [db.cycles], async (tx) => saveCycle(tx, { ...(await requireDraft(id)), global_portions: portions }));
    },

    /** Status machine. Locking requires all six slots to be filled. */
    async transition(id: string, to: CycleStatus): Promise<Cycle> {
      return writeTx(ctx, [db.cycles, db.cycleDishes], async (tx) => {
        const cycle = await requireCycle(id);
        if (!STATUS_NEXT[cycle.status].includes(to)) throw new StorageError("INVALID_STATE", `Cannot go from ${cycle.status} to ${to}.`);
        if (to === "locked") {
          const n = await db.cycleDishes.where("cycle_id").equals(id).count();
          if (n !== 6) throw new StorageError("INVALID_STATE", `Fill all 6 slots before locking (${n}/6).`);
        }
        return saveCycle(tx, { ...cycle, status: to });
      });
    },

    /** Effective portions for a dish: override, else the cycle's global stepper value. */
    portionsFor(cycle: Cycle, dish: Pick<DishRow, "portion_override">): number {
      return dish.portion_override ?? cycle.global_portions;
    },
  };

  async function patchDish(id: string, week: 1 | 2, slot: 0 | 1 | 2, f: (d: DishRow) => DishRow | null): Promise<void> {
    await writeTx(ctx, [db.cycles, db.cycleDishes], async (tx) => {
      await requireDraft(id);
      const d = await db.cycleDishes.get([id, week, slot]);
      if (!d) throw new StorageError("NOT_FOUND", `Slot ${week}-${slot} is empty.`);
      const n = f(d);
      if (!n) return;
      const hlc = tx.stamp();
      await db.cycleDishes.put({ ...n, _hlc: hlc });
      await tx.log("cycleDish", dishKey(id, week, slot), hlc, { ...n, _hlc: hlc });
    });
  }
}
