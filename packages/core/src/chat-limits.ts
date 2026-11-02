/*
 * Chat bounds that modules below `chat.ts` also need (the lorebook's timed
 * state); a leaf, so they import no request schema.
 */

/** Upper bound on turns in one generation request; the budget trims what the window cannot hold. */
export const MAX_CHAT_TURNS = 10_000;

/**
 * Largest accepted generation or preview request body, in bytes. The server
 * refuses a larger one; the tab folds held memories to stay under it.
 */
export const MAX_CHAT_BODY_BYTES = 8 * 1024 * 1024;
