import { useState } from "react";
import { CANONICAL_UNITS } from "../../domain/units/units";
import { compareStrings } from "../../domain/math/compare";
import { formatQuantity } from "../lib/format";
import { useApp } from "../app-context";

type State = "loose" | "sealed" | "opened";

/** Flat pantry list + one-row add form: the stock that [Deduct Stock] draws from. */
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
    <section className="card mt-3" aria-label="Pantry stock">
      <button className="btn w-full justify-between" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>Pantry stock ({world.pantry.length})</span>
        <span aria-hidden>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="mt-2 flex flex-col gap-2">
          {world.pantry.length === 0 && <p className="muted text-sm">No stock recorded. Add what you already have so it is deducted from the buy list.</p>}
          <ul className="flex flex-col gap-1" data-testid="pantry-list">
            {world.pantry.map((p) => (
              <li key={`${p.ingredient_id}|${p.state}`} className="flex items-center justify-between gap-2 border-b border-line py-1">
                <span><strong>{nameOf(p.ingredient_id)}</strong> · {formatQuantity(p.quantity, p.unit)} <span className="chip">{p.state}</span></span>
                <button className="btn btn-danger" aria-label={`Toss ${nameOf(p.ingredient_id)} stock`} onClick={() => run(() => s.pantry.remove(p.ingredient_id, p.state))}>Toss</button>
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
            <select className="field col-span-2" aria-label="Ingredient" required value={ingredient} onChange={(e) => setIngredient(e.target.value)}>
              <option value="">Ingredient…</option>
              {names.map((n) => <option key={n.ingredient_id} value={n.ingredient_id}>{n.display_name}</option>)}
            </select>
            <input className="field" aria-label="Quantity" inputMode="decimal" type="number" min="0" step="any" required placeholder="Qty" value={qty} onChange={(e) => setQty(e.target.value)} />
            <select className="field" aria-label="Unit" value={unit} onChange={(e) => setUnit(e.target.value)}>
              {CANONICAL_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
            <select className="field" aria-label="Stock state" value={state} onChange={(e) => setState(e.target.value as State)}>
              <option value="loose">loose</option>
              <option value="sealed">sealed</option>
              <option value="opened">opened</option>
            </select>
            <button className="btn btn-primary col-span-1 sm:col-span-3" type="submit">Add stock</button>
          </form>
        </div>
      )}
    </section>
  );
}
