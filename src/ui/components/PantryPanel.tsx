import { useState } from "react";
import { AnimatePresence, m } from "motion/react";
import { ChevronDown, Plus, Refrigerator, Trash2 } from "lucide-react";
import { CANONICAL_UNITS } from "../../domain/units/units";
import { compareStrings } from "../../domain/math/compare";
import { formatQuantity, PANTRY_STATE_LABEL } from "../lib/format";
import { useApp } from "../app-context";
import { Button, cx, IconButton, Tag } from "./ui";

type State = keyof typeof PANTRY_STATE_LABEL;

/** Flat pantry list + one-row add form: the stock that "Use my stock" draws from. */
export function PantryPanel() {
  const { s, world, cycle, run } = useApp();
  const [open, setOpen] = useState(false);
  const [ingredient, setIngredient] = useState("");
  const [qty, setQty] = useState("");
  const [unit, setUnit] = useState("g");
  const [state, setState] = useState<State>("loose");
  const names = Object.values(world.registry).sort((a, b) => compareStrings(a.display_name, b.display_name));
  const nameOf = (id: string) => world.registry[id]?.display_name ?? id;

  return (
    <section className="mt-3 rounded-2xl border border-line bg-raised shadow-card" aria-label="Pantry stock">
      <button type="button" className="flex min-h-12 w-full items-center gap-3 px-4 text-left font-semibold" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Refrigerator aria-hidden className="size-5 text-muted" />
        <span className="flex-1">Pantry stock ({world.pantry.length})</span>
        <ChevronDown aria-hidden className={cx("size-5 text-muted transition-transform duration-200", open && "rotate-180")} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <m.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <div className="flex flex-col gap-3 px-4 pb-4">
              {world.pantry.length === 0 && <p className="text-sm text-muted">Nothing here yet. Add what you already have and it comes off the buy list.</p>}
              <ul className="flex flex-col" data-testid="pantry-list">
                {world.pantry.map((p) => (
                  <li key={`${p.ingredient_id}|${p.state}`} className="flex items-center justify-between gap-2 border-b border-line py-1 last:border-0">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <strong className="font-semibold">{nameOf(p.ingredient_id)}</strong>
                      <span className="text-muted tabular-nums">{formatQuantity(p.quantity, p.unit)}</span>
                      <Tag>{PANTRY_STATE_LABEL[p.state as State] ?? p.state}</Tag>
                    </span>
                    <IconButton icon={Trash2} label={`Toss ${nameOf(p.ingredient_id)} stock`} className="text-danger" onClick={() => run(() => s.pantry.remove(p.ingredient_id, p.state))} />
                  </li>
                ))}
              </ul>
              <form
                className="grid grid-cols-2 gap-2 sm:grid-cols-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    await s.pantry.add({ ingredient_id: ingredient, state, quantity: Number(qty), unit, ...(state === "opened" ? { opened_cycle_id: cycle.id } : {}) });
                    setQty("");
                  });
                }}
              >
                <select className="field col-span-2 sm:col-span-4" aria-label="Ingredient" required value={ingredient} onChange={(e) => setIngredient(e.target.value)}>
                  <option value="">Ingredient…</option>
                  {names.map((n) => <option key={n.ingredient_id} value={n.ingredient_id}>{n.display_name}</option>)}
                </select>
                <input className="field" aria-label="Quantity" inputMode="decimal" type="number" min="0" step="any" required placeholder="Qty" value={qty} onChange={(e) => setQty(e.target.value)} />
                <select className="field" aria-label="Unit" value={unit} onChange={(e) => setUnit(e.target.value)}>
                  {CANONICAL_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                </select>
                <select className="field" aria-label="Stock state" value={state} onChange={(e) => setState(e.target.value as State)}>
                  {(Object.keys(PANTRY_STATE_LABEL) as State[]).map((k) => <option key={k} value={k}>{PANTRY_STATE_LABEL[k]}</option>)}
                </select>
                <Button variant="primary" icon={Plus} type="submit">Add stock</Button>
              </form>
            </div>
          </m.div>
        )}
      </AnimatePresence>
    </section>
  );
}
