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
  primary: "bg-accent text-accent-ink hover:brightness-110",
  secondary: "text-ink ring-[1.5px] ring-inset ring-ink/35 hover:bg-ink/5",
  ghost: "text-ink hover:bg-sunken",
  danger: "text-danger ring-1 ring-inset ring-danger/40 hover:bg-danger-soft",
};
const BTN =
  "inline-flex min-h-[44px] items-center justify-center gap-2 rounded-full px-5 text-[15px] font-semibold transition-[background-color,filter,transform,opacity] duration-150 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40 aria-pressed:bg-ink aria-pressed:text-surface aria-pressed:ring-0";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; icon?: LucideIcon };

export function Button({ variant = "secondary", icon: Icon, className, children, type = "button", ...rest }: ButtonProps) {
  return (
    <button type={type} className={cx(BTN, VARIANT[variant], className)} {...rest}>
      {Icon && <Icon aria-hidden className="size-[1.1rem] shrink-0" strokeWidth={2.25} />}
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

const TAG_TONE = { neutral: "text-muted", accent: "text-accent", ok: "text-ok", danger: "text-danger" } as const;

/** Plain inline text label with an optional icon. Deliberately not a pill: most facts don't need a container. */
export function Tag({ icon: Icon, tone = "neutral", children, className, ...rest }: { icon?: LucideIcon; tone?: keyof typeof TAG_TONE; children: ReactNode } & React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={cx("inline-flex items-center gap-1 text-[13px] font-semibold", TAG_TONE[tone], className)} {...rest}>
      {Icon && <Icon aria-hidden className="size-3.5 shrink-0" strokeWidth={2.5} />}
      {children}
    </span>
  );
}

export const PROTEIN_ICON: Record<Recipe["protein_category"], LucideIcon> = { pork: Drumstick, chicken: Drumstick, beef: Beef, fish: Fish, vegetable: Leaf };
/** Each protein owns a flat tint: dishes and recipes are recognisable by colour before they are read. */
export const PROTEIN_TINT: Record<Recipe["protein_category"], string> = { pork: "bg-p-pork", chicken: "bg-p-chicken", beef: "bg-p-beef", fish: "bg-p-fish", vegetable: "bg-p-vegetable" };

/** Spells out when a dish goes on the stove ("Cook first · Slow braise") instead of an opaque "P1". */
export function StoveOrder({ priority, long = false }: { priority: Recipe["stove_priority"]; long?: boolean }) {
  const rank = STOVE_RANK[priority];
  const o = STOVE_ORDER[rank];
  return (
    <Tag icon={Flame} tone="accent" data-testid="stove-badge" data-rank={rank}>
      {long ? `${o.long} · ${o.how}` : o.short}
    </Tag>
  );
}

export function Stepper({ label, value, min = 1, max = 30, disabled, onChange }: { label: string; value: number; min?: number; max?: number; disabled?: boolean; onChange: (n: number) => void }) {
  return (
    <div className="inline-flex items-center gap-1" role="group" aria-label={label}>
      <IconButton icon={Minus} variant="secondary" label={`Decrease ${label}`} disabled={disabled || value <= min} onClick={() => onChange(value - 1)} />
      <output aria-label={label} className="min-w-12 text-center font-display text-3xl font-extrabold tabular-nums">{value}</output>
      <IconButton icon={Plus} variant="secondary" label={`Increase ${label}`} disabled={disabled || value >= max} onClick={() => onChange(value + 1)} />
    </div>
  );
}

type SegOption<T extends string> = { id: T; label: string; icon?: LucideIcon; href?: string };

/**
 * Flat tab row with a sliding orange underline (never a wizard). Options with `href` are real links (aria-current);
 * the rest are toggle buttons (aria-pressed).
 */
export function Segmented<T extends string>({ value, options, onChange, label, className }: { value: T; options: SegOption<T>[]; onChange?: (v: T) => void; label: string; className?: string }) {
  const uid = useId();
  return (
    <div className={cx("flex gap-7 border-b border-line", className)} role="group" aria-label={label}>
      {options.map((o) => {
        const on = value === o.id;
        const inner = (
          <>
            <span className="inline-flex items-center gap-1.5">
              {o.icon && <o.icon aria-hidden className="size-4" strokeWidth={2.25} />}
              {o.label}
            </span>
            {on && <m.span layoutId={`seg-${uid}`} className="absolute inset-x-0 -bottom-px h-[3px] rounded-full bg-accent" transition={{ type: "spring", stiffness: 500, damping: 40 }} />}
          </>
        );
        const cls = cx("relative inline-flex min-h-[44px] min-w-[44px] items-center justify-center text-[15px] font-semibold transition-colors duration-150", on ? "text-ink" : "text-muted hover:text-ink");
        return o.href ? (
          <a key={o.id} href={o.href} aria-current={on ? "page" : undefined} className={cls}>{inner}</a>
        ) : (
          <button key={o.id} type="button" aria-pressed={on} className={cx(cls, "aria-pressed:bg-transparent aria-pressed:text-ink")} onClick={() => onChange?.(o.id)}>{inner}</button>
        );
      })}
    </div>
  );
}

/** A tick row: the whole row is the label, so the tap target is the full width. */
export function CheckRow({ checked, onChange, label, children, className }: { checked: boolean; onChange: (v: boolean) => void; label?: string; children: ReactNode; className?: string }) {
  return (
    <label className={cx("flex min-h-[44px] cursor-pointer items-center gap-3.5 py-2", className)}>
      <input type="checkbox" className="check" checked={checked} aria-label={label} onChange={(e) => onChange(e.target.checked)} />
      <span className={cx("min-w-0 flex-1 transition-colors duration-150", checked && "text-muted line-through decoration-1")}>{children}</span>
    </label>
  );
}

const BANNER = {
  danger: { cls: "bg-danger-soft text-danger", icon: CircleAlert },
  warn: { cls: "bg-warn-soft text-ink", icon: TriangleAlert },
  ok: { cls: "bg-accent-soft text-ink", icon: CircleCheck },
} as const;

export function Banner({ tone = "danger", children, title, onDismiss }: { tone?: keyof typeof BANNER; children: ReactNode; title?: string; onDismiss?: () => void }) {
  const { cls, icon: Icon } = BANNER[tone];
  return (
    <m.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      role={tone === "ok" ? "status" : "alert"}
      className={cx("flex items-start gap-3 rounded-2xl p-4 text-[15px]", cls)}
    >
      <Icon aria-hidden className={cx("mt-0.5 size-5 shrink-0", tone !== "danger" && "text-accent")} />
      <div className="min-w-0 flex-1">
        {title && <p className="font-semibold">{title}</p>}
        <div className={title ? "mt-0.5 opacity-85" : "font-medium"}>{children}</div>
      </div>
      {onDismiss && <IconButton icon={X} label="Dismiss" className="-my-2 -mr-2 text-current" onClick={onDismiss} />}
    </m.div>
  );
}

/** Empty state: one plain sentence in the display face, and the next thing to do. No decorative box. */
export function Empty({ icon: Icon, children, action }: { icon?: LucideIcon; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mt-12 max-w-sm">
      {Icon && <Icon aria-hidden className="mb-3 size-8 text-accent" strokeWidth={2} />}
      <p className="font-display text-2xl font-bold leading-tight">{children}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

/** Page heading: one h1 per view, big and left-aligned, with an optional one-line hint. */
export function PageTitle({ title, hint, children }: { title: string; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="font-display text-[2.6rem] font-extrabold leading-[0.95] tracking-tight">{title}</h1>
        {hint && <p className="mt-2 text-[15px] text-muted">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

export function SectionHead({ icon: Icon, title, aside }: { icon?: LucideIcon; title: string; aside?: ReactNode }) {
  return (
    <h2 className="sticky top-[var(--header-h,3.5rem)] z-10 flex items-baseline justify-between gap-2 border-b-2 border-ink bg-surface pb-1.5 pt-3 font-display text-xl font-bold">
      <span className="flex items-center gap-2">
        {Icon && <Icon aria-hidden className="size-[1.05rem] text-accent" strokeWidth={2.5} />}
        {title}
      </span>
      {aside && <span className="font-sans text-sm font-medium text-muted">{aside}</span>}
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
          "relative flex max-h-[92dvh] w-full flex-col overflow-hidden bg-surface shadow-float outline-none",
          "rounded-t-[1.75rem] sm:rounded-[1.75rem]",
          wide ? "sm:max-w-2xl" : "sm:max-w-lg",
        )}
        initial={desktop ? { opacity: 0, scale: 0.96, y: 12 } : { y: "100%" }}
        animate={desktop ? { opacity: 1, scale: 1, y: 0 } : { y: 0 }}
        exit={desktop ? { opacity: 0, scale: 0.97, y: 8 } : { y: "100%" }}
      >
        {!desktop && <span aria-hidden className="mx-auto mt-2 h-1 w-10 rounded-full bg-ink/20" />}
        <div className="flex items-center justify-between gap-2 px-5 pb-1 pt-3 sm:pt-5">
          <h2 id={titleId} className="font-display text-2xl font-extrabold">{title}</h2>
          <IconButton icon={X} label="Close dialog" className="-mr-2" onClick={onClose} />
        </div>
        <div className="overflow-y-auto overscroll-contain px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-2">{children}</div>
      </m.div>
    </div>,
    document.body,
  );
}
