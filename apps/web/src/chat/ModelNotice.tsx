import { type RefObject, useEffect, useRef, useState } from "react";
import { NoticeCard, NoticeFold } from "@/app/NoticeCard.tsx";
import { buttonVariants } from "@/components/ui/button";
import { useContextWindow, useModelOptions } from "../api.ts";
import { ModelSelect } from "../components/model-select.tsx";
import { useSetting, useSettings, useUpdateSettings } from "../settings/settings.ts";
import { WindowLink } from "../settings/window-link.tsx";
import { useSignInPhase } from "../signin/hooks.ts";
import { useChatCharacter } from "./character.ts";
import { SCRIPT_FRAME } from "./frame.ts";
import { useChat } from "./session.ts";
import { storyEmpty } from "./store.ts";

/** The notice's body, which the message field and Send are described by while it shows. */
export const MODEL_NOTICE_BODY = "model-notice-body";

/**
 * The actions row spans the card where the card stacks (phones, narrow
 * columns), so the picker and its list are wide enough for model IDs.
 */
const ACTIONS = "flex w-full flex-wrap gap-2 tablet:w-auto";

/** What keeps Send from working: no reply model, or one without a known context window. */
type Blocker = "model" | "window";

/**
 * What the notice says now: a blocker, or null when nothing blocks. A
 * window still loading for a model just chosen keeps what it said, so a
 * pick that ends on an unknown window never folds away and back. Hidden
 * while the sign-in notice holds the slot: signing in comes first.
 */
export function useModelBlocker(): { blocker: Blocker | null; settling: boolean } {
  const settings = useSettings();
  const { model } = settings;
  const window = useContextWindow(model, settings);
  const signedIn = useSignInPhase() === "active";
  if (!signedIn) return { blocker: null, settling: false };
  if (model === null) return { blocker: "model", settling: false };
  if (window === null) return { blocker: "window", settling: false };
  return { blocker: null, settling: window === "loading" };
}

/**
 * Focuses the notice's first control (Enter in an empty-handed composer); false without one.
 * A notice folding away is inert, so the one still shown is the one asked.
 */
export function focusModelNotice(): boolean {
  const control = document.querySelector<HTMLElement>(
    "[data-model-notice]:not([inert]) [data-notice-actions] :is(a, button)",
  );
  control?.focus();
  return control != null;
}

/**
 * The picker and what the notice says, for either place it shows: the live
 * blocker (`live`, null when this place has nothing to say), held while a
 * just-chosen model's window loads and while it folds away, so the words do
 * not change as it leaves. A choice made here hands focus to the message
 * field, or to the notice's way out when the model has no known window.
 */
function useModelChoice(
  composer: RefObject<HTMLTextAreaElement | null>,
  live: Blocker | null,
  settling: boolean,
) {
  const { blocker } = useModelBlocker();
  const settings = useSettings();
  const { model } = settings;
  const options = useModelOptions(model);
  const updateSettings = useUpdateSettings();
  /** The model picked in this notice, until focus has followed it; null otherwise. */
  const picked = useRef<string | null>(null);

  const [shown, setShown] = useState<Blocker | null>(live);
  if (live !== null && live !== shown) setShown(live);
  const leaving = live === null && !settling && shown !== null;

  // Only after a pick made here (the list leaves focus to this), once that model is the setting:
  // never after a change elsewhere. A second model without a window lands here too.
  useEffect(() => {
    if (picked.current === null || settling) return;
    const mine = picked.current === model;
    picked.current = null;
    // Another model chosen meanwhile (Session) supersedes the pick: nothing to hand on.
    if (!mine) return;
    if (blocker === "window") focusModelNotice();
    else if (blocker === null) composer.current?.focus();
  }, [model, blocker, settling, composer]);

  const pick = (chosen: string) => {
    // The same model again changes nothing, so nothing would hand focus on.
    if (chosen === model) return;
    picked.current = chosen;
    updateSettings({ model: chosen });
  };
  const picker = (
    <ModelSelect
      label="Chat model"
      placeholder="Browse models"
      options={options}
      value={model}
      onChange={pick}
      // A pick hands focus on (the effect above); Escape or a click away returns it to the trigger.
      finalFocus={() => picked.current === null}
      className="max-w-none tablet:w-64"
    />
  );
  return { model, shown, leaving, picker, end: () => setShown(null) };
}

