import { useEffect, useEffectEvent, useRef, useState } from "react";

/*
 * The rim (styles.css `lamplight-rim`): the one light a frame carries while
 * its work runs. Each framed consumer renders it last inside the frame's
 * positioned wrapper and says only whether the work runs and how it ended;
 * the strokes, timings and keyframes stay in styles.css.
 */

/** Busy, or ending: closing on success (`settle`) or fading on any other end. */
type Phase = "idle" | "busy" | "settle" | "fade";

/** A motion token from styles.css, as written. */
function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** A duration token in milliseconds, written in either unit (the build may rewrite 300ms as .3s). */
function ms(name: string): number {
  const value = token(name);
  return Number.parseFloat(value) * (value.endsWith("ms") ? 1 : 1000);
}

/**
 * The success closure: from wherever the head is, the tail grows backward
 * along the frame until it meets it, its front held still, while the head
 * and the bloom give way; then the whole light fades.
 */
function close(lap: SVGGElement): Animation[] {
  const tail = lap.querySelector<SVGRectElement>('[data-rim="tail"]');
  const at = Number.parseFloat(getComputedStyle(lap).getPropertyValue("--lap")) || 0;
  const dash = Number.parseFloat(tail ? getComputedStyle(tail).strokeDasharray : "") || 0;
  const timing = {
    duration: ms("--duration-close"),
    easing: token("--ease-fade"),
    fill: "forwards",
  } as const;
  const closing = tail?.animate(
    { strokeDasharray: "100 0", strokeDashoffset: String(at + 100 - dash) },
    timing,
  );
  const giving = [...lap.querySelectorAll('[data-rim="head"], [data-rim="bloom"]')].map((stroke) =>
    stroke.animate({ opacity: 0 }, timing),
  );
  return closing === undefined ? giving : [closing, ...giving];
}

/**
 * The rim over a frame. `busy` while its work runs; when it stops, `settled`
 * says whether the work finished (the ring closes, then fades) or was
 * stopped or failed (it only fades). `listen`: a still faint ring while the
 * owner writes in the chat's composer (the floating portrait only). Under
 * reduced motion it is a still ring while busy and fades at any end.
 * `onEnd`: once the light has gone after an ending.
 */
export function LamplightRim({
  busy,
  settled = false,
  listen = false,
  onEnd,
}: {
  busy: boolean;
  settled?: boolean;
  listen?: boolean;
  onEnd?: (() => void) | undefined;
}) {
  const rim = useRef<HTMLSpanElement>(null);
  const [phase, setPhase] = useState<Phase>(busy ? "busy" : "idle");
  if (busy && phase !== "busy") setPhase("busy");
  if (!busy && phase === "busy") setPhase(settled ? "settle" : "fade");
  const ended = useEffectEvent(() => onEnd?.());

  useEffect(() => {
    const lap = rim.current?.querySelector("g");
    if ((phase !== "settle" && phase !== "fade") || !lap) return;
    // A hidden tab never advances the animations, so nothing waiting on the ending would follow.
    if (document.visibilityState === "hidden") {
      setPhase("idle");
      ended();
      return;
    }
    // Reduced motion draws no lap: the still ring fades on its own.
    const moving = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const closing = phase === "settle" && moving ? close(lap) : [];
    const fade = lap.animate(
      { opacity: 0 },
      {
        delay: closing.length > 0 ? ms("--duration-close") : 0,
        duration: ms("--duration-fade-out"),
        easing: token("--ease-fade"),
        fill: "forwards",
      },
    );
    fade.finished.then(
      () => {
        setPhase("idle");
        ended();
      },
      () => {},
    );
    // After the next phase is drawn, so the light never flashes back.
    return () => {
      for (const animation of [...closing, fade]) animation.cancel();
    };
  }, [phase]);

  // The span is the container its strokes size to (styles.css: a small frame draws them finer).
  return (
    <span
      ref={rim}
      aria-hidden="true"
      data-lamplight={phase === "busy" ? "busy" : phase === "idle" ? undefined : "ending"}
      data-listen={listen ? "" : undefined}
      className="lamplight-rim"
    >
      <svg aria-hidden="true" focusable="false">
        <rect data-rim="ring" pathLength={100} />
        <g>
          <rect data-rim="bloom" pathLength={100} />
          <rect data-rim="tail" pathLength={100} />
          <rect data-rim="head" pathLength={100} />
        </g>
      </svg>
    </span>
  );
}
