import { Droplets, ListChecks, Soup, Snowflake } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { buildDay1Protocol, type Day1Task } from "../../domain/engines/freezerProtocol";
import { buildMiseEnPlace, formatGroup, formatStaging } from "../../domain/engines/miseEnPlace";
import { CUT_LABELS } from "../../domain/engines/cuts";
import { splitGroupHeading } from "../lib/format";
import { useChecklist } from "../hooks/useChecklist";
import { useWakeLock } from "../hooks/useWakeLock";
import { useApp } from "../app-context";
import { routeHref, useRoute } from "../router";
import { CheckRow, Empty, PageTitle, SectionHead, Segmented, Tag } from "../components/ui";
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
    <section className="mt-4" aria-label={title}>
      <SectionHead icon={icon} title={title} />
      <ul className="mt-1 flex flex-col gap-2">
        {items.map((t) => (
          <li key={t.id} className="rounded-2xl border border-line bg-raised px-3 py-1 shadow-card" data-testid="day1-task">
            <CheckRow checked={checked.has(t.id)} onChange={() => toggle(t.id)}>{t.text}</CheckRow>
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
    <div className="relative flex flex-col gap-3">
      <ClickSpark fire={allDone} />
      {groups.map((g) => {
        const { name, detail } = splitGroupHeading(g.heading);
        const on = checked.has(g.id);
        return (
          <section key={g.id} className="rounded-2xl border border-line bg-raised p-3 shadow-card" data-testid="prep-group" data-ingredient={g.id}>
            <CheckRow checked={on} onChange={() => toggle(g.id)} label={`Done: ${name}`}>
              <h2 className="text-base font-semibold">{name}</h2>
              {detail && <span className="block text-sm font-normal text-muted">{detail}</span>}
            </CheckRow>
            {g.surface && (
              <p className="mt-1 flex items-start gap-2 pl-10 text-sm" data-testid="surface-prep">
                <Droplets aria-hidden className="mt-0.5 size-4 shrink-0 text-info" />
                {g.surface}
              </p>
            )}
            <ul className="mt-2 flex flex-col gap-2 pl-10">
              {g.rows.map((r, i) => (
                <li key={`${r.recipeId}-${r.cut}-${i}`} className="rounded-xl bg-sunken px-3 py-2 text-sm" data-testid="cut-row" data-cut={r.cut}>
                  <p className="font-semibold">
                    {CUT_LABELS[r.cut].label}
                    {r.size && <span className="font-normal text-muted"> · {r.size}</span>}
                  </p>
                  <p className="text-muted">{r.text}</p>
                  <Tag tone="accent" icon={Soup}>{`Into ${bowl(r.bowl)}`}</Tag>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      {staging.length > 0 && (
        <section className="rounded-2xl border border-line bg-raised p-3 shadow-card" aria-label="Cans and sauces" data-testid="staging">
          <h2 className="text-base font-semibold">Set out cans and sauces</h2>
          <ul className="mt-1 flex flex-col">
            {staging.map((s) => (
              <li key={s.id} className="border-b border-line last:border-0">
                <CheckRow checked={checked.has(`staging:${s.id}`)} onChange={() => toggle(`staging:${s.id}`)}>
                  <span className="text-sm">{s.text}</span>
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
