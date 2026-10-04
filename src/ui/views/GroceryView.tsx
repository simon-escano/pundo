import { useState } from "react";
import { AISLE_LABEL, describeBuy, describeNeed, formatMoney } from "../lib/format";
import type { GroceryLine } from "../../domain/engines/grocery";
import { useApp } from "../app-context";
import { CalibrationModal } from "../components/CalibrationModal";
import { PantryPanel } from "../components/PantryPanel";
import { Banner, Empty } from "../components/ui";

export function GroceryView() {
  const { cycle, world, derived } = useApp();
  const [calibrating, setCalibrating] = useState(false);
  const g = derived.grocery;
  if (!g) return <Empty>Roll all six dishes on the Plan tab to build the grocery list.</Empty>;

  const stocked = new Set(world.pantry.map((p) => p.ingredient_id));
  const boughtCount = g.lines.filter((l) => l.bought).length;

  return (
    <div>
      <h1 className="text-xl font-extrabold">Grocery</h1>
      <p className="muted text-sm" data-testid="bought-progress">{boughtCount} of {g.lines.length} bought</p>
      {cycle.status === "draft" && <div className="mt-2"><Banner tone="warn">The plan is not locked yet. Lock it on the Plan tab before shopping.</Banner></div>}
      <PantryPanel />

      {g.aisles.map((a) => (
        <section key={a.aisle} className="mt-4" aria-label={AISLE_LABEL[a.aisle]} data-testid="aisle" data-aisle={a.aisle}>
          <h2 className="sticky-head flex items-baseline justify-between border-b-2 border-ink py-2 text-lg font-extrabold">
            <span>{AISLE_LABEL[a.aisle]}</span>
            <span className="text-sm font-semibold muted">{a.lines.length} items</span>
          </h2>
          <ul className="mt-2 flex flex-col gap-2">
            {a.lines.map((l) => (
              <LineItem key={l.key} line={l} hasStock={stocked.has(l.ingredient_id)} cycleId={cycle.id} />
            ))}
          </ul>
        </section>
      ))}

      <div className="fixed inset-x-0 bottom-14 z-20 flex items-center gap-3 border-t-2 border-ink bg-white px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold muted">Estimated total</p>
          <p className="text-xl font-extrabold tabular-nums" data-testid="estimate-total">{formatMoney(g.estimate.total)}</p>
          {g.estimate.unresolved.length > 0 && <p className="text-xs muted">{g.estimate.unresolved.length} unpriced</p>}
        </div>
        <button className="btn btn-primary" onClick={() => setCalibrating(true)}>Mark Groceries as Bought</button>
      </div>
      {calibrating && <CalibrationModal grocery={g} onClose={() => setCalibrating(false)} />}
    </div>
  );
}

function LineItem({ line, hasStock, cycleId }: { line: GroceryLine; hasStock: boolean; cycleId: string }) {
  const { s, run } = useApp();
  const label = line.display_name + (line.bucket === "cycle" ? "" : ` (Week ${line.bucket === "w1" ? 1 : 2})`);
  return (
    <li className="card" data-testid="grocery-line" data-ingredient={line.ingredient_id} data-unit={line.unitLabel} data-aisle={line.aisle}>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-base font-extrabold">{label}</h3>
        <span className="text-sm font-bold tabular-nums">{line.estimatedCost !== null ? formatMoney(line.estimatedCost) : "—"}</span>
      </div>
      <p className="text-base font-bold" data-testid="buy-qty">{describeBuy(line)}</p>
      <p className="muted text-sm" data-testid="need-qty">{describeNeed(line)}</p>
      {line.butcherNotes.map((n) => <p key={n} className="mt-1 text-sm font-semibold text-accent">✂ {n}</p>)}
      {line.highSurplus && <p className="text-sm font-semibold text-accent">⚠ {Math.round(line.surplusRatio * 100)}% of this pack goes unused</p>}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        {hasStock ? (
          <div className="flex gap-2" role="group" aria-label={`Stock handling for ${line.display_name}`}>
            <button className="btn" aria-pressed={line.deductStock} onClick={() => run(() => s.groceryState.setDeductStock(cycleId, line.key, true))}>Deduct Stock</button>
            <button className="btn" aria-pressed={!line.deductStock} onClick={() => run(() => s.groceryState.setDeductStock(cycleId, line.key, false))}>Tossed / Buy Full</button>
          </div>
        ) : <span />}
        <label className="check-row">
          <input type="checkbox" checked={line.bought} aria-label={`Bought: ${label}`} onChange={(e) => run(() => s.groceryState.setBought(cycleId, line.key, e.target.checked))} />
          <span className="font-bold">Bought</span>
        </label>
      </div>
    </li>
  );
}
