/*
 * styles.css owns every motion duration, curve, delay and distance. Script
 * that needs one reads it here as it applies (under reduced motion the
 * tokens already hold the short fades) and never keeps a copy.
 */

import type { CSSProperties } from "react";

export type Token = `--${string}`;

/**
 * The `stagger` utility's place for one of several siblings arriving together:
 * it waits `step` times `--stagger-step` (none under reduced motion).
 */
export const staggerStep = (step: number): CSSProperties => ({ "--step": step }) as CSSProperties;

/** A motion token from styles.css, as it applies now; "" outside a document (a static render). */
export function motionToken(name: Token): string {
  if (typeof document === "undefined") return "";
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * A time token in milliseconds, written in either unit (the build may
 * rewrite 300ms as .3s); 0 where it cannot be read, so nothing waits on it.
 */
export function motionMs(name: Token): number {
  const value = motionToken(name);
  const number = Number.parseFloat(value);
  if (Number.isNaN(number)) return 0;
  return value.endsWith("ms") ? number : number * 1000;
}

/** A time token in seconds, Motion's unit. */
export const motionSeconds = (name: Token): number => motionMs(name) / 1000;

/** A length token in pixels (`--rise`, `--panel-shift`); 0 where it cannot be read. */
export function motionPx(name: Token): number {
  return Number.parseFloat(motionToken(name)) || 0;
}

/** `--ease-fade` as Motion's cubic Bézier; Motion's default curve where it cannot be read. */
export function fadeEase(): [number, number, number, number] | undefined {
  const points = /cubic-bezier\(([^)]+)\)/.exec(motionToken("--ease-fade"))?.[1]?.split(",");
  const numbers = points?.map((point) => Number.parseFloat(point));
  if (numbers?.length !== 4 || numbers.some(Number.isNaN)) return undefined;
  return [numbers[0] ?? 0, numbers[1] ?? 0, numbers[2] ?? 0, numbers[3] ?? 0];
}
