import { LazyMotion, MotionConfig, MotionGlobalConfig, domMax } from "motion/react";
import type { ReactNode } from "react";

// Automated browsers (Playwright) must see final frames: screenshots, layout checks and clicks never race an animation.
if (typeof navigator !== "undefined" && navigator.webdriver) MotionGlobalConfig.skipAnimations = true;

/** Every animation in the app is `m.*` under this provider; reduced-motion users get opacity-only changes. */
export function MotionProvider({ children }: { children: ReactNode }) {
  return (
    <LazyMotion features={domMax} strict>
      <MotionConfig reducedMotion="user" transition={{ type: "spring", stiffness: 520, damping: 40, mass: 0.8 }}>
        {children}
      </MotionConfig>
    </LazyMotion>
  );
}

/** Short ease-out used for page and content fades. */
export const EASE_OUT = [0.22, 1, 0.36, 1] as const;
