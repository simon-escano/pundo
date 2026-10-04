import { lazy, Suspense, useState } from "react";
import { Flame, Snowflake } from "lucide-react";
import { orderByStovePriority, STOVE_RANK } from "../../domain/engines/stove";
import type { ScaledDish } from "../../domain/engines/scaling";
import { CUT_LABELS } from "../../domain/engines/cuts";
import { useChecklist } from "../hooks/useChecklist";
import { useWakeLock } from "../hooks/useWakeLock";
import { formatQuantity } from "../lib/format";
import { useApp } from "../app-context";
import { routeHref, useRoute } from "../router";
import { CheckRow, Empty, LinkButton, PageTitle, Segmented, StoveOrder } from "../components/ui";

// Reels are optional and heavy-ish (embed logic + player), so the drawer loads on demand.
const VideoDrawer = lazy(() => import("../components/VideoDrawer").then((m) => ({ default: m.VideoDrawer })));

export function CookView() {
  useWakeLock(true);
  const { derived } = useApp();
  const { sub } = useRoute();
  const week = sub === "week-2" ? 2 : 1;
  const dishes = orderByStovePriority(derived.scaled.filter((d) => d.week === week).map((d) => ({ ...d.recipe, dish: d })));
  return (
    <div>
      <PageTitle title="Cook" hint="Start in this order. The screen stays awake." />
      <Segmented
        className="mt-4"
        label="Cook day"
        value={`week-${week}`}
        options={[{ id: "week-1", label: "Week 1", href: routeHref("cook", "week-1") }, { id: "week-2", label: "Week 2", href: routeHref("cook", "week-2") }]}
      />
      {!derived.complete ? (
        <Empty icon={Flame} action={<LinkButton variant="primary" href={routeHref("plan")}>Go to plan</LinkButton>}>
          Roll and lock your plan to see your cooking order.
        </Empty>
      ) : (
        <div className="mt-8 flex flex-col gap-14">
          {dishes.map((d, i) => <CookCard key={d.id} dish={d.dish} order={i + 1} />)}
        </div>
      )}
    </div>
  );
}

function CookCard({ dish, order }: { dish: ScaledDish; order: number }) {
  const { cycle } = useApp();
  const [mode, setMode] = useState<"steps" | "prep">("steps");
  const { checked, toggle } = useChecklist(`cook:${cycle.id}:${dish.recipe.id}`);
  const r = dish.recipe;
  return (
    <article className="pt-2" data-testid="cook-card" data-priority={STOVE_RANK[r.stove_priority]} data-recipe={r.id}>
      <div className="flex items-start gap-4">
        <span aria-hidden className="-mt-1 font-display text-[4.5rem] font-extrabold leading-[0.85] tabular-nums text-hot">{order}</span>
        <div className="min-w-0 flex-1 pt-1">
          <h2 className="font-display text-[1.7rem] font-extrabold leading-[1.02]">{r.name}</h2>
          <div className="mt-2"><StoveOrder priority={r.stove_priority} long /></div>
        </div>
      </div>
      <Segmented
        className="mt-4"
        label={`${r.name} view`}
        value={mode}
        onChange={setMode}
        options={[{ id: "prep", label: "Ingredients" }, { id: "steps", label: "Steps" }]}
      />
      {mode === "prep" ? (
        <ul className="flex flex-col" data-testid="prep-items">
          {dish.items.map((it, i) => (
            <li key={`${it.item.ingredient_id}-${i}`} className="flex flex-wrap items-baseline justify-between gap-x-3 border-b border-line py-3 text-[15px]">
              <span className="font-semibold">{it.item.display_name}</span>
              <span className="tabular-nums text-muted">
                {formatQuantity(it.grossQuantity, it.unitLabel)}
                {it.item.cut_technique !== "NONE" && ` · ${CUT_LABELS[it.item.cut_technique].label}`}
                {it.totalPieces !== null && ` · ${it.totalPieces} pcs`}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <ol className="flex flex-col" data-testid="cook-steps">
          {r.cook_steps.map((step, i) => {
            const id = `s${i}`;
            return (
              <li key={id} className="border-b border-line">
                <CheckRow checked={checked.has(id)} onChange={() => toggle(id)} className="py-3"><span className="text-[17px] leading-snug">{step}</span></CheckRow>
              </li>
            );
          })}
        </ol>
      )}
      <div className="mt-5 flex items-start gap-3 rounded-2xl bg-accent p-4 text-accent-ink">
        <Snowflake aria-hidden className="mt-0.5 size-5 shrink-0" />
        <div>
          <p className="text-xs font-semibold opacity-80">Then pack it</p>
          <p className="font-display text-xl font-bold leading-tight" data-testid="pack-step">{r.pack_step}</p>
        </div>
      </div>
      {r.videos.length > 0 && (
        <Suspense fallback={null}>
          <VideoDrawer videos={r.videos} />
        </Suspense>
      )}
    </article>
  );
}
