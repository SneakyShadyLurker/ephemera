import { clipText, textLength } from "../card/limits.ts";
import type { SheetFields } from "../card/schema.ts";
import { type SpeakerNames, speakerOf } from "../chat.ts";
import { savedCardArtSource } from "../creator/saved-art-source.ts";
import type { CreatorKind } from "../creator/schema.ts";
import {
  BOUNDARY_BYTES_PER_TOKEN,
  clipTailToTokens,
  estimateTokens,
  utf8Bytes,
} from "../tokens.ts";
import { SCENE_LIMITS } from "./limits.ts";

/*
 * The scene source: what the prompt model reads to picture the chat's
 * current moment. Chat content (PRINCIPLES.md 1): built in the tab, sent
 * with one request, never kept.
 */

/** A shown turn as the excerpt reads it. */
type SceneTurn = { role: string; content: string; name?: string | undefined };

const SEPARATOR = "\n\n";

/**
 * The chat's latest shown turns, oldest first, each as "Speaker: text" and
 * separated by blank lines: walking back from the newest, it stops before a
 * turn that would take the whole past `excerptTokens` or `excerptTurns`. The
 * newest turn is always kept; alone over the budget, it keeps its end, the
 * scene's latest state. No turns give "".
 */
export function sceneExcerpt(
  turns: readonly SceneTurn[],
  names: SpeakerNames,
  limits: { excerptTokens: number; excerptTurns: number } = SCENE_LIMITS,
): string {
  const budget = limits.excerptTokens * BOUNDARY_BYTES_PER_TOKEN;
  const lines: string[] = [];
  let bytes = 0;
  for (let index = turns.length - 1; index >= 0 && lines.length < limits.excerptTurns; index--) {
    const turn = turns[index];
    if (turn === undefined) break;
    const label = `${speakerOf(turn, names)}: `;
    const line = `${label}${turn.content}`;
    const added = utf8Bytes(line) + (lines.length === 0 ? 0 : utf8Bytes(SEPARATOR));
    if (bytes + added <= budget) {
      lines.unshift(line);
      bytes += added;
      continue;
    }
    if (lines.length === 0) {
      lines.push(
        `${label}${clipTailToTokens(turn.content, limits.excerptTokens - estimateTokens(label))}`,
      );
    }
    break;
  }
  return lines.join(SEPARATOR);
}

/**
 * The user message's source for a scene: the card's notes as its new art
 * reads them, the people present as the chat's cast register has them
 * (`castPeopleNotes`), who speaks in the excerpt, and the excerpt. Over
 * `SCENE_LIMITS.sourceLength`, the notes are cut first, then the people;
 * the excerpt holds the moment.
 */
export function sceneSource(input: {
  kind: CreatorKind;
  card: Pick<SheetFields, "description" | "personality" | "scenario" | "firstMessage">;
  excerpt: string;
  names: SpeakerNames;
  /** The present people's notes; "" or absent leaves the block out. */
  people?: string;
}): string {
  const { user, char } = input.names;
  // A Scenario's name is its title: the narrator speaks under it, and no one is called that.
  const speaker =
    input.kind === "scenario"
      ? `"${char}" is the scenario's title, under which the narrator speaks.`
      : `The character is "${char}".`;
  const rest = [
    `${speaker} "${user}" is {{user}}, the other voice in the excerpt: context only, never shown.`,
    "",
    "<excerpt>",
    input.excerpt,
    "</excerpt>",
  ].join("\n");
  const block = (tag: string, text: string) =>
    text === "" ? "" : `<${tag}>\n${text}\n</${tag}>\n\n`;
  const assemble = (notes: string, people: string) =>
    `${block("notes", notes)}${block("people", people)}${rest}`;
  /** Room for one block's text beside the others, as the whole's limit leaves it. */
  const room = (whole: string) => Math.max(0, SCENE_LIMITS.sourceLength - (textLength(whole) - 1));
  const notesWhole = savedCardArtSource(input.kind, input.card);
  const people = clipText(input.people ?? "", room(assemble("", "x")));
  const notes = clipText(notesWhole, room(assemble("x", people)));
  return clipText(assemble(notes, people), SCENE_LIMITS.sourceLength);
}
