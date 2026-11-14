import { type ChatTurn, reasoningSentBack } from "@ephemera/core";
import { shownReply } from "./shown-reply.ts";
import type {
  AssistantMessage,
  ChatMessage,
  ChatState,
  Reply,
  Selection,
  Speaker,
  UserMessage,
} from "./store.ts";

export const isUser = (message: ChatMessage): message is UserMessage => message.role === "user";

/**
 * The messages a request carries as turns: failed and empty replies stay out.
 * A reply whose macros filled to nothing goes as the model wrote it.
 */
export function sentMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter(isSent);
}

export function isSent(message: ChatMessage): boolean {
  if (message.role === "user") return message.text !== "";
  const reply = shownReply(message);
  return reply.status !== "failed" && (reply.text !== "" || (reply.rawText ?? "") !== "");
}

/**
 * A turn as sent, with the reply's reasoning for the preset to add or leave
 * out: the user's filled text under the name it was sent as, a greeting or
 * an edited reply as shown, a generated reply as the model wrote it, for each
 * generation to fill again; an edited one a Continue added to keeps its
 * edited start as written.
 */
function turnOf(message: ChatMessage): ChatTurn {
  if (message.role === "user") {
    return message.name === undefined
      ? { role: "user", content: message.text }
      : { role: "user", content: message.text, name: message.name };
  }
  const reply = shownReply(message);
  const { text, rawText, reasoning, generated } = reply;
  const prefix = reply.macroPrefixLength ?? 0;
  const content = rawText ?? text;
  const turn: ChatTurn =
    !message.greeting && generated === true && prefix <= content.length
      ? {
          role: "assistant",
          content,
          macroEligible: true,
          ...(text === content ? {} : { scanText: text }),
          ...(prefix === 0 ? {} : { macroPrefixLength: prefix }),
        }
      : { role: "assistant", content: text };
  return reasoning.trim() === "" ? turn : { ...turn, reasoning };
}

/** A reply sent as shown from now on: its macros are never filled again. */
export const literalReply = ({
  rawText: _raw,
  generated: _generated,
  macroPrefixLength: _prefix,
  ...rest
}: Reply): Reply => rest;

const speakerOf = (message: ChatMessage): Speaker =>
  message.role === "user" && message.personaId !== null
    ? { personaId: message.personaId, name: message.name ?? null }
    : null;

/**
 * The history a request carries, and who spoke each turn.
 * Reasoning the preset does not send back stays in the tab.
 */
export function history(messages: ChatMessage[], reasoning: Selection["reasoning"]) {
  const sent = sentMessages(messages);
  const turns = sent.map(turnOf);
  const kept = reasoning === null ? null : reasoningSentBack(turns, reasoning);
  return {
    turns:
      kept === null
        ? turns
        : turns.map((turn, index) => {
            if (turn.reasoning === undefined || kept.has(index)) return turn;
            const { reasoning: _left, ...rest } = turn;
            return rest;
          }),
    speakers: sent.map(speakerOf),
  };
}

/**
 * The turns a memory call remembers, as the thread shows them: the user's
 * text under the name it was sent as, a reply's shown text; no reasoning,
 * nothing to fill again.
 */
export function shownTurns(messages: ChatMessage[]): ChatTurn[] {
  return sentMessages(messages).flatMap((message): ChatTurn[] => {
    const content = shownText(message);
    if (content.trim() === "") return [];
    return message.role === "user" && message.name !== undefined
      ? [{ role: "user", content, name: message.name }]
      : [{ role: message.role, content }];
  });
}

export const shownText = (message: ChatMessage): string =>
  message.role === "user" ? message.text : shownReply(message).text;

export const newReply = (): Reply => ({
  id: crypto.randomUUID(),
  text: "",
  generated: true,
  reasoning: "",
  thoughtMs: null,
  status: "streaming",
});

/** The last message when it is a reply; only it swipes, regenerates and continues. */
export function lastReply(state: ChatState): AssistantMessage | undefined {
  const last = state.messages.at(-1);
  return last?.role === "assistant" ? last : undefined;
}

/** A new alternate needs the user's turn to answer, right before the reply. */
export function canGenerateAlternate(state: ChatState): boolean {
  const reply = lastReply(state);
  if (reply === undefined || reply.greeting) return false;
  const before = sentMessages(state.messages.slice(0, -1)).at(-1);
  return before?.role === "user";
}
