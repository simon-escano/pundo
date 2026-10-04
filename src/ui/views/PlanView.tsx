import { useState } from "react";
import { AnimatePresence, m } from "motion/react";
import { ArrowRight, Dices, House, Lock, LockOpen, Pencil, Plus, RotateCcw, Send, Shuffle, Undo2 } from "lucide-react";
import { cycleRanges, formatCycleRange, formatRange } from "../../domain/engines/dates";
import type { RollError } from "../../domain/engines/roller";
import { formatMoney, PROTEIN_LABEL, SAUCE_LABEL, STATUS_LABEL, TIER_LABEL, WEEK_CAPTION } from "../lib/format";
import { lockWeek, randomSeed, rerollOne, rollPlan, todayIso } from "../lib/actions";
import type { SlotView } from "../lib/derive";
import { useApp } from "../app-context";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { EASE_OUT } from "../motion";
import { Banner, Button, cx, Empty, IconButton, LinkButton, Modal, PROTEIN_ICON, PROTEIN_TINT, Stepper, StoveOrder, Tag } from "../components/ui";
import { routeHref } from "../router";

function rollMessage(e: RollError): { title: string; body: string } {
  if (e.code === "INSUFFICIENT_HARDY_POOL") return { title: `Need ${e.need - e.have} more dish${e.need - e.have === 1 ? "" : "es"} that keep 2 weeks`, body: e.detail };
  if (e.code === "LOCK_CONFLICT") return { title: "A locked dish breaks a rule", body: e.detail };
  return { title: "No valid roll with these recipes", body: e.detail };
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
    <div className="flex flex-col gap-9">
      <section aria-label="Cycle controls">
        <h1 className="font-display text-[2.75rem] font-extrabold leading-[0.95] tracking-tight" data-testid="cycle-dates">{formatCycleRange(cycle.start_date)}</h1>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <Tag tone="accent" icon={cycle.status === "draft" ? Pencil : Lock} data-testid="cycle-status" className="text-[15px]">{STATUS_LABEL[cycle.status]}</Tag>
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted">Portions per dish</span>
            <Stepper label="portions" value={cycle.global_portions} disabled={!draft} onChange={(n) => run(() => s.cycles.setGlobalPortions(cycle.id, n))} />
          </div>
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          {draft && (
            <>
              <Button variant={hasDishes ? "secondary" : "primary"} icon={hasDishes ? Shuffle : Dices} onClick={doRoll}>{hasDishes ? "Shuffle unlocked" : "Roll dishes"}</Button>
              <Button variant="primary" icon={Lock} disabled={!derived.complete} onClick={() => run(() => s.cycles.transition(cycle.id, "locked"))}>Lock plan</Button>
            </>
          )}
          {cycle.status === "locked" && (
            <>
              <LinkButton variant="primary" icon={ArrowRight} href={routeHref("grocery")}>Go to grocery</LinkButton>
              <Button variant="ghost" icon={Undo2} onClick={() => run(() => s.cycles.transition(cycle.id, "draft"))}>Unlock plan</Button>
            </>
          )}
          {cycle.status === "complete" && <Button variant="primary" icon={Plus} onClick={() => run(() => s.cycles.create({ start_date: todayIso(), seed: randomSeed() }))}>Start new cycle</Button>}
        </div>
      </section>

      <AnimatePresence>{roll && <Banner title={rollMessage(roll).title}>{rollMessage(roll).body}</Banner>}</AnimatePresence>

      {([1, 2] as const).map((week) => {
        const r = week === 1 ? ranges.week1 : ranges.week2;
        const locked = hasDishes && weekLocked(week);
        return (
          <section key={week} aria-label={`Week ${week}`} data-testid={`week-${week}`}>
            <div className="flex items-start justify-between gap-3 border-t-2 border-ink pt-2.5">
              <div className="min-w-0">
                <h2 className="flex flex-wrap items-baseline gap-x-3 font-display text-3xl font-extrabold">
                  Week {week}
                  <span className="font-sans text-sm font-medium tabular-nums text-muted">{formatRange(r.start, r.end)}</span>
                </h2>
                <p className="mt-1 text-sm text-muted">{WEEK_CAPTION[week]}</p>
              </div>
              <IconButton
                icon={locked ? Lock : LockOpen}
                label={`Lock week ${week}`}
                variant="secondary"
                aria-pressed={locked}
                disabled={!draft || !hasDishes}
                onClick={() => run(() => lockWeek(s, cycle.id, week, !weekLocked(week)))}
              />
            </div>
            <div className="mt-4 grid grid-cols-3 gap-2 sm:gap-3 md:gap-4">
              {derived.slots.filter((x) => x.week === week).map((x) => (
                <DishCell key={x.slot} view={x} onRollError={setRoll} />
              ))}
            </div>
          </section>
        );
      })}
      {!hasDishes && <Empty icon={Dices}>Nothing rolled yet. Roll to draw three dishes for each week.</Empty>}
    </div>
  );
}

