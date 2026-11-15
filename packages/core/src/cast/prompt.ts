import type { CharacterCard } from "../card/schema.ts";
import type { ChatTurn, SpeakerNames } from "../chat.ts";
import { taggedCardKind } from "../creator/saved-art-source.ts";
import { CREATOR_TAGS } from "../creator/sheet.ts";
import { canonFields } from "../memory/canon.ts";
import { transcriptLines } from "../memory/prompt.ts";
import { tagged } from "../prompt/tagged.ts";
import { effectiveCastAnchor, namedInTurns } from "./effective.ts";
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
Metric units throughout. Each detail appears once: build never mentions the chest, and no state field repeats the body. Every value reads on its own and names what it describes, as in "green almond-shaped eyes", "wavy brown bob with a loose texture", "freckled fair skin with a pink undertone" or "oval face, small upturned nose, full lips"; never a bare "blue" or "round". Every value holds at most ${L.field} characters, "intimate" at most ${L.longField}; a longer one is cut, so write within the bound.`;

/** How keeper and sheet put a source's stated facts into the anchor's fields. */
const EXTRACTED = `Record only what the source states and add nothing. Keep its descriptive words, put into the field's form: stated measures converted to metric, a stated cup size converted to EU. Where it gives no cup size, describe the breasts as it does and give none. Where it gives no exact age, write the age as it does, such as "in her forties". Where it gives no height or weight, leave them empty.`;

/** The keeper instructions' first sentence, for the mock upstream to know the call by. */
export const KEEPER_OPENING =
  "You keep the cast register of a private roleplay; you do not write the story.";

