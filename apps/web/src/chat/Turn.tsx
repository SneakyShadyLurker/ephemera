import { formatLocationLine } from "@ephemera/core";
import { Component, lazy, type ReactNode, Suspense } from "react";
import { useFormFactor } from "@/app/form-factor.ts";
import { cn } from "@/lib/cn";
import { MODEL_BUSY } from "@/lib/text";
import { useSetting } from "../settings/settings.ts";
import { WindowLink } from "../settings/window-link.tsx";
import { speakerName, useChatCharacter, usePersona } from "./character.ts";
import { EditField } from "./EditField.tsx";
import { loadMarkdown } from "./markdown-chunk.ts";
import { Presence } from "./Presence.tsx";
import { HiddenReasoning, Reasoning } from "./Reasoning.tsx";
import { REFUSAL_NOTE, WINDOW_UNKNOWN } from "./refusal.ts";
import { SwipeFrame } from "./Swipe.tsx";
import { useChat } from "./session.ts";
import { type AssistantMessage, type MessageStatus, type Reply, shownReply } from "./store.ts";
import { TurnActions } from "./TurnActions.tsx";

// The Markdown renderer loads apart from the page; the thread preloads it on mount.
const Markdown = lazy(() => loadMarkdown().then((module) => ({ default: module.Markdown })));

/**
 * If the renderer chunk fails to load or a message cannot be rendered, the
 * message still shows, as plain text, instead of taking down the chat.
 */
class PlainTextFallback extends Component<
  { text: string; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? <PlainText text={this.props.text} /> : this.props.children;
  }
}

function PlainText({ text }: { text: string }) {
  return <p className="whitespace-pre-wrap">{text}</p>;
}

const STATUS_NOTE: Partial<Record<MessageStatus, string>> = {
  stopped: "Stopped.",
  failed: "Reply interrupted.",
  waiting: "Not sent yet: waiting for you to sign in.",
};

/**
 * Who speaks, named at the start of each turn in the voice that follows: the
 * character in the reading sans with a rule to the story's edge, the owner in
 * the interface sans, a quiet label over their slip. It stays at
 * the top of the view while its turn scrolls past. Assistive technology and
 * find-in-page hear the name once, with the qualifier and the colon.
 */
function Nameplate({
  voice,
  name,
  qualifier = "",
  writing = false,
}: {
  voice: "story" | "line";
  name: string;
  qualifier?: string;
  /** The reply is being written with no portrait in view: light passes along the hairline. */
  writing?: boolean;
}) {
  return (
    <p data-speaker="" data-voice={voice} className="nameplate">
      <span className="nameplate-name">
        {name}
        <span className="sr-only">{`${qualifier}: `}</span>
      </span>
      {voice === "story" && (
        <span aria-hidden="true" data-nameplate-rule="">
          {writing && <span className="lamplight-edge" />}
        </span>
      )}
    </p>
  );
}

/**
 * The owner's nameplate: a turn keeps the persona it was sent as, under the
 * name it had then, renamed or deleted since; without one, "You".
 */
function PersonaNameplate({
  personaId,
  name,
}: {
  personaId: string | null | undefined;
  name?: string | undefined;
}) {
  const persona = usePersona(personaId);
  const speaker = speakerName(personaId, name, persona);
  return speaker === undefined ? (
    <Nameplate voice="line" name="You" />
  ) : (
    <Nameplate voice="line" name={speaker} qualifier=", your persona" />
  );
}

/** A turn folded into a memory, shown on request: one step back from the live story. */
const FOLDED = "opacity-60";

/** The opening moment: the greeting fades in just after the presence arrives. */
const GREET =
  "transition-opacity delay-120 duration-(--duration-panel-in) ease-fade starting:opacity-0";

/**
 * Prose, rendered inert; plain paragraphs until the renderer arrives or if it
 * fails. A reply with no text yet shows the breathing caret, and after six
 * seconds that it is still awaited; the nameplate above says whose.
 */
function Prose({ text, streaming }: { text: string; streaming: boolean }) {
  if (text === "") {
    return (
      streaming && (
        <p className="flex items-baseline gap-3">
          <span aria-hidden="true" className="caret" />
          <span className="still-waiting text-meta text-reed">Waiting for a reply</span>
        </p>
      )
    );
  }
  return (
    <PlainTextFallback text={text}>
      <Suspense fallback={<PlainText text={text} />}>
        <Markdown streaming={streaming}>{text}</Markdown>
      </Suspense>
    </PlainTextFallback>
  );
}

/**
 * One turn. It subscribes to its own message, read at its place in the
 * thread, so streaming re-renders only this turn and each change costs a
 * turn one lookup; the last reply's actions row is the thread's, below it.
 */
