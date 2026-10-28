import { createCastSheetStore } from "./cast-sheets.ts";
import { createCharacterStore } from "./characters.ts";
import type { Db } from "./db.ts";
import { createEventStore } from "./events.ts";
import { createLorebookStore } from "./lorebooks.ts";
import { createMemoryStore } from "./memories.ts";
import { createCustomPaletteStore } from "./palettes.ts";
import { createPersonaStore } from "./personas.ts";
import type { PortraitFiles } from "./portrait-files.ts";
import { createPresetStore } from "./presets.ts";
import { createSettingsStore } from "./settings.ts";
import type { Stores } from "./store.ts";

/**
 * Every store over one database and its portrait files. Presets come first:
 * they seed what the settings point at, as `defaultWorkflow` seeds a new
 * settings row's workflow.
 */
export function createStores(
  db: Db,
  files: PortraitFiles,
  { defaultWorkflow }: { defaultWorkflow?: string } = {},
): Stores {
  const presets = createPresetStore(db);
  return {
    characters: createCharacterStore(db, files),
    personas: createPersonaStore(db, files),
    presets,
    lorebooks: createLorebookStore(db),
    events: createEventStore(db),
    memory: createMemoryStore(db),
    castSheets: createCastSheetStore(db),
    settings: createSettingsStore(db, defaultWorkflow),
    palettes: createCustomPaletteStore(db),
  };
}
