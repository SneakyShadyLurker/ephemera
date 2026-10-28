import {
  customPaletteSlot,
  DEFAULT_SETTINGS,
  isCustomPalette,
  type PaletteChoice,
  type Settings,
  type SettingsPatch,
  settingsPatchSchema,
} from "@ephemera/core";
import { desc, eq } from "drizzle-orm";
import type { Db } from "./db.ts";
import {
  characters,
  customPalettes,
  personas,
  promptPresets,
  samplerPresets,
  settings,
} from "./schema.ts";
import type { SettingsStore } from "./store.ts";

/*
 * The one settings row (PRINCIPLES.md 1: UI settings, never chat content).
 * Every write parses the strict settings patch; references must name rows
 * that exist, and clear themselves when those rows are deleted. A custom
 * palette must be saved in its slot to be chosen. A new row starts on the
 * server's default workflow (the workflow registry's).
 */
export function createSettingsStore(
  db: Db,
  defaultWorkflow: string = DEFAULT_SETTINGS.comfyuiWorkflow,
): SettingsStore {
  const latest = (table: typeof promptPresets | typeof samplerPresets) =>
    db.select({ id: table.id }).from(table).orderBy(desc(table.updatedAt)).limit(1).get()?.id ??
    null;

  const row = () => db.select().from(settings).where(eq(settings.id, 1)).get();

  const values = ({ id: _id, updatedAt: _updatedAt, ...rest }: typeof settings.$inferSelect) =>
    rest satisfies Settings;

  /** Reads the row, creating it, or pointing it at a preset, when needed. */
  const get = (): Settings => {
    const current = row();
    const promptPresetId = current?.promptPresetId ?? latest(promptPresets);
    const samplerPresetId = current?.samplerPresetId ?? latest(samplerPresets);
    if (
      current !== undefined &&
      current.promptPresetId === promptPresetId &&
      current.samplerPresetId === samplerPresetId
    ) {
      return values(current);
    }
    db.insert(settings)
      .values({
        id: 1,
        ...DEFAULT_SETTINGS,
        comfyuiWorkflow: defaultWorkflow,
        promptPresetId,
        samplerPresetId,
        updatedAt: Date.now(),
      })
      .onConflictDoUpdate({ target: settings.id, set: { promptPresetId, samplerPresetId } })
      .run();
    const saved = row();
    if (saved === undefined) throw new Error("settings row missing");
    return values(saved);
  };

  const exists = (
    table: typeof characters | typeof personas | typeof promptPresets | typeof samplerPresets,
    id: string | null | undefined,
  ) =>
    id === undefined ||
    id === null ||
    db.select({ id: table.id }).from(table).where(eq(table.id, id)).get() !== undefined;

  /** A built-in palette always exists; a custom one only once its slot is saved. */
  const paletteExists = (palette: PaletteChoice | undefined) =>
    palette === undefined ||
    !isCustomPalette(palette) ||
    db
      .select({ slot: customPalettes.slot })
      .from(customPalettes)
      .where(eq(customPalettes.slot, customPaletteSlot(palette)))
      .get() !== undefined;

  return {
    get: () => db.transaction(get),

    update(input: SettingsPatch): Settings | undefined {
      const patch = settingsPatchSchema.parse(input);
      return db.transaction(() => {
        get();
        const known =
          exists(characters, patch.characterId) &&
          exists(personas, patch.personaId) &&
          exists(personas, patch.defaultPersonaId) &&
          exists(promptPresets, patch.promptPresetId) &&
          exists(samplerPresets, patch.samplerPresetId) &&
          paletteExists(patch.palette);
        if (!known) return undefined;
        db.update(settings)
          .set({ ...patch, updatedAt: Date.now() })
          .where(eq(settings.id, 1))
          .run();
        return get();
      });
    },
  };
}
