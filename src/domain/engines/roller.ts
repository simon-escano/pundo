import type { Recipe } from "../schemas/blueprint";
import { ROLLER_RULES } from "../constants/hardware";
import { compareStrings } from "../math/compare";
import { deriveSeed, mulberry32, weightedOrder } from "../math/prng";

export { deriveSeed };

export type Slot = { week: 1 | 2; slot: 0 | 1 | 2 };
export type SlotKey = `${1 | 2}-${0 | 1 | 2}`;
export const SLOT_KEYS: readonly SlotKey[] = ["1-0", "1-1", "1-2", "2-0", "2-1", "2-2"];
export const slotKey = (s: Slot): SlotKey => `${s.week}-${s.slot}`;

export type RollConfig = {
  maxPerProtein: number;
  maxTomatoPerWeek: number;
  cooldownWeight: number;
  nodeBudget: number; // search-node cap so a pathological pool fails fast instead of hanging the UI
};

export type RollInput = {
  pool: readonly Recipe[]; // non-deleted recipes
  seed: number; // uint32
  locks: Partial<Record<SlotKey, string>>; // slot → locked recipe_id
  previousCycleRecipeIds: ReadonlySet<string>; // historical cooldown (soft)
  exclude?: ReadonlySet<string>; // never drawn into open slots (e.g. the dish being re-rolled)
  config?: Partial<RollConfig>;
};

export type RollError =
  | { code: "LOCK_CONFLICT"; detail: string }
  | { code: "INSUFFICIENT_HARDY_POOL"; have: number; need: number; detail: string }
  | { code: "UNSATISFIABLE"; detail: string };

export type RollResult =
  | { ok: true; week1: Recipe[]; week2: Recipe[]; seed: number } // arrays are slot-ordered (index = slot)
  | { ok: false; error: RollError };

const DEFAULTS: RollConfig = {
  maxPerProtein: ROLLER_RULES.MAX_PER_PROTEIN_PER_WEEK,
  maxTomatoPerWeek: ROLLER_RULES.MAX_TOMATO_BASE_PER_WEEK,
  cooldownWeight: ROLLER_RULES.COOLDOWN_WEIGHT,
  nodeBudget: 500_000,
};

const isHardy = (r: Recipe) => r.perishability_tier === "TIER_2_HARDY";
const isTomato = (r: Recipe) => r.sauce_base === "tomato";
const classOf = (r: Recipe) => `${r.perishability_tier}|${r.protein_category}|${isTomato(r) ? 1 : 0}`;

type WeekCounts = { protein: Map<string, number>; tomato: number };
const emptyCounts = (): WeekCounts => ({ protein: new Map(), tomato: 0 });

function fits(r: Recipe, c: WeekCounts, cfg: RollConfig): boolean {
  return (c.protein.get(r.protein_category) ?? 0) < cfg.maxPerProtein && (!isTomato(r) || c.tomato < cfg.maxTomatoPerWeek);
}
function place(r: Recipe, c: WeekCounts): void {
  c.protein.set(r.protein_category, (c.protein.get(r.protein_category) ?? 0) + 1);
  if (isTomato(r)) c.tomato++;
}
function unplace(r: Recipe, c: WeekCounts): void {
  c.protein.set(r.protein_category, (c.protein.get(r.protein_category) ?? 0) - 1);
  if (isTomato(r)) c.tomato--;
}

const fail = (error: RollError): RollResult => ({ ok: false, error });

/**
 * Most dishes a week can still hold under the protein and tomato caps, given what is already placed.
 * Used only to explain UNSATISFIABLE results.
 */
function maxFillable(cands: readonly Recipe[], fixed: WeekCounts, cfg: RollConfig): number {
  const byProtein = new Map<string, { plain: number; tomato: number }>();
  for (const r of cands) {
    const e = byProtein.get(r.protein_category) ?? { plain: 0, tomato: 0 };
    if (isTomato(r)) e.tomato++;
    else e.plain++;
    byProtein.set(r.protein_category, e);
  }
  let total = 0;
  let tomatoRoom = cfg.maxTomatoPerWeek - fixed.tomato;
  for (const [p, e] of [...byProtein].sort((a, b) => compareStrings(a[0], b[0]))) {
    const room = cfg.maxPerProtein - (fixed.protein.get(p) ?? 0);
    const plain = Math.min(room, e.plain);
    const tom = Math.max(0, Math.min(e.tomato, room - plain, tomatoRoom));
    tomatoRoom -= tom;
    total += plain + tom;
  }
  return total;
}

