/**
 * What the mock upstream answers a cast keeper call and a cast sheet call
 * with. Only the cast models below get the cast; every other model reads
 * an empty sheet and changes nothing, so a chat on it has no cast. The keeper upserts, from the newest turn, a woman whose name carries
 * that turn's canary with `-in-` turned to `-cast-` (as replies turn it to
 * `-out-`), and marks a man present: the narrator and keeper are sent him,
 * the panel, which lists women only, does not show him. The sheet answer is
 * fixed: a female and a male principal, nothing of the card it was sent.
 * Both answers are parsed with the core schemas, so drift fails here.
 */
import {
  CAST_ANCHOR_FIELDS,
  type CastAnchorField,
  type CastChanges,
  type CastDiscoveries,
  type CastSheetAnswer,
  castChangesSchema,
  castSheetAnswerSchema,
  KEEPER_OPENING,
  SHEET_OPENING,
} from "../../packages/core/src/cast/index.ts";

export type CastCall = "cast" | "castSheet";

/**
 * The models whose keeper and sheet calls get the cast below: `mock-cast`,
 * and `mock-slow`, which holds the answer first.
 */
export const CAST_MODELS: readonly string[] = ["mock-cast", "mock-slow"];

/** The sheet answer of any other model: nobody. */
export const EMPTY_SHEET_ANSWER = JSON.stringify(castSheetAnswerSchema.parse({ cast: [] }));
/** The keeper answer of any other model: no change. */
export const EMPTY_CAST_ANSWER = JSON.stringify(castChangesSchema.parse({ cast: {}, absent: [] }));

/** This card's first sheet read fails; its retry reads an empty fixed cast. */
export const SHEET_RETRY_EMPTY = "[e2e-cast-sheet-retry-empty]";

/** The keeper or sheet call a request is, by its system instructions; null for any other. */
export function castCall(messages: { role: string; content: string }[]): CastCall | null {
  const system = messages.find((message) => message.role === "system")?.content ?? "";
  if (system.startsWith(KEEPER_OPENING)) return "cast";
  if (system.startsWith(SHEET_OPENING)) return "castSheet";
  return null;
}

/** The sheet's female principal. */
export const SHEET_WOMAN = "Elin Varga";
/** The sheet's male principal. */
export const SHEET_MAN = "Teodor Varga";
/** The man every keeper answer marks present. */
export const KEEPER_MAN = "Tomas Weir";
/** The given name of the woman a keeper answer upserts; her surname is the turn's canary. */
export const KEEPER_WOMAN_GIVEN = "Nell";
/** Her surname when the newest turn carries no `-in-` mark. */
const UNMARKED_SURNAME = "Harrow";
/** Her outfit, so a spec can find a state field in the panel or a prompt. */
export const KEEPER_WOMAN_OUTFIT = "a grey wool coat over a green dress";

/** Only a marked turn asks for a grounded change to the sheet's existing baseline. */
export const DEVELOPMENT_TURN = "[e2e-cast-development] Elin cut her hair into a silver bob.";
export const DEVELOPED_HAIR = "silver bob";

const SHEET: CastSheetAnswer = castSheetAnswerSchema.parse({
  cast: [
    {
      name: SHEET_WOMAN,
      gender: "female",
      role: "principal",
      anchor: {
        age: "29",
        ethnicity: "Hungarian",
        skin: "fair skin, lightly freckled",
        face: "oval face, high cheekbones, a small scar on the chin",
        experience: "placeholder experience",
        relationship: "single",
        height: "168cm",
        weight: "60kg",
        build: "slim, long-legged build",
        hair: "shoulder-length dark brown hair in loose waves",
        eyes: "grey-green almond-shaped eyes",
        intimate: "placeholder intimate description",
        personality: "dry, watchful, loyal personality",
        fetishes: "fetishes: placeholder; taboos: placeholder",
      },
    },
    {
      name: SHEET_MAN,
      gender: "male",
      role: "principal",
      anchor: {
        age: "34",
        ethnicity: "Hungarian",
        skin: "weathered olive skin",
        face: "square face, broken nose, short beard",
        experience: "placeholder experience",
        relationship: "married",
        height: "185cm",
        weight: "88kg",
        build: "broad, heavy-shouldered build",
        hair: "short-cropped black hair",
        eyes: "deep-set brown eyes",
        intimate: "placeholder intimate description",
        personality: "gruff, patient, protective personality",
        fetishes: "fetishes: placeholder; taboos: placeholder",
      },
    },
  ],
});

