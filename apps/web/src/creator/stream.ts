import {
  type ArtStreamEvent,
  type ComfyuiWorkflowOption,
  type CreatorArtRequest,
  type CreatorArtStatus,
  type CreatorBrainstormEvent,
  type CreatorBrainstormRequest,
  type CreatorCardEvent,
  type CreatorCardRequest,
  creatorArtStatusSchema,
  creatorArtWorkflowsSchema,
  creatorBrainstormEventSchema,
  creatorCardEventSchema,
  decodeArtFrames,
} from "@ephemera/core";
import type { z } from "zod";
import { api } from "../api.ts";

/*
 * The creator's card, brainstorm and art streams (PRINCIPLES.md 1): the
 * description or the brainstorm request goes out, the card, the ideas and the
 * portraits come back, and nothing here keeps any of them.
 * Every request goes through the API client's one fetch owner, which throws
 * `SignedOut` when the sign-in redirect answers instead of Ephemera.
 */

/** Why a creator stream gave no usable answer: an error status, or a body that is not the format. */
export class CreatorStreamError extends Error {
  override name = "CreatorStreamError";
  readonly reason: "http" | "stream";
  constructor(reason: "http" | "stream") {
    super(`Creator stream failed (${reason})`);
    this.reason = reason;
  }
}

/**
 * One validated event per line of an NDJSON body, as the bytes arrive in
 * chunks of any size. Blank lines are the server's keepalive and are
 * skipped. A line that is not JSON or not an event of `schema`, or a body
 * cut mid-line, fails the stream; the error names no content.
 */
export async function* readEvents<Event>(
  body: ReadableStream<Uint8Array>,
  schema: z.ZodType<Event>,
): AsyncGenerator<Event> {
  const parse = (line: string): Event => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new CreatorStreamError("stream");
    }
    const event = schema.safeParse(value);
    if (!event.success) throw new CreatorStreamError("stream");
    return event.data;
  };
  const decoder = new TextDecoder();
  const reader = body.getReader();
  // The open line's text so far, in the pieces it came in: only newly
  // arrived text is searched for its end.
  const open: string[] = [];
  try {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      // A character split across chunks waits for its other bytes.
      const text = decoder.decode(chunk.value, { stream: true });
      let start = 0;
      for (let end = text.indexOf("\n"); end !== -1; end = text.indexOf("\n", start)) {
        open.push(text.slice(start, end));
        const line = open.join("");
        open.length = 0;
        start = end + 1;
        if (line.trim() !== "") yield parse(line);
      }
      if (start < text.length) open.push(text.slice(start));
    }
  } finally {
    // An early return (a stopped card) or a failure cancels the rest of the body.
    reader.cancel().catch(() => {});
  }
  open.push(decoder.decode());
  if (open.join("").trim() !== "") throw new CreatorStreamError("stream");
}

/** The events of an NDJSON `response`; an error status or no body fails at once. */
export async function events<Event>(
  response: Response,
  schema: z.ZodType<Event>,
): Promise<AsyncGenerator<Event>> {
  if (!response.ok || response.body === null) throw new CreatorStreamError("http");
  return readEvents(response.body, schema);
}

/** Writes a card from the owner's description: text as written, then one result or error. */
export async function streamCard(
  request: CreatorCardRequest,
  signal: AbortSignal,
): Promise<AsyncGenerator<CreatorCardEvent>> {
  const response = await api.creator.card.$post({ json: request }, { init: { signal } });
  return events(response, creatorCardEventSchema);
}

/** Brainstorms ten ideas for the request: the kind when classified, the ideas as written, then one result or error. */
export async function streamBrainstorm(
  request: CreatorBrainstormRequest,
  signal: AbortSignal,
): Promise<AsyncGenerator<CreatorBrainstormEvent>> {
  const response = await api.creator.brainstorm.$post({ json: request }, { init: { signal } });
  return events(response, creatorBrainstormEventSchema);
}

/** Paints the card's four portraits: progress, the images, then done; or one error. */
export async function streamArt(
  request: CreatorArtRequest,
  signal: AbortSignal,
): Promise<AsyncGenerator<ArtStreamEvent>> {
  const response = await api.creator.art.$post({ json: request }, { init: { signal } });
  return artEvents(response);
}

/** The art stream's events, decoded from its frames as they arrive. */
export async function* artEvents(response: Response): AsyncGenerator<ArtStreamEvent> {
  if (!response.ok || response.body === null) throw new CreatorStreamError("http");
  const reader = response.body.getReader();
  async function* chunks() {
    try {
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read())
        yield chunk.value;
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
  try {
    yield* decodeArtFrames(chunks());
  } catch {
    throw new CreatorStreamError("stream");
  }
}

/** The server's workflows and the user's, to choose from in Create with AI. */
export async function fetchArtWorkflows(signal?: AbortSignal): Promise<ComfyuiWorkflowOption[]> {
  const response = await api.creator.art.workflows.$get(
    undefined,
    signal ? { init: { signal } } : undefined,
  );
  if (!response.ok) throw new CreatorStreamError("http");
  return creatorArtWorkflowsSchema.parse(await response.json()).workflows;
}

/** Whether portraits can be painted with the saved address and the given workflow. */
export async function fetchArtStatus(
  workflow: string,
  signal?: AbortSignal,
): Promise<CreatorArtStatus> {
  const response = await api.creator.art.status.$get(
    { query: { workflow } },
    signal ? { init: { signal } } : undefined,
  );
  if (!response.ok) throw new CreatorStreamError("http");
  return creatorArtStatusSchema.parse(await response.json());
}
