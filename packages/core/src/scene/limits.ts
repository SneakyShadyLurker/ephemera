import { CREATOR_LIMITS } from "../creator/limits.ts";

/** Bounds for a scene picture. One owner: server and web read these. */
export const SCENE_LIMITS = {
  /** The chat excerpt's estimated tokens, speaker labels and separators included. */
  excerptTokens: 6_000,
  /** Most turns the excerpt holds. */
  excerptTurns: 40,
  /** The whole scene source the browser sends: the notes, the names and the excerpt. */
  sourceLength: CREATOR_LIMITS.artSourceLength,
} as const;
