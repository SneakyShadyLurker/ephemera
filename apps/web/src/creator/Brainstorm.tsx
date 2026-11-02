import {
  type BrainstormOption,
  CREATOR_LIMITS,
  type CreatorKind,
  creatorKindSchema,
  pitchKey,
} from "@ephemera/core";
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { isCoarsePointer, useFormFactor } from "@/app/form-factor.ts";
import { motionMs } from "@/app/motion-tokens.ts";
import { scrollBehavior } from "@/app/reduced-motion.ts";
import { CheckIcon, IdeasIcon } from "@/components/icons";
import { ModelSelect } from "@/components/model-select";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/cn";
import { isComposing } from "@/lib/keys.ts";
import { REQUEST_FIELD } from "../sheet/fields.ts";
import { ideasAlert, ideasStatus, RETRY_NOTE } from "./brainstorm-notes.ts";
import { FrameEdge } from "./CardLayout.tsx";
import { COLUMN, KINDS, leaveBrainstorm } from "./Choose.tsx";
import { useModelChoice } from "./Describe.tsx";
import { ReasoningSelect, useEffortChoice } from "./ReasoningSelect.tsx";
import { useCreator } from "./session.ts";
import { inTransition, kindTransition } from "./transition.ts";

const KIND_LABEL = "Kind of ideas";
const KIND_HINT = "Changing the kind brings ten new ideas.";

/** One row of the list: a place still to come, the previous list's idea dimmed, or an idea of this list. */
export interface IdeaRow {
  key: string;
  /** The idea's number, which feedback refers to. */
  n: number;
  /** `kept` stands where the same idea stood before, `new` arrives (replacing `gone`, if any). */
  state: "ghost" | "dim" | "kept" | "new";
  pitch: string;
  /** The previous idea at this place, fading out under the new one. */
  gone: string | null;
}

const same = (a: BrainstormOption | undefined, b: BrainstormOption | undefined) =>
  a !== undefined && b !== undefined && pitchKey(a.pitch) === pitchKey(b.pitch);

/**
 * The rows on show: the first `shown` ideas of `fresh` (the round being
 * written, or the list once settled), then the previous list `before`
 * dimmed where it still stands, then ghosts up to ten while a round runs.
 * A row's key is its place and its pitch: a kept idea keeps its row from the
 * dimmed list through the result, and any other idea arrives in its place,
 * even one the model moved there from another.
 */
export function ideaRows({
  before,
  fresh,
  shown,
  running,
}: {
  before: BrainstormOption[];
  fresh: BrainstormOption[];
  shown: number;
  running: boolean;
}): IdeaRow[] {
  const count = running ? Math.max(CREATOR_LIMITS.brainstormOptions, fresh.length) : fresh.length;
  return Array.from({ length: count }, (_, index): IdeaRow => {
    const n = index + 1;
    const old = before[index];
    const now = index < shown ? fresh[index] : undefined;
    if (now !== undefined) {
      const kept = same(old, now);
      return {
        key: `${index}:${pitchKey(now.pitch)}`,
        n,
        state: kept ? "kept" : "new",
        pitch: now.pitch,
        gone: kept || old === undefined ? null : old.pitch,
      };
    }
    if (old !== undefined) {
      return {
        key: `${index}:${pitchKey(old.pitch)}`,
        n,
        state: "dim",
        pitch: old.pitch,
        gone: null,
      };
    }
    return { key: `ghost-${index}`, n, state: "ghost", pitch: "", gone: null };
  });
}

/** How many of `fresh` show after one more step: the next new idea, and the kept ones right after it. */
export function nextShown(
  shown: number,
  fresh: BrainstormOption[],
  before: BrainstormOption[],
): number {
  let next = Math.min(shown + 1, fresh.length);
  while (next < fresh.length && same(fresh[next], before[next])) next++;
  return next;
}

/**
 * Where focus goes once a round settled, when it was lost with the Stop bar:
 * to the alert when the round failed, so its cause shows and is read before
 * the list it left in place, else to the first idea.
 */
