import type { CallAccounting } from "@ephemera/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureCastSheet, updateCast } from "./queries.ts";

const CHARACTER = "6f0c1b8e-2d4f-4c1a-9b3e-5a7d8c9e0f12";
const sheet = (fingerprint: string) => ({
  characterId: CHARACTER,
  fingerprint: fingerprint.repeat(64),
  entries: [],
  revision: 0,
  updatedAt: 0,
});

afterEach(() => vi.unstubAllGlobals());

describe("ensureCastSheet", () => {
  it("delivers both joined-job receipts before its retry settles", async () => {
    const receipt: CallAccounting = {
      calls: [
        {
          id: crypto.randomUUID(),
          purpose: "cast.sheet",
          model: "m",
          status: "completed",
          usage: {},
        },
      ],
      truncated: false,
    };
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      return Response.json({
        sheet: sheet(calls++ === 0 ? "a" : "b"),
        current: calls > 1,
        accounting: receipt,
      });
    });
    const receive = vi.fn();
    await ensureCastSheet(CHARACTER, { model: "m" }, new AbortController().signal, receive);
    expect(receive).toHaveBeenCalledTimes(2);
    expect(receive).toHaveBeenNthCalledWith(1, receipt);
  });

  it("delivers usage even when the keeper's settled body is a refusal, and distinguishes preflight", async () => {
    const receipt: CallAccounting = {
      calls: [
        {
          id: crypto.randomUUID(),
          purpose: "cast.update",
          model: "m",
          status: "failed",
          usage: {},
        },
      ],
      truncated: false,
    };
    const receive = vi.fn();
    vi.stubGlobal("fetch", async () =>
      Response.json({ error: "cast_failed", accounting: receipt }),
    );
    const request = {
      model: "m",
      mode: "update" as const,
      sheetFingerprint: null,
      register: { entries: [] },
      turns: [{ role: "user" as const, content: "Synthetic" }],
    };
    expect(await updateCast(request, new AbortController().signal, receive)).toEqual({
      ok: false,
      reason: "cast_failed",
    });
    expect(receive).toHaveBeenCalledWith(receipt);
    receive.mockClear();
    vi.stubGlobal("fetch", async () =>
      Response.json({ error: "request_timeout" }, { status: 408 }),
    );
    await updateCast(request, new AbortController().signal, receive);
    expect(receive).toHaveBeenCalledWith({ calls: [], truncated: false });
  });
  it("asks once more when it joined a job for the card as it was, and carries the server's current", async () => {
    const answers = [
      { sheet: sheet("a"), current: false },
      { sheet: sheet("b"), current: true },
    ];
    let asked = 0;
    vi.stubGlobal("fetch", async () => Response.json(answers[asked++]));
    const outcome = await ensureCastSheet(CHARACTER, { model: "m" }, new AbortController().signal);
    expect(asked).toBe(2);
    expect(outcome).toEqual({ ok: true, sheet: sheet("b"), current: true });
  });

  it("asks once only: a sheet still not current comes back as such", async () => {
    let asked = 0;
    vi.stubGlobal("fetch", async () => {
      asked += 1;
      return Response.json({ sheet: sheet("a"), current: false });
    });
    const outcome = await ensureCastSheet(CHARACTER, { model: "m" }, new AbortController().signal);
    expect(asked).toBe(2);
    expect(outcome).toMatchObject({ ok: true, current: false });
  });
});