function describePool(cands: readonly Recipe[]): string {
  const m = new Map<string, number>();
  for (const r of cands) m.set(`${r.protein_category}${isTomato(r) ? " (tomato)" : ""}`, (m.get(`${r.protein_category}${isTomato(r) ? " (tomato)" : ""}`) ?? 0) + 1);
  return [...m].sort((a, b) => compareStrings(a[0], b[0])).map(([k, n]) => `${k}: ${n}`).join(", ") || "empty";
}

/**
 * Roll a 2-week cycle. Deterministic for a given (pool, seed, locks, cooldown set).
 * Week 2 is filled first (most constrained), then Week 1, by backtracking over candidates in
 * weighted-random order (Efraimidis–Spirakis, previous-cycle dishes weighted down).
 */
export function rollCycle(input: RollInput): RollResult {
  const cfg: RollConfig = { ...DEFAULTS, ...input.config };
  const pool = [...new Map([...input.pool].map((r) => [r.id, r])).values()].sort((a, b) => compareStrings(a.id, b.id));
  const byId = new Map(pool.map((r) => [r.id, r]));

  // 1. Validate locks.
  const locked = new Map<SlotKey, Recipe>();
  const usedIds = new Set<string>();
  const counts: Record<1 | 2, WeekCounts> = { 1: emptyCounts(), 2: emptyCounts() };
  for (const [key, id] of Object.entries(input.locks) as [SlotKey, string][]) {
    if (!SLOT_KEYS.includes(key)) return fail({ code: "LOCK_CONFLICT", detail: `Unknown slot "${key}".` });
    const r = byId.get(id);
    if (!r) return fail({ code: "LOCK_CONFLICT", detail: `Locked dish "${id}" (slot ${key}) is not in the recipe pool.` });
    if (usedIds.has(id)) return fail({ code: "LOCK_CONFLICT", detail: `"${r.name}" is locked in two slots; a dish may appear once per cycle.` });
    const week = Number(key[0]) as 1 | 2;
    if (week === 2 && !isHardy(r)) {
      return fail({ code: "LOCK_CONFLICT", detail: `"${r.name}" is ${r.perishability_tier} and cannot be locked into Week 2 (hardy dishes only).` });
    }
    if (!fits(r, counts[week], cfg)) {
      const why = (counts[week].protein.get(r.protein_category) ?? 0) >= cfg.maxPerProtein
        ? `more than ${cfg.maxPerProtein} ${r.protein_category} dishes`
        : `more than ${cfg.maxTomatoPerWeek} tomato-base dish`;
      return fail({ code: "LOCK_CONFLICT", detail: `Locking "${r.name}" in Week ${week} would give ${why}.` });
    }
    place(r, counts[week]);
    usedIds.add(id);
    locked.set(key, r);
  }

  // 2. Open slots, Week 2 first.
  const open: Slot[] = [];
  for (const week of [2, 1] as const) {
    for (const slot of [0, 1, 2] as const) if (!locked.has(slotKey({ week, slot }))) open.push({ week, slot });
  }
  const needW2 = open.filter((s) => s.week === 2).length;

  // 3. Candidates for open slots.
  const candidates = pool.filter((r) => !usedIds.has(r.id) && !input.exclude?.has(r.id));
  const hardy = candidates.filter(isHardy);
  if (hardy.length < needW2) {
    return fail({
      code: "INSUFFICIENT_HARDY_POOL",
      have: hardy.length,
      need: needW2,
      detail: `Week 2 needs ${needW2} TIER_2_HARDY dishes but only ${hardy.length} are available. Add ${needW2 - hardy.length} more hardy recipe(s).`,
    });
  }
  if (candidates.length < open.length) {
    return fail({
      code: "UNSATISFIABLE",
      detail: `The cycle needs ${open.length} more distinct dishes but only ${candidates.length} are available (a dish cannot repeat within the 14 days).`,
    });
  }

  // 4. Weighted deterministic order (soft historical cooldown).
  const ordered = weightedOrder(
    candidates,
    (r) => r.id,
    (r) => (input.previousCycleRecipeIds.has(r.id) ? cfg.cooldownWeight : 1),
    mulberry32(input.seed),
  );

  // 5. Backtracking DFS. Candidates in the same class (tier, protein, tomato) are interchangeable
  // for every later decision, so a class that failed at a node is never retried there.
  const used = new Set(usedIds);
  const assigned = new Map<SlotKey, Recipe>();
  let nodes = 0;
  const dfs = (i: number): boolean => {
    if (i === open.length) return true;
    if (++nodes > cfg.nodeBudget) throw new RangeError("budget");
    const slot = open[i]!;
    const wk = counts[slot.week];
    const failedClasses = new Set<string>();
    for (const r of ordered) {
      if (used.has(r.id)) continue;
      if (slot.week === 2 && !isHardy(r)) continue;
      const cls = classOf(r);
      if (failedClasses.has(cls)) continue;
      if (!fits(r, wk, cfg)) {
        failedClasses.add(cls);
        continue;
      }
      place(r, wk);
      used.add(r.id);
      assigned.set(slotKey(slot), r);
      if (dfs(i + 1)) return true;
      assigned.delete(slotKey(slot));
      used.delete(r.id);
      unplace(r, wk);
      failedClasses.add(cls);
    }
    return false;
  };

  let solved: boolean;
  try {
    solved = dfs(0);
  } catch {
    return fail({ code: "UNSATISFIABLE", detail: "Search budget exceeded; relax locks or add more varied recipes." });
  }
  if (!solved) return fail({ code: "UNSATISFIABLE", detail: explain(candidates, hardy, counts, open, cfg) });

  const pick = (week: 1 | 2): Recipe[] =>
    ([0, 1, 2] as const).map((slot) => {
      const key = slotKey({ week, slot });
      return (locked.get(key) ?? assigned.get(key))!;
    });
  return { ok: true, week1: pick(1), week2: pick(2), seed: input.seed };
}

