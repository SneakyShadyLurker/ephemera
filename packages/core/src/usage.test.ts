import { describe, expect, it } from "vitest";
import { decodeArtFrames, encodeArtFrame } from "./creator/art-stream.ts";
import { callAccountingSchema, callRecordSchema, MAX_CALL_RECORDS } from "./usage.ts";

const record = {
  id: "00000000-0000-4000-8000-000000000001",
  purpose: "narration",
  model: "m",
  status: "completed",
  usage: { inputTokens: 0 },
};
describe("content-free call records", () => {
  it("carries optional scene accounting in the existing binary prompt-progress frame", async () => {
    const event = {
      type: "progress" as const,
      phase: "prompt" as const,
      value: 1,
      max: 1,
      accounting: callAccountingSchema.parse({ calls: [record], truncated: false }),
    };
    async function* chunks() {
      yield encodeArtFrame(event);
    }
    const decoded = [];
    for await (const part of decodeArtFrames(chunks())) decoded.push(part);
    expect(decoded).toEqual([event]);
  });
  it("preserves reported zero and missing fields, rejecting content and invalid numbers", () => {
    expect(callRecordSchema.parse(record).usage).toEqual({ inputTokens: 0 });
    for (const usage of [
      { inputTokens: -1 },
      { outputTokens: Number.NaN },
      { raw: {} },
      { text: "private" },
    ])
      expect(callRecordSchema.safeParse({ ...record, usage }).success).toBe(false);
    expect(callRecordSchema.safeParse({ ...record, prompt: "private" }).success).toBe(false);
    expect(callRecordSchema.safeParse({ ...record, finishReason: "private" }).success).toBe(false);
  });
  it("bounds a request's receipt", () => {
    expect(
      callAccountingSchema.safeParse({
        calls: Array(MAX_CALL_RECORDS).fill(record),
        truncated: true,
      }).success,
    ).toBe(true);
    expect(
      callAccountingSchema.safeParse({
        calls: Array(MAX_CALL_RECORDS + 1).fill(record),
        truncated: false,
      }).success,
    ).toBe(false);
  });
});
