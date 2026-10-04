import { PantryEntrySchema, type PantryEntry } from "../../domain/schemas/app";
import { roundDp } from "../../domain/math/precision";
import { compareBy, compareStrings } from "../../domain/math/compare";
import { convert, toCanonical, type CanonicalUnit } from "../../domain/units/units";
import { StorageError } from "../errors";
import { writeTx, type Ctx } from "../outbox";

type State = PantryEntry["state"];
export type StockInput = { ingredient_id: string; state: State; quantity: number; unit: string; opened_cycle_id?: string | null };

/** Pantry stock keyed by (ingredient_id, state). Quantities are stored in canonical units (kg → g). */
export function pantryRepo(ctx: Ctx) {
  const { db } = ctx;

  async function save(tx: Parameters<Parameters<typeof writeTx>[2]>[0], row: PantryEntry): Promise<void> {
    const hlc = tx.stamp();
    const next = { ...row, updated_at: hlc };
    await db.pantry.put(next);
    await tx.log("pantry", `${row.ingredient_id}|${row.state}`, hlc, next);
  }

  return {
    async list(): Promise<PantryEntry[]> {
      return (await db.pantry.toArray()).sort(compareBy<PantryEntry>((a, b) => compareStrings(a.ingredient_id, b.ingredient_id), (a, b) => compareStrings(a.state, b.state)));
    },
    forIngredient: (id: string) => db.pantry.where("ingredient_id").equals(id).toArray(),

    /** Add stock (merging into an existing row of the same state; units are converted when compatible). */
    async add(input: StockInput): Promise<PantryEntry> {
      const canon = toCanonical(input.quantity, input.unit);
      if (!canon) throw new StorageError("VALIDATION", `Unknown unit "${input.unit}".`);
      if (!(canon.quantity > 0) || !Number.isFinite(canon.quantity)) throw new StorageError("VALIDATION", "Quantity must be greater than zero.");
      return writeTx(ctx, [db.pantry], async (tx) => {
        const old = await db.pantry.get([input.ingredient_id, input.state]);
        let quantity = canon.quantity;
        let unit: CanonicalUnit = canon.unit;
        if (old) {
          const oldUnit = toCanonical(0, old.unit)?.unit;
          const converted = oldUnit ? convert(canon.quantity, canon.unit, oldUnit) : null;
          if (converted === null || !oldUnit) throw new StorageError("UNIT_MISMATCH", `Stock for "${input.ingredient_id}" is tracked in ${old.unit}; cannot add ${canon.unit}.`);
          quantity = roundDp(old.quantity + converted, 6);
          unit = oldUnit;
        }
        const row = PantryEntrySchema.parse({
          ingredient_id: input.ingredient_id,
          state: input.state,
          quantity,
          unit,
          opened_cycle_id: input.state === "opened" ? (input.opened_cycle_id ?? old?.opened_cycle_id ?? null) : null,
          updated_at: "",
        });
        await save(tx, row);
        return { ...row, updated_at: (await db.pantry.get([row.ingredient_id, row.state]))!.updated_at };
      });
    },

    /** Capture projected surplus (from `projectedSurplus`) after shopping/cooking. */
    async captureSurplus(entry: PantryEntry | null): Promise<PantryEntry | null> {
      return entry ? this.add({ ingredient_id: entry.ingredient_id, state: entry.state, quantity: entry.quantity, unit: entry.unit, opened_cycle_id: entry.opened_cycle_id }) : null;
    },

    /** Use stock up. Throws rather than silently clamping; a row that reaches zero is removed. */
    async deduct(ingredient_id: string, state: State, quantity: number, unit: string): Promise<PantryEntry | null> {
      const canon = toCanonical(quantity, unit);
      if (!canon || !(canon.quantity > 0)) throw new StorageError("VALIDATION", "Deduction needs a known unit and a positive quantity.");
      return writeTx(ctx, [db.pantry], async (tx) => {
        const old = await db.pantry.get([ingredient_id, state]);
        if (!old) throw new StorageError("INSUFFICIENT_STOCK", `No ${state} stock of "${ingredient_id}".`);
        const oldUnit = toCanonical(0, old.unit)!.unit;
        const amount = convert(canon.quantity, canon.unit, oldUnit);
        if (amount === null) throw new StorageError("UNIT_MISMATCH", `Stock is tracked in ${old.unit}; cannot deduct ${canon.unit}.`);
        if (amount > old.quantity + 1e-9) throw new StorageError("INSUFFICIENT_STOCK", `Only ${old.quantity}${old.unit} of "${ingredient_id}" in stock.`);
        const left = roundDp(Math.max(0, old.quantity - amount), 6);
        if (left <= 1e-9) {
          await db.pantry.delete([ingredient_id, state]);
          await tx.log("pantry", `${ingredient_id}|${state}`, tx.stamp(), null);
          return null;
        }
        await save(tx, { ...old, quantity: left });
        return (await db.pantry.get([ingredient_id, state]))!;
      });
    },

    /** [Spoiled / Tossed]: drop a stock row entirely. */
    async remove(ingredient_id: string, state: State): Promise<void> {
      await writeTx(ctx, [db.pantry], async (tx) => {
        if (!(await db.pantry.get([ingredient_id, state]))) return;
        await db.pantry.delete([ingredient_id, state]);
        await tx.log("pantry", `${ingredient_id}|${state}`, tx.stamp(), null);
      });
    },
  };
}
