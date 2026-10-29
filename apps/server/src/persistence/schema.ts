import type {
  ArtFamily,
  AuthorsNote,
  CastSheetEntry,
  CharacterCard,
  ContextLimits,
  ContextWindows,
  CustomPalette,
  CustomSlot,
  EpisodeKind,
  EventScope,
  Lorebook,
  LorebookCounts,
  PaletteChoice,
  PromptActions,
  PromptBlock,
  PromptProcessingSettings,
  PromptReasoning,
  ReasoningEffort,
  SamplerValues,
  Settings,
  Theme,
  WorkflowFields,
} from "@ephemera/core";
import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  blob,
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/*
 * The only tables Ephemera writes (PRINCIPLES.md 1): characters, personas,
 * presets, settings, custom palettes, their portraits, library lorebooks with their links
 * to characters, events (their definitions; which event fired where is
 * chat content and has no column), characters' memories (the notebook
 * and the episodes the memory call wrote; the span they came from, its
 * turns and its chat have no column), characters' cast sheets (the
 * people the card names, derived from the card alone; a chat's cast
 * register has no column) and imported ComfyUI workflows (configuration:
 * a graph template whose prompt is a placeholder, never text). There is no
 * table, column or code path for chat content. Card data and portrait images are separate rows
 * (PRINCIPLES.md 3); a portrait row keeps the thumbnail and names the
 * encrypted file under `users/<username>/portraits/` that holds the PNG.
 * Column names are snake_case through Drizzle's casing.
 */

export const characters = sqliteTable("characters", {
  id: text().primaryKey(),
  /** Denormalized from the card for listing, searching and ordering. */
  name: text().notNull(),
  nickname: text().notNull(),
  creator: text().notNull(),
  tags: text({ mode: "json" }).$type<string[]>().notNull(),
  card: text({ mode: "json" }).$type<CharacterCard>().notNull(),
  /** One more with every edit; a stale edit is refused (optimistic concurrency). */
  revision: integer().notNull().default(0),
  createdAt: integer().notNull(),
  updatedAt: integer().notNull(),
});

export const personas = sqliteTable("personas", {
  id: text().primaryKey(),
  name: text().notNull(),
  description: text().notNull(),
  /** One more with every edit; a stale edit is refused (optimistic concurrency). */
  revision: integer().notNull().default(0),
  createdAt: integer().notNull(),
  updatedAt: integer().notNull(),
});

/** A character goes with at most one persona; deleting either side removes the binding. */
export const personaBindings = sqliteTable(
  "persona_bindings",
  {
    characterId: text()
      .primaryKey()
      .references(() => characters.id, { onDelete: "cascade" }),
    personaId: text()
      .notNull()
      .references(() => personas.id, { onDelete: "cascade" }),
  },
  (table) => [index("persona_bindings_persona_id_idx").on(table.personaId)],
);

/** A library lorebook: a standalone book, linked to characters by `characterLorebooks`. */
export const lorebooks = sqliteTable("lorebooks", {
  id: text().primaryKey(),
  /** The book's own `name` mirrors it on every write. */
  name: text().notNull(),
  book: text({ mode: "json" }).$type<Lorebook>().notNull(),
  /**
   * The book's counts for the library list (core `summarizeLorebook`), so
   * the list never parses a book: written with every book and brought up to
   * date when the database opens (`{}` only until then, in a row from before).
   */
  counts: text({ mode: "json" }).$type<LorebookCounts>().notNull().default(sql`'{}'`),
  /** One more with every edit; a stale edit is refused (optimistic concurrency). */
  revision: integer().notNull().default(0),
  createdAt: integer().notNull(),
  updatedAt: integer().notNull(),
});

/**
 * A character's linked library books, in `position` order (at most
 * `LOREBOOK_LINKS`); deleting either side removes the link.
 */
