import type { CharacterCard } from "../card/schema.ts";
import type { ChatTurn, SpeakerNames } from "../chat.ts";
import { tagged } from "../creator/art-source.ts";
import { taggedCardKind } from "../creator/saved-art-source.ts";
import { CREATOR_TAGS } from "../creator/sheet.ts";
import { canonFields } from "../memory/canon.ts";
import { transcriptLines } from "../memory/prompt.ts";
import { effectiveCastAnchor } from "./effective.ts";
import { CAST_LIMITS as L } from "./limits.ts";
import { type CastRegister, setAnchorFields } from "./register.ts";

/*
 * The keeper's and the cast sheet's prompts: Ephemera's own text. The
 * provider is asked for a JSON object without being sent its schema, so the
 * instructions describe it key by key. Both instructions are static, so the
 * provider's prefix cache covers them. Pure: the server sends what these
 * return and validates the answer.
 */

/** The anchor's keys, in the present block's order, with what each holds; `man` says a man's intimate body. */
const anchorKeys = (
  man: string,
): string => `- "age": the exact age, such as "18"; for one who is not human, as canon puts it.
- "ethnicity": the ethnicity, or the kind if not human.
- "skin": the skin tone.
- "face": the face's shape, with the nose and the lips.
- "experience": the sexual experience.
- "relationship": the relationship status.
- "height": in centimetres, such as "164cm".
- "weight": in kilograms, such as "58kg".
- "build": the body's build; never the chest.
- "hair": colour, length and style, with its texture.
- "eyes": colour, with their shape.
- "intimate": the intimate body. For a woman, in this order: one exact EU cup size (never a range), the breasts' size and shape, the nipples and areolae; the pussy described graphically, with its lips, clit and hair; then the ass's size and shape. ${man}
- "personality": personality keywords.
- "fetishes": fetishes and taboos together, such as "fetishes: cum, pregnancy; taboos: none".
Metric units throughout. Each detail appears once: build never mentions the chest, and no state field repeats the body. Every value reads on its own and names what it describes, as in "green almond-shaped eyes", "wavy brown bob with a loose texture", "freckled fair skin with a pink undertone" or "oval face, small upturned nose, full lips"; never a bare "blue" or "round".`;

/** The keeper instructions' first sentence, for the mock upstream to know the call by. */
export const KEEPER_OPENING =
  "You keep the cast register of a private adult roleplay; you do not write the story.";

const KEEPER_INSTRUCTIONS = `${KEEPER_OPENING} The model that tells the story reads the register with every reply in place of describing people again, so the register keeps every detail of every person consistent for the rest of the story.

The register holds one entry per NPC, male and female, and never the player, whose name the message gives. An entry has a role, "principal" or "minor"; a gender, "female", "male" or "other"; an anchor, written once and fixed after; and a state that follows the scene. An entry's key is the NPC's full name as the story writes it.

The anchor's keys, in this order:
${anchorKeys("For a man, his cock and balls. Outside a Scenario's new-NPC canonical completion, only once a turn shows them; until then leave it empty.")}

The state's keys:
- "present": true while the NPC is in the scene, false once they left it.
- "outfit": every garment they have on now, outer layers to underwear and footwear, each with its colour and material as shown; a piece taken off leaves it.
- "disarray": the state of their clothes, only while not worn as normal: undone, open, pushed aside, pulled up or down, wet, torn or stained, garment by garment; then the pieces taken off and where they are now.
- "position": where they are and their posture.
- "activity": what they are doing.
- "mood": how they seem to feel from player-observable cues, never a private emotion.
- "arousal": only while it outwardly shows or is communicated.
- "injuries": only while seen or communicated.
- "intoxication": only while perceptibly drunk or high.
Each state value reads on its own as well and names what it describes, as in "grey hoodie over black jeans" or "leaning on the bar by the door"; never a bare "grey" or "sitting".

Rules:
- Answer only with changes. Every entry, key and field you leave out stays as it is.
- The canonical anchor is the NPC's complete truth, not what the player knows. An anchor field once set is fixed: never send it again, never paraphrase or correct it. Fill an empty one only.
- Except for a new NPC in a Scenario, extract an anchor only from explicit canon or turn evidence, copying its words exactly. Leave unknown fields empty or omitted, regardless of role. Never invent details to complete a record or expose hidden anatomy or history.
- For a new NPC in a Scenario, create one complete, coherent canonical anchor at introduction: preserve every established fact and invent what remains hidden, including anatomy, personality and preferences. This is the only permitted gap filling. Invented canon is not player discovery.
- Name everyone who left the scene in "absent".
- When a known NPC is named more fully, such as "Ilse" becoming "Ilse Brandt", key the change by the full name and give the earlier one in "was".
- Never write an entry for the player, by any of their names.

Return one JSON object with exactly these keys:
- "cast": an object keyed by full name; each value an object with any of "was", "role", "gender", "anchor" (the anchor's keys), "state" (the state's keys), "introduce" and "discovered". {} when nothing changed.
- "absent": the names of the NPCs no longer in the scene at the end of the turns; [] when none.

For example:
{"cast":{"Mara Battin":{"state":{"outfit":"a white bath towel","disarray":"towel slipping at her chest; her jeans and grey T-shirt on the bathroom floor","activity":"drying her hair","mood":"flustered"}},"Jonas Reyes":{"role":"minor","gender":"male","anchor":{"age":"34","ethnicity":"Mexican-American","build":"broad, heavy-set build"},"state":{"position":"standing behind the bar","activity":"polishing a glass"}}},"absent":["Ana Pires"]}

Answer with the JSON object alone, with nothing before or after it and no code fence.`;

