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

      <div className="mt-6 flex items-end justify-between gap-4">
        <div data-testid="bought-progress">
          <p className="font-display text-5xl font-extrabold leading-none tabular-nums">
            <CountUp value={boughtCount} /> <span className="text-2xl text-muted">of {total} bought</span>
          </p>
        </div>
        <div className="text-right">
          <p className="text-xs font-medium text-muted">Estimated total</p>
          <p className="font-display text-2xl font-extrabold tabular-nums">
            <CountUp value={g.estimate.total} format={formatMoney} data-testid="estimate-total" />
          </p>
          {g.estimate.unresolved.length > 0 && <p className="text-xs text-muted">{g.estimate.unresolved.length} unpriced</p>}
        </div>
      </div>
      <div className="relative mt-3">
        <div role="progressbar" aria-label="Items bought" aria-valuemin={0} aria-valuemax={total} aria-valuenow={boughtCount} className="h-2 overflow-hidden rounded-full bg-ink/10">
          <m.div className="h-full origin-left rounded-full bg-hot" initial={false} animate={{ scaleX: total ? boughtCount / total : 0 }} transition={{ type: "spring", stiffness: 260, damping: 30 }} />
        </div>
        <ClickSpark fire={all} />
      </div>

      {cycle.status === "draft" && (
        <div className="mt-5">
          <Banner tone="warn" title="The plan isn’t locked yet">
            <LinkButton variant="secondary" icon={ArrowRight} href={routeHref("plan")} className="mt-3">Go to plan</LinkButton>
          </Banner>
        </div>
      )}
      <PantryPanel />

      {g.aisles.map((a) => (
        <section key={a.aisle} className="mt-8" aria-label={AISLE_LABEL[a.aisle]} data-testid="aisle" data-aisle={a.aisle}>
          <SectionHead icon={AISLE_ICON[a.aisle]} title={AISLE_LABEL[a.aisle]} aside={`${a.lines.length} items`} />
          <ul>
            {a.lines.map((l) => (
              <LineItem key={l.key} line={l} hasStock={stocked.has(l.ingredient_id)} cycleId={cycle.id} />
            ))}
          </ul>
        </section>
      ))}

      <div className="mt-10">
        <Button variant="primary" icon={ReceiptText} className="h-14 w-full text-base sm:w-auto sm:px-8" onClick={() => setCalibrating(true)}>Done shopping</Button>
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
    <li className="border-b border-line transition-colors duration-300 hover:bg-ink/[0.025]" data-testid="grocery-line" data-ingredient={line.ingredient_id} data-unit={line.unitLabel} data-aisle={line.aisle}>
      <label className="flex cursor-pointer items-start gap-3.5 pb-1 pt-3.5">
        <input type="checkbox" className="check mt-0.5" checked={line.bought} aria-label={`Bought: ${label}`} onChange={(e) => run(() => s.groceryState.setBought(cycleId, line.key, e.target.checked))} />
        <span className={cx("flex min-w-0 flex-1 items-start justify-between gap-3 transition-opacity duration-200", line.bought && "opacity-45")}>
          <span className="min-w-0">
            <h3 className={cx("font-sans text-[17px] font-semibold leading-snug tracking-normal", line.bought && "line-through decoration-1")}>{line.display_name}</h3>
            <span className="block text-sm text-muted" data-testid="need-qty">{describeNeed(line)}</span>
          </span>
          <span className="shrink-0 text-right">
            <span className="block font-display text-xl font-bold leading-tight tabular-nums" data-testid="buy-qty">{describeBuy(line)}</span>
            <span className="block text-xs tabular-nums text-muted">{line.estimatedCost !== null ? formatMoney(line.estimatedCost) : "No price"}</span>
          </span>
        </span>
      </label>
      {(week || line.butcherNotes.length > 0 || line.highSurplus || hasStock) && (
        <div className="flex flex-col items-start gap-2 pb-3.5 pl-[2.6rem]">
          {week && <Tag icon={CalendarDays} tone="accent">Week {week}</Tag>}
          {line.butcherNotes.map((n) => (
            <p key={n} className="flex items-start gap-1.5 text-sm text-accent"><Scissors aria-hidden className="mt-0.5 size-4 shrink-0" />{n}</p>
          ))}
          {line.highSurplus && (
            <p className="flex items-start gap-1.5 text-sm text-muted"><TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />{Math.round(line.surplusRatio * 100)}% of this pack goes unused</p>
          )}
          {hasStock && (
            <Segmented
              label={`Stock handling for ${line.display_name}`}
              value={line.deductStock ? "use" : "full"}
              onChange={(v) => run(() => s.groceryState.setDeductStock(cycleId, line.key, v === "use"))}
              options={[{ id: "use", label: "Use my stock" }, { id: "full", label: "Buy full" }]}
            />
          )}
        </div>
      )}
    </li>
  );
}