/** A sheet call's answer: always the two principals above. */
export function castSheetAnswer(): string {
  return JSON.stringify(SHEET);
}

/** The `<turn>` block of a keeper message: its turns, one line each, newest last. */
const TURN_BLOCK = /<turn>\n([\s\S]*?)\n<\/turn>/;
/** A canary or other mark of the `-in-` class, such as `<marker>-in-1a2b3c4d`. */
const IN_MARK = /[\w]+-in-[\w-]+/g;

/**
 * The surname of the woman a keeper call upserts: the last `-in-` mark of the
 * newest turn that carries one, turned to `-cast-`; a fixed one without.
 */
function surname(messages: { role: string; content: string }[]): string {
  const user = messages.findLast((message) => message.role === "user")?.content ?? "";
  const lines = (TURN_BLOCK.exec(user)?.[1] ?? "").split("\n");
  const mark = lines
    .map((line) => line.match(IN_MARK)?.at(-1))
    .findLast((found) => found !== undefined);
  return mark?.replace("-in-", "-cast-") ?? UNMARKED_SURNAME;
}

/** The name of the woman a keeper call with these messages upserts. */
export function keeperWoman(messages: { role: string; content: string }[]): string {
  return `${KEEPER_WOMAN_GIVEN} ${surname(messages)}`;
}

/** A literal passage from the newest shown turn for the fixture's grounded discoveries. */
function discoveryEvidence(user: string): string {
  const lines = (TURN_BLOCK.exec(user)?.[1] ?? "").split("\n").filter((line) => line !== "");
  const line = lines.at(-1) ?? "";
  const mark = line.match(IN_MARK)?.at(-1);
  if (mark !== undefined) return mark;
  const colon = line.indexOf(": ");
  return (colon === -1 ? line : line.slice(colon + 2)).slice(0, 120);
}

const discoveries = (
  anchor: Partial<Record<CastAnchorField, string | undefined>>,
  evidence: string,
): CastDiscoveries =>
  Object.fromEntries(
    CAST_ANCHOR_FIELDS.flatMap((field) => {
      const value = anchor[field];
      return value === undefined || value === ""
        ? []
        : [[field, { value, basis: "seen", evidence }]];
    }),
  );

/**
 * A keeper call's answer: the woman named from the newest turn, her whole
 * anchor and a present state, and the man present with a minor's anchor.
 * Nobody absent. The same messages always get the same answer.
 */
export function castAnswer(messages: { role: string; content: string }[]): string {
  const user = messages.findLast((message) => message.role === "user")?.content ?? "";
  const development = (TURN_BLOCK.exec(user)?.[1] ?? "").includes(DEVELOPMENT_TURN);
  const evidence = discoveryEvidence(user);
  const keeperAnchor = {
    age: "24",
    ethnicity: "Irish",
    skin: "pale freckled skin",
    face: "heart-shaped face, snub nose",
    experience: "placeholder experience",
    relationship: "single",
    height: "162cm",
    weight: "54kg",
    build: "petite build",
    hair: "long copper-red hair in a braid",
    eyes: "round blue eyes",
    intimate: "placeholder intimate description",
    personality: "curious, quick, teasing personality",
    fetishes: "fetishes: placeholder; taboos: placeholder",
  };
  const changes: CastChanges = castChangesSchema.parse({
    cast: {
      [SHEET_WOMAN]: {
        introduce: { evidence },
        discovered: discoveries(
          { ...SHEET.cast[0]?.anchor, ...(development ? { hair: DEVELOPED_HAIR } : {}) },
          evidence,
        ),
        state: { present: development },
        ...(development
          ? {
              developments: {
                hair: { value: DEVELOPED_HAIR, evidence: "Elin cut her hair into a silver bob." },
                personality: {
                  value: "ungrounded personality fixture",
                  evidence: "This sentence never appeared in a turn.",
                },
              },
            }
          : {}),
      },
      [keeperWoman(messages)]: {
        role: "principal",
        gender: "female",
        introduce: { evidence },
        anchor: keeperAnchor,
        discovered: discoveries(keeperAnchor, evidence),
        state: {
          present: true,
          outfit: KEEPER_WOMAN_OUTFIT,
          position: "by the window, leaning on the sill",
          activity: "reading a folded letter",
          mood: "amused",
        },
      },
      [KEEPER_MAN]: {
        role: "minor",
        gender: "male",
        anchor: { age: "41", ethnicity: "Scottish", build: "stocky build, broad hands" },
        state: { present: true, position: "behind the bar", activity: "polishing a glass" },
      },
    },
    absent: [],
  });
  return JSON.stringify(changes);
}
