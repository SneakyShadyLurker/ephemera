import { z } from "zod";
import { isRecord } from "../card/json.ts";
import { clampKeys, clampText, cutText } from "../memory/clamp.ts";
import { castKey } from "./key.ts";
import { CAST_LIMITS as L } from "./limits.ts";

/*
 * The cast register's shapes: one entry per NPC, a fixed anchor and a
 * volatile state, and the two answers that write them (the keeper's changes,
 * the sheet's entries). Chat content once filled from a chat: tab and request
 * memory only. `chat.ts` imports this file, so it imports nothing that
 * imports `chat.ts`.
 */

const field = z.string().trim().max(L.field);
const name = z.string().trim().min(1).max(L.name);

/** Fixed once written: the keeper fills empty fields, never rewrites set ones. */
export const castAnchorSchema = z.strictObject({
  /** The full name, as the chat writes it. */
  name,
  gender: z.enum(["female", "male", "other"]),
  age: field,
  ethnicity: field,
  skin: field,
  face: field,
  /** Sexual experience. */
  experience: field,
  /** Relationship status. */
  relationship: field,
  height: field,
  weight: field,
  build: field,
  hair: field,
  eyes: field,
  /** "" for a male until a turn or the card establishes it. */
  intimate: field,
  /** Keywords. */
  personality: field,
  /** Fetishes and taboos, one field. */
  fetishes: field,
});
export type CastAnchor = z.infer<typeof castAnchorSchema>;
export type CastGender = CastAnchor["gender"];

/**
 * The anchor's text fields, each optional: durable story changes, separate
 * from the card/initial baseline (tab memory only), and the anchor a keeper
 * change or a sheet item carries.
 */
export const castDevelopmentsSchema = castAnchorSchema.omit({ name: true, gender: true }).partial();
export type CastDevelopments = z.infer<typeof castDevelopmentsSchema>;

/** A remembered person: fixed details only, name and gender required, with no chat identity or scene state. */
export const rememberedCastAnchorSchema = castAnchorSchema.partial().extend({
  name: castAnchorSchema.shape.name,
  gender: castAnchorSchema.shape.gender,
});
export type RememberedCastAnchor = z.infer<typeof rememberedCastAnchorSchema>;

/** Compact continuity cues, never part of a stored sheet or memory Cast line. */
export const castContinuitySchema = z.strictObject({
  voice: field.exactOptional(),
  goals: field.exactOptional(),
  knowledge: field.exactOptional(),
});
export type CastContinuity = z.infer<typeof castContinuitySchema>;

const groundedValue = z.strictObject({
  value: field.min(1),
  evidence: z.string().trim().min(1).max(L.field),
});
const developmentsChange = z.strictObject(
  Object.fromEntries(
    Object.keys(castDevelopmentsSchema.shape).map((key) => [key, groundedValue.exactOptional()]),
  ) as Record<keyof CastDevelopments, ReturnType<typeof groundedValue.exactOptional>>,
);
const continuityChange = z.strictObject(
  Object.fromEntries(
    Object.keys(castContinuitySchema.shape).map((key) => [key, groundedValue.exactOptional()]),
  ) as Record<keyof CastContinuity, ReturnType<typeof groundedValue.exactOptional>>,
);

/** Volatile: the keeper rewrites what changed. */
export const castStateSchema = z.strictObject({
  present: z.boolean(),
  outfit: field,
  position: field,
  activity: field,
  mood: field,
  arousal: field,
  injuries: field,
  intoxication: field,
});
export type CastState = z.infer<typeof castStateSchema>;

export const castEntrySchema = z.strictObject({
  /** Assigned once at creation (an injected id function); never changes, renames included. */
  id: z.uuid(),
  role: z.enum(["principal", "minor"]),
  anchor: castAnchorSchema,
  developments: castDevelopmentsSchema.exactOptional(),
  continuity: castContinuitySchema.exactOptional(),
  /** Earlier names the chat used for this entry, for resolution. */
  aka: z.array(name).max(L.aka).default([]),
  state: castStateSchema,
});
export type CastEntry = z.infer<typeof castEntrySchema>;
export type CastRole = CastEntry["role"];

/** Introduction order; the panel and both prompt texts keep it. */
export const castRegisterSchema = z.strictObject({
  entries: z.array(castEntrySchema).max(L.entries),
});
export type CastRegister = z.infer<typeof castRegisterSchema>;

