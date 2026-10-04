import { m } from "motion/react";
import { Beef, CircleAlert, CircleCheck, Drumstick, Fish, Flame, Leaf, Minus, Plus, TriangleAlert, X, type LucideIcon } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import type { Recipe } from "../../domain/schemas/blueprint";
import { STOVE_RANK } from "../../domain/engines/stove";
import { STOVE_ORDER } from "../lib/format";
import { useMediaQuery } from "../hooks/useMediaQuery";

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");

/* ---------------------------------------------------------------- buttons */

type Variant = "primary" | "secondary" | "ghost" | "danger";
const VARIANT: Record<Variant, string> = {
  primary: "bg-accent text-accent-ink shadow-card hover:brightness-110",
  secondary: "border border-line bg-raised text-ink shadow-card hover:bg-sunken",
  ghost: "text-ink hover:bg-sunken",
  danger: "border border-danger/40 text-danger hover:bg-danger-soft",
};
const BTN =
  "inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold transition-[background-color,filter,transform,box-shadow,opacity] duration-150 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-45 aria-pressed:border-accent aria-pressed:bg-accent-soft aria-pressed:text-accent";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; icon?: LucideIcon };

export function Button({ variant = "secondary", icon: Icon, className, children, type = "button", ...rest }: ButtonProps) {
  return (
    <button type={type} className={cx(BTN, VARIANT[variant], className)} {...rest}>
      {Icon && <Icon aria-hidden className="size-[1.1rem] shrink-0" strokeWidth={2} />}
      {children}
    </button>
  );
}

/** A link that looks like a button: navigation stays an <a>, never a <button>. */
export function LinkButton({ variant = "secondary", icon: Icon, className, children, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: Variant; icon?: LucideIcon }) {
  return (
    <a className={cx(BTN, VARIANT[variant], className)} {...rest}>
      {Icon && <Icon aria-hidden className="size-[1.1rem] shrink-0" strokeWidth={2} />}
      {children}
    </a>
  );
}

/** Icon-only button. `label` becomes the accessible name, so it is required. */
export function IconButton({ icon: Icon, label, variant = "ghost", className, ...rest }: Omit<ButtonProps, "children" | "aria-label"> & { icon: LucideIcon; label: string }) {
  return (
    <Button variant={variant} aria-label={label} title={label} className={cx("size-[44px] shrink-0 !px-0", className)} {...rest}>
      <Icon aria-hidden className="size-5" strokeWidth={2} />
    </Button>
  );
}

/* ----------------------------------------------------------- small pieces */

const TAG_TONE = {
  neutral: "bg-sunken text-ink",
  accent: "bg-accent-soft text-accent",
  warn: "bg-warn-soft text-warn",
  info: "bg-info-soft text-info",
  danger: "bg-danger-soft text-danger",
} as const;

export function Tag({ icon: Icon, tone = "neutral", children, ...rest }: { icon?: LucideIcon; tone?: keyof typeof TAG_TONE; children: ReactNode } & React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={cx("inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium leading-none", TAG_TONE[tone])} {...rest}>
      {Icon && <Icon aria-hidden className="size-3.5 shrink-0" strokeWidth={2.25} />}
      {children}
    </span>
  );
}

export const PROTEIN_ICON: Record<Recipe["protein_category"], LucideIcon> = { pork: Drumstick, chicken: Drumstick, beef: Beef, fish: Fish, vegetable: Leaf };

const STOVE_TONE = { 1: "warn", 2: "info", 3: "accent" } as const;

/** Spells out when a dish goes on the stove ("Cook first · Slow braise") instead of an opaque "P1". */
export function StoveOrder({ priority, long = false }: { priority: Recipe["stove_priority"]; long?: boolean }) {
  const rank = STOVE_RANK[priority];
  const o = STOVE_ORDER[rank];
  return (
    <Tag icon={Flame} tone={STOVE_TONE[rank]} data-testid="stove-badge" data-rank={rank}>
      {long ? `${o.long} · ${o.how}` : o.short}
    </Tag>
  );
}

