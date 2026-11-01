import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ComponentProps } from "react";
import { MemoryIcon } from "@/components/icons";
import { buttonVariants } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { memoryOnIn, memoryQuery } from "../memory/queries.ts";
import { useSetting } from "../settings/settings.ts";
import { useChat } from "./session.ts";
import { foldedTurns, heldTurns } from "./store.ts";

/** The remembered count in a corner of the mark: short enough for four figures ("1.2K"). */
const n = new Intl.NumberFormat("en", { notation: "compact" });

/**
 * Whether the chat's character has memory on (every character, until turned
 * off), once its memory loaded, and how many turns are remembered, held or
 * folded; null before the memory first loads, for a character gone or with
 * memory off.
 */
export function useMemoryStatus(): { characterId: string; remembered: number } | null {
  const characterId = useSetting((settings) => settings.characterId);
  const memory = useQuery({
    ...memoryQuery(characterId ?? ""),
    enabled: characterId !== null,
  });
  const remembered = useChat((state) => foldedTurns(state) + heldTurns(state));
  if (characterId === null || !memoryOnIn(memory)) return null;
  return { characterId, remembered };
}

/**
 * A link to the chat character's memory screen, whose Back returns to the
 * chat rather than to the character's sheet: the Memory mark, and the
 * phone's chat menu item (its `render`).
 */
export function MemoryLink({
  characterId,
  ...props
}: { characterId: string } & Omit<ComponentProps<typeof Link>, "to" | "params" | "search">) {
  return (
    <Link
      to="/characters/$id/memory"
      params={{ id: characterId }}
      search={{ from: "chat" }}
      {...props}
    />
  );
}

/**
 * How many turns are remembered, set in a control's top corner so the
 * control keeps its width and nothing beside it moves; nothing while none are.
 */
export function RememberedCount({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span
      key={count}
      aria-hidden="true"
      data-remembered-count=""
      className="pointer-events-none absolute top-0.5 right-0 min-w-4 rounded-full bg-surface-selected px-1 text-center font-medium text-[0.6875rem] text-ink leading-4 tabular-nums transition-[opacity,scale] duration-(--duration-arrive) ease-spring starting:scale-75 starting:opacity-0 touch:top-1 touch:right-0.5"
    >
      {n.format(count)}
    </span>
  );
}

/**
 * Beside the meter while the chat's character has memory on: a small page
 * with its corner turned down, and how many turns are remembered in its
 * corner. It opens the character's memory screen, whose Back returns to
 * the chat.
 */
export function MemoryMark() {
  const status = useMemoryStatus();
  if (status === null) return null;
  return (
    <Tooltip label="Memory" side="bottom">
      <MemoryLink
        characterId={status.characterId}
        aria-label="Memory"
        data-memory-mark=""
        className={cn(
          buttonVariants({ size: "icon" }),
          "transition-opacity duration-(--duration-quick) ease-fade starting:opacity-0",
        )}
      >
        <MemoryIcon />
        <RememberedCount count={status.remembered} />
      </MemoryLink>
    </Tooltip>
  );
}
