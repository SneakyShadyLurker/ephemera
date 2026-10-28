import type { InspectedPrompt } from "@ephemera/core";

type Message = InspectedPrompt["messages"][number];
type Source = Message["source"];

/** Every source a message carries: post-processing can merge several into one. */
const sources = (message: Message): Source[] => [message.source, ...(message.merged ?? [])];

/** Chat turns and what sits among them, by depth: lorebook entries placed there, recalled memories and the event included. */
const inChat = (source: Source) =>
  source.kind === "history" ||
  source.kind === "characterNote" ||
  source.kind === "castState" ||
  source.kind === "event" ||
  (source.kind === "memory" && source.part === "recalled") ||
  ((source.kind === "custom" || source.kind === "authorsNote") && source.depth !== null) ||
  (source.kind === "lorebook" &&
    (source.position === "depth" || (source.position === "authorsNote" && source.depth !== null)));

const sum = (messages: Message[]) => messages.reduce((total, message) => total + message.tokens, 0);

/**
 * How the inspector splits a sent prompt: the blocks before and after the
 * chat, the chat band between them, and the token figures. The band is the
 * run of chat messages; a Continue's reply, sent after the post-history
 * instructions, follows them outside it but still counts as chat. A merged
 * message belongs to the chat when any of its sources does; its tokens
 * cannot be split, so they count as chat history, and only an unmerged draft
 * counts as the draft.
 */
export function promptParts(messages: Message[], draftIndex: number | null) {
  const inBand = (message: Message) => sources(message).some(inChat);
  const isDraftSource = (source: Source) =>
    draftIndex !== null && source.kind === "history" && source.index === draftIndex;
  const first = messages.findIndex(inBand);
  const end =
    first === -1 ? -1 : messages.findIndex((message, at) => at > first && !inBand(message));
  const last = first === -1 ? -1 : end === -1 ? messages.length : end;
  const before = first === -1 ? messages : messages.slice(0, first);
  const band = first === -1 ? [] : messages.slice(first, last);
  const after = first === -1 ? [] : messages.slice(last);
  const turns = messages.flatMap(sources).filter((source) => source.kind === "history");
  const lorebookInChat = (source: Source) => source.kind === "lorebook" && inChat(source);
  return {
    before,
    band,
    after,
    blocks: sum([...before, ...after].filter((message) => !inBand(message))),
    draft: sum(
      messages.filter((message) => message.merged === undefined && isDraftSource(message.source)),
    ),
    /** Chat turns sent, the draft left out. */
    turns: turns.filter((source) => !isDraftSource(source)).length,
    hasDraft: turns.some(isDraftSource),
    /** Band messages that carry lorebook entries placed in the chat or with its Author's Note. */
    lorebookBlocks: band.filter((message) => sources(message).some(lorebookInChat)).length,
    /** Whether the message is the draft, or opens with it. */
    isDraft: (message: Message) => isDraftSource(message.source),
  };
}
