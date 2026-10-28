import { REWORK_LIMITS, type ReworkCard, type ReworkErrorCode } from "@ephemera/core";
import { type FormEvent, type KeyboardEvent, type ReactNode, type RefObject, useId } from "react";
import { ModelSelect } from "@/components/model-select";
import { Button } from "@/components/ui/button";
import { SwitchField } from "@/components/ui/switch";
import { cn } from "@/lib/cn";
import { isComposing } from "@/lib/keys.ts";
import { oneOf } from "@/lib/one-of.ts";
import { useModelInfo } from "../api.ts";
import { useChatPersona } from "../chat/character.ts";
import { useModelChoice } from "../creator/Describe.tsx";
import { ReasoningSelect, useEffortChoice } from "../creator/ReasoningSelect.tsx";
import { REQUEST_FIELD } from "../creator/request-field.ts";
import { PersonaSelect } from "../personas/PersonaSelect.tsx";
import { Leaf } from "../portraits/Portrait.tsx";
import { WindowLink } from "../settings/window-link.tsx";
import { portraitDefault } from "./portrait-switch.ts";
import { reworkStore, useRework } from "./session.ts";
import type { Refused } from "./store.ts";

const REFUSALS = [
  "too_large",
  "payload_too_large",
  "context_window_unknown",
  "not_found",
] as const satisfies readonly (ReworkErrorCode | Refused)[];

/** Why the server refused a run before the model wrote: said in the composer, which reopens. */
export type Refusal = (typeof REFUSALS)[number];

/** A failure the composer explains rather than the dock: the run never reached the model. */
export const isRefusal = oneOf(REFUSALS);

export interface ComposerNotice {
  code: Refusal;
  /** The model the refused run was sent to. */
  model: string;
}

/** What a refusal says, under the model select; Settings is a link where it is the fix. */
function NoticeText({ notice }: { notice: ComposerNotice }) {
  switch (notice.code) {
    case "too_large":
      return (
        <>
          This card and its lorebook are too long for {notice.model}. Pick a model with a larger
          context.
        </>
      );
    case "payload_too_large":
      return <>This card and its lorebook are too large to send for a rework.</>;
    case "context_window_unknown":
      return (
        <>
          {notice.model} reports no context window. Set one in{" "}
          <WindowLink model={notice.model}>Settings</WindowLink>.
        </>
      );
    case "not_found":
      return <>This character was deleted.</>;
  }
}

/**
 * The rework's composer: the owner's request in Describe's voice, the model,
 * its reasoning effort, the persona {{user}} is, and whether the model sees the portrait. Rework
 * sends the sheet's fields as they stand (`card`) and hands the run to the
 * dock. The same form fills the popover on tablet and desktop and the drawer
 * on phones; `phone` sets the heading's size and the full-width button.
 */
