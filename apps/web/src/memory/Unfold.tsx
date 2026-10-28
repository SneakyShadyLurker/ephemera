import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import type { ReactNode } from "react";
import { FADE, MotionScope, PANEL_OUT, QUICK, SPRING } from "@/app/motion.tsx";
import { useReducedMotion } from "@/app/reduced-motion.ts";

/*
 * Motion on the memory surfaces, on the thread's timing: what a person
 * opens grows to its height on the spring and fades in, and folds away the
 * same way, quicker. Reduced motion keeps only the fade. `AnimatePresence`
 * runs in its default mode: "popLayout" injects a <style>, which the CSP
 * forbids.
 */

/**
 * Its children while `show`, growing in from no height and folding away
 * again. Clipped only while it moves, so a focus ring inside is never cut.
 */
export function Unfold({
  show,
  id,
  className,
  children,
}: {
  show: boolean;
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  const still = useReducedMotion();
  const folded = still ? "auto" : 0;
  return (
    <MotionScope>
      <AnimatePresence initial={false}>
        {show && (
          <m.div
            key="unfold"
            id={id}
            className={className}
            initial={{ height: folded, opacity: 0, overflow: "hidden" }}
            animate={{ height: "auto", opacity: 1, transitionEnd: { overflow: "visible" } }}
            exit={{
              height: folded,
              opacity: 0,
              overflow: "hidden",
              transition: {
                height: { ...SPRING, duration: PANEL_OUT },
                opacity: { duration: QUICK },
              },
            }}
            transition={{ height: SPRING, opacity: FADE }}
          >
            {children}
          </m.div>
        )}
      </AnimatePresence>
    </MotionScope>
  );
}
