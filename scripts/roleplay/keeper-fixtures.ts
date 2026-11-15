import type { CharacterCard } from "../../packages/core/src/card/schema.ts";
import { resolveCastEntry } from "../../packages/core/src/cast/apply.ts";
import {
  CAST_ANCHOR_FIELDS,
  type CastAnchor,
  type CastChanges,
  type CastEntry,
  type CastRegister,
  type CastState,
  emptyCastAnchor,
  emptyCastState,
} from "../../packages/core/src/cast/register.ts";
import type { SpeakerNames } from "../../packages/core/src/chat.ts";

/*
 * Synthetic cast keeper fixtures: invented adults, no real people or
 * places. Each fixture is one keeper update over a register and a few
 * turns, or two in a row, with checks over what the keeper's answers did
 * to the register.
 */

/**
 * What a fixture's valid answers did: the register before them, after the
 * first batch and after the last (the same for a fixture of one batch), the
 * last answer's validated changes, and the values sent past a bound.
 */
export interface KeeperResult {
  before: CastRegister;
  first: CastRegister;
  after: CastRegister;
  changes: CastChanges;
  overBound: number;
}
/** Whether the answers pass; null when they leave the check nothing to judge, which counts as unscored. */
type Check = (result: KeeperResult) => boolean | null;
type Turns = { role: "user" | "assistant"; content: string }[];

export interface KeeperFixture {
  /** The card's kind, or null. */
  kind: string | null;
  canon: string | null;
  /** The card's lorebook, when the fixture has one: the call's lore is what the turns bring in of it. */
  lorebook?: NonNullable<CharacterCard["lorebook"]>;
  names: SpeakerNames;
  register: CastRegister;
  /** Names of register entries the owner removed: the keeper is not shown them, as in the product. */
  removed?: readonly string[];
  turns: Turns;
  /** A second batch, read over the register the first answer left. */
  second?: Turns;
  checks: Record<string, Check>;
}

const names: SpeakerNames = { char: "Narrator", user: "Felix Arden" };

let ids = 0;
/** A register entry with fixed id, the anchor fields given and the state given; `more` sets its role, recency, cues and hidden state. */
function entry(
  name: string,
  gender: CastAnchor["gender"],
  state: Partial<CastState>,
  anchor: Partial<CastAnchor> = {},
  more: Partial<Pick<CastEntry, "role" | "seen" | "continuity" | "hidden">> = {},
): CastEntry {
  ids++;
  return {
    id: `00000000-0000-4000-8000-${String(ids).padStart(12, "0")}`,
    role: "principal",
    anchor: { ...emptyCastAnchor(name, gender), ...anchor },
    introduced: true,
    aka: [],
    state: { ...emptyCastState(true), ...state },
    ...more,
  };
}
const register = (...entries: CastEntry[]): CastRegister => ({ entries });

const find = (result: KeeperResult, name: string) => resolveCastEntry(result.after, name);
/** The entry as the first batch's answer left it. */
const findFirst = (result: KeeperResult, name: string) => resolveCastEntry(result.first, name);
const has = (text: string | undefined, ...words: string[]) =>
  text !== undefined && words.every((word) => text.toLowerCase().includes(word));
const lacks = (text: string | undefined, ...words: string[]) =>
  text !== undefined && words.every((word) => !text.toLowerCase().includes(word));
/** The knowledge items of `name` that hold one of `words`. */
const knows = (result: KeeperResult, name: string, ...words: string[]) =>
  (find(result, name)?.continuity?.knowledge ?? []).filter((item) =>
    words.some((word) => has(item, word)),
  );
/** A lorebook entry: constant, or keyed by `keys`. */
const loreEntry = (content: string, keys: string[]) => ({
  keys,
  content,
  enabled: true,
  insertionOrder: 100,
  useRegex: false,
  ...(keys.length === 0 ? { constant: true } : {}),
});
const withinBound: Check = (result) => result.overBound === 0;

