/** Bounds for AI Rework. One owner: server and web read these. */
export const REWORK_LIMITS = {
  /** The owner's rework request. */
  requestLength: 20_000,
  /** Tokens the portrait is counted as in the size estimate: a 1024 x 1536 image at high detail, rounded up. */
  portraitTokens: 1_600,
} as const;
