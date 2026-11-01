import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ArtStudio } from "./ArtStudio.tsx";
import { sheetArtStore, useSheetArt } from "./session.ts";
import type { SheetArtCard } from "./store.ts";

/**
 * New art, under a saved character's portrait, and the studio it opens.
 * Opening binds the sheet-art session to this sheet (its live card and its
 * portrait-update owner) and closes the rework composer (`onOpen`); closing
 * stops a run in flight and keeps the candidates. A dropped session closes it.
 */
export function NewArtButton({
  characterId,
  name,
  portrait,
  card,
  onPortrait,
  held,
  disabled,
  onOpen,
}: {
  characterId: string;
  /** The sheet's name, or "this character" when blank. */
  name: string;
  /** The stored portrait's version; null for none. */
  portrait: number | null;
  /** The sheet's live card, read when a run or a save starts. */
  card: () => SheetArtCard;
  /** The sheet's one portrait-update owner, called on a saved Use. */
  onPortrait: (version: number) => void;
  /** A rework or this session's save holds the portrait. */
  held: boolean;
  /** Held, or the portrait picker is busy. */
  disabled: boolean;
  onOpen: () => void;
}) {
  /** The session epoch the studio was opened in; a drop (Clear, `pagehide`) advances it and closes the studio. */
  const [openedIn, setOpenedIn] = useState<number | null>(null);
  const epoch = useSheetArt((state) => state.epoch);
  const open = openedIn === epoch;
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button
        size="text"
        ref={triggerRef}
        disabled={disabled}
        onClick={() => {
          // A saved Use closes the studio whichever way it was sent: pressed, or again after a sign-in.
          sheetArtStore.getState().open({
            characterId,
            card,
            onPortrait: (version) => {
              onPortrait(version);
              setOpenedIn(null);
            },
          });
          onOpen();
          // Read after binding: opening for another character drops the old session first.
          setOpenedIn(sheetArtStore.getState().epoch);
        }}
      >
        New art
      </Button>
      <ArtStudio
        open={open}
        onOpenChange={(next) => {
          if (!next) sheetArtStore.getState().close();
          setOpenedIn(next ? epoch : null);
        }}
        characterId={characterId}
        name={name}
        portrait={portrait}
        held={held}
        trigger={triggerRef}
      />
    </>
  );
}