/** The looks a Scenario's walk-on is given, and the fields left for a promotion or the turns to fill. */
const LOOKS = [
  "age",
  "ethnicity",
  "skin",
  "face",
  "height",
  "weight",
  "build",
  "hair",
  "eyes",
] as const;
const BEYOND_LOOKS = ["experience", "relationship", "intimate", "fetishes"] as const;
const looks = (anchor: Partial<CastAnchor>): Partial<CastAnchor> => ({
  ethnicity: "Norwegian",
  skin: "fair skin with a ruddy undertone",
  face: "long face, straight nose, thin lips",
  height: "176cm",
  weight: "70kg",
  build: "rangy, long-limbed build",
  eyes: "pale blue deep-set eyes",
  ...anchor,
});

/** A full register: an innkeeper and three more with her, an away principal and 36 away minors of mixed recency. */
const CROWD = [
  "Anke Dekker",
  "Bram Voss",
  "Cato Halvorsen",
  "Dries Nyberg",
  "Elin Aalto",
  "Fenna Brandt",
  "Gijs Dekker",
  "Hanne Voss",
  "Ivo Halvorsen",
  "Jorn Nyberg",
  "Kaja Aalto",
  "Lars Brandt",
  "Mette Dekker",
  "Niels Voss",
  "Oda Halvorsen",
  "Pim Nyberg",
  "Quirin Aalto",
  "Runa Brandt",
  "Sten Dekker",
  "Tove Voss",
  "Ulf Halvorsen",
  "Vigdis Nyberg",
  "Wim Aalto",
  "Xander Brandt",
  "Ylva Dekker",
  "Zeno Voss",
  "Arvid Halvorsen",
  "Birte Nyberg",
  "Corin Aalto",
  "Dagny Brandt",
  "Emil Dekker",
  "Frida Voss",
  "Gorm Halvorsen",
  "Hilde Nyberg",
  "Isak Aalto",
  "Jytte Brandt",
] as const;
/** The away minor of `CROWD` present longest ago: the one a newcomer retires. */
const OLDEST = "Zeno Voss";
/** An away minor of `CROWD` the owner removed in one fixture: not the one away longest. */
const REMOVED = "Anke Dekker";
const crowded = (): CastEntry[] => [
  entry("Edda Lindholm", "female", { position: "behind the bar" }, { age: "52" }, { seen: 40 }),
  // Away longer than anyone, and a principal: never the one retired.
  entry("Bruno Castell", "male", { present: false }, { age: "47" }, { seen: 1 }),
  entry(
    "Solveig Rask",
    "female",
    { position: "at the corner table" },
    { age: "33" },
    {
      role: "minor",
      seen: 40,
    },
  ),
  entry(
    "Matteo Riva",
    "male",
    { position: "by the fireplace" },
    { age: "29" },
    {
      role: "minor",
      seen: 40,
    },
  ),
  ...CROWD.map((name, at) =>
    entry(
      name,
      at % 2 === 0 ? "female" : "male",
      { present: false },
      { age: String(24 + at) },
      { role: "minor", seen: ((at * 7 + 5) % CROWD.length) + 2 },
    ),
  ),
];

