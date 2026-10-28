/*
 * Bounds of a character's memory: what one memory call may write, how much
 * of the book a character keeps, the Settings ranges that pace the calls and
 * the share of the prompt the memory blocks may take.
 */

/** Estimated tokens of a chat's recap before a roll-up: see `MEMORY_LIMITS.recapTokens`. */
const RECAP_TOKENS = { min: 1_000, max: 16_000 } as const;

/**
 * The share of a recap's budget one chapter's summary may take: a roll-up
 * merges at most half the recap, so a chapter at most half of that leaves
 * the recap lighter after every merge.
 */
const CHAPTER_SHARE = 0.25;

export const MEMORY_LIMITS = {
  /** Characters of an episode's title. */
  title: 120,
  /** Characters of an episode's summary. */
  summary: 4_000,
  /** The share of a recap's budget one chapter's summary may take (`chapterRoom`). */
  chapterShare: CHAPTER_SHARE,
  /**
   * Characters of a chapter's summary at most. A chapter call is told its
   * share of its own recap's budget (`chapterRoom`) within this and an
   * episode's summary.
   */
  chapterSummary: 4_000,
  /** Cues per episode. */
  cues: 12,
  /** Characters of one cue. */
  cue: 60,
  /** Characters of the notebook's situation. */
  situation: 1_200,
  /** Characters of the next chat's opening: a Location line and one placing sentence. */
  opening: 600,
  /** Lines of the notebook's relationships, one per pair of people. */
  relationships: 16,
  /** Lines of the notebook's facts. */
  facts: 40,
  /** Lines of the notebook's open threads. */
  threads: 12,
  /** Fixed NPC anchors, stored as independently editable JSON lines. */
  cast: 32,
  castLine: 1_200,
  /** Characters of one relationship, fact or thread. */
  line: 240,
  /** Episodes per character, chapters included. */
  episodes: 2_000,
  /** Estimated tokens of unremembered turns that start a memory call (Settings). */
  spanTokens: { min: 1_500, max: 32_000, default: 6_000 },
  /** Newest turns a memory call leaves live (Settings). */
  keepTurns: { min: 1, max: 20, default: 4 },
  /**
   * Estimated tokens of this chat's episodes before a roll-up merges the
   * oldest: `min` floors the budget the window gives (`recapBudget`), and
   * the Settings cap, when the owner sets one, lies within the range.
   */
  recapTokens: RECAP_TOKENS,
  /** The part of the memory blocks' share a roll-up leaves to recall. */
  recallReserve: 0.25,
  /** Earlier episodes shown to the memory call as context: the latest in story order. */
  previous: 3,
  /**
   * Episodes recalled into one request, the latest turns scanned for them,
   * and how many of those turns' last words the scan reads.
   */
  recall: { max: 4, depth: 4, words: 4_000 },
  /** The share of the context in use the memory blocks take together. */
  share: 0.12,
  /**
   * The part of the memory blocks' share the notebook may fill. In a window
   * small enough that a full notebook would pass it, the memory call is told
   * the room (`notebookRoom`).
   */
  notebookShare: 0.5,
  /** Newest episodes a roll-up never absorbs. */
  recapKeep: 2,
  /** Episodes in a chat's recap past which a roll-up also happens. */
  recapCount: 40,
  /**
   * Memories a chat holds unfolded past which a request folds the oldest, so
   * roll-up, which takes folded ones only, keeps a chat's memories well
   * below `RECAP_IDS` even when its window never fills.
   */
  held: 40,
  /** Tokens every object call (memory, cast keeper and sheet) keeps for its answer (`answerRoom`). */
  replyReserve: 8_192,
} as const;