export function Composer({
  characterId,
  portrait,
  portraitChanging,
  card,
  notice,
  phone,
  field,
  onSubmitted,
  onModelChange,
  close,
}: {
  characterId: string;
  /** The stored portrait's version; null when the character has none. */
  portrait: number | null;
  /**
   * The portrait is being uploaded, removed or replaced by New art: Rework
   * waits, so the run never reads a portrait about to change.
   */
  portraitChanging: boolean;
  /** The sheet's fields at submit time. */
  card: () => ReworkCard;
  notice: ComposerNotice | null;
  phone: boolean;
  /** The request field, which the popover and drawer focus on opening. */
  field: RefObject<HTMLTextAreaElement | null>;
  /** After Rework started a run, with the model it went to. */
  onSubmitted: (model: string) => void;
  /** The owner picked another model: a refusal about the last one no longer applies. */
  onModelChange: () => void;
  /** The drawer's close button, beside the heading. */
  close?: ReactNode;
}) {
  const request = useRework((state) => state.request);
  const chosen = useRework((state) => state.model);
  const portraitChoice = useRework((state) => state.portrait);
  const { options, model, unavailable } = useModelChoice(chosen);
  const { efforts, effort } = useEffortChoice(
    model,
    useRework((state) => state.reasoning),
  );
  const info = useModelInfo(model);
  const personaId = useChatPersona()?.id ?? null;
  const fieldId = useId();
  const modelLabel = useId();
  const reasoningLabel = useId();
  const personaLabel = useId();
  const noticeId = useId();
  const sw = portraitDefault(info, portrait !== null);
  const includePortrait = sw.enabled && (portraitChoice ?? sw.on);
  const ready = request.trim() !== "" && model !== null && !portraitChanging;
  const described = [
    notice && noticeId,
    unavailable && `${noticeId}-unavailable`,
    portraitChanging && `${noticeId}-portrait`,
  ]
    .filter(Boolean)
    .join(" ");

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!ready) return;
    const started = reworkStore.getState().start({
      characterId,
      model,
      reasoning: effort,
      personaId,
      portrait: includePortrait,
      card: card(),
    });
    // The composer stays open, with the request, unless a run began.
    if (started) onSubmitted(model);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const composing = isComposing(event);
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !composing) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
      <div
        className={cn(
          "grid min-h-0 flex-1 gap-4 overflow-y-auto overscroll-contain",
          phone ? "px-5 pt-0 pb-4" : "px-4 pt-4 pb-3",
        )}
      >
        <div className="flex items-center justify-between gap-2">
          <label
            htmlFor={fieldId}
            className={cn("font-semibold text-ink", phone ? "text-heading" : "text-lead")}
          >
            What should change?
          </label>
          {close}
        </div>
        <textarea
          ref={field}
          id={fieldId}
          data-lamp-field=""
          value={request}
          rows={4}
          onChange={(event) => reworkStore.getState().setRequest(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Make her a decade older and fix anything that no longer fits."
          maxLength={REWORK_LIMITS.requestLength}
          autoComplete="off"
          translate="no"
          aria-describedby={described || undefined}
          className={cn(REQUEST_FIELD, "max-h-[40dvh] min-h-[calc(4*1.75rem+1.5rem)]")}
        />
        <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2.5">
          <span id={modelLabel} className="font-medium text-ink text-ui">
            Model
          </span>
          <ModelSelect
            labelId={modelLabel}
            options={options}
            value={model}
            onChange={(chosen) => {
              reworkStore.getState().setModel(chosen);
              onModelChange();
            }}
          />
          <span id={reasoningLabel} className="font-medium text-ink text-ui">
            Reasoning
          </span>
          <ReasoningSelect
            labelId={reasoningLabel}
            efforts={efforts}
            effort={effort}
            onChange={(reasoning) => reworkStore.getState().setReasoning(reasoning)}
          />
          <span id={personaLabel} className="font-medium text-ink text-ui">
            Persona
          </span>
          <PersonaSelect labelId={personaLabel} size="row" />
        </div>
        {notice !== null && (
          <p id={noticeId} className="text-pretty text-ember text-note">
            <NoticeText notice={notice} />
          </p>
        )}
        {unavailable !== null && (
          <p id={`${noticeId}-unavailable`} className="text-pretty text-ember text-note">
            {unavailable}
          </p>
        )}
        {portraitChanging && (
          <p id={`${noticeId}-portrait`} className="text-pretty text-note text-reed">
            Rework waits until the portrait change is saved.
          </p>
        )}
        {sw.shown && portrait !== null && (
          <div className="flex items-start justify-between gap-4">
            <SwitchField
              label="Include portrait"
              description={sw.description}
              checked={includePortrait}
              disabled={!sw.enabled}
              onCheckedChange={(checked) => reworkStore.getState().setPortrait(checked)}
            />
            <Leaf id={characterId} version={portrait} className="w-9" />
          </div>
        )}
      </div>
      <div
        className={cn(
          "flex shrink-0 justify-end",
          phone ? "px-5 pt-2 pb-[calc(1rem+env(safe-area-inset-bottom))]" : "px-4 pt-1 pb-4",
        )}
      >
        <Button type="submit" variant="primary" disabled={!ready} className={cn(phone && "w-full")}>
          Rework
        </Button>
      </div>
    </form>
  );
}
