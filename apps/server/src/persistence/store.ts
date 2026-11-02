import type {
  CastSheet,
  CastSheetEntry,
  ChapterOutput,
  CharacterCard,
  CharacterPatch,
  CharacterSummary,
  CustomPalette,
  CustomPaletteInput,
  CustomSlot,
  EmbeddedLorebook,
  EpisodeFields,
  EventFields,
  Lorebook,
  LorebookFields,
  LorebookLinks,
  LorebookSummary,
  MemoryOutput,
  MemoryState,
  MemoryStatePatchRequest,
  PersonaFields,
  PersonaPatch,
  PersonaSummary,
  PromptPreset,
  SamplerPreset,
  Settings,
  SettingsPatch,
  StoredCharacter,
  StoredEpisode,
  StoredEvent,
  StoredLorebook,
  StoredPersona,
  StoredPromptPreset,
  StoredSamplerPreset,
  StoredWorkflow,
  WorkflowFields,
  WorkflowGraph,
  WorkflowSummary,
} from "@ephemera/core";
import { z } from "zod";
import type { Username } from "../identity.ts";
import { isPng } from "../png.ts";

/*
 * The persistence layer's contract, free of database types, so route modules
 * and the web's RPC types can name it without reaching SQLite.
 */

const startsWith = (bytes: Uint8Array, prefix: number[], offset = 0) =>
  prefix.every((byte, i) => bytes[offset + i] === byte);
/** RIFF....WEBP */
const isWebp = (bytes: Uint8Array) =>
  startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8);