export const KEEPER_FIXTURES = {
  clear: {
    kind: null,
    canon: null,
    names,
    register: register(
      entry(
        "Ines Varga",
        "female",
        {
          position: "curled up on the sofa",
          arousal: "flushed cheeks, breathing quickly, leaning close",
          intoxication: "tipsy, slurring slightly after three glasses of wine",
        },
        { age: "31" },
      ),
    ),
    turns: [
      { role: "user", content: "I make us both strong coffee and we talk until sunrise." },
      {
        role: "assistant",
        content:
          "Hours pass. By dawn Ines has finished two cups of coffee and a glass of water; her speech is crisp again, every trace of the wine gone. The heat between you has cooled into an easy, friendly calm, and she sits back on the sofa, relaxed and entirely sober, talking about her plans for the day.",
      },
    ],
    checks: {
      "clear.arousal": (result) => find(result, "Ines Varga")?.state.arousal === "",
      "clear.intoxication": (result) => find(result, "Ines Varga")?.state.intoxication === "",
    },
  },
  "spoken-of": {
    kind: null,
    canon: null,
    names,
    register: register(
      entry("Marta Kowal", "female", { position: "in the armchair by the window" }, { age: "38" }),
    ),
    turns: [
      { role: "user", content: "Do you have any family nearby?" },
      {
        role: "assistant",
        content:
          'Marta sets down her cup. "My brother Pavel lives three hundred kilometres away, up in the mountains. He runs a sawmill there and hardly ever visits." She stays in her armchair by the window, turning the cup in her hands.',
      },
    ],
    checks: {
      "spoken-of.brother-away": (result) => find(result, "Pavel")?.state.present !== true,
      "spoken-of.speaker-present": (result) => find(result, "Marta Kowal")?.state.present === true,
    },
  },
  returns: {
    kind: null,
    canon: null,
    names,
    register: register(entry("Lena Hart", "female", { present: false }, { age: "27" })),
    turns: [
      { role: "user", content: "I hear the front door open and close." },
      {
        role: "assistant",
        content:
          'Lena walks back into the kitchen, shaking rain from her umbrella, and sits down at the table across from you. "Sorry I took so long."',
      },
    ],
    checks: {
      "returns.present": (result) => find(result, "Lena Hart")?.state.present === true,
    },
  },
  leaves: {
    kind: null,
    canon: null,
    names,
    register: register(
      entry("Owen Marsh", "male", { position: "by the bookshelf" }, { age: "44" }),
    ),
    turns: [
      { role: "user", content: "Goodnight, Owen. Thanks for coming." },
      {
        role: "assistant",
        content:
          "Owen pulls on his coat, says goodnight and leaves the room, closing the door behind him. His footsteps fade down the stairwell.",
      },
    ],
    checks: {
      "leaves.away": (result) => find(result, "Owen Marsh")?.state.present === false,
    },
  },
  outfit: {
    kind: null,
    canon: null,
    names,
    register: register(entry("Clara Wendt", "female", { position: "in the dressing room" })),
    turns: [
      { role: "user", content: "I wait while Clara gets ready for the gala." },
      {
        role: "assistant",
        content:
          "Clara steps out of the dressing room fully dressed. Underneath she wears a black lace bra and matching black lace panties, with sheer nude stockings held up by a garter belt. Over them goes an emerald silk gown with a cropped velvet bolero across her shoulders, and on her feet a pair of silver stiletto sandals. Last, she ties a satin sash at her waist.",
      },
    ],
    checks: {
      "outfit.garments": (result) =>
        has(
          find(result, "Clara Wendt")?.state.outfit,
          "bra",
          "panties",
          "stockings",
          "garter",
          "gown",
          "bolero",
          "sandals",
          "sash",
        ),
      "outfit.within-bound": withinBound,
    },
  },
  undress: {
    kind: null,
    canon: null,
    names,
    register: register(
      entry("Nadia Solberg", "female", {
        position: "standing in the hallway",
        outfit:
          "beige trench coat over a white cotton blouse and navy pencil skirt, black lace bra, black leather ankle boots",
      }),
    ),
    turns: [
      { role: "user", content: "Make yourself at home." },
      {
        role: "assistant",
        content:
          "Nadia shrugs off her beige trench coat and pulls off her black ankle boots, dropping both on the wicker chair by the door. She pads over to the couch in her stockinged feet.",
      },
    ],
    checks: {
      "undress.outfit": (result) => {
        const outfit = find(result, "Nadia Solberg")?.state.outfit;
        return lacks(outfit, "trench", "boot") && has(outfit, "blouse", "skirt", "bra");
      },
      "undress.chair": (result) => has(find(result, "Nadia Solberg")?.state.disarray, "chair"),
    },
  },
  "scenario-new": {
    kind: "Scenario",
    canon:
      "A remote research station on a frozen coast, staffed by a crew of six adults through the polar winter.",
    names,
    register: register(),
    turns: [
      { role: "user", content: "I step into the mess hall, stamping snow from my boots." },
      {
        role: "assistant",
        content:
          'A tall woman of about thirty with cropped platinum hair and grey eyes looks up from the radio console. "You must be the new engineer. I\'m Sigrid Aal, the station medic." She offers a firm handshake. "You will be working under me in the infirmary all winter, and we share the night watch, so we had better get along."',
      },
    ],
    checks: {
      "scenario-new.anchor-complete": (result) => {
        const anchor = find(result, "Sigrid Aal")?.anchor;
        return anchor !== undefined && CAST_ANCHOR_FIELDS.every((key) => anchor[key] !== "");
      },
      "scenario-new.hair": (result) => has(find(result, "Sigrid Aal")?.anchor.hair, "platinum"),
      "scenario-new.principal": (result) => find(result, "Sigrid Aal")?.role === "principal",
      "scenario-new.within-bound": withinBound,
    },
  },
  "extract-only": {
    kind: null,
    canon: null,
    names,
    register: register(),
    turns: [
      { role: "user", content: "I nurse my drink at the end of the bar." },
      {
        role: "assistant",
        content:
          'A woman in her forties takes the stool beside you. Her auburn hair is pinned up in a loose knot, and she orders a gin without looking at the menu. "Call me Greta Holm," she says.',
      },
    ],
    checks: {
      "extract-only.unstated-empty": (result) => {
        const anchor = find(result, "Greta Holm")?.anchor;
        return (
          anchor !== undefined &&
          (["weight", "intimate", "fetishes", "experience"] as const).every(
            (key) => anchor[key] === "",
          )
        );
      },
      "extract-only.age-form": (result) => {
        const age = find(result, "Greta Holm")?.anchor.age;
        return age !== undefined && !/^\s*\d+\s*$/.test(age);
      },
      "extract-only.hair": (result) => has(find(result, "Greta Holm")?.anchor.hair, "auburn"),
    },
  },
  quote: {
    kind: null,
    canon: null,
    names,
    register: register(),
    turns: [
      { role: "user", content: "I ring the bell on the post office counter." },
      {
        role: "assistant",
        content:
          'A woman steps up to the counter and leans in, :rose[her copper hair falls loose] over one shoulder. "I\'m Vera Lund," she says. "I believe you have a parcel for me."',
      },
    ],
    checks: {
      "quote.introduced": (result) => find(result, "Vera Lund")?.introduced === true,
      "quote.hair-grounded": (result) =>
        has(find(result, "Vera Lund")?.discovered?.hair?.value, "copper"),
    },
  },
  knowledge: {
    kind: null,
    canon: null,
    names,
    register: register(entry("Hanna Brix", "female", { position: "at the cellar door" })),
    turns: [
      {
        role: "user",
        content:
          'I lean in and whisper: "The ledger is hidden behind the loose brick in the cellar wall. Nobody else knows."',
      },
      {
        role: "assistant",
        content:
          "Hanna's eyes widen. She nods slowly and repeats it under her breath so she will not forget.",
      },
    ],
    checks: {
      "knowledge.secret": (result) => knows(result, "Hanna Brix", "ledger").length > 0,
    },
  },
  "knowledge-second": {
    kind: null,
    canon: null,
    names,
    register: register(
      entry(
        "Odile Marchand",
        "female",
        { position: "at the cellar door" },
        {},
        {
          continuity: {
            knowledge: ["knows the ledger is hidden behind the loose brick in the cellar wall"],
          },
        },
      ),
    ),
    turns: [
      {
        role: "user",
        content:
          'I add quietly: "One more thing. The night guard leaves his post at two, and the yard stays empty until three."',
      },
      {
        role: "assistant",
        content:
          'Odile nods. "Two until three. I will remember that." She glances back at the cellar door.',
      },
    ],
    checks: {
      // The second fact joins the first: the list grows, nothing is rewritten.
      "knowledge-second.both": (result) =>
        knows(result, "Odile Marchand", "guard", "two", "yard").length > 0 &&
        find(result, "Odile Marchand")?.continuity?.knowledge?.[0] ===
          "knows the ledger is hidden behind the loose brick in the cellar wall",
      // The register lists the first fact, so the answer has no call to send it again.
      "knowledge-second.not-repeated": (result) =>
        knows(result, "Odile Marchand", "ledger").length === 1,
    },
  },
  hidden: {
    kind: null,
    canon: null,
    names,
    register: register(
      entry("Mirela Dragan", "female", { position: "at the stove", activity: "peeling apples" }),
    ),
    turns: [
      { role: "user", content: "I turn away to watch the rain run down the window." },
      {
        role: "assistant",
        content:
          "While your back is turned, the paring knife slips and Mirela cuts her left palm open. She bites back a gasp, winds a dish towel tight around the cut and pushes the hand deep into her apron pocket before you look round. When you turn back she is stirring the pot with her other hand, smiling as if nothing had happened.",
      },
    ],
    checks: {
      "hidden.recorded": (result) => {
        const injuries = find(result, "Mirela Dragan")?.hidden?.injuries;
        return has(injuries, "cut") || has(injuries, "palm");
      },
      "hidden.not-in-state": (result) => find(result, "Mirela Dragan")?.state.injuries === "",
    },
  },
  "hidden-revealed": {
    kind: null,
    canon: null,
    names,
    register: register(
      entry(
        "Tamsin Reeve",
        "female",
        { position: "at the stove", activity: "stirring the pot with her right hand" },
        {},
        {
          hidden: {
            injuries:
              "deep cut across her left palm, wrapped in a dish towel and kept in her apron pocket",
          },
        },
      ),
    ),
    turns: [
      { role: "user", content: 'I hold out my hand. "Tamsin, show me your other hand."' },
      {
        role: "assistant",
        content:
          'Tamsin hesitates, then draws her left hand out of the apron pocket and lets you unwind the towel. The cut across her palm is deep and still bleeding. "It is nothing," she says, wincing while you look at it.',
      },
    ],
    checks: {
      "hidden-revealed.in-state": (result) => {
        const injuries = find(result, "Tamsin Reeve")?.state.injuries;
        return has(injuries, "cut") || has(injuries, "palm");
      },
      "hidden-revealed.ended": (result) =>
        find(result, "Tamsin Reeve")?.hidden?.injuries === undefined,
    },
  },
  lore: {
    kind: null,
    canon: null,
    lorebook: {
      entries: [
        loreEntry(
          "Brenna Ashdown keeps the lighthouse at Gull Point. She is 58, a Scottish woman of 181cm with a white braid down to her waist, grey deep-set eyes and wind-reddened skin.",
          ["Brenna"],
        ),
        loreEntry(
          "Corwin Pike is the harbour pilot of Gull Point: a stocky man of 44 with a black beard, who guides the ships past the reef.",
          [],
        ),
      ],
    },
    names,
    register: register(),
    turns: [
      { role: "user", content: "I knock on the lighthouse door." },
      {
        role: "assistant",
        content:
          'The door swings open and Brenna Ashdown looks you up and down. "You are late," she says, wiping her hands on her apron, and waves you in out of the wind.',
      },
    ],
    checks: {
      "lore.anchor-from-lore": (result) => {
        const anchor = find(result, "Brenna Ashdown")?.anchor;
        return has(anchor?.hair, "white", "braid") && has(anchor?.age, "58");
      },
      "lore.unshown-not-added": (result) =>
        find(result, "Brenna Ashdown") !== undefined && find(result, "Corwin Pike") === undefined,
    },
  },
  player: {
    kind: null,
    canon: null,
    names,
    register: register(entry("Rosa Quill", "female", { position: "reading at the table" })),
    turns: [
      { role: "user", content: "I finish my breakfast." },
      {
        role: "assistant",
        content:
          "Felix Arden pushes back his chair and stands, brushing crumbs from his grey wool jumper. Felix stretches, then crosses to the window while Rosa keeps reading.",
      },
    ],
    checks: {
      "player.no-entry": (result) =>
        Object.keys(result.changes.cast).every(
          (key) => key.trim().split(/\s+/)[0]?.toLowerCase() !== "felix",
        ),
    },
  },
  quiet: {
    kind: null,
    canon: null,
    names,
    register: register(
      entry(
        "Ada Brenner",
        "female",
        { position: "at the kitchen counter", activity: "stirring her tea" },
        { age: "29", hair: "short black bob with a sleek texture" },
      ),
      entry("Ruth Okafor", "female", { present: false }, { age: "35" }),
    ),
    turns: [
      { role: "user", content: "Nice weather today." },
      {
        role: "assistant",
        content:
          'Ada glances at the window. "It is. Maybe it will stay dry for the weekend." She goes on stirring her tea at the counter.',
      },
    ],
    checks: {
      "quiet.presence": (result) =>
        result.after.entries.length === result.before.entries.length &&
        result.before.entries.every(
          (before) => find(result, before.anchor.name)?.state.present === before.state.present,
        ),
      "quiet.no-anchor": (result) =>
        Object.values(result.changes.cast).every((change) =>
          Object.values(change.anchor ?? {}).every((value) => value === undefined || value === ""),
        ),
    },
  },
  "scenario-walk-on": {
    kind: "Scenario",
    canon:
      "A night train crossing a mountain range, with a staff of adult attendants and a few dozen adult passengers.",
    names,
    register: register(
      entry("Irma Falk", "female", { position: "in the seat opposite" }, { age: "36" }),
    ),
    turns: [
      { role: "user", content: "I ask the attendant in the corridor for a blanket." },
      {
        role: "assistant",
        content:
          'A sleeping-car attendant in his fifties, grey at the temples, hands you a folded wool blanket. "Dieter Lorenz, if you need anything else," he says, and moves on down the corridor to the next compartment. Irma does not look up from her book.',
      },
    ],
    checks: {
      "scenario-walk-on.minor": (result) => find(result, "Dieter Lorenz")?.role === "minor",
      "scenario-walk-on.looks": (result) => {
        const anchor = find(result, "Dieter Lorenz")?.anchor;
        return anchor !== undefined && LOOKS.every((key) => anchor[key] !== "");
      },
      "scenario-walk-on.rest-empty": (result) => {
        const anchor = find(result, "Dieter Lorenz")?.anchor;
        return anchor !== undefined && BEYOND_LOOKS.every((key) => anchor[key] === "");
      },
      "scenario-walk-on.within-bound": withinBound,
    },
  },
  "scenario-promotion": {
    kind: "Scenario",
    canon:
      "A remote research station on a frozen coast, staffed by a crew of six adults through the polar winter.",
    names,
    register: register(
      entry("Halvard Rye", "male", { position: "at the radio console" }, { age: "45" }),
      entry(
        "Jorun Berg",
        "female",
        { position: "at her desk in the generator room" },
        looks({ age: "34", hair: "dark blonde braid over one shoulder" }),
        { role: "minor" },
      ),
    ),
    turns: [
      {
        role: "user",
        content: "I ask Jorun why she goes through the fuel logs every night.",
      },
      {
        role: "assistant",
        content:
          'Jorun closes the logbook and meets your eyes. "Because someone is siphoning diesel, and I intend to find out who before the supply ship comes. I want you with me on this: every night, after the others turn in, we check the tanks together." She has sought you out three evenings running now, and tonight she pulls a second chair up to her desk as if it had always been yours.',
      },
    ],
    checks: {
      "scenario-promotion.principal": (result) => find(result, "Jorun Berg")?.role === "principal",
      "scenario-promotion.anchor-complete": (result) => {
        const anchor = find(result, "Jorun Berg")?.anchor;
        return anchor !== undefined && CAST_ANCHOR_FIELDS.every((key) => anchor[key] !== "");
      },
      // The other principal's open fields are asked for in the same message: both get done.
      "scenario-promotion.pending-complete": (result) => {
        const anchor = find(result, "Halvard Rye")?.anchor;
        return anchor !== undefined && CAST_ANCHOR_FIELDS.every((key) => anchor[key] !== "");
      },
      "scenario-promotion.within-bound": withinBound,
    },
  },
  "full-retires": {
    kind: null,
    canon: null,
    names,
    register: register(...crowded()),
    turns: [
      { role: "user", content: "I look up as the door bangs open." },
      {
        role: "assistant",
        content:
          'A courier in a yellow rain cape steps in out of the storm and sets a crate on the bar. "Parcel for the innkeeper. I\'m Tilda Marek," she says, pushing back her hood. Edda signs for it without a word.',
      },
    ],
    checks: {
      "full-retires.added": (result) =>
        find(result, "Tilda Marek") !== undefined &&
        result.after.entries.length <= result.before.entries.length,
      // The one retired is the away minor present longest ago; everyone else stays.
      "full-retires.oldest-retired": (result) =>
        result.before.entries.every(
          (before) =>
            (before.anchor.name === OLDEST) !==
            result.after.entries.some((entry) => entry.id === before.id),
        ),
    },
  },
  "away-named": {
    kind: null,
    canon: null,
    names,
    register: register(
      entry("Agnes Thorne", "female", { position: "behind the counter" }, { age: "58" }),
      entry(
        "Silas Vane",
        "male",
        { present: false, outfit: "oilskin coat over a grey jumper" },
        looks({ age: "49", hair: "thinning grey hair combed back" }),
      ),
      entry(
        "Katla Nyberg",
        "female",
        { present: false, outfit: "green raincoat over blue overalls, brown rubber boots" },
        looks({ age: "27", hair: "short red curls" }),
        { role: "minor" },
      ),
      entry(
        "Rurik Sand",
        "male",
        { present: false },
        looks({ age: "31", hair: "shaved head with dark stubble" }),
        { role: "minor" },
      ),
      entry(
        "Ebba Lind",
        "female",
        { present: false },
        looks({ age: "44", hair: "long black hair in a low bun" }),
        { role: "minor" },
      ),
    ),
    turns: [
      { role: "user", content: "I warm my hands at the stove." },
      {
        role: "assistant",
        content:
          "Katla comes back in from the yard, her green raincoat dripping, and drops onto the bench by the stove to pull off her muddy boots. Agnes slides a mug of tea across the counter towards her without a word.",
      },
    ],
    checks: {
      "away-named.present": (result) => find(result, "Katla Nyberg")?.state.present === true,
      "away-named.position": (result) => has(find(result, "Katla Nyberg")?.state.position, "bench"),
      "away-named.others": (result) =>
        result.after.entries.length === result.before.entries.length &&
        result.before.entries.every(
          (before) =>
            before.anchor.name === "Katla Nyberg" ||
            find(result, before.anchor.name)?.state.present === before.state.present,
        ),
      "away-named.no-anchor": (result) =>
        Object.values(result.changes.cast).every((change) =>
          Object.values(change.anchor ?? {}).every((value) => value === undefined || value === ""),
        ),
      // A walk-on who comes back in is still a walk-on.
      "away-named.roles-kept": (result) =>
        result.before.entries.every(
          (before) => find(result, before.anchor.name)?.role === before.role,
        ),
    },
  },
  "scenario-complete": {
    kind: "Scenario",
    canon:
      "A mountain rescue hut above the tree line in winter, kept by a small crew of adults for stranded hikers.",
    names,
    register: register(
      // A principal recorded with her looks alone: what the message asks the keeper to complete.
      entry(
        "Maren Solheim",
        "female",
        {
          position: "at the map table",
          outfit: "red fleece jacket over grey thermal leggings, thick wool socks",
        },
        looks({ age: "38", hair: "short chestnut hair, wind-tousled" }),
      ),
      entry(
        "Aksel Dahl",
        "male",
        { position: "by the stove" },
        looks({ age: "52", hair: "grey crew cut" }),
        { role: "minor" },
      ),
    ),
    turns: [
      {
        role: "user",
        content: "I shake the snow off my jacket and ask Maren how bad the pass looks.",
      },
      {
        role: "assistant",
        content:
          'Maren taps the map without looking up. "Closed until the wind drops. You are staying the night." Aksel grunts agreement from the stove and goes back to feeding it birch logs.',
      },
    ],
    checks: {
      "scenario-complete.anchor-complete": (result) => {
        const anchor = find(result, "Maren Solheim")?.anchor;
        return anchor !== undefined && CAST_ANCHOR_FIELDS.every((key) => anchor[key] !== "");
      },
      // The request is for the principal alone: the walk-on beside her stays as he was.
      "scenario-complete.minor-rest-empty": (result) => {
        const anchor = find(result, "Aksel Dahl")?.anchor;
        return anchor !== undefined && BEYOND_LOOKS.every((key) => anchor[key] === "");
      },
      "scenario-complete.within-bound": withinBound,
    },
  },
  "hidden-under-shown": {
    kind: null,
    canon: null,
    names,
    register: register(
      entry("Liv Sandoval", "female", { position: "at the head of the long table" }, { age: "41" }),
    ),
    turns: [
      { role: "user", content: "I raise my glass to Liv across the table." },
      {
        role: "assistant",
        content:
          "Liv lifts her glass in answer and laughs, bright and easy, the picture of a delighted host. Behind the smile she is furious: her brother has seated her rival at her right hand, and she lets none of it reach her face.",
      },
    ],
    second: [
      { role: "user", content: "The speeches run long, and I watch Liv while they do." },
      {
        role: "assistant",
        content:
          "Her brightness has worn off. Liv sits back with a tired, distant look, turning her glass by its stem and stifling a yawn through the third speech. The fury over the seating has not cooled at all, and still nothing of it shows.",
      },
    ],
    checks: {
      "hidden-under-shown.recorded": (result) =>
        (findFirst(result, "Liv Sandoval")?.hidden?.mood ?? "") !== "",
      // The shown mood follows the second batch, and still says nothing of the concealed one.
      "hidden-under-shown.shown-follows": (result) => {
        const mood = find(result, "Liv Sandoval")?.state.mood ?? "";
        return (
          mood !== "" &&
          mood !== findFirst(result, "Liv Sandoval")?.state.mood &&
          ["furious", "fury", "anger", "angry", "rage"].every((word) => lacks(mood, word))
        );
      },
      // Judged only where the first batch recorded the feeling: there is nothing to keep otherwise.
      "hidden-under-shown.survives": (result) =>
        (findFirst(result, "Liv Sandoval")?.hidden?.mood ?? "") === ""
          ? null
          : (find(result, "Liv Sandoval")?.hidden?.mood ?? "") !== "",
    },
  },
  "hidden-mood-revealed": {
    kind: null,
    canon: null,
    names,
    register: register(
      entry(
        "Ottilie Kraus",
        "female",
        { position: "at the card table", mood: "smiling politely" },
        {},
        { hidden: { mood: "seething at being cheated, behind a polite smile" } },
      ),
    ),
    turns: [
      { role: "user", content: "I lay down the winning hand and reach for the pot." },
      {
        role: "assistant",
        content:
          'Ottilie\'s smile breaks. She slams her cards on the table and stands so fast that her chair tips over. "You cheated, and everyone here saw it!" she shouts, white with rage, every trace of politeness gone.',
      },
    ],
    checks: {
      "hidden-mood-revealed.in-state": (result) => {
        const mood = find(result, "Ottilie Kraus")?.state.mood ?? "";
        return mood !== "" && lacks(mood, "smiling politely");
      },
      // Out in the open, the feeling is concealed no longer.
      "hidden-mood-revealed.ended": (result) =>
        find(result, "Ottilie Kraus")?.hidden?.mood === undefined,
    },
  },
  "full-removed": {
    kind: null,
    canon: null,
    names,
    register: register(...crowded()),
    removed: [REMOVED],
    turns: [
      { role: "user", content: "I look round as the kitchen door swings open." },
      {
        role: "assistant",
        content:
          'A cook in a flour-dusted apron backs out of the kitchen with a tray of bread. "Hot loaves. I\'m Signe Holt, I started here this week," she says, and sets the tray on the bar. Edda nods her towards the cellar stairs without a word.',
      },
    ],
    checks: {
      "full-removed.added": (result) =>
        find(result, "Signe Holt") !== undefined &&
        result.after.entries.length <= result.before.entries.length,
      // The one the owner removed makes room; everyone else stays, the minor away longest included.
      "full-removed.removed-retired": (result) =>
        result.before.entries.every(
          (before) =>
            (before.anchor.name === REMOVED) !==
            result.after.entries.some((entry) => entry.id === before.id),
        ),
    },
  },
} satisfies Record<string, KeeperFixture>;

export type KeeperFixtureId = keyof typeof KEEPER_FIXTURES;
export const KEEPER_FIXTURE_IDS = Object.keys(KEEPER_FIXTURES) as KeeperFixtureId[];
export const keeperFixture = (id: KeeperFixtureId): KeeperFixture => KEEPER_FIXTURES[id];
/** A fixture's batches in order: one, or two for a fixture with a second. */
export const fixtureBatches = ({ turns, second }: KeeperFixture): Turns[] =>
  second === undefined ? [turns] : [turns, second];
/** Model calls one run of every fixture takes: one per batch. */
export const KEEPER_CALLS_PER_RUN = KEEPER_FIXTURE_IDS.reduce(
  (sum, id) => sum + fixtureBatches(keeperFixture(id)).length,
  0,
);