/** One slot. Each cell animates on its own, so a re-roll flips only the dish that changed. */
function DishCell({ view, onRollError }: { view: SlotView; onRollError: (e: RollError | null) => void }) {
  const wide = useMediaQuery("(min-width: 768px)");
  return (
    <div className="min-w-0">
      <AnimatePresence mode="wait" initial={false}>
        <m.div
          key={view.recipe?.id ?? "empty"}
          className="h-full"
          initial={{ opacity: 0, scale: 0.94, y: 8, rotate: -1.5 }}
          animate={{ opacity: 1, scale: 1, y: 0, rotate: 0, transition: { duration: 0.24, ease: EASE_OUT, delay: view.slot * 0.05 } }}
          exit={{ opacity: 0, scale: 0.94, transition: { duration: 0.12 } }}
        >
          {!view.recipe || !view.dish ? (
            <div data-testid="dish-empty" className="grid min-h-44 place-items-center rounded-2xl border-2 border-dashed border-ink/20 p-2 text-center text-sm font-medium text-muted">
              Dish {view.slot + 1}
            </div>
          ) : wide ? (
            <DishCard view={view} onRollError={onRollError} />
          ) : (
            <DishTile view={view} onRollError={onRollError} />
          )}
        </m.div>
      </AnimatePresence>
    </div>
  );
}

const dishAttrs = (v: SlotView) => ({ "data-testid": "dish-card", "data-week": v.week, "data-slot": v.slot, "data-recipe": v.recipe!.id, "data-priority": v.recipe!.stove_priority });

function ProteinTag({ view }: { view: SlotView }) {
  const Icon = PROTEIN_ICON[view.recipe!.protein_category];
  return (
    <span className="inline-flex items-center gap-1 text-xs font-semibold text-ink/70" data-testid="protein-tag">
      <Icon aria-hidden className="size-4" strokeWidth={2.25} />
      {PROTEIN_LABEL[view.recipe!.protein_category]}
    </span>
  );
}

/** Phones: a flat colour tile, three across. Tapping opens the details sheet. */
function DishTile({ view, onRollError }: { view: SlotView; onRollError: (e: RollError | null) => void }) {
  const [open, setOpen] = useState(false);
  const { recipe, dish, portions } = view;
  return (
    <article {...dishAttrs(view)} className="h-full">
      <button
        type="button"
        aria-label={`Open ${recipe!.name}`}
        onClick={() => setOpen(true)}
        className={cx("flex h-full min-h-44 w-full flex-col items-start gap-2 rounded-2xl p-3 text-left transition-transform duration-150 active:scale-[0.97]", PROTEIN_TINT[recipe!.protein_category])}
      >
        <span className="flex w-full items-center justify-between">
          <ProteinTag view={view} />
          {dish!.locked && <Lock aria-label="Locked" className="size-3.5 text-ink" strokeWidth={2.5} />}
        </span>
        <h3 className="line-clamp-5 font-display text-[1.05rem] font-bold leading-[1.1]">{recipe!.name}</h3>
        <span className="mt-auto flex flex-col">
          <span className="font-display text-3xl font-extrabold leading-none tabular-nums">{portions}</span>
          <span className="text-xs font-medium text-ink/70">portions</span>
        </span>
      </button>
      <AnimatePresence>
        {open && (
          <Modal title={recipe!.name} onClose={() => setOpen(false)}>
            <DishDetail view={view} onRollError={onRollError} />
          </Modal>
        )}
      </AnimatePresence>
    </article>
  );
}