export function focusAfterRound({
  lost,
  rows,
  failed,
}: {
  lost: boolean;
  rows: number;
  failed: boolean;
}): "first-row" | "alert" | null {
  if (!lost) return null;
  if (failed) return "alert";
  return rows > 0 ? "first-row" : null;
}

/**
 * Reveals the list row by row, at least `--reveal-gap` apart (the least time
 * between two rows arriving, so a burst of lines still reads as a fill), from the
 * round's start to its last idea, past the result if the lines came in a
 * burst, then lets the last row land. The list on show when a round starts
 * is the one it dims. `edge` is the row the next idea arrives in while the
 * round runs.
 */
function useReveal(options: BrainstormOption[], incoming: BrainstormOption[], running: boolean) {
  const fresh = running ? incoming : options;
  const [reveal, setReveal] = useState(() => ({
    running,
    before: options,
    shown: running ? 0 : options.length,
    landed: !running,
  }));
  let current = reveal;
  if (reveal.running !== running || reveal.shown > fresh.length) {
    // A round starting dims the list on show; a retry starts its list again.
    const starting = running && !reveal.running;
    current = {
      running,
      before: starting ? options : reveal.before,
      shown: starting ? 0 : Math.min(reveal.shown, fresh.length),
      landed: !starting && reveal.landed,
    };
    setReveal(current);
  }
  const { before, shown, landed } = current;

  useEffect(() => {
    if (shown >= fresh.length) return;
    const timer = setTimeout(
      () =>
        setReveal((state) => ({ ...state, shown: nextShown(state.shown, fresh, state.before) })),
      motionMs("--reveal-gap"),
    );
    return () => clearTimeout(timer);
  }, [shown, fresh]);

  const landing = !running && shown >= fresh.length && !landed;
  useEffect(() => {
    if (!landing) return;
    // The last row lands (its rise and the old idea's fade under it) over
    // `--duration-panel-out` before the rows turn into buttons and could cut either short.
    const timer = setTimeout(
      () => setReveal((state) => ({ ...state, landed: true })),
      motionMs("--duration-panel-out"),
    );
    return () => clearTimeout(timer);
  }, [landing]);

  const rows = ideaRows({ before, fresh, shown, running });
  return {
    rows,
    busy: running || shown < fresh.length || !landed,
    edge: running && shown < rows.length ? shown : null,
  };
}

/** Room above the list when a round brings it into view: its status line. */
const LIST_HEADROOM = 48;

/** Placeholder bar widths, varied by row so the column reads as ideas to come, not a form. */
const GHOST_WIDTHS = [
  ["96%", "54%"],
  ["100%", "38%"],
  ["88%", "66%"],
] as const;

/** A row's number and pitch, on one grid line, over the row's wash; the pitch wraps. */
const ROW = "relative -mx-2 grid grid-cols-[2rem_minmax(0,1fr)_1rem] gap-x-3 rounded-md px-2 py-3";

/**
 * The ten ideas, numbered as feedback refers to them. While a round runs a
 * row is text; once settled it is a button that opens the idea in Describe,
 * the picked one marked. The row the next idea arrives in (`edge`) carries
 * the lamp's light along its lower edge; an idea that replaced an earlier
 * one arrives on the dusk wash an AI rewrite leaves (styles.css `settle`),
 * where a kept one only brightens.
 */
