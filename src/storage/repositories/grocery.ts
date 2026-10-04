import type { GroceryLineState } from "../../domain/schemas/app";
import { StorageError } from "../errors";
import { writeTx, type Ctx, type Tx } from "../outbox";

type Patch = Partial<Pick<GroceryLineState, "deduct_stock" | "bought" | "paid_php">>;

/** Per-line shopping state: bought checkbox, [Spoiled / Tossed] override, paid amount. Keyed by the engine's line key. */
export function groceryStateRepo(ctx: Ctx) {
  const { db } = ctx;

  async function patch(tx: Tx, cycle_id: string, line_key: string, p: Patch): Promise<GroceryLineState> {
    const old = await db.groceryLineState.get([cycle_id, line_key]);
    const hlc = tx.stamp();
    const row: GroceryLineState = { cycle_id, line_key, deduct_stock: true, bought: false, paid_php: null, ...old, ...p, updated_at: hlc };
    await db.groceryLineState.put(row);
    await tx.log("groceryLineState", `${cycle_id}|${line_key}`, hlc, row);
    return row;
  }
  async function requireCycle(id: string) {
    if (!(await db.cycles.get(id))) throw new StorageError("NOT_FOUND", `Cycle "${id}" not found.`);
  }
  const run = (cycle_id: string, line_key: string, p: Patch) =>
    writeTx(ctx, [db.groceryLineState, db.cycles], async (tx) => {
      await requireCycle(cycle_id);
      return patch(tx, cycle_id, line_key, p);
    });

  return {
    get: (cycle_id: string, line_key: string) => db.groceryLineState.get([cycle_id, line_key]),
    forCycle: (cycle_id: string) => db.groceryLineState.where("cycle_id").equals(cycle_id).toArray(),

    setBought: (cycle_id: string, line_key: string, bought: boolean) => run(cycle_id, line_key, { bought }),

    /** `deduct = false` is the single-tap [Spoiled / Tossed] override: restores the gross buy quantity. */
    setDeductStock: (cycle_id: string, line_key: string, deduct: boolean) => run(cycle_id, line_key, { deduct_stock: deduct }),

    setPaid(cycle_id: string, line_key: string, paid_php: number | null) {
      if (paid_php !== null && !(Number.isFinite(paid_php) && paid_php >= 0)) {
        throw new StorageError("VALIDATION", "Paid amount must be a non-negative number.");
      }
      return run(cycle_id, line_key, { paid_php });
    },

    /** [Mark Groceries as Bought]: one transaction for every line. */
    async markAllBought(cycle_id: string, line_keys: readonly string[], bought = true): Promise<void> {
      await writeTx(ctx, [db.groceryLineState, db.cycles], async (tx) => {
        await requireCycle(cycle_id);
        for (const k of line_keys) await patch(tx, cycle_id, k, { bought });
      });
    },
  };
}
