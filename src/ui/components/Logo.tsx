import { CookingPot } from "lucide-react";
import { cx } from "./ui";

/** The pundo mark: one pot, many portions. Same glyph as public/icons/icon.svg. */
export function LogoMark({ className = "size-9" }: { className?: string }) {
  return (
    <span aria-hidden className={cx("grid shrink-0 -rotate-6 place-items-center rounded-[0.8rem] bg-accent text-accent-ink", className)}>
      <CookingPot className="size-[62%]" strokeWidth={2} />
    </span>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-2.5", className)}>
      <LogoMark />
      <span translate="no" className="font-display text-[1.45rem] font-extrabold leading-none tracking-tight">pundo</span>
    </span>
  );
}