export const characterLorebooks = sqliteTable(
  "character_lorebooks",
  {
    characterId: text()
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    lorebookId: text()
      .notNull()
      .references(() => lorebooks.id, { onDelete: "cascade" }),
    position: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.characterId, table.lorebookId] }),
    index("character_lorebooks_lorebook_id_idx").on(table.lorebookId),
  ],
);

/**
 * A ComfyUI workflow the user imported: the finalized API-format template
 * (its prompt a placeholder, never text) under the uuid the public id
 * `user-<uuid>` names. Settings name it by that string, without a
 * reference: deleting it returns them to the server's default
 * (persistence/workflows.ts). Names are unique regardless of case.
 */
export const workflows = sqliteTable(
  "workflows",
  {
    id: text().primaryKey(),
    name: text().notNull(),
    family: text().$type<ArtFamily>().notNull(),
    graph: text({ mode: "json" }).$type<WorkflowFields["graph"]>().notNull(),
    /** The graph's node count for the list, written with every graph. */
    nodes: integer().notNull(),
    /** One more with every edit; a stale edit is refused (optimistic concurrency). */
    revision: integer().notNull().default(0),
    createdAt: integer().notNull(),
    updatedAt: integer().notNull(),
  },
  (table) => [uniqueIndex("workflows_name_idx").on(sql`${table.name} COLLATE NOCASE`)],
);

/**
 * An event: a one-line instruction with a trigger chance and a cooldown.
 * Its scope names characters by id without a reference: an unknown id
 * matches nothing (events/event.ts).
 */
export const events = sqliteTable("events", {
  id: text().primaryKey(),
  text: text().notNull(),
  /** Percent, at most one decimal. */
  chance: real().notNull(),
  cooldown: integer().notNull(),
  enabled: integer({ mode: "boolean" }).notNull(),
  scope: text({ mode: "json" }).$type<EventScope>().notNull(),
  /** One more with every edit; a stale edit is refused (optimistic concurrency). */
  revision: integer().notNull().default(0),
  createdAt: integer().notNull(),
  updatedAt: integer().notNull(),
});

