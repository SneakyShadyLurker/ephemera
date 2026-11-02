import type { Database } from "bun:sqlite";
import { isDeepStrictEqual } from "node:util";
import {
  normalizeMacroAliases,
  summarizeLorebook,
  upgradeLegacyCharacterCard,
  upgradeLegacyLorebook,
  upgradeLegacyPromptPreset,
} from "@ephemera/core";

export const NATIVE_DATA_VERSION = 2;

export class NativeDataError extends Error {
  override name = "NativeDataError";
}

// Each pass writes only rows whose data changes and bumps their revision.

function upgradeCharacters(client: Database): void {
  for (const row of client
    .query<{ id: string; card: string }, []>("SELECT id, card FROM characters")
    .all()) {
    const old: unknown = JSON.parse(row.card);
    const card = upgradeLegacyCharacterCard(old);
    if (!isDeepStrictEqual(old, card))
      client
        .query(
          "UPDATE characters SET card = ?, name = ?, nickname = ?, creator = ?, tags = ?, revision = revision + 1 WHERE id = ?",
        )
        .run(
          JSON.stringify(card),
          card.name,
          card.nickname,
          card.creator,
          JSON.stringify(card.tags),
          row.id,
        );
  }
}

function upgradeLorebooks(client: Database): void {
  for (const row of client
    .query<{ id: string; book: string; counts: string }, []>(
      "SELECT id, book, counts FROM lorebooks",
    )
    .all()) {
    const old: unknown = JSON.parse(row.book);
    const book = upgradeLegacyLorebook(old);
    const counts = summarizeLorebook(book);
    const changed = !isDeepStrictEqual(old, book);
    if (changed || !isDeepStrictEqual(JSON.parse(row.counts), counts))
      client
        .query("UPDATE lorebooks SET book = ?, counts = ?, revision = revision + ? WHERE id = ?")
        .run(JSON.stringify(book), JSON.stringify(counts), Number(changed), row.id);
  }
}

function upgradePromptPresets(client: Database): void {
  for (const row of client
    .query<
      {
        id: string;
        name: string;
        blocks: string;
        formats: string;
        reasoning: string;
        authors_note: string | null;
      },
      []
    >("SELECT id, name, blocks, formats, reasoning, authors_note FROM prompt_presets")
    .all()) {
    const physical: unknown = JSON.parse(row.formats);
    const base = {
      name: row.name,
      blocks: JSON.parse(row.blocks),
      reasoning: JSON.parse(row.reasoning),
      ...(row.authors_note === null ? {} : { authorsNote: JSON.parse(row.authors_note) }),
    };
    // The physical column retained its old name. Never disguise old wrappers as native actions.
    const native =
      typeof physical === "object" &&
      physical !== null &&
      Object.hasOwn(physical, "continue") &&
      Object.hasOwn(physical, "writeForMe");
    const old = { ...base, ...(native ? { actions: physical } : { formats: physical }) };
    const preset = upgradeLegacyPromptPreset(old);
    if (!isDeepStrictEqual(old, preset))
      client
        .query(
          "UPDATE prompt_presets SET blocks = ?, formats = ?, reasoning = ?, authors_note = ?, revision = revision + 1 WHERE id = ?",
        )
        .run(
          JSON.stringify(preset.blocks),
          JSON.stringify(preset.actions),
          JSON.stringify(preset.reasoning),
          JSON.stringify(preset.authorsNote),
          row.id,
        );
  }
}

/** SillyTavern macro aliases in the macro-expanded text of events, personas and memory openings. */
function upgradeMacroAliases(client: Database): void {
  // These saved fields are macro-expanded. Memory summaries, notebook facts and cast anchors are literal.
  for (const row of client
    .query<{ id: string; text: string; enabled: number }, []>(
      "SELECT id, text, enabled FROM events",
    )
    .all()) {
    const text = normalizeMacroAliases(row.text);
    const enabled = text.trim() === "" ? 0 : row.enabled;
    if (text !== row.text || enabled !== row.enabled)
      client
        .query("UPDATE events SET text = ?, enabled = ?, revision = revision + 1 WHERE id = ?")
        .run(text, enabled, row.id);
  }
  for (const [table, key, field] of [
    ["personas", "id", "description"],
    ["memory_notebooks", "character_id", "opening"],
  ] as const) {
    for (const row of client
      .query<{ id: string; value: string }, []>(
        `SELECT ${key} AS id, ${field} AS value FROM ${table}`,
      )
      .all()) {
      const value = normalizeMacroAliases(row.value);
      if (value !== row.value)
        client
          .query(`UPDATE ${table} SET ${field} = ?, revision = revision + 1 WHERE ${key} = ?`)
          .run(value, row.id);
    }
  }
}

/** Version 0: foreign shapes and SillyTavern macro aliases become native. */
function upgradeToOne(client: Database): void {
  upgradeCharacters(client);
  upgradeLorebooks(client);
  upgradePromptPresets(client);
  upgradeMacroAliases(client);
}

/**
 * Version 1: cards fold the removed fields into the description and presets
 * lose the retired blocks. The removed macros stay; the engine resolves them empty.
 */
function upgradeToTwo(client: Database): void {
  upgradeCharacters(client);
  upgradePromptPresets(client);
}

/** At index `n`, the step from version `n` to `n + 1`. */
const STEPS: readonly ((client: Database) => void)[] = [upgradeToOne, upgradeToTwo];

/** One synchronous transaction, before any native store sees the rows. */
export function upgradeNativeData(client: Database): boolean {
  const version = client
    .query<{ user_version: number }, []>("PRAGMA user_version")
    .get()?.user_version;
  if (version === NATIVE_DATA_VERSION) return false;
  if (version === undefined || !(version >= 0 && version < NATIVE_DATA_VERSION))
    throw new NativeDataError("Unsupported native data version");
  try {
    client.transaction(() => {
      for (let step = version; step < NATIVE_DATA_VERSION; step += 1) {
        const upgrade = STEPS[step];
        if (upgrade === undefined) throw new NativeDataError("Missing native data step");
        upgrade(client);
        client.run(`PRAGMA user_version = ${step + 1}`);
      }
    })();
    return true;
  } catch {
    // Do not expose persisted content through validation errors.
    throw new NativeDataError("Native data conversion failed");
  }
}