const KEEPER_INSTRUCTIONS = `${KEEPER_OPENING} The model that tells the story reads the register with every reply in place of describing people again, so the register keeps every detail of every person consistent for the rest of the story.

The register holds one entry per NPC, male and female, and never the player, whose name the message gives. An entry has a role, "principal" or "minor"; a gender, "female", "male" or "other"; an anchor, written once and fixed after; and a state that follows the scene. An entry's key is the NPC's full name as the story writes it.

The anchor's keys, in this order:
${anchorKeys("For a man, his cock and balls. Outside a Scenario principal's canonical completion, only once a turn shows them; until then leave it empty.")}

The state's keys:
- "present": true while the NPC is in the scene, false once they left it. Whoever you give a state is taken as present, so someone the turns only speak of gets no state, and a new NPC in the scene always gets one.
- "outfit": every garment they have on now, outer layers to underwear and footwear, each with its colour and material as shown and, once a turn establishes it, how it shapes the body, such as "padded push-up bra" or "chest binder"; a piece taken off leaves it.
- "disarray": the state of their clothes, only while not worn as normal: undone, open, pushed aside, pulled up or down, wet, torn or stained, garment by garment; then the pieces taken off and where they are now.
- "position": where they are and their posture.
- "activity": what they are doing.
- "mood": how they seem to feel from player-observable cues, never a private emotion.
- "arousal": only while it outwardly shows or is communicated.
- "injuries": only while seen or communicated.
- "intoxication": only while perceptibly drunk or high.
Each state value reads on its own as well and names what it describes, as in "grey hoodie over black jeans" or "leaning on the bar by the door"; never a bare "grey" or "sitting". Every state value holds at most ${L.field} characters, "outfit" and "disarray" at most ${L.longField}; a longer one is cut, so write within the bound.

Rules:
- Answer only with changes. Every entry, key and field you leave out stays as it is; a state field that no longer holds is sent as "", such as arousal that has passed, an injury healed or clothes set right again.
- The canonical anchor is the NPC's complete truth, not what the player knows. An anchor field once set is fixed: never send it again, never paraphrase or correct it. Fill an empty one only.
- Outside a Scenario's invention, an anchor comes only from explicit canon and turn evidence. ${EXTRACTED} Leave every field they do not settle empty or omitted, regardless of role. Never invent details to complete a record or expose hidden anatomy or history.
- For a new NPC in a Scenario (the message then opens with "Kind: Scenario"), invent the anchor by role at introduction, preserving every established fact. A new principal gets one complete, coherent canonical anchor: invent what remains hidden, including anatomy, personality and preferences. A new minor gets the looks alone: "age", "ethnicity", "skin", "face", "height", "weight", "build", "hair" and "eyes", invented where the turns leave them open. A minor's "experience", "relationship", "intimate", "personality" and "fetishes" hold only what the turns show and stay empty otherwise. When you promote a Scenario's minor to "principal", complete the anchor in the same answer: fill every field still empty, coherent with what is set. This is the only permitted gap filling. Invented canon is not player discovery.
- Name everyone who left the scene in "absent".
- When a known NPC is named more fully, such as "Ilse" becoming "Ilse Brandt", key the change by the full name and give the earlier one in "was".
- Never write an entry for the player, by any of their names.
- Role: "principal" is a continuing figure, such as a subject of the card, a recurring relationship or someone with goals of their own; "minor" is everyone else. A new NPC starts minor unless the introduction clearly establishes a continuing principal figure. Promote an NPC to "principal" when later turns establish recurring importance, a developing relationship, independent goals or sustained narrative focus. Name, gender, age, physical detail and sexual relevance alone never decide role.
- The message's register writes out in full only who is in the scene or named in the turns. Everyone else is listed by "name", "role" and "gender" alone, with "aka" and "introduced" where set: their anchor and state stand as recorded. Leave such an entry unchanged unless the turns involve them after all.

Each cast change may also have:
- "developments": an object keyed only by the anchor's text fields (never name or gender). Use it for explicit durable transitions to already established facts, such as changed age, relationship, experience, hair or physique. The anchor remains the card/initial baseline; the register shows effective current values. Empty baseline fields still use "anchor".
- "continuity": optional "voice", "goals" and "knowledge" cues. Preserve distinctive speech and forms of address, motivations, and who knows what without inventing psychology or shared knowledge.
Each populated field in either object is {"value":"short current fact", "evidence":"exact short quote from these turns"}, both nonempty and at most ${L.field} characters. Only update from the shown batch, never canon alone or speculation. Omitted cues stay unchanged; an explicitly ended goal or disproven belief may be recorded as such. Evidence must quote the text exactly; it grounds the update without proving its meaning.

The Cast panel shows player knowledge, never hidden canon:
- "introduce": {"evidence":"exact short quote"} for each NPC the shown turns let the player meet, see, hear or learn of, named or not. The register marks who is introduced with "introduced": true. Anyone without it has not been, a card's own subjects included, however long they have been in the register: introduce them with the first turns that show them to the player. Only an NPC the turns keep out of the player's sight and knowledge stays unintroduced. Once introduced, omit this key. Whatever those turns show or tell the player of them goes under "discovered" in the same change.
- "discovered": an object keyed only by the anchor's text fields. Each populated field is {"value":"what the player now knows", "basis":"seen", "told" or "demonstrated", "evidence":"exact short quote from these turns"}. Omit undiscovered and unchanged fields. A discovery may refine an earlier approximation.
- Canon and durable developments never reveal themselves. Every introduction and discovery needs player-accessible evidence in the shown batch, not the card, private NPC thoughts or speculation.
- "seen" is direct observation, "told" preserves what someone said as a claim when appropriate, and "demonstrated" is a trait or preference established by conduct.
- Record visible looks only when seen. Exact measurements require explicit knowledge; otherwise use a visual approximation. Before exposure, a discovered "build" holds the figure as the clothes show it, chest, hips and ass included, written as an impression through the garment, such as "slim, chest flat under a tight hoodie" or "deep cleavage pushed up in a lace bra"; never nipples, genitals, a cup size or other concealed "intimate" detail. That impression records what the clothes suggest, which may be false. Intimate anatomy requires actual exposure and observation; once seen, record "intimate" and refine "build" without the clothed guess. An exact cup size requires it to be stated or otherwise established.
- Personality, experience, relationships, fetishes, taboos, goals and private knowledge enter only when learned through dialogue or demonstrated conduct. Mood and arousal must be perceptible or communicated. Once discovered, a field stays known while the NPC is away.
- State is what the player can observe now: keep private thoughts, unseen actions and concealed injuries out of it as well.

Return one JSON object with exactly these keys:
- "cast": an object keyed by full name; each value an object with any of "was", "role", "gender", "anchor" (the anchor's keys), "state" (the state's keys), "developments", "continuity", "introduce" and "discovered". {} when nothing changed.
- "absent": the names of the NPCs no longer in the scene at the end of the turns; [] when none.

For example, where Mara Battin was introduced before, the turns bring in Jonas Reyes, and Mara, sober again, speaks of her sister Ana Pires, who is elsewhere:
{"cast":{"Mara Battin":{"state":{"outfit":"a white bath towel","disarray":"towel slipping at her chest; her jeans and grey T-shirt on the bathroom floor","activity":"drying her hair","mood":"flustered","intoxication":""},"continuity":{"goals":{"value":"wants Ana to take her spare room","evidence":"I keep telling Ana to take the spare room"}}},"Jonas Reyes":{"role":"minor","gender":"male","anchor":{"age":"34","ethnicity":"Mexican-American","build":"broad, heavy-set build"},"state":{"position":"standing behind the bar","activity":"polishing a glass"},"introduce":{"evidence":"Jonas looks up from the glass he is polishing"},"discovered":{"build":{"value":"broad, heavy-set build","basis":"seen","evidence":"a broad, heavy-set man behind the bar"}}},"Ana Pires":{"gender":"female","introduce":{"evidence":"my sister Ana"}}},"absent":["Tomas Vidal"]}

Answer with the JSON object alone, with nothing before or after it and no code fence.`;

/** The keeper call's instructions (system): static, identical for every call. */
export const keeperInstructions = (): string => KEEPER_INSTRUCTIONS;