/** The anchor's text fields, in the present block's order. */
export type CastAnchorField = Exclude<keyof CastAnchor, "name" | "gender">;
export const CAST_ANCHOR_FIELDS = Object.keys(castAnchorSchema.shape).filter(
  (key): key is CastAnchorField => key !== "name" && key !== "gender",
);

/** The state's text fields, in state order. */
export type CastStateField = Exclude<keyof CastState, "present">;
export const CAST_STATE_FIELDS = Object.keys(castStateSchema.shape).filter(
  (key): key is CastStateField => key !== "present",
);

/** An anchor with every text field empty. */
export const emptyCastAnchor = (anchorName: string, gender: CastGender): CastAnchor => ({
  name: anchorName,
  gender,
  ...(Object.fromEntries(CAST_ANCHOR_FIELDS.map((key) => [key, ""])) as Record<
    CastAnchorField,
    string
  >),
});

/** A state with every text field empty. */
export const emptyCastState = (present: boolean): CastState => ({
  present,
  ...(Object.fromEntries(CAST_STATE_FIELDS.map((key) => [key, ""])) as Record<
    CastStateField,
    string
  >),
});

const changeSchema = z.strictObject({
  /** The entry's earlier name, when the chat learned the full one ("Ilse" to "Ilse Brandt"). */
  was: name.exactOptional(),
  role: castEntrySchema.shape.role.exactOptional(),
  gender: castAnchorSchema.shape.gender.exactOptional(),
  anchor: castDevelopmentsSchema.exactOptional(),
  state: castStateSchema.partial().exactOptional(),
  developments: developmentsChange.exactOptional(),
  continuity: continuityChange.exactOptional(),
});
export type CastChange = z.infer<typeof changeSchema>;

/** The keeper's answer: changes only. */
export const castChangesSchema = z.strictObject({
  /** By full name: fields to set on that NPC, a new NPC's whole anchor. */
  cast: z.record(name, changeSchema),
  /** Names no longer in the scene at the end of the turn. */
  absent: z.array(name).default([]),
});
export type CastChanges = z.infer<typeof castChangesSchema>;

const fieldClamps = (keys: readonly string[]) =>
  Object.fromEntries(keys.map((key) => [key, (value: unknown) => clampText(value, L.field)]));
const anchorClamps = fieldClamps(CAST_ANCHOR_FIELDS);
const keep = (value: unknown): unknown => value;

/** A name cut to its bound; a blank one is none. */
const clampName = (value: unknown): unknown => clampText(value, L.name);

/** One change within bounds: unknown keys dropped, strings cut, a blank `was` none. */
function clampChange(value: unknown): unknown {
  const groundedClamps = (keys: readonly string[]) =>
    Object.fromEntries(
      keys.map((key) => [
        key,
        (item: unknown) =>
          clampKeys(item, {
            value: (text) => clampText(text, L.field),
            evidence: (text) => clampText(text, L.field),
          }),
      ]),
    );
  const clamped = clampKeys(value, {
    was: clampName,
    role: keep,
    gender: keep,
    anchor: (anchor) => clampKeys(anchor, anchorClamps),
    state: (state) => clampKeys(state, { present: keep, ...fieldClamps(CAST_STATE_FIELDS) }),
    developments: (fields) => clampKeys(fields, groundedClamps(CAST_ANCHOR_FIELDS)),
    continuity: (fields) =>
      clampKeys(fields, groundedClamps(Object.keys(castContinuitySchema.shape))),
  });
  if (isRecord(clamped) && clamped.was === "") delete clamped.was;
  return clamped;
}

/**
 * The keeper's answer, parsed from JSON, brought within `CAST_LIMITS` before
 * `castChangesSchema` reads it: strings cut, keys the schema does not name
 * dropped, blank names dropped, `cast` capped at `entries`. What it cannot
 * mend (a value of another type) still fails the schema.
 */
export const clampCastChanges = (value: unknown): unknown =>
  clampKeys(value, {
    cast: (cast) =>
      isRecord(cast)
        ? Object.fromEntries(
            Object.entries(cast)
              .map(([key, change]) => [clampName(key), clampChange(change)] as const)
              .filter(([key]) => key !== "")
              .slice(0, L.entries),
          )
        : cast,
    absent: (absent) =>
      Array.isArray(absent)
        ? absent
            .map(clampName)
            .filter((item) => item !== "")
            .slice(0, L.entries)
        : absent,
  });