/** A character's memory notebook: memory is on while `enabled`; it goes with the character. */
export const memoryNotebooks = sqliteTable("memory_notebooks", {
  characterId: text()
    .primaryKey()
    .references(() => characters.id, { onDelete: "cascade" }),
  enabled: integer({ mode: "boolean" }).notNull(),
  situation: text().notNull(),
  relationships: text({ mode: "json" }).$type<string[]>().notNull().default([]),
  facts: text({ mode: "json" }).$type<string[]>().notNull(),
  threads: text({ mode: "json" }).$type<string[]>().notNull(),
  cast: text({ mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
  /** The next chat's opening, written with the notebook; empty for none. */
  opening: text().notNull().default(""),
  /** One more with every edit; a stale edit is refused (optimistic concurrency). */
  revision: integer().notNull().default(0),
  updatedAt: integer().notNull(),
});

/**
 * A character's episodes, `seq` ascending in the order they were written. A
 * chapter is an episode that merged older ones; they name it by `chapterId`.
 */
export const memories = sqliteTable(
  "memories",
  {
    id: text().primaryKey(),
    characterId: text()
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    seq: integer().notNull(),
    kind: text().$type<EpisodeKind>().notNull(),
    title: text().notNull(),
    summary: text().notNull(),
    cues: text({ mode: "json" }).$type<string[]>().notNull(),
    turns: integer().notNull(),
    chapterId: text().references((): AnySQLiteColumn => memories.id, { onDelete: "set null" }),
    pinned: integer({ mode: "boolean" }).notNull(),
    /** One more with every edit; a stale edit is refused (optimistic concurrency). */
    revision: integer().notNull().default(0),
    createdAt: integer().notNull(),
    updatedAt: integer().notNull(),
  },
  (table) => [
    unique().on(table.characterId, table.seq),
    // Each deleted episode looks up the episodes naming it as their chapter; unindexed, a table scan.
    index("memories_chapter_id_idx").on(table.chapterId),
  ],
);

/**
 * A character's cast sheet: the people its card names, read from the card
 * by the sheet call, with the card fingerprint it was read at. Anchors only;
 * a chat's volatile state never reaches it.
 */
export const castSheets = sqliteTable("cast_sheets", {
  characterId: text()
    .primaryKey()
    .references(() => characters.id, { onDelete: "cascade" }),
  fingerprint: text().notNull(),
  entries: text({ mode: "json" }).$type<CastSheetEntry[]>().notNull(),
  /** One more with every write. */
  revision: integer().notNull().default(0),
  createdAt: integer().notNull(),
  updatedAt: integer().notNull(),
});

/** A portrait belongs to exactly one character or one persona, and goes with it. */
export const portraits = sqliteTable(
  "portraits",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    characterId: text()
      .unique()
      .references(() => characters.id, { onDelete: "cascade" }),
    personaId: text()
      .unique()
      .references(() => personas.id, { onDelete: "cascade" }),
    /** WebP thumbnail for galleries, the chat margin and Session. */
    thumb: blob({ mode: "buffer" }).notNull(),
    width: integer().notNull(),
    height: integer().notNull(),
    /** Changes with every replacement; part of the portrait URL, so cached copies never go stale. */
    version: integer().notNull(),
    /**
     * The portrait's file id under `users/<username>/portraits/`: the
     * re-encoded PNG, metadata stripped, also the image of PNG exports.
     */
    file: text().notNull(),
  },
  (table) => [
    check(
      "portraits_one_owner",
      sql`(${table.characterId} IS NULL) <> (${table.personaId} IS NULL)`,
    ),
  ],
);

/*
 * Column defaults as their migrations wrote them, frozen here as literals:
 * computed from core's current defaults, a later wording change there would
 * change the schema and make drizzle-kit rebuild the table.
 */
/** Reasoning settings as migration 0004 wrote them into existing rows. */
const REASONING_DEFAULTS = sql.raw(
  `'{"autoParse":false,"tag":"think","addToPrompts":false,"maxAdditions":1}'`,
);

export const promptPresets = sqliteTable("prompt_presets", {
  id: text().primaryKey(),
  name: text().notNull(),
  blocks: text({ mode: "json" }).$type<PromptBlock[]>().notNull(),
  /** Native actions, in the retained private column. Legacy values convert before stores open. */
  actions: text("formats", { mode: "json" }).$type<PromptActions>().notNull(),
  /** Reasoning in the prompt; presets from before it read nothing and send nothing back. */
  reasoning: text({ mode: "json" }).$type<PromptReasoning>().notNull().default(REASONING_DEFAULTS),
  /** The Author's Note; null is a row from before the note and reads as core's default. */
  authorsNote: text({ mode: "json" }).$type<AuthorsNote>(),
  /** One more with every edit; a stale edit is refused (optimistic concurrency). */
  revision: integer().notNull().default(0),
  createdAt: integer().notNull(),
  updatedAt: integer().notNull(),
});

export const samplerPresets = sqliteTable("sampler_presets", {
  id: text().primaryKey(),
  name: text().notNull(),
  values: text("sampler_values", { mode: "json" }).$type<SamplerValues>().notNull(),
  /** One more with every edit; a stale edit is refused (optimistic concurrency). */
  revision: integer().notNull().default(0),
  createdAt: integer().notNull(),
  updatedAt: integer().notNull(),
});

/** The one settings row. References clear themselves when their target is deleted. */
export const settings = sqliteTable(
  "settings",
  {
    id: integer().primaryKey(),
    theme: text().$type<Theme>().notNull(),
    /** A core palette id or a saved custom slot's; existing rows keep Ephemera's own. */
    palette: text().$type<PaletteChoice>().notNull().default("lamplight"),
    model: text(),
    /** The model that starts image prompts; null uses each surface's own default. */
    imagePromptModel: text(),
    characterId: text().references(() => characters.id, { onDelete: "set null" }),
    personaId: text().references(() => personas.id, { onDelete: "set null" }),
    defaultPersonaId: text().references(() => personas.id, { onDelete: "set null" }),
    promptPresetId: text().references(() => promptPresets.id, { onDelete: "set null" }),
    samplerPresetId: text().references(() => samplerPresets.id, { onDelete: "set null" }),
    /** Owner-set windows for models the provider reports none for (models.ts). */
    contextWindows: text({ mode: "json" }).$type<ContextWindows>().notNull().default({}),
    /** Owner-set limits on how much of each model's window a prompt uses (models.ts). */
    contextLimits: text({ mode: "json" }).$type<ContextLimits>().notNull().default({}),
    /** Post-processing the owner set for models whose chat template needs it. */
    promptProcessing: text({ mode: "json" })
      .$type<PromptProcessingSettings>()
      .notNull()
      .default({}),
    reasoningOpen: integer({ mode: "boolean" }).notNull().default(false),
    showHiddenReasoning: integer({ mode: "boolean" }).notNull().default(false),
    /** A card's own System Prompt replaces the preset's (on by default). */
    preferCharacterPrompt: integer({ mode: "boolean" }).notNull().default(true),
    /** A card's own Post-History Instructions replace the preset's (on by default). */
    preferCharacterInstructions: integer({ mode: "boolean" }).notNull().default(true),
    /** The owner's ComfyUI for card portraits; empty for none. */
    comfyuiBaseUrl: text().notNull().default(""),
    /**
     * A workflow id. The SQL default is the legacy one the migration wrote;
     * every insert names the server's default, and a stored id without a
     * graph reads as that default (settings.ts).
     */
    comfyuiWorkflow: text()
      .$type<Settings["comfyuiWorkflow"]>()
      .notNull()
      .default("krea2-intorealism"),
    /** New chats open on the memory's opening (on by default). */
    memoryOpening: integer({ mode: "boolean" }).notNull().default(true),
    /** The model memory calls use; null uses the reply's. */
    memoryModel: text(),
    /** The memory call's reasoning effort; null leaves it to the model. */
    memoryReasoning: text().$type<ReasoningEffort>(),
    /** Estimated tokens of unremembered turns that start a memory call. */
    memorySpanTokens: integer().notNull().default(6000),
    /** Newest turns a memory call leaves live. */
    memoryKeepTurns: integer().notNull().default(4),
    /** The most estimated tokens of a chat's episodes before a roll-up; null leaves it to the window. */
    memoryRecapTokens: integer(),
    /** The model cast calls use; null uses memory's. */
    castModel: text(),
    /** The cast calls' reasoning effort; null uses memory's. */
    castReasoning: text().$type<ReasoningEffort>(),
    updatedAt: integer().notNull(),
  },
  (table) => [check("settings_one_row", sql`${table.id} = 1`)],
);

/**
 * The player's palettes, one row per slot (1 to 3), selectable as
 * `custom-<slot>`. Colours only (PRINCIPLES.md 1: UI settings).
 */
export const customPalettes = sqliteTable(
  "custom_palettes",
  {
    slot: integer().$type<CustomSlot>().primaryKey(),
    name: text().notNull(),
    /** The palette it started from (a core palette id). */
    base: text().$type<CustomPalette["base"]>().notNull(),
    light: text({ mode: "json" }).$type<CustomPalette["light"]>().notNull(),
    dark: text({ mode: "json" }).$type<CustomPalette["dark"]>().notNull(),
    origin: text({ mode: "json" }).$type<CustomPalette["origin"]>().notNull(),
    handSet: text({ mode: "json" }).$type<CustomPalette["handSet"]>().notNull(),
    updatedAt: integer().notNull(),
  },
  (table) => [check("custom_palettes_slot", sql`${table.slot} BETWEEN 1 AND 3`)],
);
