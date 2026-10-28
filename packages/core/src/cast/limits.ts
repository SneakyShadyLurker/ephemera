/*
 * Bounds of the cast register: what a register, an entry and its fields
 * hold, what a cast sheet holds, and what one keeper call may carry.
 */

export const CAST_LIMITS = {
  /** Entries a register holds; new ones past it are refused. */
  entries: 40,
  /** Characters of a name. */
  name: 80,
  /** Characters of one field. */
  field: 240,
  /** Earlier names an entry remembers (`aka`). */
  aka: 4,
  /** Entries a cast sheet holds (Scenario: up to five principals; room for Group cards). */
  sheetEntries: 8,
  /** Newest shown turns a keeper call may carry when catching up. */
  turns: 12,
} as const;
