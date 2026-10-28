import { type FeatureBundle, LazyMotion, MotionConfig } from "motion/react";
import type { ReactNode } from "react";

/*
 * Motion's contract for the app: one feature loader, one provider pair, and
 * the JS twins of the motion tokens in styles.css (`--duration-panel-in` on
 * the calm spring, `--ease-fade` for fades). Tune them with those tokens.
 */

let loaded: FeatureBundle | undefined;

/** Loads Motion's features once and keeps them, so every later scope gets them at once. */
export const loadMotionFeatures = () =>
  import("../chat/motion-features.ts").then((module) => (loaded = module.default));

/**
 * Motion's drag and spring features for a LazyMotion: loaded on first use,
 * then handed over at once. A scope given only the loader has no renderer
 * until it resolves again, and an exit that lands in that tick never runs,
 * leaving the leaving element on screen.
 */
export const motionFeatures = () => loaded ?? loadMotionFeatures;

/** `--duration-quick` in seconds: crossfades and quick fades. */
export const QUICK = 0.12;

/** `--duration-panel-out` in seconds: what leaves goes quicker than it came. */
export const PANEL_OUT = 0.18;

/** The calm spring without overshoot, over `--duration-panel-in`. */
export const SPRING = { type: "spring", bounce: 0, duration: 0.24 } as const;

/** The fade curve, `--ease-fade`. */
export const FADE_EASE = [0.2, 0, 0, 1] as const;

/** A fade over `--duration-arrive` on the fade curve. */
export const FADE = { duration: 0.18, ease: FADE_EASE } as const;

/** Motion's features and the reduced-motion rule for what is inside. */
export function MotionScope({ children }: { children: ReactNode }) {
  return (
    <MotionConfig reducedMotion="user">
      <LazyMotion features={motionFeatures()} strict>
        {children}
      </LazyMotion>
    </MotionConfig>
  );
}
