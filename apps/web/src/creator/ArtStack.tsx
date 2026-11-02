import { CREATOR_LIMITS, imagePromptModelOf } from "@ephemera/core";
import {
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type RefObject,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { GLIDE } from "@/app/glide.ts";
import { RegenerateIcon, StopIcon } from "@/components/icons";
import { ModelSelect } from "@/components/model-select";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { isComposing } from "@/lib/keys.ts";
import { COMFYUI_BUSY, MODEL_BUSY } from "@/lib/text";
import { useModelOptions } from "../api.ts";
import { LEAF_EDGE, PORTRAIT_TRANSITION } from "../portraits/Portrait.tsx";
import { PortraitViewer } from "../portraits/PortraitViewer.tsx";
import { useSetting } from "../settings/settings.ts";
import { REQUEST_FIELD } from "../sheet/fields.ts";
import { ArtCanvas } from "./ArtCanvas.tsx";
import { ART_TRANSITION, batchKey } from "./art.ts";
import {
  shownBefore,
  useArtBatch,
  useArtFrame,
  useArtSession,
  useArtSessionHost,
} from "./art-session.tsx";
import type { ArtRun } from "./art-slice.ts";
import { CardFrame, NameLeaf } from "./CardLayout.tsx";
import { CompositionChoice } from "./CompositionChoice.tsx";
import { stepOption } from "./choice.ts";
import { LookChoice } from "./LookChoice.tsx";
import { artProgress } from "./progress.ts";
import { ReasoningSelect, useEffortChoice } from "./ReasoningSelect.tsx";
import { WorkflowSelect } from "./WorkflowSelect.tsx";

/*
 * The art of one session, in regions its host lays out (art-session.tsx):
 * the chosen portrait in the 2:3 frame, the four as a selectable group, the
 * owner's direction for the next batch with New art and the workflow, the
 * image prompt's model and its effort, and the run's status. `ArtStack` is
 * the showcase's layout of them; without art, a compact typographic
 * presence. The reveal is the one orchestrated moment: the frame develops
 * from the glow (styles.css `develop-in`), the room leans toward the chosen
 * portrait's hue from 120 ms, and the alternates fade in together from
 * 300 ms (`alternates-in`). A batch revealed before arrives with a quick
 * fade instead. Focus never moves when the art arrives.
 */

/** Alternative text from the card. */
const portraitLabel = (name: string, index: number, count: number) =>
  `Portrait of ${name}, option ${index + 1} of ${count}`;

/** The technical reason behind "Portraits unavailable", on request. */
function artReason(art: ArtRun | null, unreadable: boolean): string {
  if (unreadable) return "The images arrived but could not be read.";
  if (art?.status === "failed") {
    switch (art.code) {
      case "upstream":
        return "The model could not write the image prompt.";
      case "upstream_busy":
        return MODEL_BUSY;
      case "timeout":
        return "The art ran past its deadline.";
      case "not_configured":
        return "No ComfyUI address is saved.";
      case "not_allowed":
        return "This server does not allow the saved ComfyUI address.";
      case "comfyui":
        return "ComfyUI failed or returned an unusable batch.";
      case "comfyui_busy":
        return COMFYUI_BUSY;
      case "stream":
        return "The connection broke off before all four images arrived.";
      case "not_found":
        return "This character was deleted.";
      case "reference":
        return "The stored portrait could not be prepared for the model.";
      case "empty":
        return "Add a description or opening before creating art.";
      case "no_model":
        return "Choose a model to write the image prompt.";
    }
  }
  if (art?.status === "skipped") {
    switch (art.reason) {
      case "missing":
        return "ComfyUI is missing nodes or models the chosen workflow needs; Settings lists them.";
      case "unavailable":
        return "ComfyUI could not be reached or is not ready.";
      default:
        return "The portrait status could not be checked.";
    }
  }
  return "";
}

/** A batch shown before arrives at once, with a quick fade. */
const QUICK_FADE = "transition-opacity duration-(--duration-quick) ease-fade starting:opacity-0";

/** The four as one group: arrow keys move the choice, and the choice morphs into the frame. */
function Alternates({
  bitmaps,
  name,
  selected,
  locked,
  revealed,
  onChoose,
  className,
}: {
  bitmaps: ImageBitmap[];
  name: string;
  selected: number;
  locked: boolean;
  revealed: boolean;
  onChoose: (index: number, option: HTMLElement) => void;
  className?: string | undefined;
}) {
  const group = useRef<HTMLDivElement>(null);
  const option = (index: number) =>
    group.current?.querySelector<HTMLElement>(`[data-option="${index}"]`) ?? null;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = stepOption(event.key, selected, bitmaps.length);
    if (next === undefined || locked) return;
    event.preventDefault();
    const target = option(next);
    if (target === null) return;
    onChoose(next, target);
    target.focus();
  };
  return (
    <div
      ref={group}
      role="radiogroup"
      aria-label="Portraits"
      aria-disabled={locked || undefined}
      onKeyDown={onKeyDown}
      className={cn(
        revealed ? QUICK_FADE : "alternates-in",
        "grid w-full grid-cols-4 gap-2",
        className,
      )}
    >
      {bitmaps.map((bitmap, index) => (
        // biome-ignore lint/a11y/useSemanticElements: the choice changes inside a view transition set up first, which a native radio's own checking would run ahead of.
        <button
          // biome-ignore lint/suspicious/noArrayIndexKey: a batch's four are fixed; a new batch remounts the group.
          key={index}
          type="button"
          role="radio"
          data-option={index}
          aria-checked={index === selected}
          aria-label={portraitLabel(name, index, bitmaps.length)}
          tabIndex={index === selected ? 0 : -1}
          disabled={locked}
          onClick={(event) => onChoose(index, event.currentTarget)}
          className={cn(
            "press relative aspect-[2/3] overflow-hidden rounded-xs transition-[box-shadow,filter] duration-(--duration-quick) ease-fade hover:brightness-[1.04] disabled:cursor-default",
            LEAF_EDGE,
            GLIDE,
            index === selected && "shadow-[0_0_0_2px_var(--canvas),0_0_0_4px_var(--dusk)]",
          )}
        >
          <ArtCanvas bitmap={bitmap} />
        </button>
      ))}
    </div>
  );
}

