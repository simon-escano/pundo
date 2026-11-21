import { useState } from "react";
import { CalendarPlus } from "lucide-react";
import { formatCycleRange, parseIsoDate } from "../../domain/engines/dates";
import { NEW_PLAN_SHAPE, SHAPES, sameShape, type CycleShape } from "../../domain/engines/shape";
import { useApp } from "../app-context";
import { nextSunday, startPlan, todayIso } from "../lib/actions";
import { SHAPE_LABEL, shapeId } from "../lib/format";
import { Button, Modal, Segmented } from "./ui";

/** Start a new plan: one flat screen (start date + size). The newest start date becomes the active plan. */
export function NewPlanModal({ onClose }: { onClose: () => void }) {
  const { s, cycle, run } = useApp();
  const [date, setDate] = useState(() => nextSunday(todayIso()));
  const [shape, setShape] = useState<CycleShape>(NEW_PLAN_SHAPE);
  const valid = parseIsoDate(date) !== null;
  const notNewer = valid && date <= cycle.start_date;

  const create = () =>
    run(async () => {
      await startPlan(s, date, shape);
      onClose();
    });

  return (
    <Modal title="New plan" onClose={onClose}>
      <label className="block text-sm font-medium" htmlFor="plan-start">Starts</label>
      <input id="plan-start" className="field mt-1" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      <p className="mt-1.5 text-sm text-muted" data-testid="new-plan-range">{valid ? formatCycleRange(date, shape.weeks) : "Pick a start date."}</p>

      <p className="mb-1 mt-5 text-sm font-medium">Size</p>
      <Segmented
        label="Plan size"
        value={shapeId(shape)}
        options={SHAPES.map((x) => ({ id: shapeId(x), label: SHAPE_LABEL[shapeId(x)] }))}
        onChange={(id) => setShape(SHAPES.find((x) => shapeId(x) === id)!)}
      />
      <p className="mt-2 text-sm text-muted">
        {sameShape(shape, NEW_PLAN_SHAPE)
          ? "Two dishes, 10 portions each: four trays at home and four containers to send out."
          : "Three dishes a week for two weeks. Week 2 takes only dishes that keep."}
      </p>

      {notNewer && <p className="mt-4 text-sm font-medium text-danger">Start after {cycle.start_date}, the current plan's start, so the new plan becomes the active one.</p>}
      <div className="mt-6 flex gap-2">
        <Button variant="primary" icon={CalendarPlus} disabled={!valid || notNewer} onClick={create}>Create plan</Button>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
      </div>
    </Modal>
  );
}
