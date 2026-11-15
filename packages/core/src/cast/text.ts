import { effectiveCastAnchor } from "./effective.ts";
import {
  CAST_ANCHOR_FIELDS,
  CAST_STATE_FIELDS,
  type CastAnchor,
  type CastAnchorField,
  type CastEntry,
  type CastRegister,
  type CastState,
  type CastStateField,
} from "./register.ts";

/*
 * The register as the narrator and the scene picture read it: the fixed
 * anchors as a source block, the volatile state as a depth-1 line, the
 * present people's looks as scene notes. Chat content: built for one
 * request, never stored.
 */

/** An age as the line prints it: a bare number as "N years old", any other wording as written. */
const ageText = (age: string): string => (/^\d+$/.test(age) ? `${age} years old` : age);

/** An anchor field as a line prints it. */
const anchorText = (anchor: CastAnchor, field: CastAnchorField): string =>
  field === "age" ? ageText(anchor.age) : anchor[field];

/**
 * A field under its key, as the narrator's lines print it; "" for an empty
 * one. A value that opens with its own key, as "fetishes: none; taboos:
 * none" does, stands as written.
 */
const labelled = (label: string, value: string): string =>
  value === "" || value.toLowerCase().startsWith(`${label}:`) ? value : `${label}: ${value}`;

/** A narrator line: its parts, empty ones left out. Values hold commas of their own, so "; " parts them. */
const line = (parts: readonly string[]): string => parts.filter((part) => part !== "").join("; ");

/** The anchor fields given, each under its key. */
const anchorParts = (anchor: CastAnchor, fields: readonly CastAnchorField[]): string[] =>
  fields.map((field) => labelled(field, anchorText(anchor, field)));

/**
 * What `<cast>` holds of a minor entry beyond name and gender: enough to
 * know them by. The block sits before the chat history and goes out with
 * every reply, so it keeps the full anchor for principals alone.
 */
const MINOR_IDENTITY: readonly CastAnchorField[] = ["age", "build", "hair"];
/** A minor's other anchor fields: the narrator reads them in `Cast now` while the entry is present. */
const MINOR_DETAILS = CAST_ANCHOR_FIELDS.filter((field) => !MINOR_IDENTITY.includes(field));

/** What follows the name on the line of an entry's hidden state. */
const HIDDEN_LABEL = "hidden from the player";

/** An entry's baseline line: the name, the gender once known, then the fields its role carries. */
const anchorLine = ({ anchor, role }: CastEntry): string =>
  line([
    anchor.name,
    anchor.gender === "other" ? "" : `gender: ${anchor.gender}`,
    ...anchorParts(anchor, role === "minor" ? MINOR_IDENTITY : CAST_ANCHOR_FIELDS),
  ]);

/**
 * The `<cast>` source block: one line per entry in register order, present
 * and away alike (an away NPC may return); a principal's whole baseline
 * anchor, a minor's identity. "" for an empty register. It changes only
 * when an entry does, so a provider's prefix cache keeps it.
 */
export function castAnchorsText(register: CastRegister): string {
  if (register.entries.length === 0) return "";
  return [
    "<cast>",
    "Every NPC's card or initial baseline, the player excepted and minor figures in brief: preserve these details unless current durable overrides in Cast now take precedence for changed fields.",
    ...register.entries.map(anchorLine),
    "</cast>",
  ].join("\n");
}

/**
 * A present entry's lines: its state in state order, then what the turns
 * established beyond the player's perception, then for a minor the anchor
 * fields `<cast>` leaves out, as they stand now.
 */
function presentLines(entry: CastEntry): string[] {
  const { name } = entry.anchor;
  const state = line([
    name,
    "present",
    ...CAST_STATE_FIELDS.map((field) => labelled(field, entry.state[field])),
  ]);
  const hidden = line(
    CAST_STATE_FIELDS.map((field) => labelled(field, entry.hidden?.[field] ?? "")),
  );
  const details =
    entry.role === "minor" ? line(anchorParts(effectiveCastAnchor(entry), MINOR_DETAILS)) : "";
  return [
    state,
    ...(hidden === "" ? [] : [`${name} ${HIDDEN_LABEL}: ${hidden}`]),
    ...(details === "" ? [] : [`${name} details: ${details}`]),
  ];
}

/**
 * The `Cast now` message the narrator reads at depth 1: every entry's
 * durable overrides and continuity cues (each knowledge item a pair of its
 * own), a state line per present entry (with what is hidden from the player
 * and a present minor's remaining details), then the away ones by name.
 * "" for an empty register. `behind` says the register was read before the
 * newest reply: the opening line then puts the latest turns first.
 */
export function castStateText(register: CastRegister, behind = false): string {
  if (register.entries.length === 0) return "";
  const present = register.entries.filter((entry) => entry.state.present);
  const away = register.entries.filter((entry) => !entry.state.present);
  const lines = [
    ...register.entries.flatMap((entry) => {
      const effective = effectiveCastAnchor(entry);
      const overrides = Object.keys(entry.developments ?? {}).map((key) => {
        const field = key as keyof NonNullable<CastEntry["developments"]>;
        return `${field}: ${effective[field] || "unknown"}`;
      });
      const { voice = "", goals = "", knowledge = [] } = entry.continuity ?? {};
      const cues = [
        labelled("voice", voice),
        labelled("goals", goals),
        ...knowledge.map((item) => labelled("knowledge", item)),
      ].filter((cue) => cue !== "");
      return [
        ...(overrides.length === 0
          ? []
          : [`${effective.name} current durable overrides: ${overrides.join("; ")}`]),
        ...(cues.length === 0 ? [] : [`${effective.name} continuity: ${cues.join("; ")}`]),
      ];
    }),
    ...present.flatMap(presentLines),
    ...(away.length === 0 ? [] : [`Away: ${away.map((entry) => entry.anchor.name).join(", ")}`]),
  ];
  const opening = behind
    ? "Cast now, recorded before the latest reply; where the latest turns differ, they win:"
    : "Cast now:";
  return `[${opening}\n${lines.join("\n")}]`;
}

/** The anchor fields a scene picture shows: the looks. */
const PEOPLE_ANCHOR: readonly CastAnchorField[] = [
  "age",
  "ethnicity",
  "skin",
  "face",
  "height",
  "weight",
  "build",
  "hair",
  "eyes",
  "intimate",
];
/** The state fields a scene picture shows: the outfit as it is worn and how the entry stands. */
const PEOPLE_STATE: readonly CastStateField[] = [
  "outfit",
  "disarray",
  "position",
  "activity",
  "mood",
  "injuries",
];

/** What a scene picture shows of a present entry: its looks, outfit as worn and how it stands, comma-joined. */
const peopleLine = (anchor: CastAnchor, state: CastState): string =>
  [
    anchor.name,
    ...PEOPLE_ANCHOR.map((field) => anchorText(anchor, field)),
    ...PEOPLE_STATE.map((field) => state[field]),
  ]
    .filter((part) => part !== "")
    .join(", ");

/** The `<people>` notes of a scene picture: a line per present entry; "" when no one is present. */
export const castPeopleNotes = (register: CastRegister): string =>
  register.entries
    .filter((entry) => entry.state.present)
    .map((entry) => peopleLine(effectiveCastAnchor(entry), entry.state))
    .join("\n");
