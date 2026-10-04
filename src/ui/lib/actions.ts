import { deriveSeed, rerollSlot, rollCycle, SLOT_KEYS, slotKey, type RollResult, type Slot, type SlotKey } from "../../domain/engines/roller";
import type { Cycle } from "../../domain/schemas/app";
import type { GroceryLine } from "../../domain/engines/grocery";
import type { GlobalPriceRegistry } from "../../domain/schemas/blueprint";
import type { Storage } from "../../storage";
import { planCalibration, type CalibrationInput, type CalibrationPlan } from "./calibration";

/** Roll all open slots. The first roll uses the cycle's seed; later rolls derive a fresh seed and persist it. */
export async function rollPlan(s: Storage, cycle: Cycle, hasDishes: boolean): Promise<RollResult> {
  const seed = hasDishes ? deriveSeed(cycle.seed, 1) : cycle.seed;
  const result = rollCycle({
    pool: await s.recipes.list(),
    seed,
    locks: await s.cycles.locks(cycle.id),
    previousCycleRecipeIds: await s.cycles.previousRecipeIds(cycle.id),
  });
  if (result.ok) {
    if (seed !== cycle.seed) await s.cycles.setSeed(cycle.id, seed);
    await s.cycles.applyRollResult(cycle.id, result);
  }
  return result;
}

/** Re-roll one dish; every other slot stays put. */
export async function rerollOne(s: Storage, cycle: Cycle, target: Slot): Promise<RollResult> {
  const dishes = (await s.cycles.getPlan(cycle.id)).dishes;
  const current = {} as Record<SlotKey, string>;
  for (const k of SLOT_KEYS) {
    const d = dishes.find((x) => slotKey({ week: x.week, slot: x.slot }) === k);
    if (!d) return { ok: false, error: { code: "UNSATISFIABLE", detail: "Roll the cycle before re-rolling a single dish." } };
    current[k] = d.recipe_id;
  }
  const seed = deriveSeed(cycle.seed, target.week * 3 + target.slot + 2);
  const result = rerollSlot(
    { pool: await s.recipes.list(), seed, locks: {}, previousCycleRecipeIds: await s.cycles.previousRecipeIds(cycle.id), current },
    target,
  );
  if (result.ok) {
    await s.cycles.setSeed(cycle.id, seed);
    await s.cycles.applyRollResult(cycle.id, result);
  }
  return result;
}

/** [Lock Week N]: flag all three slots so re-rolls leave them alone. */
export async function lockWeek(s: Storage, cycleId: string, week: 1 | 2, locked: boolean): Promise<void> {
  await s.cycles.setWeekLocked(cycleId, week, locked);
}

/** Apply a calibration plan: mark everything bought, record paid amounts, append observations (EMA). */
export async function applyCalibration(
  s: Storage,
  cycleId: string,
  lines: readonly GroceryLine[],
  registry: GlobalPriceRegistry,
  input: CalibrationInput,
): Promise<CalibrationPlan> {
  const plan = planCalibration(lines, registry, input, { at: s.ctx.nowIso(), newId: s.ctx.newId, deviceId: s.deviceId, cycleId });
  await s.groceryState.markAllBought(cycleId, lines.map((l) => l.key));
  for (const u of plan.paidUpdates) await s.groceryState.setPaid(cycleId, u.key, u.paid);
  if (plan.observations.length > 0) await s.registry.appendObservations(plan.observations);
  return plan;
}

export const todayIso = (d: Date = new Date()): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export const randomSeed = (): number => crypto.getRandomValues(new Uint32Array(1))[0]!;

export async function ensureCycle(s: Storage): Promise<void> {
  if (!(await s.cycles.latest())) await s.cycles.create({ start_date: todayIso(), seed: randomSeed() });
}
