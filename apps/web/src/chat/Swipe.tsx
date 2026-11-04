import { AnimatePresence, type PanInfo } from "motion/react";
import * as m from "motion/react-m";
import { type ReactNode, type RefObject, useLayoutEffect, useRef } from "react";
import { create } from "zustand";
import { useCoarsePointer } from "@/app/form-factor.ts";
import { fade, spring } from "@/app/motion.tsx";
import { motionPx } from "@/app/motion-tokens.ts";
import { useReducedMotion } from "@/app/reduced-motion.ts";
import { cn } from "@/lib/cn";
import { chatStore } from "./session.ts";

/*
 * Swiping between a reply's alternates. Touch drags the last reply sideways
 * with a rubber band; past the threshold the next alternate slides in on the
 * spring. Buttons and keys slide it on the same spring. The arriving alternate
 * grows or shrinks from the height of the one it replaces, so what follows
 * moves on the spring. Streaming replies keep their natural height as text
 * arrives. Reduced motion keeps only the fade. `AnimatePresence`
 * waits for the exit before the entry; its "popLayout" mode injects a
 * <style> element, which the CSP forbids.
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
/** How strongly the rubber band resists a drag past the reply's place: a ratio, not a distance. */
const DRAG_ELASTIC = 0.25;

/**
 * How far an alternate travels as it leaves or arrives, none under reduced motion, and the
 * height of the alternate it replaces, measured as that one leaves and read as this one enters.
 */
interface Travel {
  direction: number;
  far: boolean;
  still: boolean;
  streaming: boolean;
  from: RefObject<number | null>;
}
/** A swipe from the arrows or keys travels a nudge; one a drag carried follows the finger further. */
const distance = ({ direction, far, still }: Travel) =>
  still ? 0 : direction * motionPx("--swipe-shift") * (far ? 1 : 0.5);

const variants = {
  enter: (travel: Travel) => ({
    x: distance(travel),
    opacity: 0,
    height: (travel.still || travel.streaming ? null : travel.from.current) ?? "auto",
  }),
  center: { x: 0, opacity: 1, height: "auto" },
  exit: (travel: Travel) => ({ x: -distance(travel), opacity: 0 }),
};

/** The slide and the height on the calm spring, the crossfade quick; read when a slide starts. */
const transition = () => ({ x: spring(), height: spring(), opacity: fade("--duration-quick") });

/**
 * The shown alternate of a reply; `swipeable` on the last reply only, and
 * kept on while it streams (the store ignores swipes then), since switching
 * Motion's drag on as a reply settles takes effect a moment late. The key is
 * the alternate's id, so a new or replaced alternate slides in.
 */
export function SwipeFrame({
  replyId,
  swipeable,
  streaming,
  children,
}: {
  replyId: string;
  swipeable: boolean;
  streaming: boolean;
  children: ReactNode;
}) {
  const coarse = useCoarsePointer();
  const { direction, far } = useSwipeMotion();
  const still = useReducedMotion();
  const frame = useRef<HTMLDivElement>(null);
  const shown = useRef(replyId);
  const from = useRef<number | null>(null);
  // While the outgoing alternate still shows (`mode="wait"` keeps it until its exit ends), its
  // height is what the next one grows from. Read once per change of alternate, never per chunk,
  // and kept out of state: a render during the exit would restart it.
  useLayoutEffect(() => {
    if (shown.current === replyId) return;
    shown.current = replyId;
    from.current = frame.current?.getBoundingClientRect().height ?? null;
  }, [replyId]);
  const custom: Travel = { direction, far, still, streaming, from };
  const drag = swipeable && coarse;
  const onDragEnd = (_event: PointerEvent, { offset, velocity }: PanInfo) => {
    if (offset.x < -DRAG_DISTANCE || velocity.x < -DRAG_VELOCITY) void swipe(1, true);
    else if (offset.x > DRAG_DISTANCE || velocity.x > DRAG_VELOCITY) void swipe(-1, true);
  };
  return (
    <AnimatePresence initial={false} custom={custom} mode="wait">
      <m.div
        key={replyId}
        ref={frame}
        custom={custom}
        variants={variants}
        initial="enter"
        animate="center"
        exit="exit"
        transition={transition()}
        drag={drag ? "x" : false}
        // Clipped below, so an arriving longer alternate does not spill over what follows while
        // its height grows. Streaming arrivals start at auto: measuring auto for a height
        // animation would freeze its target while more text arrives and clip the new text.
        className={cn("overflow-y-clip", drag && "touch-pan-y")}
        {...(drag
          ? {
              onDragEnd,
              dragDirectionLock: true,
              dragSnapToOrigin: true,
              dragElastic: DRAG_ELASTIC,
              dragConstraints: { left: 0, right: 0 },
            }
          : {})}
      >
        {children}
      </m.div>
    </AnimatePresence>
  );
}
