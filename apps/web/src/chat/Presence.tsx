import { useFormFactor } from "@/app/form-factor.ts";
import { LamplightRim } from "@/components/lamplight.tsx";
import { cn } from "@/lib/cn";
import { FullPortrait, Leaf, Portrait } from "../portraits/Portrait.tsx";
import { PortraitViewer } from "../portraits/PortraitViewer.tsx";
import { useSetting } from "../settings/settings.ts";
import { CastPanel } from "./Cast.tsx";
import { useCastVisible } from "./cast-ui.ts";
import { useChatCharacter } from "./character.ts";
import { SceneButton } from "./Scene.tsx";
import { useChat } from "./session.ts";

/** The portrait's column in each placement: the button under it takes the same width. */
const COLUMN = { float: "w-28 desktop:w-40 @chat-roomy/chat:w-56", band: "w-24" } as const;

/**
 * The character, present once. Tablet and desktop: the portrait floats at the
 * head of the latest reply shown, or of the story while there is none, so
 * that reply's text wraps around it and it moves down the story with each new
 * reply; the header names the character. Phones: a band above the first turn
 * that scrolls away, after which the header carries a small portrait; without
 * art, the name alone in the story face. It arrives the way an imported
 * portrait does, in each new place, and opens larger on a click or tap.
 * With a ComfyUI address saved, Picture this scene sits under the portrait,
 * or in its place without one. The cast's roster follows, in the float's
 * column or across the band, whenever it has someone to list, portrait or not.
 */
export function Presence({ placement }: { placement: "float" | "band" }) {
  const character = useChatCharacter();
  const desktop = useFormFactor() === "desktop";
  const pictures = useSetting((settings) => settings.comfyuiBaseUrl) !== "";
  const cast = useCastVisible();
  if (character === undefined) return null;
  const name = character.name;

  const size = placement === "float" && desktop ? "full" : "thumb";
  const portrait = character.portrait !== null && (
    // On phones the band's portrait drives the header's: its exit is a view timeline.
    <div
      className={cn(
        "relative isolate shrink-0",
        placement === "band" && "[view-timeline:--presence_block]",
      )}
    >
      <PortraitViewer
        label={`Portrait of ${name}`}
        art={<FullPortrait id={character.id} version={character.portrait} shown={size} />}
        className={COLUMN[placement]}
      >
        <Portrait id={character.id} name={name} version={character.portrait} size={size} />
      </PortraitViewer>
      {/* The reply's one light on tablet and desktop; phones carry it on the nameplate's hairline. */}
      {placement === "float" && <ReplyRim />}
    </div>
  );

  // After the portrait's viewer in the tab order.
  const roster = placement === "float" && cast;
  const column = (portrait || pictures || roster) && (
    <div className={cn("grid shrink-0 gap-2", COLUMN[placement])}>
      {portrait}
      {pictures && <SceneButton wide={placement === "float"} />}
      {roster && <CastPanel placement="float" />}
    </div>
  );

  if (placement === "float") {
    return (
      column && (
        <div
          key={character.id}
          data-presence=""
          className="surface-in float-left mt-1 mr-8 mb-4 desktop:mr-10"
        >
          {column}
        </div>
      )
    );
  }
  const head = portrait ? (
    <div className="flex items-end gap-4">
      {column}
      {/* Level with the portrait's foot, above the button under it. */}
      <p
        className={cn(
          "min-w-0 break-words font-story text-[1.5rem] text-narration leading-[1.75rem]",
          pictures && "mb-11 touch:mb-13",
        )}
      >
        {name}
      </p>
    </div>
  ) : pictures ? (
    <div className="flex items-center gap-4">
      {column}
      <p className="min-w-0 break-words font-story text-[1.25rem] text-narration leading-[1.625rem]">
        {name}
      </p>
    </div>
  ) : (
    <p className="break-words font-story text-[1.25rem] text-narration leading-[1.625rem]">
      {name}
    </p>
  );
  // The band's roster spans its whole width, under the portrait and the name.
  return (
    <div
      key={character.id}
      data-presence=""
      className={cn("surface-in -mt-2", portrait ? "pb-4" : "pb-3")}
    >
      {head}
      {cast && <CastPanel placement="band" />}
    </div>
  );
}

/**
 * The floating portrait's rim: busy while a reply (or Write for me's
 * draft) is written, closing when that generation completes and fading when
 * it is stopped or fails; a still faint ring while
 * the owner writes in the composer.
 */
function ReplyRim() {
  const writing = useChat((state) => state.generating);
  const settled = useChat((state) => state.generationEnd === "complete");
  return <LamplightRim busy={writing} settled={settled} listen />;
}

/**
 * The phone header's small portrait: it fades in as the band's portrait
 * leaves view, driven by scrolling alone, in a slot that is always reserved
 * so the title never moves. Decorative: the title names the character.
 */
export function HeaderPortrait() {
  const character = useChatCharacter();
  if (character?.portrait == null) return null;
  return (
    <span
      aria-hidden="true"
      data-presence-header=""
      className="presence-in relative isolate shrink-0"
    >
      <Leaf id={character.id} version={character.portrait} className="w-8 rounded-[4px]" />
    </span>
  );
}
