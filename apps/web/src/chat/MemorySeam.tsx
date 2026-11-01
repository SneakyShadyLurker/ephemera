import { useQuery } from "@tanstack/react-query";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import { type MouseEvent, use, useState } from "react";
import { flushSync } from "react-dom";
import { PANEL_OUT, QUICK, SPRING } from "@/app/motion.tsx";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { countOf, formatCount } from "@/lib/text";
import { OpenEpisodeContext } from "../memory/EpisodeEditor.tsx";
import { MemoryFailureAction } from "../memory/FailureAction.tsx";
import { failureNote } from "../memory/failure.ts";
import { memoryQuery } from "../memory/queries.ts";
import { useSetting } from "../settings/settings.ts";
import { notReached } from "../signin/signin.ts";
import { chatStore, useChat } from "./session.ts";
import {
  type ChatMemory,
  type ChatState,
  foldedTurns,
  heldTurns,
  latestMemory,
  rememberedEnd,
  sentCount,
} from "./store.ts";

/*
 * The seam: where the chat's remembered turns end and the unremembered ones
 * begin. Remembered turns above it are still sent while the window holds
 * them (held) and fold into their memories once it does not.
 * A hairline across the measure with the latest memory's title set on it,
 * like a chapter heading, and one quiet line under it. Chat metadata only:
 * it shows what the store holds and keeps nothing.
 */

/**
 * Where the seam stands, as an index in the messages: at the span being
 * remembered (or the one whose answer was lost) while that is the news,
 * else where the remembered turns end; null while nothing is remembered or
 * under way.
 */
export function seamIndex(memory: ChatMemory): number | null {
  if (memory.status === "remembering" && memory.boundary !== null) return memory.boundary;
  if (memory.status === "failed" && memory.pending !== null) return memory.pending.boundary;
  const end = rememberedEnd(memory);
  return end > 0 || memory.status !== "idle" ? end : null;
}

/** The latest memory's turns, as requests send them. */
function latestTurns(state: ChatState): number {
  const latest = latestMemory(state.memory);
  return latest === null ? 0 : sentCount(state.messages, latest.from, latest.to);
}

/** The thread's entrance: a short rise on the spring and a fade; reduced motion keeps the fade. */
const ENTRANCE = {
  initial: { opacity: 0, y: 4 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: 4 },
  transition: { y: { ...SPRING, duration: PANEL_OUT }, opacity: { duration: PANEL_OUT } },
} as const;

const turns = (count: number) => countOf(count, "turn");

/** What the remembered turns are now: folded into their memories, still sent, or both. */
function rememberedLine(folded: number, held: number): string {
  if (folded > 0 && held > 0) {
    return `Remembered. ${turns(folded)} folded, ${formatCount(held)} still sent.`;
  }
  if (folded > 0) return `Remembered. ${turns(folded)} folded.`;
  return held > 0 ? `Remembered. ${turns(held)} still sent.` : "";
}

const ACTION = "h-8 px-2 text-note touch:h-11";

/** The nearest ancestor of `element` that scrolls vertically: the thread's scroller. */
function scrollerOf(element: HTMLElement): HTMLElement | null {
  for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(parent).overflowY)) return parent;
  }
  return null;
}

/**
 * Shows or hides the folded turns above the seam, keeping the seam where
 * the reader sees it: the turns arrive above it (fading in, as any turn
 * does) or leave from there, and the view moves by as much, never to the
 * top of the thread.
 */
function showFoldedAnchored(event: MouseEvent<HTMLElement>, shown: boolean) {
  const seam = event.currentTarget.closest<HTMLElement>("[data-memory-seam]");
  const scroller = seam === null ? null : scrollerOf(seam);
  const before = seam?.getBoundingClientRect().top;
  flushSync(() => chatStore.getState().showFolded(shown));
  if (seam === null || scroller === null || before === undefined) return;
  scroller.scrollTop += seam.getBoundingClientRect().top - before;
}

/** One place in the thread the seam may stand: it arrives and leaves there on the thread's spring. */
export function SeamSlot({ here }: { here: boolean }) {
  return <AnimatePresence initial={false}>{here && <MemorySeam key="seam" />}</AnimatePresence>;
}