/** The keeper call's instructions (system): static, identical for every call. */
export const keeperInstructions = (): string => `${KEEPER_INSTRUCTIONS}

Each cast change may also have:
- "developments": an object keyed only by the anchor's text fields (never name or gender). Use it for explicit durable transitions to already established facts, such as changed age, relationship, experience, hair or physique. The anchor remains the card/initial baseline; the register shows effective current values. Empty baseline fields still use "anchor".
- "continuity": optional "voice", "goals" and "knowledge" cues. Preserve distinctive speech and forms of address, motivations, and who knows what without inventing psychology or shared knowledge.
Each populated field in either object is {"value":"short current fact", "evidence":"exact short quote from these turns"}, both nonempty and at most ${L.field} characters. Only update from the shown batch, never canon alone or speculation. Omitted cues stay unchanged; an explicitly ended goal or disproven belief may be recorded as such. Evidence must quote the text exactly; it grounds the update without proving its meaning. Never overwrite an owner's corrected field.

The Cast panel shows player knowledge, never hidden canon:
- "introduce": {"evidence":"exact short quote"} when the player first encounters or learns of an NPC. Presence alone is not introduction; once introduced, omit this key.
- "discovered": an object keyed only by the anchor's text fields. Each populated field is {"value":"what the player now knows", "basis":"seen", "told" or "demonstrated", "evidence":"exact short quote from these turns"}. Omit undiscovered and unchanged fields. A discovery may refine an earlier approximation.
- Canon and durable developments never reveal themselves. Every introduction and discovery needs player-accessible evidence in the shown batch, not the card, private NPC thoughts or speculation.
- "seen" is direct observation, "told" preserves what someone said as a claim when appropriate, and "demonstrated" is a trait or preference established by conduct.
- Record visible looks only when seen. Exact measurements require explicit knowledge; otherwise use a visual approximation. Clothing permits only a vague silhouette in "build", never concealed "intimate" detail. Intimate anatomy requires actual exposure and observation; an exact cup size requires it to be stated or otherwise established.
- Personality, experience, relationships, fetishes, taboos, goals and private knowledge enter only when learned through dialogue or demonstrated conduct. Mood and arousal must be perceptible or communicated. Once discovered, a field stays known while the NPC is away.
- State is what the player can observe now: keep private thoughts, unseen actions and concealed injuries out of it as well.`;

/**
 * The card's fields as the keeper's canon, names filled: description,
 * personality and scenario, and the persona's description when given.
 * Null when all are blank.
 */
export function castCanon(
  card: Pick<CharacterCard, "description" | "personality" | "scenario">,
  names: SpeakerNames,
  persona = "",
): string | null {
  const fields = canonFields({ card, names, persona });
  return fields === "" ? null : fields;
}

/** The register as the keeper reads it: compact JSON by entry, ids and empty fields left out. */
function registerJson(register: CastRegister): string {
  const filled = (fields: Record<string, string | boolean>) =>
    Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== ""));
  return JSON.stringify(
    register.entries.map((entry) => {
      const { role, aka, state, continuity } = entry;
      const anchor = effectiveCastAnchor(entry);
      const discovered = Object.fromEntries(
        Object.entries(entry.discovered ?? {}).flatMap(([field, item]) =>
          item === undefined ? [] : [[field, { value: item.value, basis: item.basis }]],
        ),
      );
      return {
        name: anchor.name,
        role,
        gender: anchor.gender,
        ...(aka.length === 0 ? {} : { aka }),
        anchor: setAnchorFields(anchor),
        state: filled(state),
        ...(continuity === undefined ? {} : { continuity: filled(continuity) }),
        ...(entry.introduced === true ? { introduced: true } : {}),
        ...(Object.keys(discovered).length === 0 ? {} : { discovered }),
      };
    }),
  );
}

