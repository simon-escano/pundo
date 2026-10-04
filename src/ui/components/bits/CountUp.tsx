/*
 * Adapted from React Bits (reactbits.dev, DavidHDev/react-bits, MIT + Commons Clause): Text Animations / Count Up.
 * Rewritten on top of motion's `animate` so it needs no extra dependency; formatting is injected so money stays locale-free.
 */
import { animate, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";

type Props = { value: number; format?: (n: number) => string; duration?: number; className?: string; "data-testid"?: string };

/** Counts from the previous value to the new one. Renders the final value immediately for reduced motion / automation. */
export function CountUp({ value, format = (n) => String(Math.round(n)), duration = 0.6, className, "data-testid": testId }: Props) {
  const reduce = useReducedMotion() || (typeof navigator !== "undefined" && navigator.webdriver);
  const prev = useRef(value);
  const [shown, setShown] = useState(value);

  useEffect(() => {
    const from = prev.current;
    prev.current = value;
    if (reduce || from === value) return;
    const controls = animate(from, value, { duration, ease: "easeOut", onUpdate: setShown });
    return () => controls.stop();
  }, [value, reduce, duration]);

  return <span className={className} data-testid={testId}>{format(reduce ? value : shown)}</span>;
}
