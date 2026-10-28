import type { CardFile } from "./cards.ts";

/*
 * Lorebook files for e2e flows, written by hand after SillyTavern's
 * documented World Info format: entries keyed by uid, each with flat
 * fields. Synthetic content only.
 */

/** A small World Info file without a book name: one keyword entry, one by chance. */
export const WORLD_INFO = {
  entries: {
    "0": {
      uid: 0,
      key: ["harbour", "quay"],
      keysecondary: [],
      comment: "Harbour",
      content: "Solm's harbour freezes over in deep winter.",
      constant: false,
      selective: true,
      selectiveLogic: 0,
      order: 100,
      position: 0,
      disable: false,
      depth: 4,
      probability: 100,
      useProbability: true,
      group: "",
      groupOverride: false,
      groupWeight: 100,
      sticky: 0,
      cooldown: 0,
      delay: 0,
      displayIndex: 0,
      automationId: "unused-import-hook",
    },
    "1": {
      uid: 1,
      key: [],
      keysecondary: [],
      comment: "Gull omen",
      content: "A gull on the mast foretells a calm crossing.",
      constant: true,
      selective: false,
      selectiveLogic: 0,
      order: 50,
      position: 1,
      disable: false,
      depth: 4,
      probability: 40,
      useProbability: true,
      group: "Omens",
      groupOverride: false,
      groupWeight: 100,
      sticky: 0,
      cooldown: 0,
      delay: 0,
      displayIndex: 1,
    },
  },
};

/** The World Info file as `<name>.json`, as the owner would pick it. */
export const worldInfoFile = (name: string): CardFile => ({
  name: `${name}.json`,
  mimeType: "application/json",
  buffer: Buffer.from(JSON.stringify(WORLD_INFO, null, 2)),
});

/** A JSON file that is no lorebook at all. */
export const notALorebookFile = (name: string): CardFile => ({
  name: `${name}.json`,
  mimeType: "application/json",
  buffer: Buffer.from(JSON.stringify({ title: "Shopping list", items: ["bread", "lamp oil"] })),
});
