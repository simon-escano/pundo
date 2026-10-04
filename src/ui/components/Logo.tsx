import { cx } from "./ui";

/** The pundo mark: the liquid-glass app icon itself (public/icons/icon.svg), so the favicon, home-screen icon and header always match. */
export function LogoMark({ className = "size-9" }: { className?: string }) {
  return <img src="/icons/icon.svg" alt="" aria-hidden width={36} height={36} className={cx("shrink-0 select-none drop-shadow-[0_3px_6px_rgb(120_50_0/0.28)]", className)} draggable={false} />;
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-2.5", className)}>
      <LogoMark />
      <span translate="no" className="font-display text-[1.45rem] font-extrabold leading-none tracking-tight">pundo</span>
    </span>
  );
}