/** Tablet and up: a larger colour card with icon actions pinned to the bottom. */
function DishCard({ view, onRollError }: { view: SlotView; onRollError: (e: RollError | null) => void }) {
  const { s, cycle, run } = useApp();
  const [editing, setEditing] = useState(false);
  const draft = cycle.status === "draft";
  const { recipe, dish, week, slot, portions } = view;
  return (
    <article {...dishAttrs(view)} className={cx("flex h-full flex-col rounded-3xl p-5", PROTEIN_TINT[recipe!.protein_category])}>
      <div className="flex items-center justify-between gap-2">
        <ProteinTag view={view} />
        {dish!.locked && <Lock aria-label="Locked" className="size-4" strokeWidth={2.5} />}
      </div>
      <h3 className="mt-3 font-display text-2xl font-bold leading-[1.05]">{recipe!.name}</h3>
      <DishFacts view={view} />
      <div className="mt-auto flex items-center gap-1.5 pt-5">
        <IconButton icon={dish!.locked ? Lock : LockOpen} variant="secondary" label={`${dish!.locked ? "Unlock" : "Lock"} ${recipe!.name}`} aria-pressed={dish!.locked} disabled={!draft} onClick={() => run(() => s.cycles.setLocked(cycle.id, week, slot, !dish!.locked))} />
        <IconButton icon={Pencil} variant="secondary" label={`Edit portions for ${recipe!.name}`} aria-expanded={editing} disabled={!draft} onClick={() => setEditing(!editing)} />
        <IconButton icon={RotateCcw} variant="secondary" label={`Re-roll ${recipe!.name}`} disabled={!draft || dish!.locked} onClick={() => run(async () => { const r = await rerollOne(s, cycle, { week, slot }); onRollError(r.ok ? null : r.error); })} />
      </div>
      <AnimatePresence initial={false}>
        {editing && draft && (
          <m.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <PortionEditor view={view} />
          </m.div>
        )}
      </AnimatePresence>
      <span className="sr-only">{portions} portions</span>
    </article>
  );
}

/** Tier, sauce, stove order, the 8 + 2 split and the cost, as plain lines. Shared by the card and the sheet. */
function DishFacts({ view }: { view: SlotView }) {
  const { recipe, dish, portions, cost } = view;
  const home = Math.min(portions, 8);
  return (
    <div className="mt-3 flex flex-col gap-1.5 text-sm text-ink/75">
      <p className="font-medium">{TIER_LABEL[recipe!.perishability_tier]} · {SAUCE_LABEL[recipe!.sauce_base]}</p>
      <StoveOrder priority={recipe!.stove_priority} />
      <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-display text-xl font-extrabold tabular-nums text-ink">{portions} portions</span>
        <span className="inline-flex items-center gap-1"><House aria-hidden className="size-4" />{home} home</span>
        {portions - home > 0 && <span className="inline-flex items-center gap-1"><Send aria-hidden className="size-4" />{portions - home} to share</span>}
        {dish!.portion_override !== null && <Tag tone="accent">Custom</Tag>}
      </p>
      {cost && (
        <p>
          <strong className="font-semibold tabular-nums text-ink">{formatMoney(cost.perPortion)}</strong> per portion{cost.source === "fallback" ? " (estimate)" : ""}
        </p>
      )}
    </div>
  );
}

function PortionEditor({ view }: { view: SlotView }) {
  const { s, cycle, run } = useApp();
  const { recipe, dish, week, slot, portions } = view;
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <Stepper label={`${recipe!.name} portions`} value={portions} onChange={(n) => run(() => s.cycles.setPortionOverride(cycle.id, week, slot, n))} />
      <Button variant="ghost" disabled={dish!.portion_override === null} onClick={() => run(() => s.cycles.setPortionOverride(cycle.id, week, slot, null))}>Use global</Button>
    </div>
  );
}

/** Phone sheet: everything about one dish, with labelled actions. */
function DishDetail({ view, onRollError }: { view: SlotView; onRollError: (e: RollError | null) => void }) {
  const { s, cycle, run } = useApp();
  const draft = cycle.status === "draft";
  const { recipe, dish, week, slot } = view;
  return (
    <div className={cx("-mx-5 -mb-5 flex flex-col gap-4 px-5 pb-6 pt-4", PROTEIN_TINT[recipe!.protein_category])}>
      <ProteinTag view={view} />
      <DishFacts view={view} />
      {draft && <PortionEditor view={view} />}
      <div className="grid grid-cols-2 gap-2">
        <Button icon={dish!.locked ? Lock : LockOpen} aria-pressed={dish!.locked} aria-label={`${dish!.locked ? "Unlock" : "Lock"} ${recipe!.name}`} disabled={!draft} onClick={() => run(() => s.cycles.setLocked(cycle.id, week, slot, !dish!.locked))}>
          {dish!.locked ? "Locked" : "Lock"}
        </Button>
        <Button icon={RotateCcw} aria-label={`Re-roll ${recipe!.name}`} disabled={!draft || dish!.locked} onClick={() => run(async () => { const r = await rerollOne(s, cycle, { week, slot }); onRollError(r.ok ? null : r.error); })}>
          Re-roll
        </Button>
      </div>
    </div>
  );
}
