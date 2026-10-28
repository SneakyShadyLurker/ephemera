import { z } from "zod";
import { MAX_CHAT_TURNS } from "../chat-limits.ts";

/*
 * The memory a chat carries from request to request: the ids of this chat's
 * folded episodes, in order, chapters replacing their members, how many
 * turns are folded into them, the remembered spans whose turns the request
 * still sends, and whether the greeting in play is the memory's opening.
 * Chat content: it lives in the tab's memory and in
 * the server for one request, never anywhere else. A leaf, so the request
 * schemas can import it.
 */

/** The most episode ids one chat carries, folded and held together. */
export const RECAP_IDS = 200;

/**
 * The most turns one chat's memories hold. Its own bound, far past
 * `MAX_CHAT_TURNS`: that bounds the live turns a request sends, and a long
 * chat folds many times that into its memories.
 */
export const MAX_FOLDED_TURNS = 1_000_000;

/**
 * A remembered span the request still sends: its memory's id and how many
 * of the request's leading history turns it covers.
 */
const heldSpanSchema = z.strictObject({
  id: z.uuid(),
  turns: z.number().int().min(1).max(MAX_CHAT_TURNS),
});

export const chatMemoryStateSchema = z
  .strictObject({
    /** The folded episodes, chapters replacing their members: the story block tells them. */
    recap: z.array(z.uuid()).max(RECAP_IDS),
    /** How many sent turns the folded messages hold: the lorebook's delay counts them (timed.ts). */
    folded: z.number().int().min(0).max(MAX_FOLDED_TURNS).default(0),
    /** Folded user turns: the Author's Note counts them. */
    foldedUsers: z.number().int().min(0).max(MAX_FOLDED_TURNS),
    /**
     * Remembered spans still in the history, oldest first; their turns lead
     * the request's messages. The server folds them, oldest first, only
     * while the history would otherwise be trimmed.
     */
    held: z.array(heldSpanSchema).max(RECAP_IDS).default([]),
    /**
     * Whether the greeting in play is the memory's opening of this chat: a
     * fresh chat then opens on the day after the last scene.
     */
    continued: z.boolean(),
  })
  .refine(({ recap, held }) => recap.length + held.length <= RECAP_IDS, {
    message: "Too many memories for one chat.",
    path: ["held"],
  })
  .refine(({ folded, foldedUsers }) => foldedUsers <= folded, {
    message: "Folded user turns exceed folded turns.",
    path: ["foldedUsers"],
  });
export type ChatMemoryState = z.infer<typeof chatMemoryStateSchema>;
