/*
 * Adapted from React Bits (reactbits.dev, DavidHDev/react-bits, MIT + Commons Clause): Animations / Click Spark.
 * Reimplemented with motion: a handful of short lines radiate from the point of the click and fade.
 * Used once per completed list ("all done"), never on every tap.
 */
import { AnimatePresence, m, useReducedMotion } from "motion/react";
import { useState } from "react";

const RAYS = 8;

export function ClickSpark({ fire }: { fire: boolean }) {
  const reduce = useReducedMotion();
  const [burst, setBurst] = useState(0);
  const [was, setWas] = useState(fire);
  if (fire !== was) {
    setWas(fire);
    if (fire) setBurst((b) => b + 1);
  }
  if (reduce) return null;
  return (
    <AnimatePresence>
      {burst > 0 && (
        <span key={burst} aria-hidden className="pointer-events-none absolute left-1/2 top-1/2 size-0">
          {Array.from({ length: RAYS }, (_, i) => {
            const a = (i / RAYS) * Math.PI * 2;
            return (
              <m.span
                key={i}
                className="absolute h-0.5 w-3 origin-left rounded-full bg-accent"
                style={{ rotate: `${(a * 180) / Math.PI}deg` }}
                initial={{ x: Math.cos(a) * 10, y: Math.sin(a) * 10, opacity: 1, scaleX: 1 }}
                animate={{ x: Math.cos(a) * 34, y: Math.sin(a) * 34, opacity: 0, scaleX: 0.4 }}
                transition={{ duration: 0.55, ease: "easeOut" }}
              />
            );
          })}
        </span>
      )}
    </AnimatePresence>
  );
}