/**
 * The card's description as the keeper's canon, names filled, and the
 * persona's description when given. Null when both are blank.
 */
export function castCanon(
  card: Pick<CharacterCard, "description">,
  names: SpeakerNames,
  persona = "",
): string | null {
  const fields = canonFields({ card, names, persona });
  return fields === "" ? null : fields;
}

/**
 * The register as the keeper reads it: compact JSON by entry, ids and empty
 * fields left out. An entry in the scene or named in `shown` (the batch's
 * turns, by `namedInTurns`) is written whole; the rest by name, role, gender,
 * earlier names and introduction alone, since the register goes out again
 * with every call and a batch seldom concerns those it does not name.
 */
function registerJson(register: CastRegister, shown: readonly string[], player: string): string {
  const filled = (fields: Record<string, string | boolean>) =>
    Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== ""));
  const named = namedInTurns(register.entries, shown, player);
  return JSON.stringify(
    register.entries.map((entry, at) => {
      const { role, aka, state, continuity } = entry;
      const anchor = effectiveCastAnchor(entry);
      const identity = {
        name: anchor.name,
        role,
        gender: anchor.gender,
        ...(aka.length === 0 ? {} : { aka }),
      };
      const introduced = entry.introduced === true ? { introduced: true } : {};
      if (!state.present && !named.has(at)) return { ...identity, ...introduced };
      const discovered = Object.fromEntries(
        Object.entries(entry.discovered ?? {}).flatMap(([field, item]) =>
          item === undefined ? [] : [[field, { value: item.value, basis: item.basis }]],
        ),
      );
      return {
        ...identity,
        anchor: setAnchorFields(anchor),
        state: filled(state),
        ...(continuity === undefined ? {} : { continuity: filled(continuity) }),
        ...introduced,
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
  /** Whether the register can take no one new (`castAdmitsNew`). */
  full: boolean;
  /** The card's creator kind, when it has one. */
  kind?: string | null;
}): string {
  const task =
    mode === "seed"
      ? "This is the opening. Set who is present and their state, introduce everyone it shows the player and add anyone new."
      : "These are the newest turns. Answer with what changed.";
  const read = turns.map((turn) => ({ ...turn, content: turn.scanText ?? turn.content }));
  return [
    ...(kind === null ? [] : [`Kind: ${kind}`]),
    ...(canon === null ? [] : [tagged("canon", canon)]),
    tagged("player", `The player is ${names.user}: never an entry.`),
    tagged(
      "register",
      register.entries.length === 0
        ? "The register is empty."
        : registerJson(
            register,
            read.map((turn) => turn.content),
            names.user,
          ),
    ),
    tagged("turn", transcriptLines(read, names)),
    task,
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

For each person, the card is the only source. ${EXTRACTED} Leave every anchor field the card does not settle empty or omitted. Never invent gap-filling details, including hidden anatomy or history, to complete the record. The narrator establishes new details when the story needs them.

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

/** The fewest people a card of each kind describes; a kind not named here promises no one. */
const SHEET_LEAST: Readonly<Record<string, number>> = {
  [CREATOR_TAGS.subject]: 1,
  [CREATOR_TAGS.group]: 2,
};

/**
 * What a sheet answer short of its card's kind is asked once more with: a
 * Subject card's answer without its subject, a Multiple Subjects card's with
 * fewer than two people. Null when the answer has as many as the kind
 * promises, the card has no kind or a Scenario's, or it has no description
 * to read them from. The second answer stands, whatever it holds: a card
 * may describe fewer people than its tag says.
 */
export function sheetShortfall(
  card: Pick<CharacterCard, "description" | "tags">,
  recorded: number,
): string | null {
  const kind = castCardKind(card.tags);
  const least = kind === null ? 0 : (SHEET_LEAST[kind] ?? 0);
  if (recorded >= least || card.description.trim() === "") return null;
  const people = recorded === 0 ? "no one" : "one person";
  const promised =
    kind === CREATOR_TAGS.group ? "its two or three people" : "the one person it is about";
  return `The card's kind is ${kind}, so it describes ${promised}, and this answer records ${people}. Read the card again and return the complete JSON object with every one of them, each under their own name; return the same object only if the card truly describes no more.`;
}

/** The tag of the kind the card's tags name, or null when none does. */
export const castCardKind = (tags: readonly string[]): string | null => {
  const kind = taggedCardKind(tags);
  return kind === null ? null : CREATOR_TAGS[kind];
};

/**
 * The cast sheet call's message (user): the card's kind, name and
 * description. `{{user}}` stays as written: a
 * sheet serves every persona.
 */
export function sheetMessage(card: Pick<CharacterCard, "name" | "description" | "tags">): string {
  const fields = canonFields({ card, names: { char: card.name, user: "{{user}}" } });
  return [
    `Kind: ${castCardKind(card.tags) ?? "none"}`,
    `Card: ${card.name}`,
    tagged("card", fields === "" ? "The card has no description." : fields),
    "Write the JSON object for the card above.",
  ].join("\n\n");
}
