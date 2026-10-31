import { type RefObject, useEffect, useRef, useState } from "react";
import { NoticeCard, noticeFold } from "@/app/NoticeCard.tsx";
import { buttonVariants } from "@/components/ui/button";
import { useContextWindow, useModelOptions } from "../api.ts";
import { ModelSelect } from "../components/model-select.tsx";
import { useSettings, useUpdateSettings } from "../settings/settings.ts";
import { WindowLink } from "../settings/window-link.tsx";
import { useSignInPhase } from "../signin/hooks.ts";
import { useChatCharacter } from "./character.ts";
import { SCRIPT_FRAME } from "./frame.ts";

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

/** Focuses the notice's first control (Enter in an empty-handed composer); false without one. */
export function focusModelNotice(): boolean {
  const control = document.querySelector<HTMLElement>(
    "[data-model-notice] [data-notice-actions] :is(a, button)",
  );
  control?.focus();
  return control != null;
}

/**
 * Above the composer, the one way out when Send cannot work: without a
 * model, the picker itself, so choosing takes one step in place; with a
 * model whose context window is unknown (PRODUCT.md § Models), a way to set
 * one beside the picker. Once nothing blocks it folds away, and a choice
 * made here hands focus to the message field.
 */
export function ModelNotice({ composer }: { composer: RefObject<HTMLTextAreaElement | null> }) {
  const { blocker, settling } = useModelBlocker();
  const settings = useSettings();
  const { model } = settings;
  const character = useChatCharacter();
  const options = useModelOptions(model);
  const updateSettings = useUpdateSettings();
  /** The model picked in this notice, until focus has followed it; null otherwise. */
  const picked = useRef<string | null>(null);

  // What the card says: the live blocker, held while a just-chosen model's window loads and while
  // it folds away, so the words do not change as it leaves.
  const [shown, setShown] = useState<Blocker | null>(blocker);
  if (blocker !== null && blocker !== shown) setShown(blocker);
  const leaving = blocker === null && !settling && shown !== null;

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

  if (shown === null) return null;

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

  return (
    <div
      data-model-notice=""
      inert={leaving}
      onTransitionEnd={(event) => {
        if (leaving && event.target === event.currentTarget && event.propertyName === "height")
          setShown(null);
      }}
      className={`${SCRIPT_FRAME} shrink-0 ${noticeFold(leaving)}`}
    >
      <div className="pb-2">
        {shown === "model" ? (
          <NoticeCard
            placement="dock"
            swapKey="model"
            bodyId={MODEL_NOTICE_BODY}
            title="Choose a model to begin"
            body={
              character === undefined
                ? "Replies come from the model you choose. You can change it any time in Session."
                : `${character.name} replies through the model you choose. You can change it any time in Session.`
            }
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
    </div>
  );
}