/**
 * New art: another batch from ComfyUI, the current one and its choice kept
 * until it is whole. Quiet beside the direction; primary as the studio's
 * footer action. `disabled`: the host withholds it beyond the session's own
 * idle (no model, say).
 */
export function NewArt({
  variant = "quiet",
  disabled = false,
  className,
  ref,
}: {
  variant?: "quiet" | "primary";
  disabled?: boolean;
  className?: string | undefined;
  ref?: Ref<HTMLButtonElement> | undefined;
}) {
  const requestArt = useArtSession((state) => state.requestArt);
  const { idle } = useArtBatch();
  return (
    <Button
      ref={ref}
      variant={variant}
      disabled={disabled || !idle}
      // Focus stays on it while the new batch develops.
      focusableWhenDisabled
      className={cn(
        variant === "quiet" && "h-8 w-fit shrink-0 px-2 text-note touch:h-11",
        className,
      )}
      onClick={requestArt}
    >
      <RegenerateIcon size={16} />
      New art
    </Button>
  );
}

/**
 * The direction's face: one control-high line at rest, about four as it
 * grows, then it scrolls. A long unbroken run wraps rather than widening the
 * column, which `field-sizing` would otherwise follow.
 */
const DIRECTION_FIELD =
  "min-h-8 max-h-[5.375rem] min-w-0 flex-1 rounded-md px-3 wrap-anywhere py-1.5 text-note leading-[1.125rem] touch:min-h-11 touch:py-3 disabled:opacity-60";

