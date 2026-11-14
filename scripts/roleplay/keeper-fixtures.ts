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
 * turns, with checks over what the keeper's answer did to the register.
 */

/** What one valid answer did: the register before and after it, its validated changes, values it sent past a bound. */
export interface KeeperResult {
  before: CastRegister;
  after: CastRegister;
  changes: CastChanges;
  overBound: number;
}
type Check = (result: KeeperResult) => boolean;

export interface KeeperFixture {
  /** The card's kind, or null. */
  kind: string | null;
  canon: string | null;
  names: SpeakerNames;
  register: CastRegister;
  turns: { role: "user" | "assistant"; content: string }[];
  checks: Record<string, Check>;
}

const names: SpeakerNames = { char: "Narrator", user: "Felix Arden" };

let ids = 0;
/** A register entry with fixed id, the anchor fields given and the state given. */
function entry(
  name: string,
  gender: CastAnchor["gender"],
  state: Partial<CastState>,
  anchor: Partial<CastAnchor> = {},
): CastEntry {
  ids++;
  return {
    id: `00000000-0000-4000-8000-${String(ids).padStart(12, "0")}`,
    role: "principal",
    anchor: { ...emptyCastAnchor(name, gender), ...anchor },
    introduced: true,
    aka: [],
    state: { ...emptyCastState(true), ...state },
  };
}
const register = (...entries: CastEntry[]): CastRegister => ({ entries });

const find = (result: KeeperResult, name: string) => resolveCastEntry(result.after, name);
const has = (text: string | undefined, ...words: string[]) =>
  text !== undefined && words.every((word) => text.toLowerCase().includes(word));
const lacks = (text: string | undefined, ...words: string[]) =>
  text !== undefined && words.every((word) => !text.toLowerCase().includes(word));
const withinBound: Check = (result) => result.overBound === 0;

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
          'A tall woman of about thirty with cropped platinum hair and grey eyes looks up from the radio console. "You must be the new engineer. I\'m Sigrid Aal, the station medic." She offers a firm handshake.',
      },
    ],
    checks: {
      "scenario-new.anchor-complete": (result) => {
        const anchor = find(result, "Sigrid Aal")?.anchor;
        return anchor !== undefined && CAST_ANCHOR_FIELDS.every((key) => anchor[key] !== "");
      },
      "scenario-new.hair": (result) => has(find(result, "Sigrid Aal")?.anchor.hair, "platinum"),
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
      "knowledge.secret": (result) =>
        has(find(result, "Hanna Brix")?.continuity?.knowledge, "ledger"),
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
} satisfies Record<string, KeeperFixture>;

export type KeeperFixtureId = keyof typeof KEEPER_FIXTURES;
export const KEEPER_FIXTURE_IDS = Object.keys(KEEPER_FIXTURES) as KeeperFixtureId[];
export const keeperFixture = (id: KeeperFixtureId): KeeperFixture => KEEPER_FIXTURES[id];
