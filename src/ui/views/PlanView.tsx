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
import { SpotlightCard } from "../components/bits/SpotlightCard";
import { Banner, Button, cx, Empty, IconButton, LinkButton, Modal, PROTEIN_ICON, Stepper, StoveOrder, Tag } from "../components/ui";
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
    <div className="flex flex-col gap-6">
      <section aria-label="Cycle controls" className="rounded-3xl border border-line bg-raised p-4 shadow-card sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold" data-testid="cycle-dates">{formatCycleRange(cycle.start_date)}</h1>
            <div className="mt-2">
              <Tag tone={cycle.status === "draft" ? "info" : "accent"} icon={cycle.status === "draft" ? Pencil : Lock} data-testid="cycle-status">{STATUS_LABEL[cycle.status]}</Tag>
            </div>
          </div>
          <div className="flex flex-col items-start gap-1 sm:items-end">
            <span className="text-xs font-medium text-muted">Portions per dish</span>
            <Stepper label="portions" value={cycle.global_portions} disabled={!draft} onChange={(n) => run(() => s.cycles.setGlobalPortions(cycle.id, n))} />
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
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
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <h2 className="flex flex-wrap items-baseline gap-x-2 text-lg font-semibold">
                  Week {week}
                  <span className="text-sm font-normal text-muted">{formatRange(r.start, r.end)}</span>
                </h2>
                <p className="text-sm text-muted">{WEEK_CAPTION[week]}</p>
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
            <div className="mt-3 grid grid-cols-3 gap-2 sm:gap-3 md:gap-4">
              {derived.slots.filter((x) => x.week === week).map((x) => (
                <DishCell key={x.slot} view={x} onRollError={setRoll} />
              ))}
            </div>
          </section>
        );
      })}
      {!hasDishes && <Empty icon={Dices}>No dishes yet. Roll to draw three dishes for each week.</Empty>}
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
          initial={{ opacity: 0, scale: 0.94, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0, transition: { duration: 0.22, ease: EASE_OUT, delay: view.slot * 0.04 } }}
          exit={{ opacity: 0, scale: 0.94, transition: { duration: 0.12 } }}
        >
          {!view.recipe || !view.dish ? (
            <div data-testid="dish-empty" className="grid min-h-40 place-items-center rounded-2xl border border-dashed border-line p-2 text-center text-sm text-muted">
              <span className="flex flex-col items-center gap-1.5">
                <Dices aria-hidden className="size-5" />
                Dish {view.slot + 1}
              </span>
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
    <span className="inline-flex items-center gap-1 text-xs font-medium text-muted" data-testid="protein-tag">
      <Icon aria-hidden className="size-3.5" />
      {PROTEIN_LABEL[view.recipe!.protein_category]}
    </span>
  );
}

/** Phones: a compact tile, three across. Tapping opens the details sheet. */
function DishTile({ view, onRollError }: { view: SlotView; onRollError: (e: RollError | null) => void }) {
  const [open, setOpen] = useState(false);
  const { recipe, dish, portions } = view;
  return (
    <article {...dishAttrs(view)} className="h-full">
      <button
        type="button"
        aria-label={`Open ${recipe!.name}`}
        onClick={() => setOpen(true)}
        className="flex h-full min-h-40 w-full flex-col items-start gap-2 rounded-2xl border border-line bg-raised p-2.5 text-left shadow-card transition-[transform,box-shadow] duration-150 active:scale-[0.98]"
      >
        <ProteinTag view={view} />
        <h3 className="line-clamp-4 text-sm font-semibold leading-snug">{recipe!.name}</h3>
        <span className="mt-auto flex w-full items-center justify-between gap-1 text-xs text-muted">
          <span className="tabular-nums">{portions} portions</span>
          {dish!.locked && <Lock aria-label="Locked" className="size-3.5 text-accent" />}
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

/** Tablet and up: the full card, with icon actions pinned to the bottom. */
function DishCard({ view, onRollError }: { view: SlotView; onRollError: (e: RollError | null) => void }) {
  const { s, cycle, run } = useApp();
  const [editing, setEditing] = useState(false);
  const draft = cycle.status === "draft";
  const { recipe, dish, week, slot, portions } = view;
  return (
    <SpotlightCard {...dishAttrs(view)} className="flex h-full flex-col rounded-2xl border border-line bg-raised p-4 shadow-card transition-shadow duration-200 hover:shadow-lift">
      <div className="flex items-center justify-between gap-2">
        <ProteinTag view={view} />
        {dish!.locked && <Lock aria-label="Locked" className="size-4 text-accent" />}
      </div>
      <h3 className="mt-2 text-base font-semibold leading-snug">{recipe!.name}</h3>
      <DishFacts view={view} />
      <div className="mt-auto flex items-center gap-1 pt-4">
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
    </SpotlightCard>
  );
}

/** Tags, the 8 + 2 split and the cost: shared by the card and the sheet. */
function DishFacts({ view }: { view: SlotView }) {
  const { recipe, dish, portions, cost } = view;
  const home = Math.min(portions, 8);
  return (
    <div className="mt-2 flex flex-col gap-2.5">
      <div className="flex flex-wrap gap-1.5">
        <Tag tone={recipe!.perishability_tier === "TIER_2_HARDY" ? "accent" : "neutral"}>{TIER_LABEL[recipe!.perishability_tier]}</Tag>
        <Tag>{SAUCE_LABEL[recipe!.sauce_base]}</Tag>
        <StoveOrder priority={recipe!.stove_priority} />
      </div>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="font-semibold tabular-nums">{portions} portions</span>
        <span className="inline-flex items-center gap-1 text-muted"><House aria-hidden className="size-4" />{home} home</span>
        {portions - home > 0 && <span className="inline-flex items-center gap-1 text-muted"><Send aria-hidden className="size-4" />{portions - home} to share</span>}
        {dish!.portion_override !== null && <Tag tone="info">Custom</Tag>}
      </p>
      {cost && (
        <p className="text-sm text-muted">
          <strong className="font-semibold text-ink tabular-nums">{formatMoney(cost.perPortion)}</strong> per portion{cost.source === "fallback" ? " (estimate)" : ""}
        </p>
      )}
    </div>
  );
}

function PortionEditor({ view }: { view: SlotView }) {
  const { s, cycle, run } = useApp();
  const { recipe, dish, week, slot, portions } = view;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 rounded-2xl bg-sunken p-2">
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
    <div className="flex flex-col gap-4">
      <ProteinTag view={view} />
      <DishFacts view={view} />
      {draft && <PortionEditor view={view} />}
      <div className={cx("grid grid-cols-2 gap-2")}>
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
