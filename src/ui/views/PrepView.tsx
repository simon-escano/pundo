import { ArrowRight, Droplets, ListChecks, Soup, Snowflake } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { buildDay1Protocol, type Day1Task } from "../../domain/engines/freezerProtocol";
import { buildMiseEnPlace, formatGroup, formatStaging } from "../../domain/engines/miseEnPlace";
import { CUT_LABELS } from "../../domain/engines/cuts";
import { splitGroupHeading } from "../lib/format";
import { useChecklist } from "../hooks/useChecklist";
import { useWakeLock } from "../hooks/useWakeLock";
import { useApp } from "../app-context";
import { routeHref, useRoute } from "../router";
import { CheckRow, Empty, PageTitle, SectionHead, Segmented } from "../components/ui";
import { ClickSpark } from "../components/bits/ClickSpark";
import { LinkButton } from "../components/ui";

const HINT = {
  "day-1": "Right after shopping: freeze week 2 meat, store the produce.",
  "week-1": "Cut everything before you turn on the stove.",
  "week-2": "Cut everything before you turn on the stove.",
} as const;

/** Prep stage: Day 1 (freezer tasks) and the two cook-day cutting lists, as flat sub-tabs that live in the URL. */
export function PrepView() {
  useWakeLock(true);
  const { derived } = useApp();
  const { sub } = useRoute();
  const tab = (sub ?? "week-1") as keyof typeof HINT;
  return (
    <div>
      <PageTitle title="Prep" hint={HINT[tab]} />
      <Segmented
        className="mt-4"
        label="Prep section"
        value={tab}
        options={[
          { id: "day-1", label: "Day 1", href: routeHref("prep", "day-1") },
          { id: "week-1", label: "Week 1", href: routeHref("prep", "week-1") },
          { id: "week-2", label: "Week 2", href: routeHref("prep", "week-2") },
        ]}
      />
      {!derived.complete ? (
        <Empty icon={Soup} action={<LinkButton variant="primary" href={routeHref("plan")}>Go to plan</LinkButton>}>
          Roll and lock your plan to get your prep lists.
        </Empty>
      ) : (
        <AnimatePresence mode="wait" initial={false}>
          <m.div key={tab} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }} className="mt-4">
            {tab === "day-1" ? <Day1Tasks /> : <CookDayPrep week={tab === "week-2" ? 2 : 1} />}
          </m.div>
        </AnimatePresence>
      )}
    </div>
  );
}

function Day1Tasks() {
  const { cycle, world, derived } = useApp();
  const { checked, toggle } = useChecklist(`day1:${cycle.id}`);
  const tasks = buildDay1Protocol(derived.scaled.filter((d) => d.week === 2), world.meta);
  const meats = tasks.filter((t) => t.kind === "bag_label_meat");
  const produce = tasks.filter((t) => t.kind === "store_produce");
  const done = tasks.filter((t) => checked.has(t.id)).length;
  return (
    <div>
      <p className="text-sm text-muted"><strong className="font-semibold text-ink tabular-nums" data-testid="day1-progress">{done} of {tasks.length} done</strong></p>
      <TaskGroup icon={Snowflake} title="Bag and label week 2 meat" items={meats} checked={checked} toggle={toggle} />
      <TaskGroup icon={Soup} title="Store hardy produce" items={produce} checked={checked} toggle={toggle} />
      {tasks.length === 0 && <Empty icon={ListChecks}>Nothing to prep today.</Empty>}
    </div>
  );
}

function TaskGroup({ icon, title, items, checked, toggle }: { icon: typeof Snowflake; title: string; items: Day1Task[]; checked: ReadonlySet<string>; toggle: (id: string) => void }) {
  if (items.length === 0) return null;
  return (
    <section className="mt-6" aria-label={title}>
      <SectionHead icon={icon} title={title} />
      <ul>
        {items.map((t) => (
          <li key={t.id} className="border-b border-line" data-testid="day1-task">
            <CheckRow checked={checked.has(t.id)} onChange={() => toggle(t.id)} className="py-3"><span className="text-base">{t.text}</span></CheckRow>
          </li>
        ))}
      </ul>
    </section>
  );
}

const bowl = (s: string) => s.replace(/ Bowl$/, " bowl").replace(/ Station$/, " station");

function CookDayPrep({ week }: { week: 1 | 2 }) {
  const { cycle, world, derived } = useApp();
  const { checked, toggle } = useChecklist(`prep:${cycle.id}:${week}`);
  const board = buildMiseEnPlace(derived.scaled.filter((d) => d.week === week), world.meta);
  const groups = board.groups.map(formatGroup);
  const staging = formatStaging(board);
  const everyTick = [...groups.map((g) => g.id), ...staging.map((s) => `staging:${s.id}`)];
  const allDone = everyTick.length > 0 && everyTick.every((id) => checked.has(id));

  return (
    <div className="relative">
      <ClickSpark fire={allDone} />
      {groups.map((g) => {
        const { name, detail } = splitGroupHeading(g.heading);
        return (
          <section key={g.id} className="border-b border-line py-4" data-testid="prep-group" data-ingredient={g.id}>
            <CheckRow checked={checked.has(g.id)} onChange={() => toggle(g.id)} label={`Done: ${name}`} className="items-start">
              <h2 className="font-display text-2xl font-bold leading-tight">{name}</h2>
              {detail && <span className="block text-sm font-normal text-muted">{detail}</span>}
            </CheckRow>
            <div className="pl-[2.6rem]">
              {g.surface && (
                <p className="mt-1 flex items-start gap-2 text-sm font-medium text-accent" data-testid="surface-prep">
                  <Droplets aria-hidden className="mt-0.5 size-4 shrink-0" />
                  {g.surface}
                </p>
              )}
              <ul className="mt-3 flex flex-col gap-3">
                {g.rows.map((r, i) => (
                  <li key={`${r.recipeId}-${r.cut}-${i}`} className="text-sm" data-testid="cut-row" data-cut={r.cut}>
                    <p className="text-base font-semibold">
                      {CUT_LABELS[r.cut].label}
                      {r.size && <span className="font-normal text-muted"> · {r.size}</span>}
                    </p>
                    <p className="text-muted">{r.text}</p>
                    <p className="mt-0.5 flex items-center gap-1 font-semibold"><ArrowRight aria-hidden className="size-3.5 text-accent" strokeWidth={3} />{`Into ${bowl(r.bowl)}`}</p>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        );
      })}
      {staging.length > 0 && (
        <section className="mt-10" aria-label="Cans and sauces" data-testid="staging">
          <h2 className="font-display text-2xl font-bold">Set out cans and sauces</h2>
          <ul className="mt-1">
            {staging.map((s) => (
              <li key={s.id} className="border-b border-line last:border-0">
                <CheckRow checked={checked.has(`staging:${s.id}`)} onChange={() => toggle(`staging:${s.id}`)} className="py-3">
                  <span className="text-base">{s.text}</span>
                  <span className="block text-sm text-muted">Into {s.stations.map(bowl).join(", ")}</span>
                </CheckRow>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
