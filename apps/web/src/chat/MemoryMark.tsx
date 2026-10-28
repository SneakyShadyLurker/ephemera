import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { MemoryIcon } from "@/components/icons";
import { buttonVariants } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { memoryOnIn, memoryQuery } from "../memory/queries.ts";
import { useSetting } from "../settings/settings.ts";
import { REMEMBERING } from "./MemorySeam.tsx";
import { useChat } from "./session.ts";
import { foldedTurns, heldTurns } from "./store.ts";

/** The remembered count in a corner of the mark: short enough for four figures ("1.2K"). */
const n = new Intl.NumberFormat("en", { notation: "compact" });

/**
 * Beside the meter while the chat's character has memory on (every
 * character, until turned off), once its memory loaded: a small page
 * with its corner turned down, and how many turns are remembered, held or
 * folded, set in its
 * corner so the mark keeps its width and nothing beside it moves. It breathes
 * while a memory is written and opens the character's memory screen,
 * whose Back returns to the chat.
 */
export function MemoryMark() {
  const characterId = useSetting((settings) => settings.characterId);
  const memory = useQuery({
    ...memoryQuery(characterId ?? ""),
    enabled: characterId !== null,
  });
  const remembered = useChat((state) => foldedTurns(state) + heldTurns(state));
  const remembering = useChat((state) => state.memory.status === "remembering");
  // Not before the memory first loads, nor for a character gone: only memory known to be on.
  if (characterId === null || !memoryOnIn(memory)) return null;
  return (
    <Tooltip label="Memory" side="bottom">
      <Link
        to="/characters/$id/memory"
        params={{ id: characterId }}
        // The screen's Back returns here, to the chat, rather than to the character's sheet.
        search={{ from: "chat" }}
        aria-label="Memory"
        data-memory-mark=""
        className={cn(
          buttonVariants({ size: "icon" }),
          "transition-opacity duration-(--duration-quick) ease-fade starting:opacity-0",
        )}
      >
        <MemoryIcon className={cn(remembering && REMEMBERING)} />
        {remembered > 0 && (
          <span
            key={remembered}
            data-remembered-count=""
            className="pointer-events-none absolute top-0.5 right-0 min-w-4 rounded-full bg-surface-selected px-1 text-center font-medium text-[0.6875rem] text-ink leading-4 tabular-nums transition-[opacity,scale] duration-(--duration-arrive) ease-spring starting:scale-75 starting:opacity-0 touch:top-1 touch:right-0.5"
          >
            {n.format(remembered)}
          </span>
        )}
      </Link>
    </Tooltip>
  );
}