/** A portrait as the image pipeline produces it; nothing else is stored as an image. */
export const portraitSchema = z.strictObject({
  png: z.instanceof(Uint8Array).refine(isPng, "png must be a PNG"),
  thumb: z.instanceof(Uint8Array).refine(isWebp, "thumb must be a WebP"),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type Portrait = z.infer<typeof portraitSchema>;

export type { StoredCharacter, StoredLorebook, StoredPersona };

/** The two images every portrait is stored as: the PNG and its WebP thumbnail. */
export const PORTRAIT_SIZES = ["full", "thumb"] as const;
export type PortraitSize = (typeof PORTRAIT_SIZES)[number];

/**
 * The outcome of an edit made against `revision`: written (the revision goes
 * up by one), refused because the entity is at another revision (nothing is
 * written), or no such entity. An edit against another revision that would
 * change nothing (a retry of a save whose answer was lost) is answered as
 * written, at the current revision, and writes nothing: no edit is lost and
 * none is overwritten.
 */
export type Updated<T> =
  | { status: "updated"; value: T }
  | { status: "conflict"; revision: number }
  | { status: "missing" };

/** The portrait of one kind of owner (a character or a persona), by the owner's id. */
export interface PortraitStore {
  /** Stores or replaces the portrait; returns its new version, or undefined for an unknown owner. */
  setPortrait(id: string, portrait: Portrait): number | undefined;
  removePortrait(id: string): boolean;
  /** The current portrait's version, without its bytes; undefined when there is none. */
  portraitVersion(id: string): number | undefined;
  portrait(
    id: string,
    size: PortraitSize,
  ): Promise<{ bytes: Uint8Array; version: number } | undefined>;
}

export interface CharacterStore extends PortraitStore {
  list(): CharacterSummary[];
  get(id: string): StoredCharacter | undefined;
  /** Whether the character exists, without reading its card. */
  exists(id: string): boolean;
  /** Creates a character; with `id`, a repeat of the same create is a no-op returning that id. */
  create(card: CharacterCard, portrait?: Portrait, id?: string): string;
  update(
    id: string,
    patch: CharacterPatch,
    revision: number,
  ): Updated<{ card: CharacterCard; revision: number }>;
  /** Copies the card, portrait and lorebook links; the persona binding stays with the original. */
  duplicate(id: string): string | undefined;
  /** Removes the character; its portrait, binding and lorebook links go with it. */
  remove(id: string): boolean;
}

export interface PersonaStore extends PortraitStore {
  list(): PersonaSummary[];
  get(id: string): StoredPersona | undefined;
  /** Creates a persona under a client-chosen id; a repeat of the same create is a no-op. */
  create(fields: PersonaFields, id: string): string;
  update(id: string, patch: PersonaPatch, revision: number): Updated<StoredPersona>;
  /** Copies name, description and portrait; bindings stay with the original. */
  duplicate(id: string): string | undefined;
  remove(id: string): boolean;
  /** Which persona a character goes with (null: none); false for an unknown character or persona. */
  bind(characterId: string, personaId: string | null): boolean;
}

/** A partial edit as a strict Zod partial parses it: absent keys, or keys with values. */
export type Patch<T> = { [K in keyof T]?: T[K] | undefined };

/** A library book as generation reads it, for one character. */
export interface LinkedLorebook {
  id: string;
  name: string;
  book: Lorebook;
}

/**
 * The outcome of linking a book to a character: linked (also when it already
 * was, which changes nothing), either side missing, or the character already
 * at `LOREBOOK_LINKS`.
 */
export type LinkResult = "linked" | "missing" | "full";

export interface LorebookStore {
  /** By name. */
  list(): LorebookSummary[];
  /** Every character whose card has a book, empty ones included, by name. */
  embedded(): EmbeddedLorebook[];
  /** Every character's linked books, in link order. */
  links(): LorebookLinks;
  get(id: string): StoredLorebook | undefined;
  /** Creates a book under a client-chosen id; a repeat of the same create is a no-op. */
  create(fields: LorebookFields, id: string): string;
  update(id: string, patch: Patch<LorebookFields>, revision: number): Updated<StoredLorebook>;
  /** Copies the book under a new name; links stay with the original. */
  duplicate(id: string): string | undefined;
  /** Removes the book; its links go with it. */
  remove(id: string): boolean;
  /** The character's linked books in link order; none for an unknown character. */
  booksOf(characterId: string): LinkedLorebook[];
  link(lorebookId: string, characterId: string): LinkResult;
  /** Unlinks (a missing link is no change); the other links keep their order. False when either side is missing. */
  unlink(lorebookId: string, characterId: string): boolean;
}

/** The outcome of creating an event: created (also by a repeat of the same create), or refused at `EVENT_LIMITS.events`. */
export type EventCreation = "created" | "full";

export interface EventStore {
  /** Newest first: by creation time, then id. */
  list(): StoredEvent[];
  get(id: string): StoredEvent | undefined;
  /** Creates an event under a client-chosen id; a repeat of the same create is a no-op. */
  create(fields: EventFields, id: string): EventCreation;
  update(id: string, patch: Patch<EventFields>, revision: number): Updated<StoredEvent>;
  remove(id: string): boolean;
}

/**
 * The outcome of writing a memory: written (the episode, and the notebook as
 * it stands after), refused because memory is off for the character, no such
 * character, or the character's book at `MEMORY_LIMITS.episodes`.
 */
export type Remembered =
  | { status: "written"; episode: StoredEpisode; notebook: MemoryState }
  | "off"
  | "missing"
  | "full";

/** A chapter's member as it was read: what the chapter's write checks has not moved. */
export type ChapterMember = Pick<StoredEpisode, "id" | "revision" | "chapterId">;

/**
 * A character's memory: the notebook row (memory is on without one, and
 * while it is enabled: core `memoryIsOn`) and the book of episodes. Only what the memory call wrote and the owner
 * edited; the span it came from never reaches this store (PRINCIPLES.md 1).
 */
export interface MemoryStore {
  /** The notebook row, or undefined while nothing needed one (memory on, notebook empty). */
  state(characterId: string): MemoryState | undefined;
  /**
   * Turns memory on or off or rewrites the notebook or the next chat's
   * opening against `revision`; a character without a row is at revision 0,
   * and the write creates it.
   */
  setState(
    characterId: string,
    patch: Patch<{
      enabled: boolean;
      notebook: NonNullable<MemoryStatePatchRequest["notebook"]>;
      opening: string;
    }>,
    revision: number,
  ): Updated<MemoryState>;
  /** By `seq`, oldest first. */
  list(characterId: string): StoredEpisode[];
  get(id: string): StoredEpisode | undefined;
  update(id: string, patch: Patch<EpisodeFields>, revision: number): Updated<StoredEpisode>;
  /** Removes an episode; the episodes a chapter merged are free again. */
  remove(id: string): boolean;
  /**
   * Removes every episode and empties the notebook and the opening, keeping
   * on or off; false for an unknown character.
   */
  forget(characterId: string): boolean;
  /**
   * Writes one episode, next in `seq`, while memory is still on; the notebook
   * and the opening only when its revision is still `notebookRevision` (else
   * the owner's edit stays), creating the row when the character has none.
   */
  remember(
    characterId: string,
    input: { output: MemoryOutput; turns: number; notebookRevision: number },
  ): Remembered;
  /**
   * Writes a chapter merging `members` (episodes of the character, as read
   * before the chapter was asked for) and marks them; one transaction.
   * `stale` when any member is gone, was edited since (its revision moved)
   * or already belongs to a chapter.
   */
  chapter(
    characterId: string,
    input: { output: ChapterOutput; members: ChapterMember[] },
  ): StoredEpisode | "off" | "missing" | "full" | "stale";
}

/** The outcome of deleting a preset: the last one of a kind stays. */
export type PresetRemoval = "removed" | "missing" | "last";

export interface PresetKindStore<Preset, Stored> {
  /** Most recently edited first. */
  list(): Stored[];
  get(id: string): Stored | undefined;
  /** Creates a preset under a client-chosen id; a repeat of the same create is a no-op. */
  create(preset: Preset, id: string): string;
  update(id: string, patch: Patch<Preset>, revision: number): Updated<Stored>;
  duplicate(id: string): string | undefined;
  /** Deleting the preset in use points the settings at the most recently edited other one. */
  remove(id: string): PresetRemoval;
}

export interface PresetStore {
  prompt: PresetKindStore<PromptPreset, StoredPromptPreset>;
  sampler: PresetKindStore<SamplerPreset, StoredSamplerPreset>;
  /** Creates an imported pair in one transaction; a repeat of the same import is a no-op. */
  createPair(
    prompt: PromptPreset,
    sampler: SamplerPreset,
    ids: { prompt: string; sampler: string },
  ): void;
}

export interface SettingsStore {
  get(): Settings;
  /** Applies a strict partial; undefined when a reference, or a custom palette, names nothing that exists. */
  update(patch: SettingsPatch): Settings | undefined;
}

export interface CustomPaletteStore {
  /** By slot. */
  list(): CustomPalette[];
  /** Saves a palette in an empty slot; undefined when the slot holds one (another tab's). */
  create(slot: CustomSlot, palette: CustomPaletteInput): CustomPalette | undefined;
  /** Replaces the palette saved at `updatedAt`; "missing" for an empty slot, "changed" when another save came since. */
  replace(
    slot: CustomSlot,
    palette: CustomPaletteInput,
    updatedAt: number,
  ): CustomPalette | "missing" | "changed";
  /**
   * Removes the palette saved at `updatedAt`; settings that chose it return
   * to its built-in base or the default palette. "missing" or "changed" as for replace.
   */
  delete(slot: CustomSlot, updatedAt: number): "deleted" | "missing" | "changed";
}

/** A workflow create's outcome: "full" at `WORKFLOW_LIMITS.workflows`, "name_taken" for a name another has in any case. */
export type WorkflowCreation = "created" | "full" | "name_taken";

/** The user's imported ComfyUI workflows, by uuid (the public id is `user-<uuid>`). */
export interface WorkflowStore {
  /** Summaries by name, case-insensitively; never the graph. */
  list(): WorkflowSummary[];
  get(id: string): StoredWorkflow | undefined;
  /** Client-chosen id; a repeat of the same create is a no-op "created". */
  create(fields: WorkflowFields, id: string): WorkflowCreation;
  /** Metadata edit: name and family only, never the graph. */
  update(
    id: string,
    patch: Patch<Pick<WorkflowFields, "name" | "family">>,
    revision: number,
  ): Updated<StoredWorkflow> | "name_taken";
  /** Graph replacement: the finalized template and its node count. */
  replaceGraph(id: string, graph: WorkflowGraph, revision: number): Updated<StoredWorkflow>;
  /** Removes it; settings naming `user-<id>` return to the server's default workflow in the same transaction. */
  remove(id: string): boolean;
}

/** Characters' cast sheets; a sheet goes with its character (cascade). */
export interface CastSheetStore {
  /** The character's sheet, or null while none was read. */
  get(characterId: string): CastSheet | null;
  /**
   * Writes the character's sheet, creating it or replacing it with one more
   * revision. Entries carry anchors only: a `state` key is refused.
   */
  put(characterId: string, sheet: { fingerprint: string; entries: CastSheetEntry[] }): CastSheet;
}

/** Every store, over one database, so references between entities hold. */
export interface Stores {
  characters: CharacterStore;
  personas: PersonaStore;
  presets: PresetStore;
  lorebooks: LorebookStore;
  events: EventStore;
  memory: MemoryStore;
  castSheets: CastSheetStore;
  settings: SettingsStore;
  palettes: CustomPaletteStore;
  workflows: WorkflowStore;
}

/** One user's open instance: their stores over their in-memory database. */
export interface UserInstance {
  readonly username: Username;
  readonly stores: Stores;
  /** Generation calibration ratios by model; they live and die with the instance. */
  readonly calibration: Map<string, number>;
  /** A request (or its stream) is in flight: the instance is not evicted. */
  enter(): void;
  /** The request (or its stream) ended: the idle timeout starts again. */
  leave(): void;
  /** Writes the database to its encrypted file when it changed; serialized and coalesced. */
  flushIfDirty(): Promise<void>;
}

export interface InstanceRegistry {
  /** Opens (or returns the open) instance; throws for a file that cannot be opened. */
  instance(username: Username): UserInstance;
  readonly size: number;
  /** Stops evicting, flushes every instance and drops them all; `instance` refuses from then on. */
  close(): Promise<void>;
}

export class RegistryClosed extends Error {
  override name = "RegistryClosed";
}
