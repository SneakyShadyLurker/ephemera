/** Bounds for AI card creation. One owner: server and web read these. */
export const CREATOR_LIMITS = {
  /** The owner's description of the character or scenario. */
  descriptionLength: 20_000,
  /** The art source the browser sends back for the art request. */
  artSourceLength: 64 * 1024,
  /** A saved card's description as its art source quotes it when the card formats do not hold it. */
  savedDescriptionLength: 12_000,
  /** Each person's personality as art context, including later mannerisms. */
  artPersonalityLength: 12_000,
  /** The owner's direction for the next art: a short steer, not a second description. */
  artDirectionLength: 500,
  /** The owner's direction for an image card: a steer that may name personality, history and voice. */
  imageCardDirectionLength: 2_000,
  /** Ideas in one brainstorm list; the prompt asks for exactly this many. */
  brainstormOptions: 10,
  /** Earlier lists a round carries as context; the browser drops older ones. */
  brainstormRounds: 3,
  /**
   * `maxOutputTokens` for every creator call (card, rework, image prompt): above
   * what a card needs. Sent because a provider's default when it is omitted
   * can be far lower.
   */
  maxOutputTokens: 100_000,
  /** Token cap for one subject block; over it is reported, never cut. */
  subjectBlockTokens: 5_500,
  /** Token cap for a whole scenario description; over it is reported, never cut. */
  scenarioDescriptionTokens: 10_000,
  /** Most subject blocks one card holds. */
  subjects: 3,
  /** Longest block tag name the parser recognises. */
  blockNameLength: 64,
  /** Most problems one validation reports. */
  problems: 32,
} as const;

/** How many subject blocks a card of each character kind holds. */
export const SUBJECT_COUNTS = {
  subject: { min: 1, max: 1 },
  group: { min: 2, max: CREATOR_LIMITS.subjects },
} as const;

/** The art batch: always 4 portraits of 1024 x 1536 from ComfyUI. */
export const CREATOR_ART = {
  count: 4,
  width: 1024,
  height: 1536,
  /** Largest single PNG the art stream carries. */
  imageBytes: 8 * 1024 * 1024,
  /** Largest complete batch, shared by both transports. */
  batchBytes: 24 * 1024 * 1024,
} as const;
