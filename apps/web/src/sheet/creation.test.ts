import { describe, expect, it } from "vitest";
import { type Creation, creations } from "./creation.ts";

/** A server that stores by id, as the create routes do: a second create under an id makes nothing new. */
function server() {
  const stored = new Map<string, string>();
  const sent: Creation<string>[] = [];
  return {
    stored,
    sent,
    /** Stores the creation; "lost": stored, but the answer never reached the client. */
    create: async (creation: Creation<string>, answer: "ok" | "lost") => {
      sent.push(creation);
      if (!stored.has(creation.id)) stored.set(creation.id, creation.payload);
      return { ok: answer === "ok" };
    },
  };
}

describe("one creation per intent", () => {
  it("a retry after a lost answer sends the first attempt's id and payload, and makes one entity", async () => {
    const api = server();
    const creates = creations<string>();
    const lost = await creates.run("new", ({ take }) => api.create(take("first draft"), "lost"));
    expect(lost).toEqual({ ok: false });
    // The retry offers another payload; the held one goes again.
    const retried = await creates.run("new", ({ held, take }) => {
      expect(held).toEqual(api.sent[0]);
      return api.create(take("second draft"), "ok");
    });
    expect(retried).toEqual({ ok: true });
    expect(api.sent).toHaveLength(2);
    expect(api.sent[1]).toEqual(api.sent[0]);
    expect([...api.stored.values()]).toEqual(["first draft"]);
  });

  it("an acknowledged creation is released, so the next intent is a new one", async () => {
    const api = server();
    const creates = creations<string>();
    await creates.run("new", ({ take }) => api.create(take("one"), "ok"));
    await creates.run("new", ({ held, take }) => {
      expect(held).toBeUndefined();
      return api.create(take("two"), "ok");
    });
    expect(api.sent[1]?.id).not.toBe(api.sent[0]?.id);
    expect([...api.stored.values()]).toEqual(["one", "two"]);
  });

  it("while an attempt is on its way, another for the same intent sends nothing", async () => {
    const api = server();
    const creates = creations<string>();
    let answer = () => {};
    const first = creates.run("new", async ({ take }) => {
      const creation = take("draft");
      await new Promise<void>((resolve) => {
        answer = resolve;
      });
      return api.create(creation, "ok");
    });
    let repeated = false;
    const second = await creates.run("new", async () => {
      repeated = true;
      return { ok: true };
    });
    expect(second).toBeUndefined();
    expect(repeated).toBe(false);
    answer();
    expect(await first).toEqual({ ok: true });
    expect(api.stored.size).toBe(1);
  });

  it("keeps each intent's creation apart: two copies, or a prompt and a sampler preset", async () => {
    const api = server();
    const creates = creations<string>();
    await creates.run("copy:a", ({ take }) => api.create(take("book a"), "lost"));
    await creates.run("copy:b", ({ take }) => api.create(take("book b"), "lost"));
    await creates.run("copy:a", ({ take }) => api.create(take("changed"), "ok"));
    await creates.run("copy:b", ({ take }) => api.create(take("changed"), "ok"));
    const [a, b, aAgain, bAgain] = api.sent;
    expect(a?.id).not.toBe(b?.id);
    expect(aAgain).toEqual(a);
    expect(bAgain).toEqual(b);
    expect([...api.stored.values()]).toEqual(["book a", "book b"]);
  });

  it("a creation the server refused is released, so the retry sends a fresh id and payload", async () => {
    const creates = creations<string>();
    const sent: Creation<string>[] = [];
    await creates.run("copy:a", async ({ take }) => {
      sent.push(take("too large"));
      return { ok: false, refused: true };
    });
    await creates.run("copy:a", async ({ held, take }) => {
      expect(held).toBeUndefined();
      sent.push(take("corrected"));
      return { ok: true };
    });
    expect(sent[1]?.payload).toBe("corrected");
    expect(sent[1]?.id).not.toBe(sent[0]?.id);
  });

  it("release lets an intent completed another way take a new creation", async () => {
    const creates = creations<string>();
    let first: Creation<string> | undefined;
    await creates.run("new", async ({ take }) => {
      first = take("one");
      return { ok: false };
    });
    await creates.run("new", async ({ held, take, release }) => {
      expect(held).toEqual(first);
      release();
      const next = take("two");
      expect(next.id).not.toBe(first?.id);
      expect(next.payload).toBe("two");
      return { ok: true };
    });
  });

  it("a payload that cannot be read takes no creation, and a later attempt reads it afresh", async () => {
    const creates = creations<string>();
    const unread = await creates.run("copy:a", async () => ({ ok: false }));
    expect(unread).toEqual({ ok: false });
    await creates.run("copy:a", async ({ held }) => {
      expect(held).toBeUndefined();
      return { ok: false };
    });
  });

  it("a send that throws ends the attempt, so the intent can run again", async () => {
    const creates = creations<string>();
    await expect(
      creates.run("new", async ({ take }) => {
        take("draft");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const again = await creates.run("new", async ({ held }) => ({ ok: held?.payload === "draft" }));
    expect(again).toEqual({ ok: true });
  });
});
