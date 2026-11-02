import { useEffect, useRef, useState } from "react";
import { EditIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { DisclosureChevron } from "@/components/ui/disclosure";
import { countOf } from "@/lib/text";
import { useSetting } from "../settings/settings.ts";
import { EditField } from "./EditField.tsx";
import { chatStore, useChat } from "./session.ts";
import type { Reply } from "./store.ts";

/** Whole seconds, at least one: "Thought for 1 second". */
function thoughtFor(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  return `Thought for ${countOf(seconds, "second")}`;
}

/** Seconds since the component mounted, ticking once a second; presentation only. */
function useElapsed(running: boolean): number {
  const [started] = useState(() => Date.now());
  const [now, setNow] = useState(started);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [running]);
  return Math.floor((now - started) / 1000);
}

/**
 * The model's reasoning above its reply: collapsed by default (open when
 * the owner chose so in Settings), while it streams too; a native
 * disclosure, so find in page opens it. The text is untrusted and shown as
 * plain text; it can be edited in place, and emptied to remove it, unless
 * its turn is remembered or being remembered (`editable` false).
 */
export function Reasoning({
  reply,
  messageId,
  editable = true,
}: {
  reply: Reply;
  messageId: string;
  editable?: boolean;
}) {
  const thinking = reply.status === "streaming" && reply.text === "";
  const elapsed = useElapsed(thinking);
  const reasoningOpen = useSetting((settings) => settings.reasoningOpen);
  const editing = useChat(
    (state) => state.editing?.id === messageId && state.editing.target === "reasoning",
  );
  // Editing opens the block; closing it again stays the reader's choice.
  const details = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (editing && details.current) details.current.open = true;
  }, [editing]);
  return (
    // On phones its line sits tight between the nameplate and the prose; the summary keeps its touch height.
    <details
      ref={details}
      open={reasoningOpen}
      className="disclosure mb-2 max-tablet:-mt-1.5 max-tablet:mb-0.5"
    >
      <summary className="-ml-1 inline-flex min-h-8 cursor-pointer list-none items-center gap-1.5 rounded-md px-1 text-note text-reed hover:text-ink touch:min-h-11 [&::-webkit-details-marker]:hidden">
        <DisclosureChevron className="[--chevron-closed:-90deg] [--chevron-open:0deg]" />
        {thinking ? (
          <span className="flex items-baseline gap-2">
            Thinking
            <span aria-hidden="true" className="caret" />
            <span aria-hidden="true" className="inline-block min-w-7 text-meta tabular-nums">
              {elapsed} s
            </span>
          </span>
        ) : reply.thoughtMs === null ? (
          "Reasoning"
        ) : (
          thoughtFor(reply.thoughtMs)
        )}
      </summary>
      <div className="mt-1.5 mb-2 ml-[0.4rem] grid gap-2 border-control-edge border-l-2 pl-4 text-narration text-ui leading-6">
        {editing ? (
          <EditField id={messageId} label="Edit reasoning" target="reasoning" />
        ) : (
          <>
            <p translate="no" className="whitespace-pre-wrap break-words">
              {reply.reasoning}
            </p>
            {!thinking && editable && (
              <Button
                size="text"
                variant="quiet"
                onClick={() => chatStore.getState().startEdit(messageId, "reasoning")}
                // Out of sight while anything is written, by CSS: earlier turns stay untouched.
                className="justify-self-start gap-1.5 [[aria-busy=true]_&]:invisible"
              >
                <EditIcon size={16} />
                Edit reasoning
              </Button>
            )}
          </>
        )}
      </div>
    </details>
  );
}

/**
 * For a model that reasoned but kept its reasoning hidden (Show Hidden):
 * how long it took, and nothing to open.
 */
export function HiddenReasoning({ ms }: { ms: number }) {
  return (
    <p className="mb-2 flex min-h-8 items-center gap-1.5 text-note text-reed touch:min-h-11 max-tablet:-mt-1.5 max-tablet:mb-0.5">
      <span aria-hidden="true" className="size-4" />
      {thoughtFor(ms)}; the model keeps its reasoning to itself.
    </p>
  );
}