export function Turn({
  id,
  index,
  enter,
  last,
  folded = false,
  locked = false,
  presence = false,
}: {
  id: string;
  /** Its place in the thread's messages, as the thread last rendered it. */
  index: number;
  enter: boolean;
  last: boolean;
  /** Folded into a memory and shown on request: dimmed. */
  folded?: boolean;
  /** Remembered or being remembered: read-only, so its actions are hidden. */
  locked?: boolean;
  /** The latest reply shown, from tablet up: the portrait floats at its head. */
  presence?: boolean;
}) {
  // A place a deletion or Undo has just shifted holds another message until the thread
  // renders the new one in the same pass: read as nothing then, never as that message.
  const message = useChat((state) => {
    const at = state.messages[index];
    return at?.id === id ? at : undefined;
  });
  const editing = useChat((state) => state.editing?.id === id && state.editing.target === "text");
  if (message === undefined) return null;
  return message.role === "user" ? (
    <li
      data-message=""
      data-role="user"
      data-status="complete"
      data-folded={folded ? "" : undefined}
      className={cn("group relative", enter && "arrive", folded && FOLDED)}
    >
      <PersonaNameplate personaId={message.personaId} name={message.name} />
      <div
        data-prose=""
        data-voice="line"
        className={cn("prose-turn voice-line text-line", !editing && "slip")}
      >
        {editing ? (
          <EditField id={id} label="Edit your message" />
        ) : (
          <Prose text={message.text} streaming={false} />
        )}
      </div>
      {!editing && !locked && <TurnActions id={id} speaker="your message" />}
    </li>
  ) : (
    <ReplyTurn
      message={message}
      enter={enter}
      last={last}
      editing={editing}
      folded={folded}
      locked={locked}
      presence={presence}
    />
  );
}

/** The existing reply footer also explains provider-ended partial replies. */
export function ReplyNote({ reply, last }: { reply: Reply; last: boolean }) {
  const partial =
    reply.status !== "complete"
      ? undefined
      : reply.finishReason === "length"
        ? reply.text !== ""
          ? last
            ? "Cut off at the output limit. Continue writes on from here."
            : "Cut off at the output limit."
          : reply.reasoning !== "" || reply.hiddenMs !== undefined
            ? "The output limit ran out while the model was reasoning, before any reply."
            : "The output limit ran out before any reply."
        : reply.finishReason === "content-filter"
          ? reply.text !== ""
            ? "Stopped by the provider's content filter."
            : "The provider's content filter blocked this reply."
          : undefined;
  const note = reply.failed
    ? `${reply.failed === "continue" ? "Continue" : "Replace"} failed; the reply is as it was.`
    : reply.refusal !== undefined
      ? REFUSAL_NOTE[reply.refusal]
      : reply.busy && reply.status === "failed"
        ? MODEL_BUSY
        : (STATUS_NOTE[reply.status] ?? partial);
  return note ? (
    <p
      className={cn(
        "mt-2 font-sans text-meta",
        reply.status === "failed" || (note === partial && reply.finishReason === "content-filter")
          ? "text-ember"
          : "text-reed",
      )}
    >
      {!reply.failed && reply.refusal === "context_window_unknown" ? <WindowRefusal /> : note}
    </p>
  ) : null;
}

/**
 * A reply refused for want of a context window. A reply does not record its
 * model, so the link opens Context without choosing one; the composer's
 * notice links the current model's window.
 */
function WindowRefusal() {
  return (
    <>
      Not sent: {WINDOW_UNKNOWN}. <WindowLink model={null}>Set one in Settings</WindowLink>, or
      choose another model.
    </>
  );
}

function ReplyTurn({
  message,
  enter,
  last,
  editing,
  folded,
  locked,
  presence,
}: {
  message: AssistantMessage;
  enter: boolean;
  last: boolean;
  editing: boolean;
  folded: boolean;
  locked: boolean;
  presence: boolean;
}) {
  const chosen = useChatCharacter();
  const character = chosen?.name ?? "Model";
  // One light for the reply: the portrait's rim where the float shows one (Presence), else the hairline.
  const rim = useFormFactor() !== "phone" && chosen?.portrait != null;
  const showHidden = useSetting((settings) => settings.showHiddenReasoning);
  const reply = shownReply(message);
  const streaming = reply.status === "streaming";
  const kind = message.greeting ? "greeting" : "reply";
  return (
    <li
      data-message=""
      data-role="assistant"
      data-status={reply.status}
      data-greeting={message.greeting ? "" : undefined}
      data-folded={folded ? "" : undefined}
      className={cn(
        "group relative",
        enter && (message.greeting ? GREET : "arrive"),
        folded && FOLDED,
      )}
    >
      <Nameplate voice="story" name={character} writing={streaming && !rim} />
      {/* Under the nameplate, so it sticks clear of the portrait; the reply's text wraps around it. */}
      {presence && <Presence placement="float" />}
      <div className="prose-turn min-w-0 text-story-phone tablet:text-story">
        {editing ? (
          <EditField id={message.id} label={`Edit ${character}'s ${kind}`} story />
        ) : (
          <>
            {reply.reasoning !== "" ? (
              <Reasoning
                key={reply.id}
                reply={reply}
                messageId={message.id}
                editable={!locked && !folded}
              />
            ) : (
              showHidden && reply.hiddenMs !== undefined && <HiddenReasoning ms={reply.hiddenMs} />
            )}
            <div data-prose="" data-voice="story" className="voice-story voice-scene">
              <SwipeFrame replyId={reply.id} swipeable={last}>
                <Prose text={formatLocationLine(reply.text)} streaming={streaming} />
              </SwipeFrame>
              <ReplyNote reply={reply} last={last} />
            </div>
          </>
        )}
      </div>
      {!editing && !locked && reply.status !== "waiting" && (
        <TurnActions id={message.id} speaker={`${character}'s ${kind}`} />
      )}
    </li>
  );
}