export function IdeaList({
  rows,
  busy,
  edge = null,
  picked,
  onPick,
  listRef,
}: {
  rows: IdeaRow[];
  busy: boolean;
  edge?: number | null;
  picked: number | null;
  onPick: (index: number) => void;
  listRef?: RefObject<HTMLOListElement | null>;
}) {
  return (
    <ol ref={listRef} aria-label="Ideas" aria-busy={busy} className="grid border-rush border-b">
      {rows.map((row, index) => (
        <li
          key={row.key}
          className={cn("relative border-rush border-t", row.state === "new" && "arrive")}
        >
          {row.state === "new" && row.gone !== null && (
            <span
              aria-hidden="true"
              data-rework-wash=""
              className="pointer-events-none absolute -inset-x-2 inset-y-0 animate-[settle_var(--duration-settle)_var(--ease-fade)_both] rounded-md bg-(--dusk-wash)"
            />
          )}
          {row.state === "ghost" ? (
            <div aria-hidden="true" className={cn(ROW, "min-h-[calc(2*1.75rem+1.5rem)]")}>
              <RowNumber n={row.n} />
              <span className="grid">
                {(GHOST_WIDTHS[index % GHOST_WIDTHS.length] ?? []).map((width) => (
                  <span key={width} className="flex h-7 items-center">
                    <span className="h-2 rounded-full bg-rush" style={{ width }} />
                  </span>
                ))}
              </span>
            </div>
          ) : busy || row.state === "dim" ? (
            <div className={ROW}>
              <RowNumber n={row.n} />
              <Pitch dim={row.state === "dim"} gone={row.gone}>
                {row.pitch}
              </Pitch>
            </div>
          ) : (
            <button
              type="button"
              aria-label={`${row.n}. ${row.pitch}`}
              aria-current={picked === index ? "true" : undefined}
              onClick={() => onPick(index)}
              className={cn(
                ROW,
                "press w-[calc(100%+1rem)] text-left hover:bg-surface-hover focus-visible:outline-offset-0",
                picked === index && "bg-surface-selected hover:bg-surface-selected",
              )}
            >
              <RowNumber n={row.n} />
              <Pitch dim={false} gone={null}>
                {row.pitch}
              </Pitch>
              {picked === index && <CheckIcon size={16} className="mt-1.5 text-ink" />}
            </button>
          )}
          {edge === index && <FrameEdge />}
        </li>
      ))}
    </ol>
  );
}

function RowNumber({ n }: { n: number }) {
  return <span className="text-reed text-ui tabular-nums leading-7">{n}</span>;
}

/** A pitch; dimmed while the next list may replace it, or over the old one fading out. */
function Pitch({
  dim,
  gone,
  children,
}: {
  dim: boolean;
  gone: string | null;
  children: ReactNode;
}) {
  return (
    <span className="relative min-w-0">
      {gone !== null && (
        <span
          aria-hidden="true"
          className="absolute inset-x-0 top-0 text-pretty text-reed text-story-phone opacity-0 transition-opacity duration-(--duration-panel-out) ease-fade starting:opacity-70"
        >
          {gone}
        </span>
      )}
      <span
        className={cn(
          "block text-pretty text-story-phone transition-[color,opacity] duration-(--duration-quick) ease-fade",
          // A list being replaced fades to dim as the round starts.
          dim ? "text-reed opacity-70 starting:text-ink starting:opacity-100" : "text-ink",
        )}
      >
        {children}
      </span>
    </span>
  );
}

const isKind = (value: unknown): value is CreatorKind =>
  creatorKindSchema.options.some((kind) => kind === value);

const KIND_ITEMS = Object.fromEntries(
  creatorKindSchema.options.map((kind) => [kind, KINDS[kind].label]),
) as Record<CreatorKind, string>;

/**
 * Which kind of idea the list holds, and the one way to switch: a select on
 * a phone, a toggle group of the three kinds from tablet up, the pressed one
 * checked besides its surface. The kind on show cannot be unpressed; with
 * none (an unclear request) choosing one runs the brainstorm.
 */
