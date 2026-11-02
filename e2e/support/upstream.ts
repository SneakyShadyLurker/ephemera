/**
 * What the mock upstream (e2e/support/mock-upstream.ts) and the specs share;
 * a module apart, since importing the mock starts serving it.
 */
import type { UpstreamRecord } from "../../apps/server/test/fake-upstream.ts";
import type { CastCall } from "./cast-fixtures.ts";
import type { MemoryCall } from "./memory-fixtures.ts";

/** A call the mock upstream answers from fixtures: memory, chapter, opening, cast keeper or cast sheet. */
export type MockCall = MemoryCall | CastCall;

/** The models the mock upstream lists, each with behaviour of its own. */
export const MOCK_MODELS = [
  "mock-fast",
  "mock-slow",
  "mock-long",
  "mock-error",
  "mock-hostile",
  "mock-lowonly",
  "mock-nowindow",
  "mock-inline",
  "mock-unreported",
  "mock-scripted",
  "mock-wide",
  "mock-textonly",
  "mock-badcard",
  "mock-stall",
  "mock-memory-prose",
  "mock-fold",
  "mock-cast",
] as const;
export type MockModel = (typeof MOCK_MODELS)[number];

/** The output a streamed chat answer reports, and the share of it that was reasoning. */
export const MOCK_OUTPUT_TOKENS = 4;
export const MOCK_REASONING_TOKENS = 3;

/** One request as the mock upstream recorded it. */
export interface MockRecord extends UpstreamRecord {
  model: MockModel;
  /** The body's `prompt_cache_key`, the chat's cache affinity id; null when absent. */
  cacheKey: string | null;
  input: string;
  sampling: Record<string, unknown>;
  /** Each message with its text parts joined; image parts are left out. */
  messages: { role: string; content: string }[];
  /** Whether any message carried an image part. */
  image: boolean;
  /** The first image part's data URL (the image as the server re-encoded it); null without one. */
  imageData: string | null;
  /**
   * The text a card or brainstorm call has flushed to the socket so far, or the whole
   * answer a memory, chapter, opening, cast or cast sheet call was given;
   * null for other calls.
   */
  answer: string | null;
  /** The fixture call a request is, by its instructions; null for any other. */
  call: MockCall | null;
}

/** One request as `/__records` answers it: without its input, URL, credentials or body. */
export type UpstreamRecordView = Omit<MockRecord, "input" | "url" | "authorization" | "body">;
