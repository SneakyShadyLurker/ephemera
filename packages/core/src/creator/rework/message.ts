import { usesSecondary } from "../../lorebook/activate.ts";
import { joinKeywords } from "../../lorebook/keys.ts";
import { entrySettings } from "../../lorebook/settings.ts";
import type { PersonaFields } from "../../persona.ts";
import { fieldKey, fieldText, type ReworkField, type TextKey } from "./fields.ts";
import type { ReworkCard } from "./schema.ts";

/*
 * The text of a rework request's user message: the persona chosen in the
 * composer, the card as tagged fields under the keys the answer uses, the
 * lorebook, and the owner's request. Each field's text goes in exactly as
 * `fieldText` gives it, on its own lines between its tags, so a find copied
 * from here matches the field once the parser drops the newline on each
 * side (parse.ts). Empty fields are sent as empty tags so the model knows
 * they exist.
 */

const PERSONA_NOTE =
  "The player plays {{user}} as the persona below. Treat it as context for the card: wherever the card or the request concerns {{user}}, keep it consistent with this persona. {{user}} is never one of the card's characters. Always call them {{user}}, never by the persona's name, and do not copy the persona into the card, because the roleplay supplies it separately.";

const PORTRAIT_NOTE = "The portrait is attached.";

const tagged = (key: string, text: string): string => `<${key}>\n${text}\n</${key}>`;

/** A field as sent: its key's tags around its current text; nothing when the card lacks it. */
function sent(card: ReworkCard, field: ReworkField): string[] {
  const text = fieldText(card, field);
  return text === undefined ? [] : [tagged(fieldKey(field), text)];
}

const setting = (value: number | undefined): string =>
  value === undefined || !Number.isFinite(value) ? "not set" : String(value);

/** The book's settings and each entry's flags: context the model reads and never changes. */
function lorebook(card: ReworkCard): string[] {
  const book = card.lorebook;
  if (book === null) return ["<lorebook>", "</lorebook>"];
  const settings = `Book settings, not editable: scan depth ${setting(book.scanDepth)}, token budget ${setting(book.tokenBudget)}, recursive scanning ${book.recursiveScanning === true ? "on" : "off"}.`;
  const entries = book.entries.map((entry, index) => {
    const key = fieldKey({ kind: "entry", index, part: "content" });
    const settings = entrySettings(entry);
    return [
      `<${key}>`,
      ...sent(card, { kind: "entry", index, part: "name" }),
      ...sent(card, { kind: "entry", index, part: "keys" }),
      // Shown so the density rewrite keeps the phrases they match.
      ...(usesSecondary(entry, settings)
        ? [`secondary keywords, not editable: ${joinKeywords(settings.secondaryKeys)}`]
        : []),
      `enabled: ${entry.enabled ? "yes" : "no"}`,
      `always on: ${entry.constant === true ? "yes" : "no"}`,
      // Its keywords are patterns, so the model keeps them as such.
      ...(entry.useRegex ? ["regex: yes"] : []),
      entry.content,
      `</${key}>`,
    ].join("\n");
  });
  return ["<lorebook>", settings, ...entries, "</lorebook>"];
}

/** The user message's text for a rework; the portrait, when sent, is a part of its own. */
export function reworkPrompt(
  card: ReworkCard,
  request: string,
  persona: PersonaFields | null,
  portrait: boolean,
): string {
  const about = persona?.description.trim() ?? "";
  const personaBlock =
    persona === null
      ? []
      : [
          PERSONA_NOTE,
          "",
          "<persona>",
          `<name>${persona.name}</name>`,
          ...(about === "" ? [] : [`<about>\n${about}\n</about>`]),
          "</persona>",
          "",
        ];
  const text = (key: TextKey) => sent(card, { kind: "text", key });
  const cardBlock = [
    "<card>",
    ...text("name"),
    ...text("description"),
    ...text("personality"),
    ...text("scenario"),
    ...text("firstMessage"),
    ...card.alternateGreetings.flatMap((_, index) => sent(card, { kind: "alternate", index })),
    ...text("exampleDialogue"),
    ...text("systemPrompt"),
    ...text("postHistoryInstructions"),
    ...text("creatorNotes"),
    ...text("characterNote"),
    ...sent(card, { kind: "tags" }),
    ...lorebook(card),
    "</card>",
  ];
  return [
    ...personaBlock,
    ...cardBlock,
    "",
    ...(portrait ? [PORTRAIT_NOTE, ""] : []),
    tagged("rework_request", request),
  ].join("\n");
}
