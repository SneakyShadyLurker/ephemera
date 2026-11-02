/**
 * A name as the cast matches it: compatibility-decomposed, marks stripped,
 * lower case, whitespace collapsed. For name matching only (resolution, the
 * player exclusion, the sheet overlay's fallback), never an id.
 */
export const castKey = (name: string): string =>
  name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();

/** The first word of a name's key. */
export const firstWordKey = (name: string): string => castKey(name).split(" ")[0] ?? "";

/** Whether a name is a single word. */
export const isOneWord = (name: string): boolean => !castKey(name).includes(" ");
