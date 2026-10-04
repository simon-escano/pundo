import { CookingPot } from "lucide-react";
import { cx } from "./ui";

/** The pundo mark: one pot, many portions. Same glyph as public/icons/icon.svg. */
export function LogoMark({ className = "size-9" }: { className?: string }) {
  return (
    <span aria-hidden className={cx("grid shrink-0 place-items-center rounded-xl bg-accent text-accent-ink shadow-card", className)}>
      <CookingPot className="size-[62%]" strokeWidth={1.9} />
    </span>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-2.5", className)}>
      <LogoMark />
      <span translate="no" className="text-lg font-semibold tracking-tight">pundo</span>
    </span>
  );
}
