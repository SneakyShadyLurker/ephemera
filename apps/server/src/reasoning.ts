import type { LanguageModelMiddleware } from "ai";

/*
 * Auto-Parse: a reply that opens with
 * the preset's tag has the tag's content read out as reasoning. Only a
 * block at the start counts, so a story that mentions the tag later stays
 * text. The AI SDK's extractReasoningMiddleware matches the tag anywhere,
 * so it cannot hold that rule.
 */

type WrapStream = NonNullable<LanguageModelMiddleware["wrapStream"]>;
type Streamed = Awaited<ReturnType<Parameters<WrapStream>[0]["doStream"]>>;
type Part = Streamed["stream"] extends ReadableStream<infer T> ? T : never;
type WrapGenerate = NonNullable<LanguageModelMiddleware["wrapGenerate"]>;
type Generated = Awaited<ReturnType<Parameters<WrapGenerate>[0]["doGenerate"]>>;
type Content = Generated["content"][number];
type Text = Extract<Content, { type: "text" }>;

/** The length of the longest end of `text` that begins `tag`: the tag may arrive in pieces. */
function partialTail(text: string, tag: string): number {
  for (let length = Math.min(tag.length - 1, text.length); length > 0; length -= 1) {
    if (tag.startsWith(text.slice(-length))) return length;
  }
  return 0;
}

interface TextPart {
  phase: "start" | "reasoning" | "text";
  /** Text not yet sent on: a possible tag, or the reply's start before it is decided. */
  buffer: string;
  /** Held until the part's first text, so reasoning comes first. */
  start: Part | null;
  /** After the reasoning block, the reply's leading whitespace is dropped. */
  trimLead: boolean;
}

export function startReasoningMiddleware(tag: string): LanguageModelMiddleware {
  const open = `<${tag}>`;
  const close = `</${tag}>`;

  /** A whole reply's text read as its stream would be: a leading block is reasoning. */
  const split = (part: Text): Content[] => {
    const lead = part.text.trimStart();
    if (!lead.startsWith(open)) return [part];
    const end = lead.indexOf(close, open.length);
    if (end === -1) return [{ type: "reasoning", text: lead.slice(open.length) }];
    const after = lead.slice(end + close.length).trimStart();
    return [
      { type: "reasoning", text: lead.slice(open.length, end) },
      ...(after === "" ? [] : [{ ...part, text: after }]),
    ];
  };

  return {
    // The stream sends a reply's text as one part, so its pieces are read as one text here too.
    wrapGenerate: async ({ doGenerate }) => {
      const result = await doGenerate();
      const texts = result.content.filter((part): part is Text => part.type === "text");
      const [first] = texts;
      if (first === undefined) return result;
      const whole = { ...first, text: texts.map((part) => part.text).join("") };
      return {
        ...result,
        content: result.content.flatMap((part) =>
          part.type !== "text" ? [part] : part === first ? split(whole) : [],
        ),
      };
    },
    wrapStream: async ({ doStream }) => {
      const { stream, ...rest } = await doStream();
      const parts = new Map<string, TextPart>();
      const reasoningId = (id: string) => `${id}-reasoning`;

      const transform = new TransformStream<Part, Part>({
        transform(chunk, controller) {
          const text = (id: string, delta: string, part: TextPart) => {
            const value = part.trimLead ? delta.trimStart() : delta;
            if (value === "") return;
            part.trimLead = false;
            if (part.start !== null) controller.enqueue(part.start);
            part.start = null;
            controller.enqueue({ type: "text-delta", id, delta: value });
          };
          const reasoning = (id: string, delta: string) => {
            if (delta !== "")
              controller.enqueue({ type: "reasoning-delta", id: reasoningId(id), delta });
          };
          /** Sends on what the buffer settles, keeping only a possible tag. */
          const settle = (id: string, part: TextPart) => {
            if (part.phase === "start") {
              const lead = part.buffer.trimStart();
              if (lead.length < open.length && open.startsWith(lead)) return;
              if (!lead.startsWith(open)) {
                part.phase = "text";
                text(id, part.buffer, part);
                part.buffer = "";
                return;
              }
              part.phase = "reasoning";
              part.buffer = lead.slice(open.length);
              controller.enqueue({ type: "reasoning-start", id: reasoningId(id) });
            }
            if (part.phase === "reasoning") {
              const end = part.buffer.indexOf(close);
              if (end === -1) {
                const kept = partialTail(part.buffer, close);
                reasoning(id, part.buffer.slice(0, part.buffer.length - kept));
                part.buffer = part.buffer.slice(part.buffer.length - kept);
                return;
              }
              reasoning(id, part.buffer.slice(0, end));
              controller.enqueue({ type: "reasoning-end", id: reasoningId(id) });
              const after = part.buffer.slice(end + close.length);
              part.phase = "text";
              part.buffer = "";
              part.trimLead = true;
              text(id, after, part);
            }
          };

          switch (chunk.type) {
            case "text-start":
              parts.set(chunk.id, { phase: "start", buffer: "", start: chunk, trimLead: false });
              return;
            case "text-delta": {
              const part = parts.get(chunk.id);
              if (part === undefined) break;
              if (part.phase === "text") {
                text(chunk.id, chunk.delta, part);
              } else {
                part.buffer += chunk.delta;
                settle(chunk.id, part);
              }
              return;
            }
            case "text-end": {
              const part = parts.get(chunk.id);
              if (part === undefined) break;
              flush(chunk.id, part, controller);
              if (part.start !== null) controller.enqueue(part.start);
              parts.delete(chunk.id);
              break;
            }
          }
          controller.enqueue(chunk);
        },
        // A stream that ends without closing its text still keeps every character.
        flush(controller) {
          for (const [id, part] of parts) flush(id, part, controller);
        },
      });

      /** What the buffer holds when the text ends: a tag that never came is text. */
      function flush(
        id: string,
        part: TextPart,
        controller: TransformStreamDefaultController<Part>,
      ) {
        if (part.phase === "reasoning") {
          if (part.buffer !== "") {
            controller.enqueue({
              type: "reasoning-delta",
              id: reasoningId(id),
              delta: part.buffer,
            });
          }
          controller.enqueue({ type: "reasoning-end", id: reasoningId(id) });
        } else if (part.buffer !== "") {
          if (part.start !== null) controller.enqueue(part.start);
          part.start = null;
          controller.enqueue({ type: "text-delta", id, delta: part.buffer });
        }
        part.buffer = "";
        part.phase = "text";
      }

      return { stream: stream.pipeThrough(transform), ...rest };
    },
  };
}