export function MemorySeam() {
  const memory = useChat((state) => state.memory);
  const folded = useChat(foldedTurns);
  const held = useChat(heldTurns);
  const forgotten = useChat(latestTurns);
  const characterId = useSetting((settings) => settings.characterId);
  const { data } = useQuery({
    ...memoryQuery(characterId ?? ""),
    enabled: characterId !== null,
  });
  // The chat owns the editor: the seam moving on (a new memory) neither closes nor retargets it.
  const openEpisode = use(OpenEpisodeContext);
  const [confirming, setConfirming] = useState(false);
  const [forgetFailed, setForgetFailed] = useState(false);
  const { status, shown } = memory;
  const latest = latestMemory(memory);
  // The title as last saved, when the owner renamed it on the memory screen.
  const stored =
    latest === null ? undefined : data?.episodes.find((episode) => episode.id === latest.id);
  const title = stored?.title ?? latest?.title ?? "";

  const forget = async () => {
    if (latest === null) return;
    setForgetFailed(false);
    await chatStore.getState().forgetLatest();
    if (latestMemory(chatStore.getState().memory)?.id === latest.id) setForgetFailed(true);
  };

  return (
    <m.li
      data-memory-seam=""
      data-status={status}
      {...ENTRANCE}
      className="group/seam grid justify-items-center gap-1.5 py-1 text-center"
    >
      <div className="flex w-full items-center gap-4">
        {/* While a memory is written a light passes outward from the title along each side. */}
        <span aria-hidden="true" className="relative h-px flex-1 -scale-x-100 bg-rush">
          {status === "remembering" && <span className="lamplight-edge" />}
        </span>
        {title !== "" && (
          <p className="min-w-0 max-w-[80%] text-balance font-semibold font-story text-[1.125rem] text-ink leading-6 [overflow-wrap:anywhere]">
            {title}
          </p>
        )}
        <span
          aria-hidden="true"
          className={cn("relative h-px flex-1 bg-rush", title === "" && "-ml-4")}
        >
          {status === "remembering" && <span className="lamplight-edge" />}
        </span>
      </div>
      {/* Three columns, the outer two equal, so the line stays under the title whether Edit and
          Forget, which hover reveals, are seen or not. */}
      <div className="grid w-full grid-cols-[1fr_auto_1fr] items-center text-note text-reed">
        <div className="col-start-2 flex flex-wrap items-center justify-center gap-x-1 gap-y-0.5">
          <p role="status" className="px-1">
            {status === "remembering"
              ? "Remembering…"
              : status === "failed"
                ? failureNote(memory.failure).text
                : forgetFailed
                  ? `Not forgotten: ${notReached()}.`
                  : rememberedLine(folded, held)}
          </p>
          {status === "failed" && characterId !== null && (
            <MemoryFailureAction
              action={failureNote(memory.failure).action}
              characterId={characterId}
            />
          )}
          {status === "idle" && folded > 0 && (
            <Button
              variant="quiet"
              aria-expanded={shown}
              className={cn(ACTION, "text-ink")}
              onClick={(event) => showFoldedAnchored(event, !shown)}
            >
              <AnimatePresence initial={false} mode="wait">
                <m.span
                  key={shown ? "hide" : "show"}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: QUICK }}
                >
                  {shown ? "Hide the folded turns" : "Show the folded turns"}
                </m.span>
              </AnimatePresence>
            </Button>
          )}
        </div>
        {status === "idle" && latest !== null && (
          <span className="flex justify-self-start opacity-0 transition-opacity duration-(--duration-quick) ease-fade group-focus-within/seam:opacity-100 group-hover/seam:opacity-100 touch:opacity-100">
            {stored !== undefined && openEpisode !== null && (
              <Button variant="quiet" className={ACTION} onClick={() => openEpisode(stored.id)}>
                Edit
              </Button>
            )}
            <Button variant="quiet" className={ACTION} onClick={() => setConfirming(true)}>
              Forget
            </Button>
          </span>
        )}
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Forget this memory?"
        description={
          latest?.held === true
            ? `Its ${turns(forgotten)} stay in the story, no longer remembered.`
            : `Its ${turns(forgotten)} return to the story.`
        }
        confirm="Forget"
        onConfirm={() => void forget()}
      />
    </m.li>
  );
}
