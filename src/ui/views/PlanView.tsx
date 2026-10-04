import { useState } from "react";
import { cycleRanges, formatCycleRange, formatRange } from "../../domain/engines/dates";
import { formatMoney, PROTEIN_LABEL, SAUCE_LABEL, TIER_LABEL } from "../lib/format";
import { lockWeek, rerollOne, rollPlan } from "../lib/actions";
import type { SlotView } from "../lib/derive";
import { useApp } from "../app-context";
import { Banner, Empty, Stepper, StoveBadge } from "../components/ui";
import { todayIso, randomSeed } from "../lib/actions";
import type { RollError } from "../../domain/engines/roller";

function rollMessage(e: RollError): { title: string; body: string } {
  if (e.code === "INSUFFICIENT_HARDY_POOL") return { title: `Need ${e.need - e.have} more hardy dish${e.need - e.have === 1 ? "" : "es"}`, body: e.detail };
  if (e.code === "LOCK_CONFLICT") return { title: "A locked dish conflicts with the rules", body: e.detail };
  return { title: "No valid roll with the current recipes and locks", body: e.detail };
}

export function PlanView() {
  const { s, cycle, world, derived, run } = useApp();
  const [roll, setRoll] = useState<RollError | null>(null);
  const draft = cycle.status === "draft";
  const hasDishes = world.dishes.length > 0;
  const ranges = cycleRanges(cycle.start_date);
  const weekLocked = (w: 1 | 2) => derived.slots.filter((x) => x.week === w).every((x) => x.dish?.locked);

  const doRoll = () =>
    run(async () => {
      const r = await rollPlan(s, cycle, hasDishes);
      setRoll(r.ok ? null : r.error);
    });

  return (
    <div>
      <header className="card flex flex-wrap items-center gap-x-3 gap-y-2" aria-label="Cycle controls">
        <div className="min-w-0 flex-1 basis-40">
          <h1 className="text-xl font-extrabold" data-testid="cycle-dates">{formatCycleRange(cycle.start_date)}</h1>
          <span className="chip" data-testid="cycle-status">{cycle.status === "locked" ? "Plan locked" : cycle.status}</span>
        </div>
        <Stepper label="portions" value={cycle.global_portions} disabled={!draft} onChange={(n) => run(() => s.cycles.setGlobalPortions(cycle.id, n))} />
        <div className="flex w-full flex-wrap gap-2">
          <button className="btn btn-primary" disabled={!draft} onClick={doRoll}>Roll Cycle</button>
          <button className="btn" aria-pressed={hasDishes && weekLocked(1)} disabled={!draft || !hasDishes} onClick={() => run(() => lockWeek(s, cycle.id, 1, !weekLocked(1)))}>Lock Week 1</button>
          <button className="btn" aria-pressed={hasDishes && weekLocked(2)} disabled={!draft || !hasDishes} onClick={() => run(() => lockWeek(s, cycle.id, 2, !weekLocked(2)))}>Lock Week 2</button>
          {draft ? (
            <button className="btn btn-primary" disabled={!derived.complete} onClick={() => run(() => s.cycles.transition(cycle.id, "locked"))}>Lock Plan → Grocery</button>
          ) : cycle.status === "locked" ? (
            <button className="btn" onClick={() => run(() => s.cycles.transition(cycle.id, "draft"))}>Unlock Plan</button>
          ) : null}
          {cycle.status === "complete" && (
            <button className="btn btn-primary" onClick={() => run(() => s.cycles.create({ start_date: todayIso(), seed: randomSeed() }))}>New Cycle</button>
          )}
        </div>
      </header>

      {roll && (
        <div className="mt-3">
          <Banner title={rollMessage(roll).title}>{rollMessage(roll).body}</Banner>
        </div>
      )}

      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        {([1, 2] as const).map((week) => (
          <section key={week} aria-label={`Week ${week}`} data-testid={`week-${week}`}>
            <h2 className="sticky-head flex items-baseline justify-between gap-2 border-b-2 border-ink py-2 text-lg font-extrabold">
              <span>Week {week}</span>
              <span className="text-sm font-semibold muted">
                {formatRange(week === 1 ? ranges.week1.start : ranges.week2.start, week === 1 ? ranges.week1.end : ranges.week2.end)} · {week === 1 ? "Fresh + Hardy" : "Hardy only"}
              </span>
            </h2>
            <div className="mt-2 flex flex-col gap-2">
              {derived.slots.filter((x) => x.week === week).map((x) => (
                <DishCard key={x.slot} view={x} onRollError={setRoll} />
              ))}
            </div>
          </section>
        ))}
      </div>
      {!hasDishes && <Empty>No dishes yet. Tap “Roll Cycle” to draw three dishes per week.</Empty>}
    </div>
  );
}

function DishCard({ view, onRollError }: { view: SlotView; onRollError: (e: RollError | null) => void }) {
  const { s, cycle, run } = useApp();
  const [editing, setEditing] = useState(false);
  const draft = cycle.status === "draft";
  const { recipe, dish, week, slot, portions, cost } = view;

  if (!recipe || !dish) {
    return <div className="card muted" data-testid="dish-empty">Empty slot {slot + 1}: roll to fill</div>;
  }
  const home = Math.min(portions, 8);
  return (
    <article className="card" data-testid="dish-card" data-week={week} data-slot={slot} data-recipe={recipe.id} data-priority={recipe.stove_priority}>
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-base font-extrabold">{recipe.name}</h3>
        <button className="btn" aria-pressed={dish.locked} aria-label={`${dish.locked ? "Unlock" : "Lock"} ${recipe.name}`} disabled={!draft} onClick={() => run(() => s.cycles.setLocked(cycle.id, week, slot, !dish.locked))}>
          {dish.locked ? "🔒 Locked" : "🔓 Lock"}
        </button>
      </div>
      <div className="mt-1 flex flex-wrap gap-1.5">
        <span className="chip" data-testid="protein-tag">{PROTEIN_LABEL[recipe.protein_category]}</span>
        <span className="chip">{TIER_LABEL[recipe.perishability_tier]}</span>
        <span className="chip">{SAUCE_LABEL[recipe.sauce_base]}</span>
        <StoveBadge priority={recipe.stove_priority} />
      </div>
      <p className="mt-1.5 text-sm">
        <strong>{portions}</strong> portions · {home} freezer + {portions - home} send-out
        {cost && <> · <strong>{formatMoney(cost.perPortion)}</strong>/portion{cost.source === "fallback" ? " (est.)" : ""}</>}
        {dish.portion_override !== null && <span className="chip ml-1">override</span>}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button className="btn" aria-expanded={editing} aria-label={`Edit portions for ${recipe.name}`} disabled={!draft} onClick={() => setEditing(!editing)}>✎ Portions</button>
        <button className="btn" aria-label={`Re-roll ${recipe.name}`} disabled={!draft || dish.locked} onClick={() => run(async () => { const r = await rerollOne(s, cycle, { week, slot }); onRollError(r.ok ? null : r.error); })}>↻ Re-roll</button>
      </div>
      {editing && draft && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-stone-100 p-2">
          <Stepper label={`${recipe.name} portions`} value={portions} onChange={(n) => run(() => s.cycles.setPortionOverride(cycle.id, week, slot, n))} />
          <button className="btn" disabled={dish.portion_override === null} onClick={() => run(() => s.cycles.setPortionOverride(cycle.id, week, slot, null))}>Use global</button>
        </div>
      )}
    </article>
  );
}
