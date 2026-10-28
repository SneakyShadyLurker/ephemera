import { CREATOR_LIMITS as C, SUBJECT_COUNTS } from "./limits.ts";
import { formatLocationLine } from "./location.ts";
import {
  type CardProblem,
  type CardSection,
  type CreatorKind,
  cardSectionSchema,
  type GeneratedCard,
  generatedCardSchema,
} from "./schema.ts";

/*
 * One reading of the model's tagged plain-text answer, for the live view
 * while it streams and for the final check. Block text is prose, so this
 * scans for tags instead of parsing XML: text outside known tags is ignored,
 * a tag never closed runs to the end of the text, and a tag cut off mid-way
 * at the end of a stream is dropped.
 */

export type AnswerState = "absent" | "incomplete" | "complete";

interface AnswerSection {
  state: AnswerState;
  /** The text inside the tags so far, trimmed; empty when absent. */
  text: string;
}

/** One XML block of the description, with the blocks inside it. */
export interface AnswerBlock {
  name: string;
  state: "incomplete" | "complete";
  /** Everything inside the block, inner tags included, trimmed. */
  text: string;
  blocks: AnswerBlock[];
}

export interface CardAnswer {
  name: AnswerSection;
  description: AnswerSection;
  /** Its text set in the card's opening shape (formatLocationLine). */
  firstMessage: AnswerSection;
  creatorNotes: AnswerSection;
  /** The description's blocks: subjects with their inner tags, or Roleplay, Setting, People and Tone. */
  blocks: AnswerBlock[];
}

/** A subject block's inner tags, in order. */
export const SUBJECT_TAGS = ["backgroundstory", "appearance", "personality", "vocabulary"] as const;
export type SubjectTag = (typeof SUBJECT_TAGS)[number];
/** A Scenario's blocks, in order. */
export const SCENARIO_BLOCKS = ["Roleplay", "Setting", "People", "Tone"] as const;
export type ScenarioBlock = (typeof SCENARIO_BLOCKS)[number];
/** A Scenario's blocks before People had its own, as cards saved then still hold them. */
const LEGACY_SCENARIO_BLOCKS = ["Roleplay", "Setting", "Tone"] as const;
/**
 * Description, block, inner tag, then two deeper: a character block written
 * into a Scenario's, also inside one wrapper such as a <cast>.
 */
const BLOCK_DEPTH = 4;
const BLOCK_NAME = /^\p{Ll}+(?:_\p{Ll}+)*$/u;
/**
 * Card fields the prompts no longer ask for. A model that writes one anyway
 * has it scanned as a section, so tags inside it stay inside it, and dropped.
 */
const IGNORED_SECTIONS = ["scenario", "alternate_greeting", "tags"];
const SECTION_OPEN = `<(${[...cardSectionSchema.options, ...IGNORED_SECTIONS].join("|")})\\s*>`;
/** The characters a block's tag name is written in. */
const TAG_NAME = "[\\p{L}\\p{N}_-]";
const BLOCK_OPEN = `<(${TAG_NAME}{1,${C.blockNameLength}})\\s*>`;
/** An opening or closing tag cut off at the end of a stream. */
const PARTIAL_TAG = new RegExp(`</?${TAG_NAME}*\\s*$`, "u");
/** Any whole opening or closing tag. */
export const ANY_TAG = new RegExp(`</?${TAG_NAME}+\\s*>`, "gu");

export interface Tagged {
  name: string;
  state: "incomplete" | "complete";
  /** Where the opening tag starts. */
  at: number;
  /** Where the closing tag ends, or the end of the text. */
  end: number;
  body: string;
}

/**
 * The tags `open` matches, in order, each up to its closing tag or the end of
 * the text. Tags inside a matched one are skipped: scanning resumes after its
 * closing tag. Shared with the rework parser.
 */
export function scan(text: string, open: string): Tagged[] {
  const opening = new RegExp(open, "gu");
  const found: Tagged[] = [];
  for (let match = opening.exec(text); match !== null; match = opening.exec(text)) {
    const name = match[1] ?? "";
    const start = match.index + match[0].length;
    const closing = new RegExp(`</${name}\\s*>`, "gu");
    closing.lastIndex = start;
    const close = closing.exec(text);
    if (close === null) {
      found.push({
        name,
        state: "incomplete",
        at: match.index,
        end: text.length,
        body: text.slice(start).replace(PARTIAL_TAG, ""),
      });
      break;
    }
    const end = close.index + close[0].length;
    found.push({
      name,
      state: "complete",
      at: match.index,
      end,
      body: text.slice(start, close.index),
    });
    opening.lastIndex = end;
  }
  return found;
}

/** The text around the tags `scan` found in it, each piece trimmed: one more piece than tags. */
function around(text: string, tagged: Tagged[]): string[] {
  const bounds = [0, ...tagged.flatMap(({ at, end }) => [at, end]), text.length];
  return Array.from({ length: tagged.length + 1 }, (_, i) =>
    text.slice(bounds[2 * i], bounds[2 * i + 1]).trim(),
  );
}

function toBlocks(tagged: Tagged[], depth: number): AnswerBlock[] {
  return tagged.map(({ name, state, body }) => {
    const inner = depth < BLOCK_DEPTH ? scan(body, BLOCK_OPEN) : [];
    return { name, state, text: body.trim(), blocks: toBlocks(inner, depth + 1) };
  });
}

