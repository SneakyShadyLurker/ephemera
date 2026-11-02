import { parseCardAnswer } from "@ephemera/core";
import { useRef } from "react";
import { useFormFactor } from "@/app/form-factor.ts";
import { ArtStack } from "./ArtStack.tsx";
import { type ArtSessionHost, ArtSessionProvider } from "./art-session.tsx";
import { CardHeading, SHOWCASE_GRID } from "./CardLayout.tsx";
import { ShowcaseText, TagChips } from "./CardText.tsx";
import { creatorStore, useCreator } from "./session.ts";
import type { CardRun } from "./store.ts";

/** The creator's words where the art is off, stopped or unavailable: the card can be kept without it. */
const CREATOR_ART_COPY: ArtSessionHost["copy"] = {
  off: "Add a ComfyUI address in Settings to paint portraits. The card can be kept without one.",
  stopped: "Art stopped. Try it again or keep the card without it.",
  unavailable: "Portraits unavailable. Try the art again or keep the card without it.",
};

/**
 * State 4, the showcase: the new character met. Desktop and tablet: the art
 * stack, sticky in its column, beside the name, tagline, tags and the card's
 * text. Phones: the art at about 38dvh with the alternates beside it, then
 * the name and tagline, so the opening is on the first screen. Keep and the
 * rest of the actions sit in the screen's action bar (KeepBar).
 */
export function Showcase({ card }: { card: CardRun }) {
  const phone = useFormFactor() === "phone";
  const parsed = parseCardAnswer(card.answer);
  const name = parsed.name.text;
  const heading = <CardHeading name={name} tagline={parsed.creatorNotes.text} />;
  const text = <ShowcaseText kind={card.kind} answer={parsed} tokens={card.tokens} phone={phone} />;
  const locked = useCreator((state) => state.keepRun?.status === "saving");
  // Kept: the art travels into its place in the gallery or the sheet.
  const leaving = useCreator((state) => state.keepRun?.status === "kept");
  const newArt = useRef<HTMLButtonElement>(null);
  const again = useRef<HTMLButtonElement>(null);
  const host: ArtSessionHost = {
    store: creatorStore,
    kind: card.kind,
    defaults: { model: card.model, reasoning: card.reasoning },
    locked,
    leaving,
    copy: CREATOR_ART_COPY,
    focusAfter: () => again.current ?? newArt.current,
  };
  const art = (
    <ArtSessionProvider host={host}>
      <ArtStack name={name} phone={phone} newArt={newArt} again={again} />
    </ArtSessionProvider>
  );

  if (phone) {
    return (
      <div className="grid gap-6 px-5 pt-4 pb-8">
        {art}
        {heading}
        {text}
      </div>
    );
  }
  return (
    <div className="@container">
      <div className={SHOWCASE_GRID}>
        <aside className="grid max-w-48 content-start @card:sticky @card:top-8 @card:max-w-none @card:self-start">
          {art}
        </aside>
        <div className="grid min-w-0 content-start gap-8">
          <div className="grid gap-4">
            {heading}
            <TagChips kind={card.kind} />
          </div>
          {text}
        </div>
      </div>
    </div>
  );
}