const sheetItemSchema = z.strictObject({
  name,
  gender: castAnchorSchema.shape.gender,
  role: castEntrySchema.shape.role.default("principal"),
  anchor: castDevelopmentsSchema,
});

/** What the sheet call returns: the card's subjects and their anchors. */
export const castSheetAnswerSchema = z.strictObject({
  cast: z.array(sheetItemSchema).max(L.sheetEntries),
});
export type CastSheetAnswer = z.infer<typeof castSheetAnswerSchema>;

/** A stored sheet entry: an entry without its state. */
export const castSheetEntrySchema = castEntrySchema.omit({
  state: true,
  developments: true,
  continuity: true,
});
export type CastSheetEntry = z.infer<typeof castSheetEntrySchema>;

/**
 * The sheet call's answer, parsed from JSON, brought within `CAST_LIMITS`
 * before `castSheetAnswerSchema` reads it: strings cut, unknown keys
 * dropped, a missing gender `other`, nameless and duplicate people (by
 * `castKey`, first wins) dropped, at most `sheetEntries` kept.
 */
export const clampCastSheetAnswer = (value: unknown): unknown =>
  clampKeys(value, {
    cast: (cast) => {
      if (!Array.isArray(cast)) return cast;
      const seen = new Set<string>();
      return cast
        .map((item) => {
          const clamped = clampKeys(item, {
            name: clampName,
            gender: keep,
            role: keep,
            anchor: (anchor) => clampKeys(anchor, anchorClamps),
          });
          if (isRecord(clamped) && !("gender" in clamped)) clamped.gender = "other";
          return clamped;
        })
        .filter((item) => {
          if (!isRecord(item)) return true;
          if (typeof item.name !== "string") return true;
          if (item.name === "") return false;
          const key = castKey(item.name);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, L.sheetEntries);
    },
  });

/** The fields of a partial anchor that hold text. */
export const setAnchorFields = (
  anchor: Partial<Record<CastAnchorField, string | undefined>>,
): Partial<Record<CastAnchorField, string>> =>
  Object.fromEntries(
    CAST_ANCHOR_FIELDS.flatMap((key) => {
      const value = anchor[key];
      return value === undefined || value === "" ? [] : [[key, value]];
    }),
  );

/**
 * The sheet answer as stored entries: one per person in order, `id` from
 * `newId`, missing anchor fields empty. `clampCastSheetAnswer` already
 * dropped duplicates and `castSheetAnswerSchema` bounds the count.
 */
export const sheetEntriesFromAnswer = (
  answer: CastSheetAnswer,
  newId: () => string,
): CastSheetEntry[] =>
  answer.cast.map((item) => ({
    id: newId(),
    role: item.role,
    anchor: { ...emptyCastAnchor(item.name, item.gender), ...setAnchorFields(item.anchor) },
    aka: [],
  }));

/** An owner's correction of an entry's fields, as the panel writes it. */
export interface CastCorrectionPatch {
  anchor?: Partial<CastAnchor>;
  state?: Partial<CastState>;
}

/**
 * An owner's correction within `CAST_LIMITS`, as the register's schema takes
 * it: every text trimmed and cut to its bound. Null for a blank name, which
 * no entry may have.
 */
export function clampCastCorrection(patch: CastCorrectionPatch): CastCorrectionPatch | null {
  const anchor: Partial<CastAnchor> = { ...patch.anchor };
  for (const key of CAST_ANCHOR_FIELDS) {
    const value = anchor[key];
    if (value !== undefined) anchor[key] = cutText(value, L.field);
  }
  if (anchor.name !== undefined) {
    anchor.name = cutText(anchor.name, L.name);
    if (anchor.name === "") return null;
  }
  const state: Partial<CastState> = { ...patch.state };
  for (const key of CAST_STATE_FIELDS) {
    const value = state[key];
    if (value !== undefined) state[key] = cutText(value, L.field);
  }
  return {
    ...(patch.anchor === undefined ? {} : { anchor }),
    ...(patch.state === undefined ? {} : { state }),
  };
}