/** The blocks of a description text, nested as deep as the card formats go. */
export const descriptionBlocks = (description: string): AnswerBlock[] =>
  toBlocks(scan(description, BLOCK_OPEN), 1);

/**
 * A description's blocks and the text outside its top-level blocks, the
 * pieces trimmed and joined by newlines: how much of a saved card's
 * description the card formats do not hold.
 */
export function descriptionOutline(description: string): {
  blocks: AnswerBlock[];
  outside: string;
} {
  const tagged = scan(description, BLOCK_OPEN);
  const outside = around(description, tagged).filter((piece) => piece !== "");
  return { blocks: toBlocks(tagged, 1), outside: outside.join("\n") };
}

const ABSENT: AnswerSection = { state: "absent", text: "" };

/** Reads an answer, finished or still streaming. */
export function parseCardAnswer(answer: string): CardAnswer {
  const found = scan(answer, SECTION_OPEN).map((tagged): [string, AnswerSection] => [
    tagged.name,
    { state: tagged.state, text: tagged.body.trim() },
  ]);
  const first = (section: CardSection): AnswerSection =>
    found.find(([name]) => name === section)?.[1] ?? ABSENT;
  const description = first("description");
  const opening = first("firstMessage");
  return {
    name: first("name"),
    description,
    firstMessage: { ...opening, text: formatLocationLine(opening.text) },
    creatorNotes: first("creatorNotes"),
    blocks: descriptionBlocks(description.text),
  };
}

type CardAnswerResult =
  | { ok: true; card: GeneratedCard; blocks: AnswerBlock[] }
  | { ok: false; problems: CardProblem[] };

const hasInnerTags = (block: AnswerBlock): boolean =>
  block.state === "complete" &&
  block.blocks.length === SUBJECT_TAGS.length &&
  block.blocks.every((inner, i) => inner.state === "complete" && inner.name === SUBJECT_TAGS[i]);

/*
 * A block inside a Scenario's that holds a subject's parts: a fixed character,
 * which a Scenario never has. Tag-like words in its prose, such as an <i>,
 * hold none and pass.
 */
const characterShaped = (block: AnswerBlock): boolean =>
  block.blocks.some(
    (inner) => SUBJECT_TAGS.some((tag) => tag === inner.name) || characterShaped(inner),
  );

/** Whether the blocks are exactly `names`, in order, each closed. */
const blocksNamed = (blocks: AnswerBlock[], names: readonly string[]): boolean =>
  blocks.length === names.length &&
  blocks.every((block, i) => block.state === "complete" && block.name === names[i]);

/**
 * Whether a saved card's description is in a Scenario layout the creator
 * writes or wrote: the current one, or the three blocks before People.
 */
export const savedScenarioLayout = (blocks: AnswerBlock[]): boolean =>
  descriptionProblems("scenario", blocks).length === 0 ||
  blocksNamed(blocks, LEGACY_SCENARIO_BLOCKS);

/** A subject block on a Subject or Multiple Subjects card. */
export function characterProblems(block: AnswerBlock): CardProblem[] {
  const problems: CardProblem[] = [];
  if (!BLOCK_NAME.test(block.name)) problems.push({ code: "block_name", block: block.name });
  if (!hasInnerTags(block)) problems.push({ code: "block_tags", block: block.name });
  return problems;
}

export function descriptionProblems(kind: CreatorKind, blocks: AnswerBlock[]): CardProblem[] {
  if (kind !== "scenario") {
    const { min, max } = SUBJECT_COUNTS[kind];
    const problems: CardProblem[] =
      blocks.length < min || blocks.length > max
        ? [{ code: "subject_count", count: blocks.length, min, max }]
        : [];
    return [...problems, ...blocks.flatMap(characterProblems)];
  }
  const exact =
    blocksNamed(blocks, SCENARIO_BLOCKS) &&
    !blocks.some((block) => block.blocks.some(characterShaped));
  return exact ? [] : [{ code: "scenario_blocks" }];
}

const REQUIRED: CardSection[] = ["name", "description", "firstMessage"];

/** Checks a finished answer and returns the generated card, or every problem found. */
export function validateCardAnswer(kind: CreatorKind, answer: string): CardAnswerResult {
  const parsed = parseCardAnswer(answer);
  const sections: [CardSection, AnswerSection][] = [
    ["name", parsed.name],
    ["description", parsed.description],
    ["firstMessage", parsed.firstMessage],
    ["creatorNotes", parsed.creatorNotes],
  ];
  const problems: CardProblem[] = [];
  for (const [section, { state }] of sections) {
    if (state === "incomplete") problems.push({ code: "incomplete", section });
  }
  for (const [section, { state, text }] of sections) {
    if (REQUIRED.includes(section) && state !== "incomplete" && text === "") {
      problems.push({ code: "missing", section });
    }
  }
  if (parsed.description.state === "complete" && parsed.description.text !== "") {
    problems.push(...descriptionProblems(kind, parsed.blocks));
  }
  if (problems.length > 0) return { ok: false, problems: problems.slice(0, C.problems) };

  const card = generatedCardSchema.safeParse({
    name: parsed.name.text,
    description: parsed.description.text,
    firstMessage: parsed.firstMessage.text,
    creatorNotes: parsed.creatorNotes.text,
  });
  if (card.success) return { ok: true, card: card.data, blocks: parsed.blocks };
  const tooLong = new Set(card.error.issues.map(({ path }) => cardSectionSchema.parse(path[0])));
  return { ok: false, problems: [...tooLong].map((section) => ({ code: "too_long", section })) };
}
