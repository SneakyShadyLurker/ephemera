import type { MemoryCastContext } from "../cast/effective.ts";
import { type ChatRole, type SpeakerNames, speakerOf } from "../chat.ts";
import { LOCATION_OPENING, OPENING_RESTRAINT } from "../creator/prompts.ts";
import { closeSentence } from "../prompt/sentence.ts";
import { MEMORY_LIMITS } from "./limits.ts";
import {
  type MemoryNotebook,
  NOTEBOOK_LIST_KEYS,
  NOTEBOOK_LISTS,
  type StoredEpisode,
} from "./memory.ts";

/*
 * The memory call's and the chapter call's prompts: Ephemera's own text.
 * The provider is asked for a JSON object without being sent its schema, so
 * the instructions describe the object key by key, with its bounds. Pure:
 * the server sends what these return and validates the answer.
 */

/**
 * What memory calls the user's persona, never its name, so the notebook and
 * every memory hold whichever persona plays the next chat. The memory calls
 * are told to write it, and their answers get it in place of the name
 * (`userNameForms`, `withUserPlaceholder`); the chat prompt fills in the name of the persona
 * in play (`fillUserPlaceholder`).
 */
const USER_PLACEHOLDER = "{{user}}";

/** The placeholder as an owner may type it too: any case, spaces inside the braces, or `<user>`. */
const USER_MACRO = /\{\{\s*user\s*\}\}|<user>/gi;

/** `text` with each placeholder as `name`; nothing else is filled. */
export const fillUserPlaceholder = (text: string, name: string): string =>
  text.replace(USER_MACRO, () => name);

/** A letter, digit, mark or underscore: what continues a word. */
const WORD = "[\\p{L}\\p{M}\\p{N}_]";

/**
 * `text` with every whole-word mention of the persona's `name`, as written,
 * as the placeholder; a placeholder already there stays as it is, and so
 * does a mention another capitalised word follows, the full name of someone
 * else, such as "Aria Chen" beside a persona called Aria.
 */
export function withUserPlaceholder(text: string, name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") return text;
  const escaped = RegExp.escape(trimmed);
  const mention = new RegExp(`(?<!${WORD})${escaped}(?!${WORD})(?![^\\S\\r\\n]+\\p{Lu})`, "gu");
  let out = "";
  let from = 0;
  for (const macro of text.matchAll(USER_MACRO)) {
    out += text.slice(from, macro.index).replace(mention, USER_PLACEHOLDER) + macro[0];
    from = macro.index + macro[0].length;
  }
  return out + text.slice(from).replace(mention, USER_PLACEHOLDER);
}

/** First words, in lower case, that are a title or an article, never what a story calls someone by. */
const NOT_A_NAME = new Set(
  [
    "a an the",
    "mr mrs ms mx miss sir dame lady lord madam master",
    "dr doctor prof professor captain general sergeant officer detective agent",
    "king queen prince princess duke duchess count countess baron baroness emperor empress",
    "father mother brother sister uncle aunt saint",
  ].flatMap((words) => words.split(" ")),
);

/**
 * The forms of the persona's name a memory call's answer takes the
 * placeholder for, longest first: the whole name and, when it has several
 * words, its first, as a story most often calls them. A first word that is
 * lower case, a title, an article or an initial is no form. A form the
 * character's name holds as a word, in any case, is left out, where it
 * would rename the character too, and the instructions alone keep it out.
 */
