// Plan size ("shape") of a cycle: how many weeks it covers and how many dishes each week holds.
// Pure and deterministic. Every module that used to assume 2 weeks x 3 dishes asks this file instead.

export type Week = 1 | 2;
export type SlotIndex = 0 | 1 | 2;
export type Slot = { week: Week; slot: SlotIndex };
export type SlotKey = `${Week}-${SlotIndex}`;
export const slotKey = (s: Slot): SlotKey => `${s.week}-${s.slot}`;

export type CycleShape = { weeks: Week; dishesPerWeek: 2 | 3 };

/** Cycles created before plan sizes existed carry no shape fields: they were all 2 weeks x 3 dishes. */
export const LEGACY_SHAPE: CycleShape = { weeks: 2, dishesPerWeek: 3 };
/** What the New plan form starts on. */
export const NEW_PLAN_SHAPE: CycleShape = { weeks: 1, dishesPerWeek: 2 };
export const SHAPES: readonly CycleShape[] = [NEW_PLAN_SHAPE, LEGACY_SHAPE];

export const shapeOf = (c: { weeks?: Week; dishes_per_week?: 2 | 3 }): CycleShape => ({
  weeks: c.weeks ?? LEGACY_SHAPE.weeks,
  dishesPerWeek: c.dishes_per_week ?? LEGACY_SHAPE.dishesPerWeek,
});
export const shapeFields = (s: CycleShape) => ({ weeks: s.weeks, dishes_per_week: s.dishesPerWeek });
export const sameShape = (a: CycleShape, b: CycleShape) => a.weeks === b.weeks && a.dishesPerWeek === b.dishesPerWeek;

export const weeksOf = (s: CycleShape): Week[] => (s.weeks === 2 ? [1, 2] : [1]);
const slotIndices = (s: CycleShape): SlotIndex[] => (s.dishesPerWeek === 3 ? [0, 1, 2] : [0, 1]);

/** Every slot in display order (Week 1 first). */
export function slotsOf(s: CycleShape): Slot[] {
  return weeksOf(s).flatMap((week) => slotIndices(s).map((slot) => ({ week, slot })));
}
export const slotKeysOf = (s: CycleShape): SlotKey[] => slotsOf(s).map(slotKey);
export const slotCount = (s: CycleShape): number => s.weeks * s.dishesPerWeek;
export const hasSlot = (s: CycleShape, week: number, slot: number): boolean =>
  weeksOf(s).includes(week as Week) && slotIndices(s).includes(slot as SlotIndex);

/**
 * The roller's fill order: the most constrained week (Week 2, hardy only) first, then Week 1.
 * For the legacy shape this is exactly [2-0, 2-1, 2-2, 1-0, 1-1, 1-2], so existing seeds roll the same plans.
 */
export function fillOrder(s: CycleShape): Slot[] {
  return [...weeksOf(s)].reverse().flatMap((week) => slotIndices(s).map((slot) => ({ week, slot })));
}

/** Days a cycle of this shape spans. */
export const daysOf = (s: CycleShape): number => s.weeks * 7;
