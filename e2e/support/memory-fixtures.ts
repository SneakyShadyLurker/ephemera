/**
 * What the mock upstream answers a memory call, a chapter call and an
 * opening call with:
 * fixed synthetic prose about a harbour, a letter and a chandler, which
 * holds no canary and nothing of the span it was sent. Each answer ends on
 * a ledger number of its own, so a test can find that one memory's text
 * wherever it was written. A summary weighs a little over 250 tokens by the
 * boundary estimate, so four in a recap pass the smallest recap budget
 * (1,000 tokens) and roll up.
 */

/** The opening every memory and chapter call's instructions share (packages/core/src/memory/prompt.ts). */
const ARCHIVIST = "You are the archivist of a long roleplay in which ";
/** What only a memory call's instructions say. */
const MEMORY_TASK = "one memory of that span";
/** What only a chapter call's instructions say. */
const CHAPTER_TASK = "merge them into one chapter";
/** What only an opening call's instructions say. */
const OPENING_TASK = "write one thing: the opening of the next chat";

export type MemoryCall = "memory" | "chapter" | "opening";

/** The memory, chapter or opening call a request is, by its system instructions; null for any other. */
export function memoryCall(messages: { role: string; content: string }[]): MemoryCall | null {
  const system = messages.find((message) => message.role === "system")?.content ?? "";
  if (!system.startsWith(ARCHIVIST)) return null;
  if (system.includes(MEMORY_TASK)) return "memory";
  if (system.includes(CHAPTER_TASK)) return "chapter";
  if (system.includes(OPENING_TASK)) return "opening";
  return null;
}

export const MEMORY_TITLE = "The letter at the harbour";
export const MEMORY_CAST_NAME = "Ilse Brandt";
export const MEMORY_SITUATION =
  "The sealed letter lies in the chandler's back room, unread. The harbour master expects an answer by the next tide.";
export const MEMORY_FACT = "The chandler keeps a ledger of every ship that docks after dark.";
export const MEMORY_THREAD = "Who sealed the letter with green wax?";
export const MEMORY_RELATIONSHIP =
  "The chandler and the harbour master: civil on the quay, each now watching the other.";
export const CHAPTER_TITLE = "The chandler's season";
/** The placing sentence of the next chat's opening, the persona as `{{user}}`. */
export const MEMORY_OPENING_SCENE =
  "The chandler stands at the open strongbox with the sealed letter in hand while {{user}} waits by the shuttered window.";
/** The next chat's opening every memory call writes: a Location line, then the placing sentence. */
export const MEMORY_OPENING = `> Location: The back room of the chandlery, after dark\n\n${MEMORY_OPENING_SCENE}`;

/** The placing sentence of an opening Regenerate writes, the persona as `{{user}}`. */
const REGENERATED_OPENING_SCENE =
  "The harbour master waits on the quay with his lantern lit while {{user}} counts the empty moorings.";
/** The opening an opening call writes: a Location line, then the placing sentence. */
export const REGENERATED_OPENING = `> Location: The quay at low tide, before dawn\n\n${REGENERATED_OPENING_SCENE}`;

const SUMMARY = [
  "A sealed letter arrived at the harbour on the evening boat, addressed to no one by name and closed with green wax.",
  "The chandler took it in from the boatman, set it beside the lamp oil and the coils of tarred rope, and said nothing of it until the shop was shut.",
  "Later that night the harbour master came by with a lantern and asked whether any post had come off the boat.",
  "The chandler said only that a parcel of wicks had arrived, and the harbour master left without buying anything.",
  "In the back room the chandler held the letter to the lamp and saw that it had been opened once and sealed again with a second, darker wax.",
  "A list of ship names was written in the margin of the chandler's ledger the next morning, each with a small cross beside it.",
  "By noon the fog had lifted from the quay, and three of the ships on that list had left without clearing their cargo.",
  "The chandler closed the shop early, locked the letter in the strongbox under the counter and went down to the water to count the moorings that stood empty.",
].join(" ");

const CHAPTER_SUMMARY = [
  "Over one season the chandler's shop by the harbour became the place where unsigned letters waited for their readers.",
  "The harbour master grew suspicious of the ships that left at night, and the chandler kept a ledger of each one, never saying who asked for it.",
].join(" ");

/** A ledger number of this answer's own. */
const ledger = () => `Ledger ${crypto.randomUUID().slice(0, 8)}.`;

/**
 * A memory call's answer: the object alone, or with `prose`, wrapped in a
 * sentence and a code fence as a model that ignores the instructions writes
 * it, which the server's repair reads.
 */
export function memoryAnswer({ prose }: { prose: boolean }): string {
  const object = JSON.stringify({
    title: MEMORY_TITLE,
    summary: `${SUMMARY} ${ledger()}`,
    cues: ["harbour", "sealed letter", "green wax", "chandler's ledger"],
    // Lines only added: a repeat of one the notebook holds is skipped, so every call leaves
    // the same notebook.
    notebook: {
      situation: MEMORY_SITUATION,
      relationships: { change: [], drop: [], add: [MEMORY_RELATIONSHIP] },
      facts: {
        change: [],
        drop: [],
        add: [MEMORY_FACT, "The harbour master walks the quay with a lantern every night."],
      },
      threads: {
        change: [],
        drop: [],
        add: [MEMORY_THREAD, "Why did three ships leave without clearing their cargo?"],
      },
      cast: {
        change: [],
        drop: [],
        add: [
          JSON.stringify({
            name: MEMORY_CAST_NAME,
            gender: "female",
            age: "31",
            hair: `black bob; ${ledger()}`,
          }),
        ],
      },
    },
    opening: MEMORY_OPENING,
  });
  return prose
    ? `Here is the memory of that span.\n\n\`\`\`json\n${object}\n\`\`\`\n\nI kept to the facts of the scene.`
    : object;
}

/** A chapter call's answer. */
export function chapterAnswer(): string {
  return JSON.stringify({
    title: CHAPTER_TITLE,
    summary: `${CHAPTER_SUMMARY} ${ledger()}`,
    cues: ["harbour", "chandler's ledger", "night ships"],
  });
}

/** An opening call's answer. */
export function openingAnswer(): string {
  return JSON.stringify({ opening: REGENERATED_OPENING });
}
