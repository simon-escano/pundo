import { useState } from "react";
import type { GroceryList } from "../../domain/engines/grocery";
import { applyCalibration } from "../lib/actions";
import { formatMoney } from "../lib/format";
import { useApp } from "../app-context";
import { Modal } from "./ui";

/** Post-shopping calibration: one receipt total (spread by ratio) OR per-item paid prices. Both are optional. */
export function CalibrationModal({ grocery, onClose }: { grocery: GroceryList; onClose: () => void }) {
  const { s, cycle, world, run } = useApp();
  const [receipt, setReceipt] = useState("");
  const [paid, setPaid] = useState<Record<string, string>>({});
  const buyLines = grocery.lines.filter((l) => l.purchaseQuantity > 0);
  const anyPaid = Object.values(paid).some((v) => v.trim() !== "");

  const save = () =>
    run(async () => {
      const paidNums: Record<string, number> = {};
      for (const [k, v] of Object.entries(paid)) if (v.trim() !== "" && Number.isFinite(Number(v))) paidNums[k] = Number(v);
      const total = receipt.trim() === "" ? null : Number(receipt);
      await applyCalibration(s, cycle.id, grocery.lines, world.registry, { receiptTotal: total !== null && Number.isFinite(total) ? total : null, paid: paidNums });
      onClose();
    });

  return (
    <Modal title="Mark groceries as bought" onClose={onClose}>
      <p className="muted mb-3 text-sm">Optional: tell the app what you actually paid so prices stay accurate. Enter a receipt total <em>or</em> item prices (item prices win).</p>
      <label className="block text-sm font-bold" htmlFor="receipt-total">Receipt total (₱)</label>
      <input id="receipt-total" className="field" type="number" inputMode="decimal" min="0" step="any" placeholder={`Estimated ${formatMoney(grocery.estimate.total)}`} value={receipt} disabled={anyPaid} onChange={(e) => setReceipt(e.target.value)} />
      <h3 className="mb-1 mt-4 text-sm font-extrabold">Or paid per item</h3>
      <ul className="flex flex-col gap-2">
        {buyLines.map((l) => (
          <li key={l.key} className="flex items-center justify-between gap-2">
            <label htmlFor={`paid-${l.key}`} className="flex-1 text-sm font-semibold">{l.display_name}</label>
            <input id={`paid-${l.key}`} className="field !w-28" type="number" inputMode="decimal" min="0" step="any" placeholder={l.estimatedCost !== null ? formatMoney(l.estimatedCost) : "₱"} value={paid[l.key] ?? ""} onChange={(e) => setPaid({ ...paid, [l.key]: e.target.value })} />
          </li>
        ))}
      </ul>
      <div className="mt-4 flex flex-wrap gap-2">
        <button className="btn btn-primary flex-1" onClick={save}>Save &amp; mark bought</button>
        <button className="btn" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}