export function Stepper({ label, value, min = 1, max = 30, disabled, onChange }: { label: string; value: number; min?: number; max?: number; disabled?: boolean; onChange: (n: number) => void }) {
  return (
    <div className="inline-flex items-center gap-1 rounded-xl bg-sunken p-1" role="group" aria-label={label}>
      <IconButton icon={Minus} label={`Decrease ${label}`} disabled={disabled || value <= min} onClick={() => onChange(value - 1)} />
      <output aria-label={label} className="min-w-9 text-center text-lg font-semibold tabular-nums">{value}</output>
      <IconButton icon={Plus} label={`Increase ${label}`} disabled={disabled || value >= max} onClick={() => onChange(value + 1)} />
    </div>
  );
}

type SegOption<T extends string> = { id: T; label: string; icon?: LucideIcon; href?: string };

/**
 * Flat two-to-four way switch with a sliding highlight (never a wizard). Options with `href` are real links
 * (aria-current); the rest are toggle buttons (aria-pressed).
 */
export function Segmented<T extends string>({ value, options, onChange, label, className }: { value: T; options: SegOption<T>[]; onChange?: (v: T) => void; label: string; className?: string }) {
  const uid = useId();
  return (
    <div className={cx("flex gap-1 rounded-2xl bg-sunken p-1", className)} role="group" aria-label={label}>
      {options.map((o) => {
        const on = value === o.id;
        const inner = (
          <>
            {on && <m.span layoutId={`seg-${uid}`} className="absolute inset-0 rounded-xl bg-raised shadow-card" transition={{ type: "spring", stiffness: 500, damping: 38 }} />}
            <span className={cx("relative z-10 inline-flex items-center gap-1.5", on ? "text-ink" : "text-muted")}>
              {o.icon && <o.icon aria-hidden className="size-4" strokeWidth={2.25} />}
              {o.label}
            </span>
          </>
        );
        const cls = "relative inline-flex min-h-[44px] flex-1 items-center justify-center rounded-xl px-3 text-sm font-semibold transition-colors duration-150 hover:text-ink";
        return o.href ? (
          <a key={o.id} href={o.href} aria-current={on ? "page" : undefined} className={cls}>{inner}</a>
        ) : (
          <button key={o.id} type="button" aria-pressed={on} className={cls} onClick={() => onChange?.(o.id)}>{inner}</button>
        );
      })}
    </div>
  );
}

/** A tick row: the whole row is the label, so the tap target is the full width. */
export function CheckRow({ checked, onChange, label, children, className }: { checked: boolean; onChange: (v: boolean) => void; label?: string; children: ReactNode; className?: string }) {
  return (
    <label className={cx("flex min-h-[44px] cursor-pointer items-center gap-3 rounded-xl py-1.5", className)}>
      <input type="checkbox" className="check" checked={checked} aria-label={label} onChange={(e) => onChange(e.target.checked)} />
      <span className={cx("min-w-0 flex-1 transition-colors duration-150", checked && "text-muted line-through")}>{children}</span>
    </label>
  );
}

const BANNER = {
  danger: { cls: "bg-danger-soft text-danger", icon: CircleAlert },
  warn: { cls: "bg-warn-soft text-warn", icon: TriangleAlert },
  ok: { cls: "bg-accent-soft text-accent", icon: CircleCheck },
} as const;

export function Banner({ tone = "danger", children, title, onDismiss }: { tone?: keyof typeof BANNER; children: ReactNode; title?: string; onDismiss?: () => void }) {
  const { cls, icon: Icon } = BANNER[tone];
  return (
    <m.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      role={tone === "ok" ? "status" : "alert"}
      className={cx("flex items-start gap-3 rounded-2xl p-3.5 text-sm", cls)}
    >
      <Icon aria-hidden className="mt-0.5 size-5 shrink-0" />
      <div className="min-w-0 flex-1">
        {title && <p className="font-semibold">{title}</p>}
        <div className={title ? "mt-0.5 opacity-90" : "font-medium"}>{children}</div>
      </div>
      {onDismiss && <IconButton icon={X} label="Dismiss" className="-my-2 -mr-2 text-current" onClick={onDismiss} />}
    </m.div>
  );
}

