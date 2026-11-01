import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { PortraitLeaf } from "../portraits/Portrait.tsx";
import type { LinkedCharacter } from "./library.ts";

/** How many portraits a row of linked characters shows before its count speaks for the rest. */
const SHOWN_LEAVES = 3;

/**
 * Up to three linked characters as small overlapping portrait leaves,
 * informational only (their names and count are said beside them). A leaf
 * that arrives after the row first showed, a new link, rises and fades in;
 * nothing moves on load, and reduced motion keeps only the fade (the
 * `--rise` token is 0 then).
 */
export function Leaves({
  characters,
  small = false,
  className,
}: {
  characters: LinkedCharacter[];
  /** In a list row, where they stay within its meta line. */
  small?: boolean;
  className?: string;
}) {
  const [settled, setSettled] = useState(false);
  useEffect(() => setSettled(true), []);
  const shown = characters.slice(0, SHOWN_LEAVES);
  if (shown.length === 0) return null;
  return (
    <span aria-hidden="true" className={cn("flex shrink-0 -space-x-1.5", className)}>
      {shown.map((character) => (
        <span
          key={character.id}
          title={character.name}
          className={cn(
            "relative block rounded-xs ring-2 ring-canvas",
            small ? "w-4" : "w-5",
            settled && "arrive",
          )}
        >
          <PortraitLeaf
            id={character.id}
            name={character.name}
            version={character.portrait}
            className={small ? "w-4" : "w-5"}
          />
        </span>
      ))}
    </span>
  );
}
