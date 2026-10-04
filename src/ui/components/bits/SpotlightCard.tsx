/*
 * Adapted from React Bits (reactbits.dev, DavidHDev/react-bits, MIT + Commons Clause): Components / Spotlight Card.
 * The glow is a CSS radial gradient driven by two custom properties, so pointer moves never re-render React.
 * Disabled on touch and for reduced motion (the gradient layer simply never appears).
 */
import type { HTMLAttributes, PointerEvent, ReactNode } from "react";

type Props = HTMLAttributes<HTMLElement> & { as?: "article" | "li" | "section" | "div"; children: ReactNode };

export function SpotlightCard({ as: Tag = "article", className = "", children, ...rest }: Props) {
  const move = (e: PointerEvent<HTMLElement>) => {
    if (e.pointerType !== "mouse") return;
    const r = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty("--sx", `${e.clientX - r.left}px`);
    e.currentTarget.style.setProperty("--sy", `${e.clientY - r.top}px`);
  };
  return (
    <Tag onPointerMove={move} className={`group/spot relative overflow-hidden ${className}`} {...(rest as object)}>
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover/spot:opacity-100 motion-reduce:hidden"
        style={{ background: "radial-gradient(260px circle at var(--sx, 50%) var(--sy, 0%), color-mix(in srgb, var(--accent) 14%, transparent), transparent 70%)" }}
      />
      <div className="relative">{children}</div>
    </Tag>
  );
}