/**
 * The owner's direction for the next batch, a short steer the image prompt
 * follows before the card's notes and inside its fixed form, with the action
 * that paints it (`children`) on the same line, so it costs the column no
 * height. A creation draft, held in the session's memory and dropped with it.
 * Enter paints with it when `paint` is given (the action could be pressed);
 * Shift+Enter breaks the line. What is left shows near the limit. `labelled`:
 * a visible "Direction" label, as a row of the choices' label column
 * (`CHOICE_ROW`), so it goes inside their group.
 */
function ArtDirection({
  paint,
  disabled = false,
  labelled = false,
  className,
  children,
}: {
  paint: (() => void) | null;
  disabled?: boolean;
  labelled?: boolean;
  className?: string | undefined;
  children?: ReactNode;
}) {
  const portraits = useSetting((settings) => settings.comfyuiBaseUrl) !== "";
  const direction = useArtSession((state) => state.artDirection);
  const setArtDirection = useArtSession((state) => state.setArtDirection);
  const hintId = useId();
  const fieldId = useId();
  if (!portraits) return null;
  const left = CREATOR_LIMITS.artDirectionLength - direction.length;
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const composing = isComposing(event);
    if (event.key !== "Enter" || event.shiftKey || composing) return;
    event.preventDefault();
    paint?.();
  };
  const field = (
    <>
      <div className="flex items-end gap-2">
        <textarea
          id={fieldId}
          data-lamp-field=""
          value={direction}
          onChange={(event) => setArtDirection(event.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          disabled={disabled}
          placeholder="Steer the next art"
          maxLength={CREATOR_LIMITS.artDirectionLength}
          autoComplete="off"
          translate="no"
          aria-label="Direction for the next art"
          aria-describedby={hintId}
          className={cn(REQUEST_FIELD, DIRECTION_FIELD)}
        />
        {children}
      </div>
      <p id={hintId} className="sr-only">
        A place, light, outfit or mood, followed before the card. Enter paints new art; Shift and
        Enter start a new line.
      </p>
      {left <= CREATOR_LIMITS.artDirectionLength / 5 && (
        <p className="text-meta text-reed tabular-nums transition-opacity duration-(--duration-arrive) ease-fade starting:opacity-0">
          {left} characters left
        </p>
      )}
    </>
  );
  if (!labelled) return <div className={cn("grid w-full gap-1", className)}>{field}</div>;
  return (
    <div className={cn(CHOICE_ROW, "@3xs:items-start", className)}>
      <label htmlFor={fieldId} className={cn(CHOICE_LABEL, "@3xs:pt-1.5 touch:@3xs:pt-3")}>
        Direction
      </label>
      <div className="grid min-w-0 gap-1">{field}</div>
    </div>
  );
}

/** A compact trigger in the art column, filling its cell. */
const CHOICE = "h-8 text-note tablet:w-full touch:h-11";

/**
 * One labelled row of the choices. Narrow columns (the tablet's) stack the
 * label over its control; wider ones set the labels beside them, the rows
 * sharing one label column. A host's own rows (`before`) take the same.
 */
export const CHOICE_ROW = "grid gap-y-1 @3xs:col-span-2 @3xs:grid-cols-subgrid @3xs:items-center";
export const CHOICE_LABEL = "text-note text-reed";

/**
 * The model that writes the next image prompt and how hard it reasons:
 * Settings' image prompt model, else the host's (the card's, the saved
 * model), until another is chosen, which then stays for this session. The effort narrows to what the model offers, as
 * before a card.
 */
function usePromptChoice() {
  const { defaults } = useArtSessionHost();
  const artModel = useArtSession((state) => state.artModel);
  const artReasoning = useArtSession((state) => state.artReasoning);
  const setting = useSetting((settings) => settings.imagePromptModel);
  const model = imagePromptModelOf(artModel, setting, defaults.model);
  const options = useModelOptions(model);
  const { efforts, effort } = useEffortChoice(model, artReasoning ?? defaults.reasoning);
  return { model, options, efforts, effort };
}

/**
 * Under New art, as one group: the workflow the next batch is painted with,
 * the model that writes its image prompt and that model's effort, so the art
 * changes without writing the card again. A batch already painting keeps
 * what it started with; one waiting for sign-in takes the choices shown when
 * it resumes. `before` and `after`: the host's own rows, first and last in
 * the group; `narrow`: capped to the showcase's column; `disabled`: the host
 * holds the pickers (the studio while a run paints); `className`: how the
 * group arrives. Without any model to choose, it says so under the picker.
 */
function ArtChoices({
  before,
  after,
  narrow,
  disabled = false,
  className,
}: {
  before?: ReactNode;
  after?: ReactNode;
  narrow: boolean;
  disabled?: boolean;
  className?: string | undefined;
}) {
  const portraits = useSetting((settings) => settings.comfyuiBaseUrl) !== "";
  const setArtModel = useArtSession((state) => state.setArtModel);
  const setArtReasoning = useArtSession((state) => state.setArtReasoning);
  const composition = useArtSession((state) => state.artComposition);
  const setComposition = useArtSession((state) => state.setArtComposition);
  const look = useArtSession((state) => state.artLook);
  const setLook = useArtSession((state) => state.setArtLook);
  const { kind, locked } = useArtSessionHost();
  const { model, options, efforts, effort } = usePromptChoice();
  const workflowLabel = useId();
  const modelLabel = useId();
  const reasoningLabel = useId();
  if (!portraits) return null;
  const row = CHOICE_ROW;
  const label = CHOICE_LABEL;
  // The studio's column is wider than the showcase's: its pickers fill it.
  const choice = cn(CHOICE, !narrow && "max-w-none");
  return (
    <div className={cn("@container w-full", narrow && "max-w-72", className)}>
      <fieldset
        aria-label="Next art"
        className="grid min-w-0 gap-y-2.5 @3xs:grid-cols-[auto_minmax(0,1fr)] @3xs:gap-x-4 @3xs:gap-y-2"
      >
        {before}
        {kind === "subject" && (
          <div className={row}>
            <CompositionChoice
              value={composition}
              onChange={setComposition}
              disabled={disabled || locked}
              labelClassName={label}
            />
          </div>
        )}
        {kind !== "scenario" && (
          <div className={row}>
            <LookChoice
              value={look}
              onChange={setLook}
              disabled={disabled || locked}
              labelClassName={label}
              className={choice}
            />
          </div>
        )}
        <div className={row}>
          <span id={workflowLabel} className={label}>
            Workflow
          </span>
          <WorkflowSelect labelId={workflowLabel} disabled={disabled} className={choice} />
        </div>
        <div className={row}>
          <span id={modelLabel} className={label}>
            Prompt model
          </span>
          <ModelSelect
            labelId={modelLabel}
            options={options}
            value={model}
            onChange={setArtModel}
            disabled={disabled}
            className={choice}
          />
          {model === null && (
            <p className="text-pretty text-note text-reed @3xs:col-start-2">
              Choose a model to write the image prompt.
            </p>
          )}
        </div>
        <div className={row}>
          <span id={reasoningLabel} className={label}>
            Reasoning
          </span>
          <ReasoningSelect
            labelId={reasoningLabel}
            efforts={efforts}
            effort={effort}
            onChange={setArtReasoning}
            disabled={disabled}
            className={choice}
          />
        </div>
        {after}
      </fieldset>
    </div>
  );
}

/** Whether `after` ms passed since the run was last `heard` from; false again with each new word. */
function useQuiet(heard: number | undefined, after: number | undefined): boolean {
  const [quiet, setQuiet] = useState<number>();
  useEffect(() => {
    if (heard === undefined || after === undefined) return;
    const timer = setTimeout(() => setQuiet(heard), heard + after - performance.now());
    return () => clearTimeout(timer);
  }, [heard, after]);
  return heard !== undefined && quiet === heard;
}

/**
 * Stop, shown while the run is in flight. When it leaves holding focus,
 * pressed or because the run ended, focus moves to the host's `focusAfter`
 * rather than to the page. Its layout cleanup runs before the button leaves
 * the document, and the focus moves once the new state is in place.
 */
function StopArt() {
  const stopArt = useArtSession((state) => state.stopArt);
  const { focusAfter } = useArtSessionHost();
  const button = useRef<HTMLButtonElement>(null);
  const handOff = useEffectEvent(() => focusAfter()?.focus());
  // On unmount only: a re-render while the run goes on leaves focus on Stop.
  useLayoutEffect(() => {
    const node = button.current;
    return () => {
      if (node !== null && document.activeElement === node) queueMicrotask(handOff);
    };
  }, []);
  return (
    <Button ref={button} variant="outline" className="w-full" onClick={stopArt}>
      <StopIcon size={16} />
      Stop
    </Button>
  );
}

/**
 * While portraits are on their way: the stage, its count, a word after a
 * silence, and Stop. The stage and the word are each said politely once,
 * from live regions in place before their words arrive; the count is there
 * to read, never announced. `captioned`: the frame's caption shows the
 * stage, so here it is only said.
 */
function ArtProgressNote({ art, captioned }: { art: ArtRun | null; captioned: boolean }) {
  const progress = artProgress(art);
  const quiet = useQuiet(art?.status === "running" ? art.heard : undefined, progress?.quiet?.after);
  return (
    <>
      {/* In place while nothing is on its way too, so the first stage is said. */}
      <p role="status" className="sr-only">
        {progress?.label}
      </p>
      {progress !== null && (
        <div className="grid w-full justify-items-start gap-3 text-note">
          <div className={cn("grid content-start gap-0.5", !captioned && "min-h-[2lh]")}>
            {!captioned && (
              <p aria-hidden="true" className="text-pretty text-ink">
                <span
                  key={progress.label}
                  className="transition-opacity duration-(--duration-arrive) ease-fade starting:opacity-0"
                >
                  {progress.label}
                </span>
              </p>
            )}
            {/* Eases in with each stage; a count or a place in line then changes in place. */}
            {progress.detail !== undefined && (
              <p
                key={progress.label}
                className="text-reed tabular-nums transition-opacity duration-(--duration-arrive) ease-fade starting:opacity-0"
              >
                {progress.detail}
              </p>
            )}
            <p role="status" className="text-pretty text-reed">
              {quiet && progress.quiet && (
                <span className="block pt-1 transition-opacity duration-(--duration-arrive) ease-fade starting:opacity-0">
                  {progress.quiet.text} You can keep waiting or stop.
                </span>
              )}
            </p>
          </div>
          {(art?.status === "running" || art?.status === "waiting") && <StopArt />}
        </div>
      )}
    </>
  );
}

/**
 * Under New art after it failed: the batch on show stays, and why it failed
 * is said at once. `retry`: "Try again" here, where no other New art waits.
 */
function NewArtFailure({ art, retry }: { art: ArtRun | null; retry: boolean }) {
  const requestArt = useArtSession((state) => state.requestArt);
  if (art?.status !== "failed" && art?.status !== "skipped") return null;
  return (
    <div role="status" className="grid justify-items-start gap-1 text-note">
      <p className="text-ember">New art failed. The current portraits are kept.</p>
      <Reason text={artReason(art, false)} />
      {retry && (
        <Button size="text" className="-ml-2" onClick={requestArt}>
          Try again
        </Button>
      )}
    </div>
  );
}

/** Why the art failed, in a sentence of its own. */
function Reason({ text }: { text: string }) {
  if (text === "") return null;
  return <p className="text-pretty text-reed">{text}</p>;
}

/** The art's 2:3 frame: about 38dvh tall on phones, the column's width elsewhere. */
const FRAME = { phone: "h-[38dvh] aspect-[2/3]", column: "w-full" } as const;

/**
 * What the session shows: a batch, or without one a run developing (or not
 * yet asked for), portraits off, a stopped run, or an unavailable one.
 */
type ArtShowing = "batch" | "developing" | "off" | "stopped" | "unavailable";

export function useArtShowing(): ArtShowing {
  const art = useArtSession((state) => state.art);
  const shown = useArtSession((state) => state.images.length > 0);
  const batch = useArtBatch();
  const unreadable = batch.status === "failed";
  if (shown && !unreadable) return "batch";
  if (art?.status === "skipped" && art.reason === "off") return "off";
  if (art?.status === "stopped") return "stopped";
  // A new run after an unreadable batch develops like any other.
  const inFlight = art?.status === "running" || art?.status === "waiting";
  const unavailable =
    !inFlight && (unreadable || art?.status === "failed" || art?.status === "skipped");
  return unavailable ? "unavailable" : "developing";
}

/**
 * The 2:3 frame for the art named `name`: the chosen portrait, opening
 * larger on a click or tap; without a batch, the name on its leaf with the
 * stage while portraits are on their way, `caption` otherwise. `phone`: about
 * 38dvh tall; elsewhere the column's width.
 */
export function ArtFrame({
  name,
  phone,
  caption,
  className,
}: {
  name: string;
  phone: boolean;
  caption?: string | undefined;
  className?: string | undefined;
}) {
  const art = useArtSession((state) => state.art);
  const images = useArtSession((state) => state.images);
  const selected = useArtSession((state) => state.selected);
  const { leaving } = useArtSessionHost();
  const batch = useArtBatch();
  const frameRef = useArtFrame();
  const showing = useArtShowing();
  const progress = artProgress(art);
  // A first batch can complete while the card's light is still closing, before this frame
  // mounts: the frame then starts busy and settles at once, so its light still closes on it.
  const [owed, setOwed] = useState(
    () => art?.status === "complete" && images.length > 0 && !shownBefore(images),
  );
  useEffect(() => {
    if (owed) setOwed(false);
  }, [owed]);
  const busy = art?.status === "running" || owed;
  const settled = art?.status === "complete";

  if (showing !== "batch") {
    return (
      <div className={cn("@container", phone ? FRAME.phone : FRAME.column, className)}>
        <CardFrame progress={progress?.line} busy={busy} settled={settled}>
          <NameLeaf name={name} caption={progress?.label ?? caption} />
        </CardFrame>
      </div>
    );
  }

  const bitmap = batch.status === "ready" ? batch.bitmaps[selected] : undefined;
  const label = portraitLabel(name, selected, images.length);
  return (
    <div className={cn(phone ? FRAME.phone : FRAME.column, className)}>
      <CardFrame progress={progress?.line} busy={busy} settled={settled}>
        {/* Mounted through a new batch's decoding, so an open viewer takes the new art. */}
        <PortraitViewer
          label={label}
          art={bitmap !== undefined && <ArtCanvas bitmap={bitmap} label={label} />}
          disabled={bitmap === undefined}
          // Focus drawn inside: the frame clips everything outside it.
          className="absolute inset-0 rounded-[inherit] focus-ring-inset"
        >
          <div
            ref={frameRef}
            style={leaving ? { viewTransitionName: PORTRAIT_TRANSITION } : undefined}
            className={cn("absolute inset-0 rounded-[inherit]", LEAF_EDGE, GLIDE)}
          >
            {bitmap !== undefined && (
              <ArtCanvas
                key={batchKey(images)}
                bitmap={bitmap}
                label={label}
                className={batch.revealed ? QUICK_FADE : "develop-in"}
              />
            )}
          </div>
        </PortraitViewer>
      </CardFrame>
    </div>
  );
}

/** The four of the batch on show for the art named `name`, as one Portraits radiogroup. */
export function ArtAlternates({
  name,
  className,
}: {
  name: string;
  className?: string | undefined;
}) {
  const images = useArtSession((state) => state.images);
  const selected = useArtSession((state) => state.selected);
  const select = useArtSession((state) => state.select);
  const { locked } = useArtSessionHost();
  const batch = useArtBatch();
  const frameRef = useArtFrame();
  if (batch.status !== "ready") return null;

  // The chosen alternate morphs into the frame: it carries the name into the
  // transition, the frame takes it in the new state. A new choice skips a
  // running morph to its end and starts from there. Not React's
  // <ViewTransition share>: both images stay mounted, and the choice lives
  // in the art session's external store, whose updates are never a
  // transition React animates.
  const choose = (index: number, option: HTMLElement) => {
    const main = frameRef.current;
    if (index === selected) return;
    if (main === null) {
      select(index);
      return;
    }
    main.style.viewTransitionName = "";
    option.style.viewTransitionName = ART_TRANSITION;
    const transition = document.startViewTransition(() => {
      option.style.viewTransitionName = "";
      main.style.viewTransitionName = ART_TRANSITION;
      flushSync(() => select(index));
    });
    void transition.finished.finally(() => {
      main.style.viewTransitionName = "";
    });
  };

  return (
    <Alternates
      key={batchKey(images)}
      bitmaps={batch.bitmaps}
      name={name}
      selected={selected}
      locked={locked}
      revealed={batch.revealed}
      onChoose={choose}
      className={className}
    />
  );
}

/**
 * The owner's choices for the next batch: the direction, with New art at its
 * end when `newArt` is "inline", then the `Next art` group with the host's
 * rows (`before`) first. `width`: "narrow" caps the group, and a direction
 * without New art beside it, to the showcase's column. `directionLabel`
 * "visible" (the studio) labels the direction and sets it as the group's last
 * row. `disabled`: the pickers held by the host. `className`: how the
 * direction and the group arrive.
 */
export function ArtControls({
  before,
  newArt,
  newArtRef,
  directionLabel,
  width,
  disabled = false,
  className,
}: {
  before?: ReactNode;
  newArt: "inline" | "none";
  newArtRef?: Ref<HTMLButtonElement> | undefined;
  directionLabel: "visible" | "hidden";
  width: "narrow" | "full";
  disabled?: boolean;
  className?: string | undefined;
}) {
  const requestArt = useArtSession((state) => state.requestArt);
  const { locked } = useArtSessionHost();
  const { idle } = useArtBatch();
  const portraits = useSetting((settings) => settings.comfyuiBaseUrl) !== "";
  const narrow = width === "narrow";
  const labelled = directionLabel === "visible";
  const direction = (
    <ArtDirection
      paint={idle ? requestArt : null}
      disabled={locked}
      labelled={labelled}
      className={cn(narrow && newArt === "none" && "max-w-72", !labelled && className)}
    >
      {newArt === "inline" && <NewArt ref={newArtRef} />}
    </ArtDirection>
  );
  return (
    <>
      {!labelled && direction}
      {newArt === "inline" && !portraits && <NewArt ref={newArtRef} />}
      <ArtChoices
        before={before}
        after={labelled && direction}
        narrow={narrow}
        disabled={disabled}
        className={className}
      />
    </>
  );
}

/**
 * The run's status: while portraits are on their way, the stage and Stop;
 * beside a batch, why New art failed; without one, portraits off, the
 * stopped and the unavailable lines with "Try the art again" (`again`).
 * `retry: false` leaves out "Try the art again" and "Try again" where the
 * host's own New art is the one retry (the studio's footer).
 * `children`: the host's own notice at its end (the studio's sign-in).
 */
export function ArtStatus({
  again,
  retry = true,
  children,
}: {
  again?: Ref<HTMLButtonElement> | undefined;
  retry?: boolean;
  children?: ReactNode;
}) {
  const art = useArtSession((state) => state.art);
  const requestArt = useArtSession((state) => state.requestArt);
  const { copy } = useArtSessionHost();
  const batch = useArtBatch();
  const showing = useArtShowing();

  if (showing === "batch" || showing === "developing") {
    return (
      <>
        <ArtProgressNote art={art} captioned={showing === "developing"} />
        <NewArtFailure art={art} retry={retry} />
        {children}
      </>
    );
  }
  if (showing === "off") {
    return (
      <>
        <div className="grid gap-1 text-note">
          <p className="font-medium text-ink">Portraits off</p>
          <p className="text-pretty text-reed">{copy.off}</p>
        </div>
        {children}
      </>
    );
  }
  return (
    <>
      <div role="status" className="grid justify-items-start gap-2 text-note">
        {showing === "stopped" ? (
          <p className="text-pretty text-ink">{copy.stopped}</p>
        ) : (
          <>
            <p className="text-pretty text-ember">{copy.unavailable}</p>
            <Reason text={artReason(art, batch.status === "failed")} />
          </>
        )}
        {retry && (
          <Button ref={again} variant="outline" onClick={requestArt}>
            <RegenerateIcon size={16} />
            Try the art again
          </Button>
        )}
      </div>
      {children}
    </>
  );
}

/**
 * The showcase's art for the card named `name`, from the session its
 * `ArtSessionProvider` holds. `phone`: the art at about 38dvh beside the
 * alternates; elsewhere the stack in the art column, sized so all of it fits
 * between the header and the action bar. `newArt` and `again`: the buttons
 * Stop hands focus to, for the host's `focusAfter`.
 */
export function ArtStack({
  name,
  phone,
  newArt,
  again,
}: {
  name: string;
  phone: boolean;
  newArt: RefObject<HTMLButtonElement | null>;
  again: RefObject<HTMLButtonElement | null>;
}) {
  const showing = useArtShowing();

  // Still developing: the frame, its glow, its line and under it the progress note.
  if (showing === "developing") {
    return (
      <div className="grid gap-4">
        <ArtFrame name={name} phone={phone} caption="Developing the art" />
        <ArtStatus />
      </div>
    );
  }

  // No batch on show: portraits off, stopped, or unavailable with "Try the art again".
  if (showing !== "batch") {
    return (
      <div
        className={cn(
          "grid content-start justify-items-start gap-3",
          phone && "grid-cols-[6rem_minmax(0,1fr)] items-end gap-4",
        )}
      >
        <div
          className={cn(
            "@container relative grid aspect-[2/3] w-24 overflow-hidden rounded-lg bg-surface",
            !phone && "@card:w-40",
          )}
        >
          <NameLeaf name={name} />
        </div>
        {showing === "off" ? (
          <ArtStatus />
        ) : (
          <div className="grid justify-items-start gap-3">
            <ArtStatus again={again} />
            {/* Outside the status region, so a choice does not say the failure again. */}
            <ArtControls newArt="none" directionLabel="hidden" width="narrow" />
          </div>
        )}
      </div>
    );
  }

  const main = <ArtFrame name={name} phone={phone} />;
  const group = <ArtAlternates name={name} className={phone ? "grid-cols-2" : undefined} />;
  const controls = (
    <div className="grid w-full justify-items-start gap-2">
      {/* Under the four, New art at the direction's end; it arrives with them. */}
      <ArtControls
        newArt="inline"
        newArtRef={newArt}
        directionLabel="hidden"
        width="narrow"
        className="alternates-in"
      />
      <ArtStatus />
    </div>
  );

  // Phones: the alternates beside the art, New art and its progress across
  // the width under both, where the narrow column would crowd them. The art
  // stays the first child, as while it developed, so its frame (and the
  // rim closing on the first batch) is the same one.
  if (phone) {
    return (
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-end gap-4">
        {main}
        {group}
        <div className="col-span-full">{controls}</div>
      </div>
    );
  }
  return (
    <div className="grid w-full content-start gap-3 @card:max-w-[calc((100dvh-15rem-env(safe-area-inset-top))/1.875)]">
      {main}
      <div className="grid content-end justify-items-start gap-2">
        {group}
        {controls}
      </div>
    </div>
  );
}
