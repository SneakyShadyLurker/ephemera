import { type FeatureBundle, LazyMotion, MotionConfig } from "motion/react";
import type { ReactNode } from "react";
import { fadeEase, motionSeconds, type Token } from "./motion-tokens.ts";

/*
 * Motion's contract for the app: one feature loader, one provider pair, and
 * Motion's transitions built from the motion tokens in styles.css, read as
 * they apply (./motion-tokens.ts). Tune them with those tokens.
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

/**
 * The calm spring without overshoot (`--ease-spring`), over a duration
 * token, `--duration-panel-in` unless another is named.
 */
export const spring = (duration: Token = "--duration-panel-in") =>
  ({ type: "spring", bounce: 0, duration: motionSeconds(duration) }) as const;

/** A fade on `--ease-fade` over a duration token, `--duration-arrive` unless another is named. */
export function fade(duration: Token = "--duration-arrive") {
  const ease = fadeEase();
  return ease === undefined
    ? { duration: motionSeconds(duration) }
    : { duration: motionSeconds(duration), ease };
}

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
