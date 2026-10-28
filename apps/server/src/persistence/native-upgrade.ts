import type { Database } from "bun:sqlite";
import { isDeepStrictEqual } from "node:util";
import {
  normalizeMacroAliases,
  summarizeLorebook,
  upgradeLegacyCharacterCard,
  upgradeLegacyLorebook,
  upgradeLegacyPromptPreset,
} from "@ephemera/core";

export const NATIVE_DATA_VERSION = 1;

export class NativeDataError extends Error {
  override name = "NativeDataError";
}

/** One synchronous transaction, before any native store sees the rows. */
export function upgradeNativeData(client: Database): boolean {
  const version = client
    .query<{ user_version: number }, []>("PRAGMA user_version")
    .get()?.user_version;
  if (version === NATIVE_DATA_VERSION) return false;
  if (version !== 0) throw new NativeDataError("Unsupported native data version");
  try {
    client.transaction(() => {
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
            .query(
              "UPDATE lorebooks SET book = ?, counts = ?, revision = revision + ? WHERE id = ?",
            )
            .run(JSON.stringify(book), JSON.stringify(counts), Number(changed), row.id);
      }
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
      client.run(`PRAGMA user_version = ${NATIVE_DATA_VERSION}`);
    })();
    return true;
  } catch {
    // Do not expose persisted content through validation errors.
    throw new NativeDataError("Native data conversion failed");
  }
}
