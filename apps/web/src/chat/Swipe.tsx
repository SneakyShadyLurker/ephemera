import { AnimatePresence, type PanInfo, useIsPresent, usePresenceData } from "motion/react";
import * as m from "motion/react-m";
import { type ComponentProps, type ReactNode, useLayoutEffect, useRef, useState } from "react";
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
 * arrives. Alternates overlap in normal text flow for the crossfade, keeping
 * the portrait's float around both. The old prose stays until the new prose
 * is ready. Reduced motion keeps only the fade.
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
  from: number | null;
}
/** Alternate replacements travel one short nudge, including after a drag. */
const distance = ({ direction, still }: Travel) =>
  still ? 0 : direction * motionPx("--swipe-shift");

const variants = {
  enter: (travel: Travel) => ({
    x: distance(travel),
    opacity: 0,
    height: (travel.still || travel.streaming ? null : travel.from) ?? "auto",
    minHeight: !travel.still && travel.streaming ? (travel.from ?? 0) : 0,
  }),
  exit: (travel: Travel) => ({
    x: -distance(travel),
    opacity: 0,
    height: travel.still ? "auto" : (travel.from ?? "auto"),
    minHeight: 0,
  }),
};

/** The slide and the height on the calm spring, the crossfade quick; read when a slide starts. */
const transition = () => ({
  x: spring(),
  height: spring(),
  minHeight: spring(),
  opacity: fade("--duration-quick"),
});

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
  ready = true,
  children,
}: {
  replyId: string;
  swipeable: boolean;
  streaming: boolean;
  ready?: boolean;
  children: ReactNode;
}) {
  const coarse = useCoarsePointer();
  const { direction, far } = useSwipeMotion();
  const still = useReducedMotion();
  const frame = useRef<HTMLDivElement>(null);
  const [kept, setKept] = useState<{ id: string; children: ReactNode; from: number | null }>({
    id: replyId,
    children,
    from: null,
  });
  // Empty streaming alternates wait behind the readable one. Only rendered prose is retained.
  useLayoutEffect(() => {
    if (replyId !== kept.id && !ready) return;
    const from =
      replyId !== kept.id ? (frame.current?.getBoundingClientRect().height ?? null) : kept.from;
    setKept((current) =>
      current.id === replyId && current.children === children
        ? current
        : { id: replyId, children, from },
    );
  }, [replyId, ready, children, kept.id, kept.from]);
  const visibleId = kept.id;
  const visible = replyId === kept.id ? children : kept.children;
  const custom: Travel = { direction, far, still, streaming, from: kept.from };
  const drag = swipeable && coarse;
  const onDragEnd = (_event: PointerEvent, { offset, velocity }: PanInfo) => {
    if (offset.x < -DRAG_DISTANCE || velocity.x < -DRAG_VELOCITY) void swipe(1, true);
    else if (offset.x > DRAG_DISTANCE || velocity.x > DRAG_VELOCITY) void swipe(-1, true);
  };
  return (
    <div className="min-w-0">
      <AnimatePresence initial={false} custom={custom} mode="sync">
        <SwipePanel
          key={visibleId}
          ref={(node) => {
            if (node) frame.current = node;
          }}
          custom={custom}
          variants={variants}
          initial="enter"
          animate={{
            x: 0,
            opacity: 1,
            height: "auto",
            minHeight: !still && streaming ? (kept.from ?? 0) : 0,
          }}
          exit="exit"
          transition={transition()}
          drag={drag ? "x" : false}
          // Streaming arrivals keep natural height as their prose grows.
          className={cn("min-w-0", drag && "touch-pan-y")}
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
          {visible}
        </SwipePanel>
      </AnimatePresence>
    </div>
  );
}

function SwipePanel({ children, ...props }: ComponentProps<typeof m.div>) {
  const present = useIsPresent();
  const travel: Travel = usePresenceData();
  return (
    <m.div
      {...props}
      // Cancels only the retained outgoing frame's flow height. Both prose blocks
      // keep the same float context; the incoming frame owns the region's height.
      style={{ marginBottom: present ? undefined : -(travel.from ?? 0) }}
      data-swipe=""
      data-leaving={present ? undefined : ""}
      inert={!present}
      aria-hidden={!present || undefined}
    >
      {children}
    </m.div>
  );
}
