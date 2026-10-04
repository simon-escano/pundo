import { useState } from "react";
import { buildMiseEnPlace, formatGroup, formatStaging } from "../../domain/engines/miseEnPlace";
import { useChecklist } from "../hooks/useChecklist";
import { useWakeLock } from "../hooks/useWakeLock";
import { useApp } from "../app-context";
import { Empty, Toggle } from "../components/ui";

export function PrepBoardView() {
  useWakeLock(true);
  const { cycle, world, derived } = useApp();
  const [week, setWeek] = useState<"1" | "2">("1");
  const { checked, toggle } = useChecklist(`prep:${cycle.id}:${week}`);
  if (!derived.complete) return <Empty>Roll and lock a plan first to build the master prep checklist.</Empty>;

  const board = buildMiseEnPlace(derived.scaled.filter((d) => String(d.week) === week), world.meta);
  const groups = board.groups.map(formatGroup);
  const staging = formatStaging(board);

  return (
    <div>
      <h1 className="text-xl font-extrabold">Master prep checklist</h1>
      <p className="muted mb-2 text-sm">One list for every knife operation across the three dishes. Screen stays awake.</p>
      <Toggle label="Cook day" value={week} onChange={setWeek} options={[{ id: "1", label: "Week 1 cook day" }, { id: "2", label: "Week 2 cook day" }]} />

      <div className="mt-3 flex flex-col gap-3">
        {groups.map((g) => (
          <section key={g.id} className="card" data-testid="prep-group" data-ingredient={g.id}>
            <label className="check-row">
              <input type="checkbox" checked={checked.has(g.id)} onChange={() => toggle(g.id)} aria-label={`Done: ${g.heading}`} />
              <h2 className={`text-base font-extrabold ${checked.has(g.id) ? "line-through muted" : ""}`}>{g.heading}</h2>
            </label>
            {g.surface && <p className="ml-1 text-sm" data-testid="surface-prep"><strong>Surface prep:</strong> {g.surface}</p>}
            <ul className="mt-1 flex flex-col gap-1.5">
              {g.rows.map((r, i) => (
                <li key={`${r.recipeId}-${r.cut}-${i}`} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm" data-testid="cut-row" data-cut={r.cut}>
                  <span className="chip font-mono">{r.tag}</span>
                  <span className="font-semibold">{r.text}</span>
                  {r.size && <span className="muted">{r.size}</span>}
                  <span className="font-extrabold">→ {r.bowl}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {staging.length > 0 && (
          <section className="card" aria-label="Canned and sauce staging" data-testid="staging">
            <h2 className="text-base font-extrabold">Canned &amp; sauce staging</h2>
            <ul className="mt-1 flex flex-col">
              {staging.map((s) => (
                <li key={s.id} className="border-b border-line last:border-0">
                  <label className="check-row py-1">
                    <input type="checkbox" checked={checked.has(`staging:${s.id}`)} onChange={() => toggle(`staging:${s.id}`)} />
                    <span className="text-sm"><span className="font-semibold">{s.text}</span> <strong>→ {s.stations.join(", ")}</strong></span>
                  </label>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
