import { useState } from "react";
import { AnimatePresence, m } from "motion/react";
import { ArrowRight, CalendarDays, Container, Package, ReceiptText, Scissors, ShoppingBasket, TriangleAlert, Carrot, Beef, type LucideIcon } from "lucide-react";
import type { Aisle } from "../../domain/schemas/app";
import type { GroceryLine } from "../../domain/engines/grocery";
import { AISLE_LABEL, describeBuy, describeNeed, formatMoney } from "../lib/format";
import { useApp } from "../app-context";
import { CalibrationModal } from "../components/CalibrationModal";
import { PantryPanel } from "../components/PantryPanel";
import { ClickSpark } from "../components/bits/ClickSpark";
import { CountUp } from "../components/bits/CountUp";
import { Banner, Button, cx, Empty, LinkButton, PageTitle, SectionHead, Segmented, Tag } from "../components/ui";
import { routeHref } from "../router";

const AISLE_ICON: Record<Aisle, LucideIcon> = { produce: Carrot, fresh_meat: Beef, canned_dry: Package, disposable: Container };

export function GroceryView() {
  const { cycle, world, derived } = useApp();
  const [calibrating, setCalibrating] = useState(false);
  const g = derived.grocery;
  if (!g) {
    return (
      <Empty icon={ShoppingBasket} action={<LinkButton variant="primary" icon={ArrowRight} href={routeHref("plan")}>Go to plan</LinkButton>}>
        Roll all six dishes to build your shopping list.
      </Empty>
    );
  }

  const stocked = new Set(world.pantry.map((p) => p.ingredient_id));
  const total = g.lines.length;
  const boughtCount = g.lines.filter((l) => l.bought).length;
  const all = total > 0 && boughtCount === total;

  return (
    <div>
      <PageTitle title="Grocery" hint="Tick items as they go in the basket." />

      <div className="mt-4 rounded-2xl border border-line bg-raised p-4 shadow-card">
        <p className="flex items-baseline justify-between text-sm" data-testid="bought-progress">
          <span><CountUp value={boughtCount} className="text-lg font-semibold tabular-nums" /> of {total} bought</span>
        </p>
        <div className="relative mt-2">
          <div role="progressbar" aria-label="Items bought" aria-valuemin={0} aria-valuemax={total} aria-valuenow={boughtCount} className="h-2 overflow-hidden rounded-full bg-sunken">
            <m.div className="h-full origin-left rounded-full bg-accent" initial={false} animate={{ scaleX: total ? boughtCount / total : 0 }} transition={{ type: "spring", stiffness: 260, damping: 30 }} />
          </div>
          <ClickSpark fire={all} />
        </div>
      </div>

      {cycle.status === "draft" && (
        <div className="mt-3">
          <Banner tone="warn" title="The plan isn’t locked yet">
            <LinkButton variant="secondary" icon={ArrowRight} href={routeHref("plan")} className="mt-2">Go to plan</LinkButton>
          </Banner>
        </div>
      )}
      <PantryPanel />

      {g.aisles.map((a) => (
        <section key={a.aisle} className="mt-5" aria-label={AISLE_LABEL[a.aisle]} data-testid="aisle" data-aisle={a.aisle}>
          <SectionHead icon={AISLE_ICON[a.aisle]} title={AISLE_LABEL[a.aisle]} aside={`${a.lines.length} items`} />
          <ul className="mt-1 flex flex-col gap-2">
            {a.lines.map((l) => (
              <LineItem key={l.key} line={l} hasStock={stocked.has(l.ingredient_id)} cycleId={cycle.id} />
            ))}
          </ul>
        </section>
      ))}

      <div className="fixed inset-x-0 bottom-[calc(4.1rem+env(safe-area-inset-bottom))] z-20 border-t border-line bg-raised/90 backdrop-blur-md md:bottom-0">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-muted">Estimated total</p>
            <p className="text-xl font-semibold tabular-nums">
              <CountUp value={g.estimate.total} format={formatMoney} data-testid="estimate-total" />
            </p>
            {g.estimate.unresolved.length > 0 && <p className="text-xs text-muted">{g.estimate.unresolved.length} unpriced</p>}
          </div>
          <Button variant="primary" icon={ReceiptText} onClick={() => setCalibrating(true)}>Done shopping</Button>
        </div>
      </div>
      <AnimatePresence>{calibrating && <CalibrationModal grocery={g} onClose={() => setCalibrating(false)} />}</AnimatePresence>
    </div>
  );
}

function LineItem({ line, hasStock, cycleId }: { line: GroceryLine; hasStock: boolean; cycleId: string }) {
  const { s, run } = useApp();
  const week = line.bucket === "cycle" ? null : line.bucket === "w1" ? 1 : 2;
  const label = line.display_name + (week ? ` (Week ${week})` : "");
  return (
    <li className="rounded-2xl border border-line bg-raised p-3 shadow-card" data-testid="grocery-line" data-ingredient={line.ingredient_id} data-unit={line.unitLabel} data-aisle={line.aisle}>
      <label className="flex cursor-pointer items-start gap-3">
        <input type="checkbox" className="check mt-1" checked={line.bought} aria-label={`Bought: ${label}`} onChange={(e) => run(() => s.groceryState.setBought(cycleId, line.key, e.target.checked))} />
        <span className={cx("min-w-0 flex-1 transition-opacity duration-200", line.bought && "opacity-50")}>
          <span className="flex items-baseline justify-between gap-2">
            <h3 className={cx("font-semibold", line.bought && "line-through")}>{line.display_name}</h3>
            <span className="text-sm font-medium tabular-nums text-muted">{line.estimatedCost !== null ? formatMoney(line.estimatedCost) : "No price"}</span>
          </span>
          <span className="mt-0.5 block text-lg font-semibold tabular-nums" data-testid="buy-qty">{describeBuy(line)}</span>
          <span className="block text-sm text-muted" data-testid="need-qty">{describeNeed(line)}</span>
        </span>
      </label>

      {(week || line.butcherNotes.length > 0 || line.highSurplus) && (
        <div className="mt-2 flex flex-col items-start gap-1.5 pl-10">
          {week && <Tag icon={CalendarDays}>Week {week}</Tag>}
          {line.butcherNotes.map((n) => (
            <p key={n} className="flex items-start gap-1.5 text-sm text-warn"><Scissors aria-hidden className="mt-0.5 size-4 shrink-0" />{n}</p>
          ))}
          {line.highSurplus && (
            <p className="flex items-start gap-1.5 text-sm text-warn"><TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />{Math.round(line.surplusRatio * 100)}% of this pack goes unused</p>
          )}
        </div>
      )}
      {hasStock && (
        <div className="mt-3 pl-10">
          <Segmented
            label={`Stock handling for ${line.display_name}`}
            value={line.deductStock ? "use" : "full"}
            onChange={(v) => run(() => s.groceryState.setDeductStock(cycleId, line.key, v === "use"))}
            options={[{ id: "use", label: "Use my stock" }, { id: "full", label: "Buy full" }]}
          />
        </div>
      )}
    </li>
  );
}
