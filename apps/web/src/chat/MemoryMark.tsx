import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ComponentProps } from "react";
import { MemoryIcon } from "@/components/icons";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { memoryOnIn, memoryQuery } from "../memory/queries.ts";
import { useSetting } from "../settings/settings.ts";
import { useChat } from "./session.ts";
import { foldedTurns, heldTurns } from "./store.ts";

/** The remembered count, after the word or in a corner of the phone's menu button: short enough for four figures ("1.2K"). */
const n = new Intl.NumberFormat("en", { notation: "compact" });

/**
 * Whether the chat's character has memory on (every character, until turned
 * off), once its memory loaded, and how many turns are remembered, held or
 * folded; null before the memory first loads, for a character gone or with
 * memory off.
 */
function useMemoryStatus(): { characterId: string; remembered: number } | null {
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
function MemoryLink({
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
 * From tablet up, beside the meter while the chat's character has memory on:
 * a quiet labelled link like the header's other actions, with how many turns
 * are remembered after the word. It opens the character's memory screen,
 * whose Back returns to the chat.
 */
export function MemoryMark({ compact = false }: { compact?: boolean }) {
  const status = useMemoryStatus();
  if (status === null) return null;
  return (
    <MemoryLink
      characterId={status.characterId}
      aria-label="Memory"
      data-memory-mark=""
      className={cn(
        buttonVariants(),
        "transition-opacity duration-(--duration-quick) ease-fade starting:opacity-0",
        compact && "gap-1 px-2 touch:px-2",
      )}
    >
      {!compact && <MemoryIcon size={16} />}
      Memory
      {!compact && status.remembered > 0 && (
        <span
          key={status.remembered}
          className="text-meta text-reed tabular-nums transition-opacity duration-(--duration-quick) ease-fade starting:opacity-0"
        >
          {n.format(status.remembered)}
        </span>
      )}
    </MemoryLink>
  );
}
