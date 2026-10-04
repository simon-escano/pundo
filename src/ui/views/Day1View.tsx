import { buildDay1Protocol, type Day1Task } from "../../domain/engines/freezerProtocol";
import { useChecklist } from "../hooks/useChecklist";
import { useApp } from "../app-context";
import { Empty } from "../components/ui";

export function Day1View() {
  const { cycle, world, derived } = useApp();
  const { checked, toggle } = useChecklist(`day1:${cycle.id}`);
  if (!derived.complete) return <Empty>Roll and lock a plan first: Day 1 prep is built from Week 2’s dishes.</Empty>;

  const tasks = buildDay1Protocol(derived.scaled.filter((d) => d.week === 2), world.meta);
  const meats = tasks.filter((t) => t.kind === "bag_label_meat");
  const produce = tasks.filter((t) => t.kind === "store_produce");
  const done = tasks.filter((t) => checked.has(t.id)).length;

  return (
    <div>
      <h1 className="text-xl font-extrabold">Day 1 freezer prep</h1>
      <p className="muted text-sm">A 5-minute task list before you store the groceries. <strong data-testid="day1-progress">{done} of {tasks.length} done</strong></p>
      <Group title="Bag & label Week 2 meats" items={meats} checked={checked} toggle={toggle} />
      <Group title="Store hardy produce" items={produce} checked={checked} toggle={toggle} />
      {tasks.length === 0 && <Empty>Nothing to prep today.</Empty>}
    </div>
  );
}

function Group({ title, items, checked, toggle }: { title: string; items: Day1Task[]; checked: ReadonlySet<string>; toggle: (id: string) => void }) {
  if (items.length === 0) return null;
  return (
    <section className="mt-4" aria-label={title}>
      <h2 className="sticky-head border-b-2 border-ink py-2 text-lg font-extrabold">{title}</h2>
      <ul className="mt-1 flex flex-col">
        {items.map((t) => (
          <li key={t.id} className="border-b border-line" data-testid="day1-task">
            <label className="check-row py-1">
              <input type="checkbox" checked={checked.has(t.id)} onChange={() => toggle(t.id)} />
              <span className={checked.has(t.id) ? "line-through muted" : "font-semibold"}>{t.text}</span>
            </label>
          </li>
        ))}
      </ul>
    </section>
  );
}