export function KindControl({
  phone,
  kind,
  disabled,
  onChoose,
}: {
  phone: boolean;
  kind: CreatorKind | null;
  disabled: boolean;
  onChoose: (kind: CreatorKind) => void;
}) {
  const label = useId();
  const choose = (value: unknown) => {
    if (isKind(value) && value !== kind) onChoose(value);
  };
  const hint = <p className="text-note text-reed">{KIND_HINT}</p>;
  if (phone) {
    const Icon = kind === null ? null : KINDS[kind].Icon;
    return (
      <div className="grid gap-2">
        <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3">
          <span id={label} className="font-medium text-ink text-ui">
            {KIND_LABEL}
          </span>
          <Select value={kind} items={KIND_ITEMS} disabled={disabled} onValueChange={choose}>
            <SelectTrigger
              aria-labelledby={label}
              placeholder="Choose a kind"
              className="w-full max-w-72"
            >
              {kind === null || Icon === null ? undefined : (
                <span className="flex min-w-0 flex-1 items-center gap-2.5">
                  <Icon size={16} className="text-narration in-data-disabled:text-text-disabled" />
                  <span className="truncate">{KINDS[kind].label}</span>
                </span>
              )}
            </SelectTrigger>
            <SelectContent label={KIND_LABEL}>
              {creatorKindSchema.options.map((option) => {
                const { label: name, Icon: OptionIcon } = KINDS[option];
                return (
                  <SelectItem key={option} value={option}>
                    <span className="flex items-center gap-2.5">
                      <OptionIcon size={16} className="text-narration" />
                      {name}
                    </span>
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </div>
        {hint}
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <ToggleGroup
        aria-label={KIND_LABEL}
        value={kind === null ? [] : [kind]}
        disabled={disabled}
        onValueChange={(values) => choose(values[0])}
        className="w-fit"
      >
        {creatorKindSchema.options.map((option) => {
          const { label: name, Icon } = KINDS[option];
          const pressed = option === kind;
          return (
            <ToggleGroupItem key={option} value={option} labelled>
              <span
                key={pressed ? "check" : "kind"}
                className="grid place-items-center transition-opacity duration-(--duration-quick) ease-fade starting:opacity-0"
              >
                {pressed ? <CheckIcon size={16} /> : <Icon size={16} />}
              </span>
              {name}
            </ToggleGroupItem>
          );
        })}
      </ToggleGroup>
      {hint}
    </div>
  );
}

/** The model and its reasoning effort, as Describe has them; both screens share the choice. */
function useModel() {
  const setModel = useCreator((state) => state.setModel);
  const setReasoning = useCreator((state) => state.setReasoning);
  const { options, model, unavailable } = useModelChoice(useCreator((state) => state.model));
  const { efforts, effort } = useEffortChoice(
    model,
    useCreator((state) => state.reasoning),
  );
  return { options, model, unavailable, efforts, effort, setModel, setReasoning };
}

/** Model and Reasoning on the left, the submit on the right from tablet up, and why no model can be chosen. */
function SendRow({
  model: { options, model, unavailable, efforts, effort, setModel, setReasoning },
  submit,
  disabled,
}: {
  model: ReturnType<typeof useModel>;
  submit: string;
  disabled: boolean;
}) {
  const modelLabel = useId();
  const reasoningLabel = useId();
  return (
    <>
      <div className="flex flex-col gap-3 tablet:flex-row tablet:items-end tablet:justify-between">
        <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2.5">
          <span id={modelLabel} className="font-medium text-ink text-ui">
            Model
          </span>
          <ModelSelect labelId={modelLabel} options={options} value={model} onChange={setModel} />
          <span id={reasoningLabel} className="font-medium text-ink text-ui">
            Reasoning
          </span>
          <ReasoningSelect
            labelId={reasoningLabel}
            efforts={efforts}
            effort={effort}
            onChange={setReasoning}
          />
        </div>
        <Button type="submit" variant="primary" disabled={disabled} className="self-end">
          {submit}
        </Button>
      </div>
      {unavailable !== null && <p className="text-ember text-note">{unavailable}</p>}
    </>
  );
}

/** Cmd/Ctrl+Enter in a field submits its form. */
const submitOnEnter = (submit: () => void) => (event: KeyboardEvent<HTMLTextAreaElement>) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !isComposing(event)) {
    event.preventDefault();
    submit();
  }
};

/**
 * The brainstorm stage: ask for ideas from a mood or a few words, read ten
 * of the detected kind as they arrive, switch the kind or adjust them, and
 * pick one into Describe. One column; everything but the filling list stays
 * quiet. A round in flight has its Stop in the bar under the scroller.
 */
export function Brainstorm({ scroller }: { scroller: RefObject<HTMLDivElement | null> }) {
  const session = useCreator((state) => state.brainstorm);
  const change = useCreator((state) => state.change);
  const askIdeas = useCreator((state) => state.askIdeas);
  const adjustIdeas = useCreator((state) => state.adjustIdeas);
  const switchIdeasKind = useCreator((state) => state.switchIdeasKind);
  const pickIdea = useCreator((state) => state.pickIdea);
  const editIdeasRequest = useCreator((state) => state.editIdeasRequest);
  const resetIdeas = useCreator((state) => state.resetIdeas);
  const setIdeasDraft = useCreator((state) => state.setIdeasDraft);
  const setIdeasFeedback = useCreator((state) => state.setIdeasFeedback);
  const model = useModel();
  const phone = useFormFactor() === "phone";
  const { status, request, draft, feedback, kind, options, incoming, failure, retried, picked } =
    session;
  const asking = status === "idle";
  const running = status === "classifying" || status === "writing" || status === "waiting";
  const { rows, busy, edge } = useReveal(options, incoming, running);
  const alert = status === "failed" ? ideasAlert(failure) : null;
  const statusLine = ideasStatus(session);
  const list = useRef<HTMLOListElement>(null);
  const alertRef = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const feedbackId = useId();

  // Back from Describe, the list is where it was and focus on the idea that was picked.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only on arrival.
  useEffect(() => {
    if (picked === null) return;
    scroller.current?.scrollTo({ top: session.scroll });
    list.current
      ?.querySelector<HTMLElement>('[aria-current="true"]')
      ?.focus({ preventScroll: true });
  }, []);

  // A round sent from below the list, as feedback is, brings the list's top and its status line
  // into view, so every row is seen changing; a list already in view stays where it is.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only as a round starts.
  useEffect(() => {
    const view = scroller.current;
    const top = list.current?.getBoundingClientRect().top;
    if (!running || view === null || top === undefined) return;
    const above = top - view.getBoundingClientRect().top - LIST_HEADROOM;
    if (above < 0) view.scrollBy({ top: above, behavior: scrollBehavior() });
  }, [running]);

  // A round that settled while focus was lost with the Stop bar hands it to the list, or the alert.
  const wasBusy = useRef(busy);
  useEffect(() => {
    const was = wasBusy.current;
    wasBusy.current = busy;
    if (!was || busy) return;
    const active = document.activeElement;
    const target = focusAfterRound({
      lost: active === null || active === document.body,
      rows: rows.length,
      failed: alert !== null,
    });
    if (target === "first-row") list.current?.querySelector("button")?.focus();
    else if (target === "alert") alertRef.current?.focus();
  }, [busy, rows.length, alert]);

  const adjust = () => {
    if (!running && model.model !== null) adjustIdeas(feedback, model.model, model.effort);
  };

  return (
    <div className={`${COLUMN} grid gap-5 pt-6 pb-16 tablet:pt-10`}>
      <div className="flex items-center gap-1">
        <span
          className="flex w-fit items-center gap-2 font-semibold text-ink text-ui"
          style={{ viewTransitionName: kindTransition("brainstorm") }}
        >
          <IdeasIcon size={20} className="text-narration" />
          Brainstorm
        </span>
        <Button
          size="text"
          aria-label="Change from Brainstorm"
          onClick={() => leaveBrainstorm(change)}
        >
          Change
        </Button>
      </div>
      {asking ? (
        <Ask
          draft={draft}
          onDraft={setIdeasDraft}
          model={model}
          onAsk={(text) => {
            if (model.model !== null) {
              const chosen = model.model;
              inTransition(() => askIdeas(text, chosen, model.effort));
            }
          }}
        />
      ) : (
        <div className="grid justify-items-start gap-1.5">
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((open) => !open)}
            className="w-full cursor-pointer text-left text-lead text-narration transition-colors duration-(--duration-quick) ease-fade hover:text-ink focus-visible:text-ink"
          >
            <span className="sr-only">Your request: </span>
            <span className={cn("whitespace-pre-line break-words", !expanded && "line-clamp-2")}>
              {request}
            </span>
          </button>
          <div className="-ml-2 flex flex-wrap gap-1">
            <Button size="text" onClick={() => inTransition(editIdeasRequest)}>
              Edit request
            </Button>
            <Button size="text" onClick={() => inTransition(resetIdeas)}>
              Start over
            </Button>
          </div>
        </div>
      )}
      {!asking && (
        <KindControl
          phone={phone}
          kind={kind}
          disabled={running}
          onChoose={(next) => {
            if (model.model !== null) switchIdeasKind(next, model.model, model.effort);
          }}
        />
      )}
      {/* Always mounted, so each change of the round is announced; never each pitch. */}
      <p
        role="status"
        className={asking ? "sr-only" : "-mb-2 text-note text-reed empty:-mt-5 empty:mb-0"}
      >
        {/* Each new line fades in; none at all keeps the paragraph :empty. */}
        {statusLine !== "" && (
          <span
            key={statusLine}
            className="transition-opacity duration-(--duration-quick) ease-fade starting:opacity-0"
          >
            {statusLine}
          </span>
        )}
      </p>
      {!asking && retried && running && (
        <p className="-mt-3 text-note text-reed arrive">{RETRY_NOTE}</p>
      )}
      {alert !== null && (
        <p
          ref={alertRef}
          role="alert"
          tabIndex={-1}
          className="text-ember text-ui outline-none arrive"
        >
          {alert}
        </p>
      )}
      {!asking && rows.length > 0 && (
        <IdeaList
          listRef={list}
          rows={rows}
          busy={busy}
          edge={status === "waiting" ? null : edge}
          picked={picked}
          onPick={(index) => inTransition(() => pickIdea(index, scroller.current?.scrollTop ?? 0))}
        />
      )}
      {!asking && (
        <form
          className="grid gap-3 pt-3"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            adjust();
          }}
        >
          <label htmlFor={feedbackId} className="font-medium text-ink text-ui">
            Adjust the ideas
          </label>
          <textarea
            id={feedbackId}
            data-lamp-field=""
            value={feedback}
            onChange={(event) => setIdeasFeedback(event.target.value)}
            onKeyDown={submitOnEnter(adjust)}
            placeholder="Keep 3 and 7 and make the rest darker. Leave it empty for ten new ones."
            maxLength={CREATOR_LIMITS.descriptionLength}
            autoComplete="off"
            translate="no"
            className={cn(REQUEST_FIELD, "max-h-[min(20rem,32dvh)] min-h-[calc(3*1.75rem+1.5rem)]")}
          />
          <SendRow model={model} submit="New ideas" disabled={running || model.model === null} />
        </form>
      )}
    </div>
  );
}

