import { useState } from "react";
import { Save } from "lucide-react";
import type { GroceryList } from "../../domain/engines/grocery";
import { applyCalibration } from "../lib/actions";
import { formatMoney } from "../lib/format";
import { useApp } from "../app-context";
import { Button, Modal } from "./ui";

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
    <Modal title="Enter receipt" onClose={onClose}>
      <p className="mb-4 text-sm text-muted">Optional. What you paid keeps future estimates accurate. Item prices win over the total.</p>
      <label className="block text-sm font-medium" htmlFor="receipt-total">Receipt total (₱)</label>
      <input id="receipt-total" className="field mt-1" type="number" inputMode="decimal" min="0" step="any" placeholder={`Estimated ${formatMoney(grocery.estimate.total)}`} value={receipt} disabled={anyPaid} onChange={(e) => setReceipt(e.target.value)} />
      <h3 className="mb-2 mt-5 text-sm font-semibold">Or price each item</h3>
      <ul className="flex flex-col gap-2">
        {buyLines.map((l) => (
          <li key={l.key} className="flex items-center justify-between gap-3">
            <label htmlFor={`paid-${l.key}`} className="flex-1 text-sm">{l.display_name}</label>
            <input id={`paid-${l.key}`} className="field !w-28" type="number" inputMode="decimal" min="0" step="any" placeholder={l.estimatedCost !== null ? formatMoney(l.estimatedCost) : "₱"} value={paid[l.key] ?? ""} onChange={(e) => setPaid({ ...paid, [l.key]: e.target.value })} />
          </li>
        ))}
      </ul>
      <div className="mt-5 flex gap-2">
        <Button variant="primary" icon={Save} className="flex-1" onClick={save}>Save receipt</Button>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
      </div>
    </Modal>
  );
}