function explain(
  candidates: readonly Recipe[],
  hardy: readonly Recipe[],
  counts: Record<1 | 2, WeekCounts>,
  open: readonly Slot[],
  cfg: RollConfig,
): string {
  const need = (w: 1 | 2) => open.filter((s) => s.week === w).length;
  const cap2 = maxFillable(hardy, counts[2], cfg);
  if (cap2 < need(2)) {
    return `Week 2 can fill only ${cap2} of ${need(2)} open slot(s) under the caps (max ${cfg.maxPerProtein} per protein, max ${cfg.maxTomatoPerWeek} tomato-base). Hardy pool by protein: ${describePool(hardy)}. Add a hardy dish with a different protein or a non-tomato sauce.`;
  }
  const cap1 = maxFillable(candidates, counts[1], cfg);
  if (cap1 < need(1)) {
    return `Week 1 can fill only ${cap1} of ${need(1)} open slot(s) under the caps (max ${cfg.maxPerProtein} per protein, max ${cfg.maxTomatoPerWeek} tomato-base). Pool by protein: ${describePool(candidates)}. Add more varied recipes.`;
  }
  return `Weeks 1 and 2 compete for the same dishes: no split of the pool satisfies the protein and tomato caps in both weeks. Pool by protein: ${describePool(candidates)}. Add more varied hardy recipes or unlock a slot.`;
}

/** Re-roll one slot: every other slot stays fixed and the current occupant is excluded. */
export function rerollSlot(input: RollInput & { current: Record<SlotKey, string> }, target: Slot): RollResult {
  const key = slotKey(target);
  const locks: Partial<Record<SlotKey, string>> = {};
  for (const k of SLOT_KEYS) if (k !== key) locks[k] = input.current[k];
  const exclude = new Set(input.exclude ?? []);
  exclude.add(input.current[key]);
  return rollCycle({ ...input, locks, exclude });
}
