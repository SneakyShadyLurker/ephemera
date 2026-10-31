import { BUILT_IN_NAMES, type CallSettings, type InspectedPrompt } from "@ephemera/core";
import { useQuery } from "@tanstack/react-query";
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useFormFactor } from "@/app/form-factor.ts";
import { setInspectorOpen, setSessionOpen, useUi } from "@/app/ui.ts";
import { ChatIcon, ChevronDownIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerCloseIcon,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/cn";
import { depthText, ROLE_NAMES } from "@/lib/roles";
import { countOf, formatCount } from "@/lib/text";
import { inChatText } from "../lorebook/copy.ts";
import { personasQuery } from "../personas/queries.ts";
import { REASONING_LABELS } from "../presets/queries.ts";
import { useSetting } from "../settings/settings.ts";
import { WindowLink } from "../settings/window-link.tsx";
import { type CacheBreak, cacheBreak } from "./cache-break.ts";
import { speakerName, useChatCharacter } from "./character.ts";
import { LorebookReport } from "./LorebookReport.tsx";
import { promptParts } from "./prompt-parts.ts";
import { chatStore, useChat } from "./session.ts";
import type { Preview, Speaker } from "./store.ts";
import { UsageSection } from "./Usage.tsx";

/*
 * The prompt inspector: the exact prompt of the last request, or a labelled
 * preview of the next one, message by message, measured against the model's
 * context window. Everything shown is chat content from the in-memory store;
 * nothing is copied, stored or sent anywhere from here. The preview's
 * comparison with the last prompt sent is computed here, on render, and kept
 * nowhere.
 */

type Mode = "sent" | "preview";

/** What the model counted for the last prompt sent, once its reply finished. */
interface Counted {
  inputTokens: number;
  /** Of `inputTokens`, read from the provider's prompt cache. */
  cachedTokens: number | null;
  outputTokens: number | null;
  /** Of `outputTokens`, reasoning. */
  reasoningTokens: number | null;
}

type Message = InspectedPrompt["messages"][number];

const HATCH =
  "bg-[repeating-linear-gradient(135deg,var(--control-edge)_0_2px,transparent_2px_4px)]";
/** History turns shown before "Show earlier messages". */
const RECENT = 12;
export function Inspector() {
  const open = useUi((state) => state.inspectorOpen);
  const phone = useFormFactor() === "phone";
  const [mode, setMode] = useState<Mode>("sent");
  const hasSent = useChat((state) => state.lastSent !== null);
  // Nothing sent yet: the preview is what there is to show.
  const shown: Mode = hasSent ? mode : "preview";
  return (
    <Drawer
      open={open}
      onOpenChange={setInspectorOpen}
      swipeDirection={phone ? "down" : "right"}
      showSwipeHandle={phone}
    >
      <DrawerContent className="data-[swipe-axis=y]:[--drawer-content-max-height:92dvh] tablet:data-[swipe-axis=x]:[--drawer-content-width:min(calc(100vw-5rem),clamp(44rem,40vw,56rem))]">
        <DrawerHeader>
          <DrawerTitle className="flex-1">Prompt</DrawerTitle>
          <ToggleGroup
            aria-label="Show"
            value={[shown]}
            onValueChange={(value) => {
              const next = value[0];
              if (next === "sent" || next === "preview") setMode(next);
            }}
          >
            <ToggleGroupItem value="sent" labelled disabled={!hasSent}>
              Last sent
            </ToggleGroupItem>
            <ToggleGroupItem value="preview" labelled>
              Preview
            </ToggleGroupItem>
          </ToggleGroup>
          <DrawerCloseIcon label="Close prompt" />
        </DrawerHeader>
        <div
          key={shown}
          className="min-h-0 flex-1 overflow-y-auto pb-[calc(1.5rem+env(safe-area-inset-bottom))] transition-opacity duration-(--duration-quick) ease-fade starting:opacity-0"
        >
          {open && (shown === "sent" ? <LastSentView /> : <PreviewView />)}
        </div>
      </DrawerContent>
    </Drawer>
  );
}

/** What the last request was for, after "Sent to model at time". */
const SENT_FOR: Record<InspectedPrompt["mode"], string> = {
  reply: "",
  continue: " to continue the last reply",
  impersonate: " to write your next message",
};

function LastSentView() {
  const lastSent = useChat((state) => state.lastSent);
  if (lastSent === null) return null;
  const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(
    lastSent.sentAt,
  );
  return (
    <PromptView
      prompt={lastSent.prompt}
      intro={
        <>
          Sent to <span className="font-medium">{lastSent.prompt.model}</span> at {time}
          {SENT_FOR[lastSent.prompt.mode]}.
        </>
      }
      counted={
        lastSent.inputTokens === null
          ? null
          : {
              inputTokens: lastSent.inputTokens,
              cachedTokens: lastSent.cachedTokens,
              outputTokens: lastSent.outputTokens,
              reasoningTokens: lastSent.reasoningTokens,
            }
      }
      speakers={lastSent.speakers}
      draftIndex={null}
      cache={null}
      preview={false}
    />
  );
}

/**
 * Built on open and on switching to it; the store rebuilds it after a pause
 * whenever the chat, the draft or the selection changes.
 */
function PreviewView() {
  const preview = useChat((state) => state.preview);
  const model = useSetting((settings) => settings.model);
  useEffect(() => {
    void chatStore.getState().requestPreview();
  }, []);

  const intro = (
    <>
      Preview for <span className="font-medium">{model ?? "no model"}</span>. Edits and random
      macros can change what goes out when you send.
    </>
  );
  if (model === null) {
    return <Status intro={intro}>Choose a model to preview a prompt.</Status>;
  }
  return <PreviewBody preview={preview} intro={intro} model={model} />;
}

function PreviewBody({
  preview,
  intro,
  model,
}: {
  preview: Preview;
  intro: React.ReactNode;
  model: string;
}) {
  const sent = useChat((state) => state.lastSent?.prompt ?? null);
  switch (preview.status) {
    case "ready":
      return preview.prompt === null ? null : (
        <PromptView
          prompt={preview.prompt}
          intro={intro}
          counted={null}
          speakers={[]}
          draftIndex={preview.draftIndex}
          cache={sent === null ? null : cacheBreak(sent, preview.prompt)}
          preview
        />
      );
    case "context_window_unknown":
      return (
        <Status intro={intro} tone="ember">
          {model} has no known context window, so the prompt can't be sized or sent.{" "}
          <WindowLink model={model}>Set one in Settings</WindowLink>, or choose another model.
        </Status>
      );
    case "prompt_too_long":
      return (
        <Status intro={intro} tone="ember">
          Too long for {model}'s context window: the preset's blocks, your latest message and the
          reply length don't fit, even with the rest of the chat left out.
        </Status>
      );
    case "failed":
      return (
        <Status intro={intro} tone="ember">
          The preview could not be built: Ephemera could not be reached.{" "}
          <Button
            variant="outline"
            className="mt-2 h-8 px-2.5 text-ink text-note touch:h-11"
            onClick={() => void chatStore.getState().requestPreview()}
          >
            Try again
          </Button>
        </Status>
      );
    default:
      return (
        <Status intro={intro} busy>
          Building the preview…
        </Status>
      );
  }
}

function Status({
  intro,
  tone = "reed",
  busy = false,
  children,
}: {
  intro: React.ReactNode;
  tone?: "reed" | "ember";
  busy?: boolean;
  children: React.ReactNode;
}) {
  const usage = useChat((state) => state.usage);
  return (
    <>
      <section aria-busy={busy} className="grid gap-2.5 px-5 pt-1 pb-5">
        <p className="text-pretty text-ink text-ui">{intro}</p>
        <div
          role={tone === "ember" ? "alert" : "status"}
          className={cn("text-pretty text-note", tone === "ember" ? "text-ember" : "text-reed")}
        >
          {children}
        </div>
      </section>
      <UsageSection ledger={usage} generation={null} preview />
    </>
  );
}

/** A message's place in the request, stable across renders. */
function messageKey({ source }: Message): string {
  switch (source.kind) {
    case "block":
      return source.id;
    case "custom":
      return source.id;
    case "example":
      return `example-${source.index}-${source.line}`;
    case "history":
      return `turn-${source.index}`;
    case "authorsNote":
      return "authors-note";
    case "characterNote":
      return "character-note";
    case "castState":
      return "cast-state";
    case "lorebook":
      switch (source.position) {
        case "depth":
          return `lorebook-depth-${source.depth}-${source.role}`;
        case "examples":
          return `lorebook-examples-${source.side}-${source.index}-${source.line}`;
        default:
          return `lorebook-${source.position}`;
      }
    case "instruction":
      return `instruction-${source.id}`;
    case "placeholder":
      return "placeholder";
    case "event":
      return "event";
    case "memory":
      return `memory-${source.part}`;
  }
}

/** The post-processing names the Settings screen uses. */
const PROCESSING: Record<InspectedPrompt["processing"], string | null> = {
  none: null,
  merge: "Merge consecutive roles",
  semiStrict: "One system message",
  strict: "Strict alternation",
  single: "Single user message",
};

function PromptView({
  prompt,
  intro,
  counted,
  speakers,
  draftIndex,
  cache,
  preview,
}: {
  prompt: InspectedPrompt;
  intro: React.ReactNode;
  counted: Counted | null;
  speakers: Speaker[];
  draftIndex: number | null;
  /** Where the preview first differs from the last prompt sent; null in Last sent. */
  cache: CacheBreak | null;
  /** The next prompt, not one sent: what it folds is only shown. */
  preview: boolean;
}) {
  const parts = promptParts(prompt.messages, draftIndex);
  const { before, band, after } = parts;
  const label = useLabels(speakers, parts.isDraft);
  const character = useChatCharacter();
  const usage = useChat((state) => state.usage);
  const generation = useChat((state) => state.lastSent?.generation ?? null);
  // The break's index within each run of the list; null when it falls elsewhere.
  const at = cache?.at ?? null;
  const within = (start: number, length: number) =>
    at !== null && at >= start && at < start + length ? at - start : null;
  const inBefore = within(0, before.length);
  const inBand = within(before.length, band.length);
  const inAfter = within(before.length + band.length, after.length);
  return (
    <>
      <Measure
        prompt={prompt}
        intro={intro}
        counted={counted}
        blocks={parts.blocks}
        draft={parts.draft}
        cache={cache === null ? null : cacheSentence(cache, prompt.messages, parts, label)}
        preview={preview}
      />
      <UsageSection ledger={usage} generation={generation} preview={preview} />
      {prompt.lorebook !== null && (
        <LorebookReport
          report={prompt.lorebook}
          name={character?.name ?? "The character"}
          characterId={character?.id ?? null}
          draft={draftIndex !== null}
        />
      )}
      <ol aria-label="Prompt in send order" className="grid border-rush border-t">
        {before.map((message, index) => (
          <Fragment key={messageKey(message)}>
            {index === inBefore && <CacheRule />}
            <Entry message={message} label={label(message)} />
          </Fragment>
        ))}
        <HistoryBand prompt={prompt} parts={parts} label={label} breakAt={inBand} />
        {after.map((message, index) => (
          <Fragment key={messageKey(message)}>
            {index === inAfter && <CacheRule />}
            <Entry message={message} label={label(message)} />
          </Fragment>
        ))}
        {/* A next prompt that ends before the last one did differs at its end. */}
        {at !== null && at === prompt.messages.length && <CacheRule />}
      </ol>
      <SentWith prompt={prompt} />
    </>
  );
}

type LorebookSource = Extract<Message["source"], { kind: "lorebook" }>;

/** A lorebook message's label: its block, or where in the chat or the examples it sits. */
function lorebookLabel(source: LorebookSource): string {
  const entries = countOf(source.entries, "entry", "entries");
  switch (source.position) {
    case "before":
    case "after": {
      return `${BUILT_IN_NAMES[source.position === "before" ? "lorebookBefore" : "lorebookAfter"]}: ${entries}`;
    }
    case "depth":
      return `Lorebook, ${inChatText(source.depth)}: ${entries}`;
    case "authorsNote":
      return source.depth === null
        ? `Lorebook, with the Author's Note: ${entries}`
        : `Lorebook, with the Author's Note ${inChatText(source.depth)}: ${entries}`;
    case "examples":
      return `Lorebook example dialogue, ${source.side} the card's: ${entries}`;
  }
}

/** Where each message came from, in the words the preset editor uses. */
function useLabels(speakers: Speaker[], isDraft: (message: Message) => boolean) {
  const character = useChatCharacter();
  const { data } = useQuery(personasQuery);
  const label = (message: Message): string => {
    const { source } = message;
    switch (source.kind) {
      case "block":
        return BUILT_IN_NAMES[source.id];
      case "custom":
        return source.depth === null ? source.name : `${source.name}, ${depthText(source.depth)}`;
      case "example":
        return `Example dialogue ${source.index + 1}`;
      case "authorsNote":
        return source.depth === null
          ? "Author's Note, after the main prompt"
          : `Author's Note, ${depthText(source.depth)}`;
      case "characterNote":
        return `Character's Note, ${depthText(source.depth)}`;
      case "castState":
        return `Cast state, ${depthText(source.depth)}`;
      case "lorebook":
        return lorebookLabel(source);
      case "instruction":
        return source.id === "continue" ? "Continue instruction" : "Write for me instruction";
      case "placeholder":
        return "Placeholder for strict alternation";
      case "event":
        return "Event";
      case "memory": {
        const episodes = countOf(source.episodes, "memory", "memories");
        return source.part === "story"
          ? `Memory: the story so far (${episodes})`
          : `Memory: recalled (${episodes})`;
      }
      case "history": {
        if (isDraft(message)) return "Your draft";
        if (message.role === "assistant") return character?.name ?? "Model";
        const speaker = speakers[source.index] ?? null;
        const persona = data?.find((entry) => entry.id === speaker?.personaId);
        return speakerName(speaker?.personaId, speaker?.name, persona) ?? "You";
      }
    }
  };
  // Post-processing can merge several sources into one message.
  return (message: Message): string => {
    const merged = message.merged?.length ?? 0;
    return merged === 0 ? label(message) : `${label(message)}, and ${formatCount(merged)} merged`;
  };
}

/** Where the window goes: numbers first, over a hairline gauge. */
function Measure({
  prompt,
  intro,
  counted,
  blocks,
  draft,
  cache,
  preview,
}: {
  prompt: InspectedPrompt;
  intro: React.ReactNode;
  counted: Counted | null;
  blocks: number;
  draft: number;
  /** The sentence on what the next prompt shares with the last one sent. */
  cache: string | null;
  /** The next prompt, not one sent. */
  preview: boolean;
}) {
  const { window, reserve, estimate } = prompt;
  const history = Math.max(0, estimate - blocks - draft);
  const free = Math.max(0, window.tokens - estimate - reserve);
  const trimmed = prompt.history.total - prompt.history.sent;
  const examples = prompt.examples.total - prompt.examples.sent;
  const fold = prompt.memoryFold;
  return (
    <section aria-label="Size" className="grid gap-2.5 px-5 pt-1 pb-5">
      <p className="text-pretty text-ink text-ui">{intro}</p>
      <div
        role="img"
        aria-label={`${formatCount(estimate)} of ${formatCount(window.tokens)} tokens estimated, ${formatCount(reserve)} reserved for the reply`}
        className="mt-1 flex h-1 w-full gap-px bg-rush"
      >
        <span className="bg-reed" style={{ flexGrow: blocks }} />
        <span className="bg-ink" style={{ flexGrow: history + draft }} />
        <span className={HATCH} style={{ flexGrow: reserve }} />
        <span style={{ flexGrow: free }} />
      </div>
      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-note">
        <dt className="text-reed">
          Context window{window.source === "owner" ? ", set by you" : ""}
          {window.limit === "owner" &&
            `, limited by you to ${formatCount(window.tokens)} of ${formatCount(window.model)}`}
          {window.limit === "default" &&
            `, limited by default to ${formatCount(window.tokens)} of ${formatCount(window.model)}; Settings can change it`}
        </dt>
        <dd className="text-right text-ink tabular-nums">{formatCount(window.tokens)}</dd>
        <dt className="text-reed">Prompt blocks</dt>
        <dd className="text-right text-ink tabular-nums">{formatCount(blocks)}</dd>
        <dt className="text-reed">Chat history</dt>
        <dd className="text-right text-ink tabular-nums">{formatCount(history)}</dd>
        {draft > 0 && (
          <>
            <dt className="text-reed">Your draft</dt>
            <dd className="text-right text-ink tabular-nums">{formatCount(draft)}</dd>
          </>
        )}
        <dt className="text-reed">Reply reserve</dt>
        <dd className="text-right text-ink tabular-nums">{formatCount(reserve)}</dd>
        <dt className="font-medium text-ink">Estimated free</dt>
        <dd className="text-right font-medium text-ink tabular-nums">{formatCount(free)}</dd>
      </dl>
      <p className="text-pretty text-note text-reed">
        {fold !== undefined && (
          <>
            {countOf(fold.spans, "memory", "memories")} {preview ? "would fold" : "folded"} for this
            prompt ({countOf(fold.turns, "turn")}).{" "}
          </>
        )}
        {trimmed > 0 && (
          <>
            The {countOf(trimmed, "oldest message")} {TRIMMED[prompt.trimming]}{" "}
          </>
        )}
        {examples > 0 && (
          <>
            {countOf(examples, "example dialogue block")} {examples === 1 ? "was" : "were"} left out
            to fit.{" "}
          </>
        )}
        {cache !== null && <>{cache} </>}
        {counted === null
          ? "Counts are estimates, corrected by what the model counted last time."
          : countedSentence(estimate, counted)}
      </p>
    </section>
  );
}

/**
 * The estimate beside what the model counted, read and wrote. Figures show as
 * the provider gave them; an output figure it did not give is left out, and
 * so is a reasoning share of 0, which most providers report for none.
 */
export function countedSentence(
  estimate: number,
  { inputTokens, cachedTokens, outputTokens, reasoningTokens }: Counted,
): string {
  const cached =
    cachedTokens === null
      ? ""
      : `, of which ${formatCount(cachedTokens)} ${cachedTokens === 1 ? "was" : "were"} cached`;
  const reasoning =
    reasoningTokens === null || reasoningTokens === 0
      ? ""
      : `, ${formatCount(reasoningTokens)} of them reasoning`;
  const wrote = outputTokens === null ? "" : `; it wrote ${formatCount(outputTokens)}${reasoning}`;
  return `Estimated ${formatCount(estimate)}; the model counted ${formatCount(inputTokens)}${cached}${wrote}.`;
}

/** Where in the prompt a message sits, after its label. */
function place(index: number, parts: ReturnType<typeof promptParts>): string {
  if (index < parts.before.length) return "before the chat";
  return index < parts.before.length + parts.band.length ? "in the chat" : "after the chat";
}

/**
 * What the next prompt shares with the last one sent, said conservatively:
 * the provider decides what it still holds, so the shared part is only what
 * its cache could reach.
 */
function cacheSentence(
  cache: CacheBreak,
  messages: Message[],
  parts: ReturnType<typeof promptParts>,
  label: (message: Message) => string,
): string {
  const tokens = formatCount(cache.shared.tokens);
  if (cache.at === null)
    return "The next prompt only adds to the last one sent; whether the provider still has it cached depends on the provider.";
  const message = messages[cache.at];
  if (message === undefined)
    return `The next prompt matches the start of the last prompt sent, about ${tokens} tokens, and ends before it does.`;
  const where = `“${label(message)}”, ${place(cache.at, parts)}`;
  return cache.shared.tokens === 0
    ? `The next prompt differs from the last prompt sent from the start, at ${where}.`
    : `The next prompt matches the last prompt sent up to about ${tokens} tokens; it first differs at ${where}.`;
}

/**
 * The preview's one accent: a Dusk hairline where the next prompt stops
 * matching the last one sent. Everything above it is unchanged; where the
 * exact point is folded away, it sits above the fold, which stays true.
 */
function CacheRule({ inBand = false }: { inBand?: boolean }) {
  return (
    <li
      className={cn(
        "relative -mt-px border-dusk border-t pt-1 pr-5 pb-1.5 text-meta text-reed transition-opacity duration-(--duration-quick) ease-fade starting:opacity-0 tablet:pl-[6.5rem]",
        inBand ? "pl-3" : "pl-5",
      )}
    >
      Unchanged since the last prompt above this line
    </li>
  );
}

/** How the oldest messages were left out, after "The N oldest messages". */
const TRIMMED: Record<InspectedPrompt["trimming"], string> = {
  exact: "were left out to fit.",
  blocks:
    "were left out in a block, so the rest stays put for the model's cache until the chat overflows again.",
  "blocks-fallback":
    "were left out to fit, one at a time: a block of this chat is larger than the room for its history.",
};

/** Chat history is the waterline band, as in the prompt preset; it opens to its messages. */
function HistoryBand({
  prompt,
  parts,
  label,
  breakAt,
}: {
  prompt: InspectedPrompt;
  parts: ReturnType<typeof promptParts>;
  label: (message: Message) => string;
  /** The band message where the preview stops matching the last prompt sent. */
  breakAt: number | null;
}) {
  const [open, setOpen] = useState(false);
  const [earlier, setEarlier] = useState(false);
  const { band, turns, isDraft, lorebookBlocks } = parts;
  const hidden = earlier ? 0 : Math.max(0, band.length - RECENT);
  const trimmed = prompt.history.total - prompt.history.sent;
  return (
    <>
      {/* Closed, the band hides where the break is: the rule sits above it. */}
      {breakAt !== null && !open && <CacheRule />}
      <li className="relative border-control-edge border-y py-1 pl-3 before:absolute before:top-3 before:bottom-3 before:left-0 before:w-0.5 before:rounded-full before:bg-control-edge dark:bg-surface">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="press flex min-h-12 w-full items-center gap-3 rounded-md pr-5 pl-1 text-left hover:bg-surface-hover touch:min-h-14"
        >
          <span className="grid w-7 place-items-center text-reed" aria-hidden="true">
            <ChatIcon size={16} />
          </span>
          <span className="grid min-w-0 flex-1">
            <span className="font-medium text-ink text-ui italic">Chat history</span>
            <span className="text-meta text-reed">
              {turns === 0
                ? parts.hasDraft
                  ? "Your draft only"
                  : "No messages yet"
                : `${countOf(turns, "message")} sent`}
              {lorebookBlocks > 0 && `, ${countOf(lorebookBlocks, "lorebook block")} among them`}
              {trimmed > 0 && `; the ${formatCount(trimmed)} oldest left out`}
            </span>
          </span>
          <span className="text-meta text-reed tabular-nums">
            {formatCount(band.reduce((total, message) => total + message.tokens, 0))}
          </span>
          <ChevronDownIcon
            size={16}
            className={cn(
              "text-reed transition-[rotate] duration-(--duration-arrive) ease-spring motion-reduce:transition-none",
              open && "rotate-180",
            )}
          />
        </button>
        {/* The waterline opens: the band grows to its content on the spring; reduced motion fades. */}
        <div
          className={cn(
            "overflow-hidden transition-[height,opacity] duration-(--duration-panel-in) ease-spring [interpolate-size:allow-keywords] motion-reduce:transition-opacity motion-reduce:duration-(--duration-quick)",
            open ? "h-auto opacity-100" : "h-0 opacity-0",
          )}
          inert={!open}
        >
          <ol aria-label="Chat history as sent" className="grid border-rush border-t">
            {breakAt !== null && open && breakAt < hidden && <CacheRule inBand />}
            {hidden > 0 && (
              <li className="border-rush border-b py-1.5 pl-8 tablet:pl-[6.5rem]">
                <button
                  type="button"
                  onClick={() => setEarlier(true)}
                  className="rounded-sm text-meta text-reed underline decoration-control-edge underline-offset-4 hover:text-ink touch:min-h-11"
                >
                  Show {formatCount(hidden)} earlier messages
                </button>
              </li>
            )}
            {band.slice(hidden).map((message, index) => (
              <Fragment key={messageKey(message)}>
                {open && index + hidden === breakAt && <CacheRule inBand />}
                <Entry message={message} label={label(message)} inBand draft={isDraft(message)} />
              </Fragment>
            ))}
          </ol>
        </div>
      </li>
    </>
  );
}

function Entry({
  message,
  label,
  inBand = false,
  draft = false,
}: {
  message: Message;
  label: string;
  inBand?: boolean;
  draft?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const item = useRef<HTMLLIElement>(null);
  const text = useRef<HTMLParagraphElement>(null);
  // Offered whenever the text runs past its three lines, so every word stays reachable.
  const [clamped, setClamped] = useState(false);
  useLayoutEffect(() => {
    const node = text.current;
    const row = item.current;
    if (node === null || row === null || open) return;
    // Only an entry on screen is measured: reading an off-screen one would
    // lay out what `content-visibility: auto` skips. It is measured when it
    // comes into view, and again when a rotation or a resized window can
    // clamp text that fit before.
    const measure = () => {
      if (!node.checkVisibility({ contentVisibilityAuto: true })) return;
      setClamped(node.scrollHeight > node.clientHeight + 1);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    row.addEventListener("contentvisibilityautostatechange", measure);
    return () => {
      observer.disconnect();
      row.removeEventListener("contentvisibilityautostatechange", measure);
    };
  }, [open]);
  return (
    <li
      ref={item}
      className={cn(
        "grid gap-x-4 border-rush border-b py-3 pr-5 [content-visibility:auto] last:border-b-0 tablet:grid-cols-[5.5rem_minmax(0,1fr)]",
        inBand ? "pl-3 tablet:pl-0" : "pl-5 tablet:pl-0",
      )}
    >
      <span className="hidden text-meta text-reed tablet:block tablet:pt-0.5 tablet:text-right">
        {ROLE_NAMES[message.role]}
      </span>
      <div className="grid min-w-0 gap-1">
        <div className="flex items-baseline gap-3">
          <span
            className={cn(
              "min-w-0 flex-1 truncate font-medium text-ink text-ui",
              draft && "italic",
            )}
          >
            {label}
          </span>
          <span className="shrink-0 text-meta text-reed tablet:hidden">
            {ROLE_NAMES[message.role]}
          </span>
          <span className="shrink-0 text-meta text-reed tabular-nums">
            {formatCount(message.tokens)}
          </span>
        </div>
        <p
          ref={text}
          translate="no"
          className={cn(
            "whitespace-pre-wrap break-words font-mono text-ink text-note",
            !open && "line-clamp-3",
          )}
        >
          {message.content}
        </p>
        {clamped && (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="justify-self-start rounded-sm text-meta text-reed underline decoration-control-edge underline-offset-4 hover:text-ink touch:min-h-11"
          >
            {open ? "Show less" : "Show all"}
          </button>
        )}
      </div>
    </li>
  );
}

const SETTING_LABELS: Record<Exclude<keyof CallSettings, "reasoning">, string> = {
  maxOutputTokens: "Reply length",
  temperature: "Temperature",
  topP: "Top-p",
  frequencyPenalty: "Frequency penalty",
  presencePenalty: "Presence penalty",
  seed: "Seed",
};

/** The call settings that went with the prompt; anything absent was left to the model. */
function SentWith({ prompt }: { prompt: InspectedPrompt }) {
  const { settings, reasoningNotOffered, model, processing } = prompt;
  const entries = (Object.keys(SETTING_LABELS) as (keyof typeof SETTING_LABELS)[])
    .filter((key) => settings[key] !== undefined)
    .map((key) => [SETTING_LABELS[key], formatCount(settings[key] ?? 0)] as const);
  if (settings.reasoning !== undefined)
    entries.push(["Reasoning", REASONING_LABELS[settings.reasoning]]);
  const processed = PROCESSING[processing];
  if (processed !== null) entries.push(["Post-processing", processed]);
  return (
    <section aria-label="Sent with" className="grid gap-2 px-5 pt-5">
      <h3 className="font-medium text-ink text-ui">Sent with</h3>
      {entries.length === 0 ? (
        <p className="text-note text-reed">Every sampling value was left to the model.</p>
      ) : (
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-note">
          {entries.map(([name, value]) => (
            <div key={name} className="contents">
              <dt className="text-reed">{name}</dt>
              <dd className="text-right text-ink tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {reasoningNotOffered !== null && (
        <p className="text-pretty text-note text-reed">
          {REASONING_LABELS[reasoningNotOffered]} reasoning was not sent: {model} doesn't offer it.{" "}
          <button
            type="button"
            className="rounded-sm text-ink underline decoration-control-edge underline-offset-4"
            onClick={() => {
              setInspectorOpen(false);
              setSessionOpen(true);
            }}
          >
            Open Session
          </button>
        </p>
      )}
    </section>
  );
}
