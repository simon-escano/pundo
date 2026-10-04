import { lazy, Suspense, useState } from "react";
import { orderByStovePriority, STOVE_RANK } from "../../domain/engines/stove";
import type { ScaledDish } from "../../domain/engines/scaling";
import { CUT_LABELS } from "../../domain/engines/cuts";
import { useChecklist } from "../hooks/useChecklist";
import { useWakeLock } from "../hooks/useWakeLock";
import { formatQuantity } from "../lib/format";
import { useApp } from "../app-context";
import { Empty, StoveBadge, Toggle } from "../components/ui";

// Reels are optional and heavy-ish (embed logic + player), so the drawer loads on demand.
const VideoDrawer = lazy(() => import("../components/VideoDrawer").then((m) => ({ default: m.VideoDrawer })));

export function CookView() {
  useWakeLock(true);
  const { derived } = useApp();
  const [week, setWeek] = useState<"1" | "2">("1");
  if (!derived.complete) return <Empty>Roll and lock a plan first to see the stovetop cards.</Empty>;

  const dishes = orderByStovePriority(derived.scaled.filter((d) => String(d.week) === week).map((d) => ({ ...d.recipe, dish: d })));
  return (
    <div>
      <h1 className="text-xl font-extrabold">Stovetop</h1>
      <p className="muted mb-2 text-sm">Longest-cooking dish first. Screen stays awake.</p>
      <Toggle label="Cook day" value={week} onChange={setWeek} options={[{ id: "1", label: "Week 1 cook day" }, { id: "2", label: "Week 2 cook day" }]} />
      <div className="mt-3 flex flex-col gap-3">
        {dishes.map((d) => <CookCard key={d.id} dish={d.dish} />)}
      </div>
    </div>
  );
}

function CookCard({ dish }: { dish: ScaledDish }) {
  const { cycle } = useApp();
  const [mode, setMode] = useState<"steps" | "prep">("steps");
  const { checked, toggle } = useChecklist(`cook:${cycle.id}:${dish.recipe.id}`);
  const r = dish.recipe;
  return (
    <article className="card" data-testid="cook-card" data-priority={STOVE_RANK[r.stove_priority]} data-recipe={r.id}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-extrabold">{r.name}</h2>
        <StoveBadge priority={r.stove_priority} />
      </div>
      <div className="mt-2">
        <Toggle label={`${r.name} view`} value={mode} onChange={setMode} options={[{ id: "prep", label: "Prep Items" }, { id: "steps", label: "Cook Steps" }]} />
      </div>
      {mode === "prep" ? (
        <ul className="mt-2 flex flex-col divide-y divide-line" data-testid="prep-items">
          {dish.items.map((it, i) => (
            <li key={`${it.item.ingredient_id}-${i}`} className="flex flex-wrap items-baseline justify-between gap-x-3 py-1.5 text-sm">
              <span className="font-bold">{it.item.display_name}</span>
              <span className="muted">
                {formatQuantity(it.grossQuantity, it.unitLabel)}
                {it.item.cut_technique !== "NONE" && ` · ${CUT_LABELS[it.item.cut_technique].label}`}
                {it.totalPieces !== null && ` · ${it.totalPieces} pcs`}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="mt-1 flex flex-col" data-testid="cook-steps">
          {r.cook_steps.map((step, i) => {
            const id = `s${i}`;
            return (
              <li key={id} className="border-b border-line">
                <label className="check-row py-1">
                  <input type="checkbox" checked={checked.has(id)} onChange={() => toggle(id)} />
                  <span className={`text-base ${checked.has(id) ? "line-through muted" : "font-semibold"}`}>{step}</span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-3 rounded-lg bg-ink p-3 text-lg font-extrabold text-white" data-testid="pack-step">{r.pack_step}</p>
      {r.videos.length > 0 && (
        <Suspense fallback={null}>
          <VideoDrawer videos={r.videos} />
        </Suspense>
      )}
    </article>
  );
}