/**
 * The keeper call's message (user): canon when the chat has no current
 * sheet, the player, the register, the turns, then the task. Canon sits
 * first: it is stable per character, the register changes every call.
 */
export function keeperMessage({
  canon,
  names,
  register,
  turns,
  mode,
  full,
  kind = null,
}: {
  canon: string | null;
  /** The character's and the player's names; the turns' speakers fall back to them. */
  names: SpeakerNames;
  register: CastRegister;
  turns: readonly Pick<ChatTurn, "role" | "content" | "scanText" | "name">[];
  mode: "seed" | "update";
  /** Whether the register holds `CAST_LIMITS.entries`. */
  full: boolean;
  /** The card's creator kind, when it has one. */
  kind?: string | null;
}): string {
  const task =
    mode === "seed"
      ? "This is the opening. Set who is present and their state; add anyone it introduces."
      : "These are the newest turns. Answer with what changed.";
  return [
    ...(kind === null ? [] : [`Kind: ${kind}`]),
    ...(canon === null ? [] : [tagged("canon", canon)]),
    tagged("player", `The player is ${names.user}: never an entry.`),
    tagged(
      "register",
      register.entries.length === 0 ? "The register is empty." : registerJson(register),
    ),
    tagged(
      "turn",
      transcriptLines(
        turns.map((turn) => ({ ...turn, content: turn.scanText ?? turn.content })),
        names,
      ),
    ),
    task,
    ...(kind === "Scenario"
      ? [
          "For this Scenario, a new NPC starts minor unless the introduction clearly establishes a continuing principal figure. Promote an NPC when later turns establish recurring importance, a developing relationship, independent goals or sustained narrative focus. Name, gender, age, physical detail and sexual relevance alone never decide role.",
        ]
      : []),
    ...(full ? ["The register is full: add no one; update and mark absent only."] : []),
  ].join("\n\n");
}

/** The sheet instructions' first sentence, for the mock upstream to know the call by. */
export const SHEET_OPENING =
  "You read a roleplay character card and write the fixed record of the people it describes.";

const SHEET_INSTRUCTIONS = `${SHEET_OPENING} The model that tells the story reads that record with every reply, so it keeps every detail of these people consistent for the whole story.

Record the card's subjects, from the card alone, by the kind the message names:
- Subject: the one person the card is about.
- Multiple Subjects: its two or three people.
- Scenario: only a person the card describes in full, in a block of their own with their appearance. A scenario sets a world and leaves its people to play: the kinds of people in <People> and the one-line figures in <Setting> are not records, so a scenario without such blocks has none.
- No kind: the one to three people the card describes; a world without them has none.
Never record the player, whom the card calls {{user}}. A card with no one to record answers with an empty list.

For each person, extract only what the card explicitly states, copying its words exactly. Leave unknown anchor fields empty or omitted. Never invent gap-filling details, including hidden anatomy or history, to complete the record. The narrator establishes new details when the story needs them.

The anchor's keys, in this order:
${anchorKeys("For a man, his cock and balls when the card states them; otherwise leave it empty.")}

Return one JSON object with exactly one key, "cast": a list of at most ${L.sheetEntries} people in the card's order, each an object with exactly these keys:
- "name": the full name, as the card writes it.
- "gender": "female", "male" or "other".
- "role": "principal".
- "anchor": an object with the anchor's keys above.

Answer with the JSON object alone, with nothing before or after it and no code fence.`;

/** The cast sheet call's instructions (system): static, identical for every call. */
export const sheetInstructions = (): string => SHEET_INSTRUCTIONS;

/** The tag of the kind the card's tags name, or null when none does. */
export const castCardKind = (tags: readonly string[]): string | null => {
  const kind = taggedCardKind(tags);
  return kind === null ? null : CREATOR_TAGS[kind];
};

/**
 * The cast sheet call's message (user): the card's kind and its name,
 * description, personality and scenario. `{{user}}` stays as written: a
 * sheet serves every persona.
 */
export function sheetMessage(
  card: Pick<CharacterCard, "name" | "description" | "personality" | "scenario" | "tags">,
): string {
  const fields = canonFields({ card, names: { char: card.name, user: "{{user}}" } });
  return [
    `Kind: ${castCardKind(card.tags) ?? "none"}`,
    `Card: ${card.name}`,
    tagged("card", fields === "" ? "The card has no description." : fields),
    "Write the JSON object for the card above.",
  ].join("\n\n");
}