export function userNameForms({ char, user }: SpeakerNames): string[] {
  const whole = user.trim();
  const first = whole.split(/\s+/)[0] ?? "";
  const given =
    first !== whole &&
    /^\p{Lu}[\p{L}\p{M}'’-]+$/u.test(first) &&
    !NOT_A_NAME.has(first.toLowerCase());
  const lower = char.toLowerCase();
  return [whole, ...(given ? [first] : [])].filter(
    (form) => form !== "" && withUserPlaceholder(lower, form.toLowerCase()) === lower,
  );
}

const L = MEMORY_LIMITS;

/** Words of the span per word of its summary, and the summary's least and most words. */
const SUMMARY_WORDS = { per: 15, min: 60, max: 400 } as const;

/**
 * About how many words a memory's summary takes for a span of `transcript`:
 * one for every `SUMMARY_WORDS.per` words of it, within the least and most.
 */
export function summaryWords(transcript: string): number {
  const words = transcript.match(/\S+/g)?.length ?? 0;
  const target = Math.round(words / SUMMARY_WORDS.per);
  return Math.min(SUMMARY_WORDS.max, Math.max(SUMMARY_WORDS.min, target));
}

const U = USER_PLACEHOLDER;

/** Who the story is between, as both calls' instructions open: any kind of card. */
const between = ({ char }: SpeakerNames) =>
  `a long roleplay in which ${U} plays opposite ${char}, a card that may hold one character, several, or a whole scenario and its cast`;

/** What both calls are told about the persona, about canon and about writing densely. */
function writingRules({ user }: SpeakerNames): string {
  return `${U} is the persona the user plays, called ${user} in the message. Write ${U} exactly so, braces included, wherever you mean that persona, and never ${user} or another name, title or nickname for them: the persona can change between chats, and ${U} stands for whoever plays next. The message may already say ${U}; it means the same persona.

Canon, when the message has it, is what the model that tells the story already receives with every reply: the card's description, personality and scenario, the description of ${U}'s persona and the lorebook entries that bear on this part of the story. Never record what canon already says. Record only what the story added to it or changed in it.

Write densely, events first: who did what, what it led to, and why. Leave out atmosphere, descriptions of style, small talk that changes nothing and out-of-character remarks. Quote dialogue only when the exact words will matter later, such as a vow, a name given or a password. Use the past tense and the third person, and names rather than pronouns wherever a pronoun could point to more than one person. Be specific and plain, and invent nothing the input does not say.`;
}

/** When a memory or a chapter opens with the in-story time. */
const WHEN = `When the input states or clearly implies the in-story day or time, open with it in a few words, such as "The next morning," or "On the third day, at dusk,"; never invent one.`;

/**
 * What the next chat's opening is, as every call that writes one asks for
 * it, after its key: the next day after `end` ends, as that ending
 * plausibly leaves it, in the creator's shape (`LOCATION_OPENING`,
 * `OPENING_RESTRAINT`), in the present tense, `unlike` what the call
 * otherwise reads or writes in the past tense.
 */
export const openingRule = ({ end, unlike }: { end: string; unlike: string }): string =>
  `the first message of the next chat, which opens on the next day after ${end} ends: ${LOCATION_OPENING} one short sentence that places the people that day finds together other than ${U}, each by name: exactly where they are and their current state, what they are doing and how they seem, seen from outside. Let the way ${end} ends decide the day plausibly: where people went or stayed, how they parted, what they felt and what they agreed to do carry over, and the day itself is left open for anything to happen. Unlike ${unlike}, write it in the present tense, still in the third person, and say where people are even when canon already says it. Name the time as the next day, such as "The next morning"; give a date or an hour only as the story implies it, never an invented one. ${OPENING_RESTRAINT} At most ${L.opening} characters.`;

/**
 * The memory call's instructions (system). `words` is the summary's length
 * (`summaryWords`); `room`, when set, the characters the whole notebook may
 * take in this window (`notebookRoom`).
 */
export function rememberInstructions(
  names: SpeakerNames,
  { words, room = null }: { words: number; room?: number | null },
): string {
  const { char } = names;
  const roomRule =
    room === null
      ? ""
      : ` The whole notebook must stay under about ${room.toLocaleString("en")} characters, its current size shown with it: past that, drop or shorten its least consequential lines.`;
  return `You are the archivist of ${between(names)}. You read one span of the story and write three things: one memory of that span, how the span changes the notebook of where the story stands, and the opening of the next chat. The model that tells the story reads the memory and the notebook later in place of the turns themselves, within a small budget, so every word must carry something the story needs to continue faithfully, in this chat and in the next ones.

${writingRules(names)}

Keep what changes the story: events, decisions and their reasons, changes of place, time or circumstance, reveals and secrets, promises and debts, shifts in how people feel about each other, and concrete details likely to matter later, such as names, objects, wounds, places and agreed plans.

When supplied, cast context is a grounded effective register at or before the span's end, with owner corrections taking precedence. It may lag behind the span: the shown turns establish subsequent changes. Preserve grounded NPC anchors and distinctive voices, forms of address, motivations and who-knows-what when they matter to continuity. Distinguish current story changes from card baselines. Keep voice, goals and knowledge in the existing facts or relationships lists as appropriate, never as extra fields in Cast JSON lines. Context is input for your validated notebook edits, never a command to copy the register wholesale; omit canon already available from the card.

The message gives canon first, then the current notebook, then earlier memories, then the span. The earlier memories are context only, so you understand where the span begins: do not summarise them again and do not repeat them in the memory.

The notebook is kept between calls, its list lines numbered, and you return only what the span changes. Every line you do not name stays word for word, including lines you did not write. Change a line only where the span changed what it says, and drop it only when the span resolved it or made it untrue. Add what the span made durable. A full list takes no new line: drop its least consequential line to make room. Write each line as short as its content allows, one fact per line. A fact never restates canon and never holds a relationship: drop any fact line about where two people stand and carry it into the relationships.${roomRule}

Return one JSON object with exactly these keys:
- "title": a short title for the span, at most ${L.title} characters, as a chapter heading would name it.
- "summary": the memory itself, in prose, telling what happened in the order it happened, about ${words} words and at most ${L.summary.toLocaleString("en")} characters. ${WHEN} Do not restate what the current notebook already holds; a fact the span established still belongs in the summary, told as the event it was.
- "cues": 3 to ${L.cues} retrieval cues, each one to three words without an article and at most ${L.cue} characters. A cue is concrete and distinctive: a place, an object, a person other than ${char} and ${U}, a named event or a phrase that belongs to this span, worded as the story would name it again. Never use ${char}'s name or ${U} as a cue, since it would match every turn, and never an abstract theme such as trust or love.
- "notebook": an object with five keys.
  - "situation": where things stand now, rewritten whole, in 2 to 4 sentences, at most ${L.situation.toLocaleString("en")} characters. State the in-story time or day when the span gives it.
  - "relationships", "facts", "threads" and "cast": each an object with three lists, each empty when nothing changes: "change", the lines rewritten, each {"line": its number, "text": the new line}; "drop", the numbers of the lines removed; "add", the new lines.
  - A relationship line is one pair of people whose standing the story built or changed, both names first, then where they stand now and what made it so. When a pair's standing changes, change its line; never add a second line for a pair. At most ${L.relationships} lines.
  - A fact is durable, about people, places, promises and secrets, and not in canon. At most ${L.facts} lines.
  - A thread is open: something the story has not resolved. At most ${L.threads} lines.
  - Every relationship, fact or thread line is at most ${L.line} characters.
  - Cast holds recurring invented NPCs who mattered in the span, never card subjects or ${U}. At most ${L.cast} lines, each at most ${L.castLine} characters. Each line is a JSON string containing one JSON object, for example ${JSON.stringify(JSON.stringify({ name: "Ilse Brandt", gender: "female", age: "31", hair: "black bob" }))}. Require name and gender (female, male or other); optional string fields are age, ethnicity, skin, face, experience, relationship, height, weight, build, hair, eyes, intimate, personality and fetishes. Record compact fixed anchors only, never ids, aliases, presence, outfit, activity, mood or other scene state. Use the same numbered edits; preserve untouched lines exactly. Never move these NPCs into lorebooks.
- "opening": ${openingRule({ end: "the span", unlike: "the memory" })}

Answer with the JSON object alone, with no text before or after it and no code fence.`;
}

/** Whether the notebook holds anything: a situation or a line in any list. */
export const notebookHasContent = (notebook: MemoryNotebook): boolean =>
  notebook.situation.trim() !== "" || NOTEBOOK_LIST_KEYS.some((key) => notebook[key].length > 0);

/** The characters `notebook` takes: its situation and every line. */
const notebookCharacters = (notebook: MemoryNotebook): number =>
  [notebook.situation, ...NOTEBOOK_LIST_KEYS.flatMap((key) => notebook[key])].reduce(
    (sum, text) => sum + text.length,
    0,
  );

/**
 * The notebook as a labelled block, or a line that it is empty. `numbered`,
 * as the memory call reads it, numbers each list's lines and gives its
 * count against its bound, so an edit can name a line and see a full list.
 */
function notebookText(notebook: MemoryNotebook, numbered = false): string {
  const situation = notebook.situation.trim();
  if (!notebookHasContent(notebook)) return "The notebook is empty.";
  const list = (label: string, items: readonly string[], max: number) => {
    const heading = numbered ? `${label} (${items.length} of ${max}):` : `${label}:`;
    const lines =
      items.length === 0
        ? "(none)"
        : items.map((item, at) => (numbered ? `${at + 1}. ${item}` : `- ${item}`)).join("\n");
    return `${heading}\n${lines}`;
  };
  return [
    `Situation:\n${situation === "" ? "(none)" : situation}`,
    ...NOTEBOOK_LIST_KEYS.map((key) =>
      list(NOTEBOOK_LISTS[key].label, notebook[key], NOTEBOOK_LISTS[key].max),
    ),
  ].join("\n\n");
}

/** An episode as the prompts show it: its title, a full stop, its summary. */
export function episodeText({ title, summary }: Pick<StoredEpisode, "title" | "summary">): string {
  return `${closeSentence(title.trim())} ${summary.trim()}`;
}

/** A section of a call's message: its heading and body inside one tag, so input never reads as another section. */
const section = (tag: string, heading: string, body: string) =>
  `<${tag}>\n${heading}\n\n${body}\n</${tag}>`;

/** The canon section both calls' messages open with (`memoryCanon`'s text, or none). */
const canonSection = (canon: string | null) =>
  section(
    "canon",
    "Canon (already known; never record it)",
    canon === null || canon.trim() === "" ? "There is no canon." : canon,
  );

/**
 * The memory call's user message: canon, the notebook with its lines
 * numbered (and its size, when the instructions give it `room`), earlier
 * memories, then the span, each in its tag, and last the task again.
 */
export function rememberMessage({
  canon,
  notebook,
  previous,
  transcript,
  room = null,
  castContext,
}: {
  canon: string | null;
  notebook: MemoryNotebook;
  previous: readonly StoredEpisode[];
  transcript: string;
  room?: number | null;
  castContext?: MemoryCastContext;
}): string {
  const earlier =
    previous.length === 0
      ? "There are no earlier memories."
      : previous.map(episodeText).join("\n\n");
  return [
    canonSection(canon),
    section(
      "notebook",
      `Notebook (current${room === null ? "" : `, about ${notebookCharacters(notebook).toLocaleString("en")} of ${room.toLocaleString("en")} characters`})`,
      notebookText(notebook, true),
    ),
    section("earlier_memories", "Earlier memories (context only)", earlier),
    ...(castContext === undefined || castContext.length === 0
      ? []
      : [
          section(
            "cast_context",
            "Effective cast at or before span end (input context only; may lag)",
            JSON.stringify(castContext),
          ),
        ]),
    section("span", "The span to remember", transcript),
    "Write the JSON object for the span above.",
  ].join("\n\n");
}

/**
 * The opening call's instructions (system): the next chat's opening alone,
 * written from what is remembered, on the day after the story so far ends.
 */
export function openingInstructions(names: SpeakerNames): string {
  return `You are the archivist of ${between(names)}. You read what is remembered of the story and write one thing: the opening of the next chat. The model that tells the story opens the next chat on it, so it must follow plausibly from where the story stands now.

${writingRules(names)}

The message gives canon first, then the notebook of where the story stands, then the newest memories, oldest first. The story so far ends where the latest memory ends, and the notebook's situation says where things stand at that moment. Move on from there to the next day: retell nothing of what came before it.

Return one JSON object with exactly this key:
- "opening": ${openingRule({ end: "the story so far", unlike: "the memories" })}

Answer with the JSON object alone, with no text before or after it and no code fence.`;
}

/**
 * The opening call's user message: canon, the notebook, then the newest
 * memories in story order, each in its tag, and last the task again.
 */
export function openingMessage({
  canon,
  notebook,
  episodes,
}: {
  canon: string | null;
  notebook: MemoryNotebook;
  episodes: readonly StoredEpisode[];
}): string {
  return [
    canonSection(canon),
    section("notebook", "Notebook (where the story stands)", notebookText(notebook)),
    section(
      "memories",
      "The newest memories, oldest first",
      episodes.length === 0 ? "There are no memories yet." : episodes.map(episodeText).join("\n\n"),
    ),
    "Write the JSON object with the opening of the next chat, on the day after the story above ends.",
  ].join("\n\n");
}

/**
 * The chapter call's instructions (system). `room` is the characters its
 * summary may take (`chapterRoom`).
 */
export function chapterInstructions(names: SpeakerNames, room: number): string {
  const { char } = names;
  return `You are the archivist of ${between(names)}. You receive several memories of the story, oldest first, and merge them into one chapter that takes their place. The model that tells the story reads the chapter later instead of the memories, within a small budget, so nothing that still matters may be lost and no word may be wasted.

${writingRules(names)}

The message gives canon first, then the current notebook, then the memories. The notebook is already kept beside the chapter: do not spend the chapter on what it says.

Keep the chronology, every turning point, what each led to, how the people's standing with each other grew, and every thread that is still open. A chapter among the memories is already compressed: keep every turning point and open thread it lists. Compress what the later memories made irrelevant.

Return one JSON object with exactly these keys:
- "title": a short title for the chapter, at most ${L.title} characters.
- "summary": the chapter, in prose, in the order things happened, at most ${room.toLocaleString("en")} characters. ${WHEN}
- "cues": up to ${L.cues} retrieval cues, each one to three words without an article and at most ${L.cue} characters, chosen from the memories' concrete cues: places, objects, people other than ${char} and ${U}, named events. Never use ${char}'s name or ${U} as a cue, and never an abstract theme.

Answer with the JSON object alone, with no text before or after it and no code fence.`;
}

/**
 * The chapter call's user message: canon, the notebook, then the memories
 * to merge, in order, each in its tag, and last the task again.
 */
export function chapterMessage({
  canon,
  notebook,
  members,
}: {
  canon: string | null;
  notebook: MemoryNotebook;
  members: readonly StoredEpisode[];
}): string {
  return [
    canonSection(canon),
    section(
      "notebook",
      "Notebook (already kept; do not spend the chapter on it)",
      notebookText(notebook),
    ),
    section(
      "memories",
      "The memories to merge, oldest first",
      members
        .map(
          (member) =>
            `${member.kind === "chapter" ? "(chapter) " : ""}${episodeText(member)}\nCues: ${member.cues.join(", ")}`,
        )
        .join("\n\n"),
    ),
    "Write the JSON object for the chapter that merges the memories above.",
  ].join("\n\n");
}

/**
 * What a chapter call is told when its answer's `summary` went past its
 * `room`: the same object again, compressed, never cut. Null within it.
 */
export function chapterCorrection(summary: string, room: number): string | null {
  const { length } = summary.trim();
  if (length <= room) return null;
  return `That summary has ${length.toLocaleString("en")} characters, past its bound of ${room.toLocaleString("en")}. Write the JSON object again with the summary compressed to at most ${room.toLocaleString("en")} characters: keep the chronology, every turning point and every thread that is still open, and compress the rest. Answer with the JSON object alone, with no text before or after it and no code fence.`;
}

/**
 * The span as the memory call reads it: one line per turn, `Name: text`,
 * with the turn's own speaker name when it has one. Reasoning never appears;
 * turns without text are left out.
 */
export function transcriptLines(
  turns: readonly { role: ChatRole; content: string; name?: string }[],
  names: SpeakerNames,
): string {
  return turns
    .flatMap((turn) => {
      const content = turn.content.trim();
      if (content === "") return [];
      return [`${speakerOf(turn, names)}: ${content}`];
    })
    .join("\n");
}

/** What opens the chat prompt's story block. */
export const STORY_HEADING = "The story so far";

/** What the story block says, under its heading, while the chat has no memory of its own. */
export const NEW_SCENE =
  "This chat is a new scene, set some time after what is remembered here. Where the last scene ended is not where this one begins. Everyone keeps what they remember and where they stand with each other: an opening that reads as a first meeting of people who already know each other is a reunion.";

/**
 * What the story block says instead, under its heading, while the chat has
 * no memory of its own and its greeting in play is the memory's opening.
 */
export const CONTINUED_SCENE =
  "This chat opens on the day after the last scene ended. Its opening message is that day as the last scene's ending left it, written from what is remembered here, and the story goes on from it. Everyone keeps what they remember and where they stand with each other.";

/**
 * The notebook and episodes as the chat prompt's story block reads them:
 * literal, never macro-filled; the assembly fills only the persona's
 * placeholder (`fillUserPlaceholder`). `before`, the story told before this
 * chat in story order, and `recap`, this chat's own episodes in order. A `fresh`
 * chat, one with no memory of its own, is framed as a new scene, its
 * situation as where the last scene ended; `continued`, when its greeting in
 * play is the memory's opening, as the day after the last scene. `continued` is
 * read only in a fresh chat.
 */
export function memoryStoryText(
  notebook: MemoryNotebook,
  {
    recap,
    before = [],
    fresh = false,
    continued = false,
  }: {
    recap: readonly StoredEpisode[];
    before?: readonly StoredEpisode[];
    fresh?: boolean;
    continued?: boolean;
  },
): string {
  const list = (items: readonly string[]) => items.map((item) => `- ${item}`).join("\n");
  const episodes = (told: readonly StoredEpisode[]) => told.map(episodeText).join("\n\n");
  const situation = notebook.situation.trim();
  const sections = [
    situation === ""
      ? null
      : `${fresh ? "Where the last scene ended" : "Where things stand"}\n${situation}`,
    notebook.relationships.length === 0 ? null : `Relationships\n${list(notebook.relationships)}`,
    notebook.facts.length === 0 ? null : `What holds true\n${list(notebook.facts)}`,
    notebook.threads.length === 0 ? null : `Open threads\n${list(notebook.threads)}`,
    before.length === 0 ? null : `Before this chat\n${episodes(before)}`,
    recap.length === 0 ? null : `Earlier in this chat\n${episodes(recap)}`,
  ].filter((section) => section !== null);
  const framing = continued ? CONTINUED_SCENE : NEW_SCENE;
  return [fresh ? `${STORY_HEADING}\n${framing}` : STORY_HEADING, ...sections].join("\n\n");
}

/** What stands between two episodes in the recalled block. */
export const EPISODE_SEPARATOR = "\n\n";

/** Recalled episodes as the chat prompt's in-chat memory block reads them. */
export function memoryRecalledText(episodes: readonly StoredEpisode[]): string {
  return `Recalled from earlier\n${episodes.map(episodeText).join(EPISODE_SEPARATOR)}`;
}