export function Empty({ icon: Icon, children, action }: { icon?: LucideIcon; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mt-6 flex flex-col items-center gap-3 rounded-3xl border border-dashed border-line px-6 py-10 text-center">
      {Icon && <span className="grid size-12 place-items-center rounded-2xl bg-sunken text-muted"><Icon aria-hidden className="size-6" /></span>}
      <p className="max-w-xs text-muted">{children}</p>
      {action}
    </div>
  );
}

/** Page heading: one h1 per view, with an optional one-line hint. */
export function PageTitle({ title, hint, children }: { title: string; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold">{title}</h1>
        {hint && <p className="mt-1 text-sm text-muted">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

export function SectionHead({ icon: Icon, title, aside }: { icon?: LucideIcon; title: string; aside?: ReactNode }) {
  return (
    <h2 className="sticky top-[var(--header-h,3.5rem)] z-10 -mx-4 flex items-center justify-between gap-2 bg-surface/90 px-4 py-2.5 text-base font-semibold backdrop-blur">
      <span className="flex items-center gap-2">
        {Icon && <Icon aria-hidden className="size-[1.1rem] text-muted" />}
        {title}
      </span>
      {aside && <span className="text-sm font-normal text-muted">{aside}</span>}
    </h2>
  );
}

/* ----------------------------------------------------------------- modal */

let inertDepth = 0;

/** Focus, inert root, scroll lock and Esc for anything that takes over the screen (Modal, SignInScreen). */
export function useModalBehavior(onClose: () => void) {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const root = document.getElementById("root");
    if (inertDepth++ === 0) root?.setAttribute("inert", "");
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.current?.focus();
    const key = (e: KeyboardEvent) => e.key === "Escape" && close.current();
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("keydown", key);
      document.body.style.overflow = prevOverflow;
      if (--inertDepth === 0) root?.removeAttribute("inert");
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return panel;
}

/**
 * Dialog on desktop, bottom sheet on phones. Rendered in a portal; the app root is `inert` while open, so focus and
 * assistive tech stay inside. Esc or the scrim closes. Wrap the call site in <AnimatePresence> for the exit animation.
 */
export function Modal({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const desktop = useMediaQuery("(min-width: 640px)");
  const panel = useModalBehavior(onClose);
  const titleId = useId();

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6">
      <m.div className="scrim absolute inset-0" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }} onClick={onClose} />
      <m.div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cx(
          "relative flex max-h-[92dvh] w-full flex-col overflow-hidden bg-raised shadow-lift outline-none",
          "rounded-t-3xl sm:rounded-3xl",
          wide ? "sm:max-w-2xl" : "sm:max-w-lg",
        )}
        initial={desktop ? { opacity: 0, scale: 0.96, y: 12 } : { y: "100%" }}
        animate={desktop ? { opacity: 1, scale: 1, y: 0 } : { y: 0 }}
        exit={desktop ? { opacity: 0, scale: 0.97, y: 8 } : { y: "100%" }}
      >
        {!desktop && <span aria-hidden className="mx-auto mt-2 h-1 w-10 rounded-full bg-line" />}
        <div className="flex items-center justify-between gap-2 px-5 pb-1 pt-3 sm:pt-5">
          <h2 id={titleId} className="text-lg font-semibold">{title}</h2>
          <IconButton icon={X} label="Close dialog" className="-mr-2" onClick={onClose} />
        </div>
        <div className="overflow-y-auto overscroll-contain px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-2">{children}</div>
      </m.div>
    </div>,
    document.body,
  );
}