const MODEL_STEP = {
  title: "Choose a model to begin",
  body: (name: string | undefined) =>
    name === undefined
      ? "Replies come from the model you choose. You can change it any time in Session."
      : `${name} replies through the model you choose. You can change it any time in Session.`,
};

/**
 * Above the composer, the one way out when Send cannot work: without a
 * model, the picker itself, so choosing takes one step in place; with a
 * model whose context window is unknown (PRODUCT.md § Models), a way to set
 * one beside the picker. On a first run (an empty story, no character) the
 * model step is the empty story's (ModelStep), so this says only the
 * window then. Once nothing blocks it folds away.
 */
export function ModelNotice({ composer }: { composer: RefObject<HTMLTextAreaElement | null> }) {
  const { blocker, settling } = useModelBlocker();
  const empty = useChat(storyEmpty);
  const firstRun = useSetting((settings) => settings.characterId) === null && empty;
  const character = useChatCharacter();
  const { model, shown, leaving, picker, end } = useModelChoice(
    composer,
    blocker === "model" && firstRun ? null : blocker,
    settling,
  );
  if (shown === null) return null;

  return (
    <NoticeFold
      data-model-notice=""
      leaving={leaving}
      onLeft={end}
      className={`${SCRIPT_FRAME} shrink-0`}
    >
      <div className="pb-2">
        {shown === "model" ? (
          <NoticeCard
            placement="dock"
            swapKey="model"
            bodyId={MODEL_NOTICE_BODY}
            title={MODEL_STEP.title}
            body={MODEL_STEP.body(character?.name)}
            actions={
              <div data-notice-actions="" className={ACTIONS}>
                {picker}
              </div>
            }
          />
        ) : (
          <NoticeCard
            placement="dock"
            swapKey={`window:${model ?? ""}`}
            bodyId={MODEL_NOTICE_BODY}
            title="Context window unknown"
            body={`${model ?? "This model"} has no known context window, so the prompt can't be sized. Set one for it, or choose another model.`}
            actions={
              <div data-notice-actions="" className={ACTIONS}>
                <WindowLink
                  model={model}
                  className={buttonVariants({ variant: "outline", className: "px-2.5" })}
                >
                  Set a context window
                </WindowLink>
                {picker}
              </div>
            }
          />
        )}
      </div>
    </NoticeFold>
  );
}

/**
 * A first run's opening step while no model is chosen: the same title,
 * sentence and picker as the notice, set as the empty story's first step
 * rather than a card over the composer. It folds away once a model is
 * chosen, inside room the empty story keeps, so nothing after it moves.
 */
export function ModelStep({ composer }: { composer: RefObject<HTMLTextAreaElement | null> }) {
  const { blocker, settling } = useModelBlocker();
  const { shown, leaving, picker, end } = useModelChoice(
    composer,
    blocker === "model" ? "model" : null,
    settling,
  );
  if (shown === null) return null;
  return (
    <NoticeFold data-model-notice="" leaving={leaving} onLeft={end}>
      <div role="status" className="grid max-w-empty justify-items-start gap-3 pb-8">
        <div className="grid gap-1">
          <p className="font-medium text-ink text-lead">{MODEL_STEP.title}</p>
          <p id={MODEL_NOTICE_BODY} className="text-pretty text-note text-reed">
            {MODEL_STEP.body(undefined)}
          </p>
        </div>
        <div data-notice-actions="" className={ACTIONS}>
          {picker}
        </div>
      </div>
    </NoticeFold>
  );
}
