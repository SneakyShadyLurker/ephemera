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

/** The texts given, empty ones left out, comma-joined. */
const joined = (parts: readonly string[]): string => parts.filter((part) => part !== "").join(", ");

/** An anchor field as a line prints it. */
const anchorText = (anchor: CastAnchor, field: CastAnchorField): string =>
  field === "age" ? ageText(anchor.age) : anchor[field];

/** An entry's anchor in the present block's order, outfit and state left out. */
const anchorLine = (anchor: CastAnchor): string =>
  joined([anchor.name, ...CAST_ANCHOR_FIELDS.map((field) => anchorText(anchor, field))]);

/**
 * The `<cast>` source block: one line per entry in register order, present
 * and away alike (an away NPC may return). "" for an empty register.
 */
export function castAnchorsText(register: CastRegister): string {
  if (register.entries.length === 0) return "";
  return [
    "<cast>",
    "Every NPC's card or initial baseline, the player excepted. Preserve these details unless current durable overrides in Cast now take precedence for changed fields; the current state is in the chat.",
    ...register.entries.map((entry) => anchorLine(entry.anchor)),
    "</cast>",
  ].join("\n");
}

/** A present entry's state in state order, empty fields left out. */
const stateLine = ({ anchor, state }: CastEntry): string =>
  `${anchor.name}: ${joined(["present", ...CAST_STATE_FIELDS.map((field) => state[field])])}`;

/**
 * The `Cast now` line the narrator reads at depth 1: a line per present
 * entry, then the away ones by name. "" for an empty register.
 */
export function castStateText(register: CastRegister): string {
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
      const cues = Object.entries(entry.continuity ?? {})
        .filter(([, value]) => value !== "")
        .map(([key, value]) => `${key}: ${value}`);
      return [
        ...(overrides.length === 0
          ? []
          : [
              `${effective.name} current durable overrides (authoritative over <cast> baseline for these fields): ${overrides.join("; ")}`,
            ]),
        ...(cues.length === 0 ? [] : [`${effective.name} continuity: ${cues.join("; ")}`]),
      ];
    }),
    ...present.map(stateLine),
    ...(away.length === 0 ? [] : [`Away: ${away.map((entry) => entry.anchor.name).join(", ")}`]),
  ];
  return `[Cast now:\n${lines.join("\n")}]`;
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
/** The state fields a scene picture shows: the outfit and how the entry stands. */
const PEOPLE_STATE: readonly CastStateField[] = [
  "outfit",
  "position",
  "activity",
  "mood",
  "injuries",
];

/** What a scene picture shows of a present entry: its looks, outfit and how it stands. */
const peopleLine = (anchor: CastAnchor, state: CastState): string =>
  joined([
    anchor.name,
    ...PEOPLE_ANCHOR.map((field) => anchorText(anchor, field)),
    ...PEOPLE_STATE.map((field) => state[field]),
  ]);

/** The `<people>` notes of a scene picture: a line per present entry; "" when no one is present. */
export const castPeopleNotes = (register: CastRegister): string =>
  register.entries
    .filter((entry) => entry.state.present)
    .map((entry) => peopleLine(effectiveCastAnchor(entry), entry.state))
    .join("\n");