/** Ask: the request in one large field, the model, and Brainstorm ideas. */
function Ask({
  draft,
  onDraft,
  model,
  onAsk,
}: {
  draft: string;
  onDraft: (text: string) => void;
  model: ReturnType<typeof useModel>;
  onAsk: (text: string) => void;
}) {
  const field = useRef<HTMLTextAreaElement>(null);
  const fieldId = useId();
  const ready = draft.trim() !== "" && model.model !== null;

  // No keyboard pops up unasked on a touch screen.
  useEffect(() => {
    if (!isCoarsePointer()) field.current?.focus({ preventScroll: true });
  }, []);

  const submit = () => {
    if (ready) onAsk(draft);
  };

  return (
    <form
      aria-labelledby={`${fieldId}-heading`}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      className="grid gap-5"
    >
      <h2
        id={`${fieldId}-heading`}
        className="font-semibold text-ink text-title-phone tablet:text-title"
      >
        <label htmlFor={fieldId}>What are you in the mood for?</label>
      </h2>
      <textarea
        ref={field}
        id={fieldId}
        data-lamp-field=""
        value={draft}
        onChange={(event) => onDraft(event.target.value)}
        onKeyDown={submitOnEnter(submit)}
        placeholder="Something slow and tense in a snowed-in mountain hotel, with a stranger who knows too much. A mood or a few words is enough."
        maxLength={CREATOR_LIMITS.descriptionLength}
        autoComplete="off"
        translate="no"
        className={cn(REQUEST_FIELD, "max-h-[min(28rem,42dvh)] min-h-[calc(6*1.75rem+1.5rem)]")}
      />
      <SendRow model={model} submit="Brainstorm ideas" disabled={!ready} />
    </form>
  );
}
