import type { ReactNode } from "react";
import type { Recipe } from "../../domain/schemas/blueprint";
import { STOVE_LABEL, STOVE_RANK } from "../../domain/engines/stove";

export function Stepper({ label, value, min = 1, max = 30, disabled, onChange }: { label: string; value: number; min?: number; max?: number; disabled?: boolean; onChange: (n: number) => void }) {
  return (
    <div className="inline-flex items-center gap-1" role="group" aria-label={label}>
      <button className="btn" aria-label={`Decrease ${label}`} disabled={disabled || value <= min} onClick={() => onChange(value - 1)}>−</button>
      <output aria-label={label} className="min-w-9 text-center text-xl font-extrabold tabular-nums">{value}</output>
      <button className="btn" aria-label={`Increase ${label}`} disabled={disabled || value >= max} onClick={() => onChange(value + 1)}>+</button>
    </div>
  );
}

const PRIORITY_BG = { 1: "bg-priority-1", 2: "bg-priority-2", 3: "bg-priority-3" } as const;

export function StoveBadge({ priority }: { priority: Recipe["stove_priority"] }) {
  const rank = STOVE_RANK[priority];
  return (
    <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-extrabold text-white ${PRIORITY_BG[rank]}`} data-testid="stove-badge">
      P{rank} {STOVE_LABEL[priority]}
    </span>
  );
}

export function Banner({ tone = "danger", children, title }: { tone?: "danger" | "warn" | "ok"; children: ReactNode; title?: string }) {
  const cls = tone === "danger" ? "border-danger bg-red-50 text-danger" : tone === "warn" ? "border-accent bg-amber-50 text-amber-900" : "border-ok bg-green-50 text-ok";
  return (
    <div role={tone === "ok" ? "status" : "alert"} className={`rounded-lg border-2 p-3 text-sm font-semibold ${cls}`}>
      {title && <p className="font-extrabold">{title}</p>}
      <div>{children}</div>
    </div>
  );
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/50 sm:items-center" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={title} className="max-h-[92vh] w-full overflow-y-auto rounded-t-xl bg-white p-4 sm:max-w-xl sm:rounded-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-lg font-extrabold">{title}</h2>
          <button className="btn" onClick={onClose} aria-label="Close dialog">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="card muted mt-3 text-center">{children}</p>;
}

/** Two-way flat toggle (never a wizard): used for Week 1 / Week 2 and Prep / Steps. */
export function Toggle<T extends string>({ value, options, onChange, label }: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} className="btn" aria-pressed={value === o.id} onClick={() => onChange(o.id)}>{o.label}</button>
      ))}
    </div>
  );
}
