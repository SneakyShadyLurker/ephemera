import {
  type AnswerBlock,
  type AnswerState,
  type CardAnswer,
  type CreatorKind,
  SCENARIO_BLOCKS,
  SUBJECT_TAGS,
  type SubjectTag,
} from "@ephemera/core";
import { sentence } from "@/lib/text";

/*
 * What the card column shows of an answer, in the order the model writes it:
 * every section is listed from the start, a quiet label until its text
 * arrives, so nothing the owner is reading moves.
 */

export interface CardRow {
  key: string;
  label: string;
  /** A subject's name, shown above its first row. */
  heading?: string;
  state: AnswerState;
  text: string;
}

/** How the owner reads each of a subject's parts. */
const SUBJECT_LABELS: Record<SubjectTag, string> = {
  backgroundstory: "Background",
  appearance: "Appearance",
  personality: "Personality",
  vocabulary: "Voice",
};

/** A subject's four parts, as the card's tags and as the owner reads them. */
export const SUBJECT_PARTS = SUBJECT_TAGS.map((tag) => [tag, SUBJECT_LABELS[tag]] as const);

/** `mara_voss` as a name: "Mara Voss". */
export const blockTitle = (name: string): string =>
  name
    .split("_")
    .filter(Boolean)
    .map((part) => sentence(part))
    .join(" ");

const partOf = (block: AnswerBlock | undefined, name: string) => {
  const inner = block?.blocks.find((candidate) => candidate.name === name);
  return inner === undefined
    ? { state: "absent" as const, text: "" }
    : { state: inner.state, text: inner.text };
};

/** A subject's four parts; before its block opens, the labels alone. */
function characterRows(block: AnswerBlock | undefined, key: string): CardRow[] {
  return SUBJECT_PARTS.map(([name, label], index) => ({
    key: `${key}/${name}`,
    label,
    ...(index === 0 && block !== undefined ? { heading: blockTitle(block.name) } : {}),
    ...partOf(block, name),
  }));
}

const sectionRow = (key: string, label: string, section: { state: AnswerState; text: string }) => ({
  key,
  label,
  state: section.state,
  text: section.text,
});

export function cardRows(kind: CreatorKind, answer: CardAnswer): CardRow[] {
  const rows: CardRow[] = [];
  if (kind !== "scenario") {
    const subjects = answer.blocks.length === 0 ? [undefined] : answer.blocks;
    subjects.forEach((block, index) => {
      rows.push(...characterRows(block, block?.name ?? String(index)));
    });
  } else {
    for (const name of SCENARIO_BLOCKS) {
      const block = answer.blocks.find((candidate) => candidate.name === name);
      rows.push({
        key: name,
        label: name,
        state: block?.state ?? "absent",
        text: block?.text ?? "",
      });
    }
  }
  rows.push(sectionRow("firstMessage", "Opening", answer.firstMessage));
  return rows;
}

/** The edge while the model writes the tagline, which stands under the name rather than in a row. */
export const TAGLINE_EDGE = "tagline";

/**
 * Where text arrives now: the tagline while it is open, else the last
 * section the model has opened, or none before the first.
 */
export const writingEdge = (answer: CardAnswer, rows: CardRow[]): string | undefined =>
  answer.creatorNotes.state === "incomplete"
    ? TAGLINE_EDGE
    : rows.findLast((row) => row.state !== "absent")?.key;

/** What the frame says is being written: the name, the tagline, the section at `edge`, or nothing yet. */
export function writingCaption(
  answer: CardAnswer,
  rows: CardRow[],
  edge: string | undefined,
): string {
  if (edge === undefined) return answer.name.state === "absent" ? "Writing" : "Writing the name";
  if (edge === TAGLINE_EDGE) return "Writing the tagline";
  const label = rows.find((row) => row.key === edge)?.label;
  return label === undefined ? "Writing" : `Writing the ${label.toLocaleLowerCase()}`;
}

/** How far a section has come: opened counts for a little, closed for all of it. */
const STATE_SHARE: Record<AnswerState, number> = { absent: 0, incomplete: 0.3, complete: 1 };

/**
 * How much of the card is written, from 0 to 1, by the answer's top-level
 * sections. The description, most of a card, weighs four. The sections are
 * fixed whatever the model writes inside them and their states only advance,
 * so the measure never steps back as a second subject opens.
 */
export function writingProgress(answer: CardAnswer): number {
  const sections: [{ state: AnswerState }, number][] = [
    [answer.name, 1],
    [answer.description, 4],
    [answer.firstMessage, 1],
    [answer.creatorNotes, 1],
  ];
  const total = sections.reduce((sum, [, weight]) => sum + weight, 0);
  const done = sections.reduce(
    (sum, [section, weight]) => sum + STATE_SHARE[section.state] * weight,
    0,
  );
  return done / total;
}
