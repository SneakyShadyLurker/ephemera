import { AnimatePresence, type PanInfo } from "motion/react";
import * as m from "motion/react-m";
import type { ReactNode } from "react";
import { create } from "zustand";
import { useCoarsePointer } from "@/app/form-factor.ts";
import { fade, spring } from "@/app/motion.tsx";
import { useReducedMotion } from "@/app/reduced-motion.ts";
import { chatStore } from "./session.ts";

/*
 * Swiping between a reply's alternates. Touch drags the last reply sideways
 * with a rubber band; past the threshold the next alternate slides in on the
 * spring. Buttons and keys move it 12px with a crossfade. Reduced motion
 * keeps only the fade. `AnimatePresence` runs in its default mode: its
 * "popLayout" mode injects a <style> element, which the CSP forbids.
 */

/** How the last change of alternate was made: presentation state, never chat content. */
const useSwipeMotion = create<{ direction: -1 | 1; far: boolean }>(() => ({
  direction: 1,
  far: false,
}));

/** Swipes the last reply; `far` when a drag carried it, so the slide follows the finger. */
export function swipe(direction: -1 | 1, far = false) {
  useSwipeMotion.setState({ direction, far });
  return chatStore.getState().swipe(direction);
}

const DRAG_DISTANCE = 72;
const DRAG_VELOCITY = 480;

/** How far an alternate travels as it leaves or arrives; none under reduced motion. */
interface Travel {
  direction: number;
  far: boolean;
  still: boolean;
}
/** A swipe from the arrows or keys travels a nudge; one a drag carried follows the finger further. */
const NEAR_TRAVEL = 12;
const FAR_TRAVEL = 64;
const distance = ({ direction, far, still }: Travel) =>
  still ? 0 : direction * (far ? FAR_TRAVEL : NEAR_TRAVEL);

const variants = {
  enter: (travel: Travel) => ({ x: distance(travel), opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit: (travel: Travel) => ({ x: -distance(travel), opacity: 0 }),
};

/** The slide on the calm spring, the crossfade quick; read when a slide starts. */
const transition = () => ({ x: spring(), opacity: fade("--duration-quick") });

/**
 * The shown alternate of a reply; `swipeable` on the last reply only, and
 * kept on while it streams (the store ignores swipes then), since switching
 * Motion's drag on as a reply settles takes effect a moment late. The key is
 * the alternate's id, so a new or replaced alternate slides in.
 */
export function SwipeFrame({
  replyId,
  swipeable,
  children,
}: {
  replyId: string;
  swipeable: boolean;
  children: ReactNode;
}) {
  const coarse = useCoarsePointer();
  const { direction, far } = useSwipeMotion();
  const custom: Travel = { direction, far, still: useReducedMotion() };
  const drag = swipeable && coarse;
  const onDragEnd = (_event: PointerEvent, { offset, velocity }: PanInfo) => {
    if (offset.x < -DRAG_DISTANCE || velocity.x < -DRAG_VELOCITY) void swipe(1, true);
    else if (offset.x > DRAG_DISTANCE || velocity.x > DRAG_VELOCITY) void swipe(-1, true);
  };
  return (
    <AnimatePresence initial={false} custom={custom} mode="wait">
      <m.div
        key={replyId}
        custom={custom}
        variants={variants}
        initial="enter"
        animate="center"
        exit="exit"
        transition={transition()}
        drag={drag ? "x" : false}
        dragDirectionLock
        dragSnapToOrigin
        dragElastic={0.25}
        dragConstraints={{ left: 0, right: 0 }}
        {...(drag ? { onDragEnd, className: "touch-pan-y" } : {})}
      >
        {children}
      </m.div>
    </AnimatePresence>
  );
}
