import { type CreatorKind, parseCardAnswer } from "@ephemera/core";
import { type RefObject, useEffect, useRef, useState } from "react";
import { LatestIcon, StopIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { CardFrame, CardHeading, CardLayout, CardSection, NameLeaf } from "./CardLayout.tsx";
import { endNote } from "./notes.ts";
import {
  cardRows,
  TAGLINE_EDGE,
  writingCaption,
  writingEdge,
  writingProgress,
} from "./sections.ts";
import { useCreator } from "./session.ts";
import { inTransition } from "./transition.ts";

/** The frame's accessible label while the card is written. */
const WRITING_LABEL: Record<CreatorKind, string> = {
  subject: "The character, being written",
  group: "The characters, being written",
  scenario: "The scenario, being written",
};

/** Whether a point (the writing edge) is inside the scroller's view, with a little room. */
function inView(point: Element, scroller: Element): boolean {
  const at = point.getBoundingClientRect();
  const view = scroller.getBoundingClientRect();
  return at.top >= view.top - 1 && at.bottom <= view.bottom + 24;
}

/**
 * State 3: the showcase's layout at once, filling in as the model writes.
 * The frame is the art-less leaf: the name as it arrives, what is being
 * written, and how much of the card is done along its lower edge. Sections
 * fill in order from the live parse and stay expanded, so nothing the owner
 * reads moves; those still to come hold placeholder lines, and the caret
 * stands where text arrives. The column follows the writing only while the
 * owner stays at its edge. While the model thinks, before its first text,
 * the frame and the edge say so; when a first draft lacked parts, a quiet
 * line above the name says it is being written again. A finished card stays
 * here while the frame's light closes and fades, then `onClosed` hands it to
 * the showcase.
 */
export function Writing({
  scroller,
  onClosed,
}: {
  scroller: RefObject<HTMLDivElement | null>;
  onClosed: () => void;
}) {
  const kind = useCreator((state) => state.card?.kind ?? "subject");
  const status = useCreator((state) => state.card?.status ?? "writing");
  const answer = useCreator((state) => state.card?.answer ?? "");
  const failure = useCreator((state) => state.card?.failure ?? null);
  const problems = useCreator((state) => state.card?.problems);
  const reasoned = useCreator((state) => state.card?.thinking ?? false);
  const retried = useCreator((state) => state.card?.retried ?? false);
  const stop = useCreator((state) => state.stop);
  const rewrite = useCreator((state) => state.rewrite);
  const back = useCreator((state) => state.returnToDescription);
  const writing = status === "writing";
  const thinking = writing && reasoned && answer === "";
  const parsed = parseCardAnswer(answer);
  const rows = cardRows(kind, parsed);
  const opened = writingEdge(parsed, rows);
  const edge = writing ? (opened ?? "name") : undefined;
  const name = useRef<HTMLHeadingElement>(null);
  const rewriteButton = useRef<HTMLButtonElement>(null);
  const [following, setFollowing] = useState(true);

  // Focus goes to the name as writing starts; once it ends, to Rewrite, when Stop took it along.
  useEffect(() => {
    if (writing) {
      name.current?.focus({ preventScroll: true });
      setFollowing(true);
    } else if (document.activeElement === document.body || document.activeElement === null) {
      rewriteButton.current?.focus();
    }
  }, [writing]);

  // While the owner stays at the writing edge, the column keeps it in view as text arrives.
  // biome-ignore lint/correctness/useExhaustiveDependencies: each new piece of text moves the edge.
  useEffect(() => {
    if (!writing || !following) return;
    const point = scroller.current?.querySelector("[data-writing-edge]");
    point?.scrollIntoView({ block: "nearest" });
  }, [answer, writing, following, scroller]);

  // Any scroll decides it: away from the edge stops following, back to it follows again.
  useEffect(() => {
    const view = scroller.current;
    if (view === null || !writing) return;
    const onScroll = () => {
      const point = view.querySelector("[data-writing-edge]");
      if (point !== null) setFollowing(inView(point, view));
    };
    view.addEventListener("scroll", onScroll, { passive: true });
    return () => view.removeEventListener("scroll", onScroll);
  }, [scroller, writing]);

  const note = endNote({ status, failure, problems: problems ?? [] });
  const caption = writing
    ? thinking
      ? "Thinking"
      : writingCaption(parsed, rows, opened)
    : status === "waiting"
      ? "Waiting for you to sign in"
      : undefined;

  const actions = writing ? (
    <Button variant="outline" onClick={stop} className="w-full">
      <StopIcon size={16} />
      Stop
    </Button>
  ) : null;

  return (
    <>
      <CardLayout
        frame={
          <CardFrame
            progress={writing ? writingProgress(parsed) : undefined}
            busy={writing}
            settled={status === "complete"}
            onEnd={onClosed}
          >
            <NameLeaf name={parsed.name.text} caption={caption} />
          </CardFrame>
        }
        actions={actions}
      >
        <div aria-busy={writing} className="grid gap-8">
          {writing && retried && (
            <p className="-mb-4 text-note text-reed arrive">
              The first draft was missing parts, so the card is being written again.
            </p>
          )}
          <CardHeading
            name={parsed.name.text}
            tagline={parsed.creatorNotes.text}
            headingRef={name}
            edge={
              edge === "name" || edge === TAGLINE_EDGE
                ? { at: edge, restart: answer.length, thinking }
                : undefined
            }
            label={WRITING_LABEL[kind]}
          />
          {/* Once writing ends nothing more comes: only what was written stays, above the note. */}
          {rows
            .filter((row) => writing || row.state !== "absent")
            .map((row) => (
              <CardSection
                key={row.key}
                row={row}
                streaming={writing}
                edge={edge === row.key ? answer.length : undefined}
              />
            ))}
        </div>
        {note !== null && (
          <div
            role={status === "stopped" || status === "waiting" ? "status" : "alert"}
            className="grid justify-items-start gap-3 border-rush border-t pt-4 arrive"
          >
            <p
              className={
                status === "stopped" || status === "waiting"
                  ? "text-ink text-ui"
                  : "text-ember text-ui"
              }
            >
              {note}
            </p>
            <div className="flex flex-wrap gap-2">
              {status !== "waiting" && (
                <Button ref={rewriteButton} variant="primary" onClick={() => inTransition(rewrite)}>
                  Rewrite
                </Button>
              )}
              <Button variant="outline" onClick={() => inTransition(back)}>
                Edit description
              </Button>
            </div>
          </div>
        )}
      </CardLayout>
      <p role="status" className="sr-only">
        {writing
          ? thinking
            ? "The model is thinking."
            : retried
              ? "The first draft was missing parts. Writing the card again."
              : "Writing the card."
          : ""}
      </p>
      {writing && !following && (
        <div className="pointer-events-none sticky bottom-3 flex justify-center">
          <Button
            variant="outline"
            className="pointer-events-auto bg-surface shadow-overlay arrive"
            onClick={() => {
              setFollowing(true);
              // At once: a smooth scroll would pass through views away from the edge.
              scroller.current
                ?.querySelector("[data-writing-edge]")
                ?.scrollIntoView({ block: "nearest" });
            }}
          >
            <LatestIcon />
            Follow writing
          </Button>
        </div>
      )}
    </>
  );
}
