import {
  CAST_ANCHOR_FIELDS,
  type CastAnchorField,
  type CastGender,
  readMemoryCastLine,
} from "@ephemera/core";

/*
 * The notebook's cast lines as the owner reads and edits them: a stored line
 * is one JSON object, and only one that reads as a remembered person
 * (`readMemoryCastLine`, the reader that seeds a chat) is a name, a gender and
 * fixed details here, written back in the same shape. Any other line stays
 * raw text.
 */

export const CAST_GENDERS: readonly CastGender[] = ["female", "male", "other"];

/** A person as edited: the name, the gender and the details set. */
export type CastLinePerson = Record<string, string>;

/** The person in a stored line, or null when it does not read as one that seeds a chat. */
export function castLinePerson(line: string): CastLinePerson | null {
  const anchor = readMemoryCastLine(line);
  return anchor === null
    ? null
    : Object.fromEntries(
        Object.entries(anchor).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      );
}

/**
 * The line for an edited person: name, gender, then the details in the
 * anchor's order, empty details left out. A person with no name yet is
 * unfinished, a blank line, which is not saved.
 */
export function castLineText(person: CastLinePerson): string {
  if ((person.name ?? "").trim() === "") return "";
  return JSON.stringify(
    Object.fromEntries(
      ["name", "gender", ...CAST_ANCHOR_FIELDS].flatMap((key) => {
        const value = person[key];
        return value === undefined || (key !== "gender" && value.trim() === "")
          ? []
          : [[key, value]];
      }),
    ),
  );
}

/** The details set on a person, in the anchor's order. */
export const castLineDetails = (person: CastLinePerson): CastAnchorField[] =>
  CAST_ANCHOR_FIELDS.filter((field) => (person[field] ?? "").trim() !== "");

/**
 * The length of a person's line once named: one with no name yet is
 * measured with a one-letter name, so their details keep within a line's
 * limit before the name comes and the name's first letter still fits.
 */
export const castLineLength = (person: CastLinePerson): number =>
  castLineText((person.name ?? "").trim() === "" ? { ...person, name: "x" } : person).length;
