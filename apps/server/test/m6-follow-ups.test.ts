import { blankCard, DEFAULT_AUTHORS_NOTE, defaultPromptPreset } from "@ephemera/core";
import { describe, expect, it } from "vitest";
import { type FakeUpstreamOptions, fakeUpstream } from "./fake-upstream.ts";
import {
  CLOCK,
  fileForm,
  formRequest,
  ownerHeaders,
  PICK_SEED,
  postJson,
  promptPart,
  responseParts,
  TEST_USER,
  testApp,
} from "./helpers.ts";

function setup(options: FakeUpstreamOptions = {}) {
  const upstream = fakeUpstream({ chunks: ["Aye."], ...options });
  const { app, instances } = testApp({ fetch: upstream.fetch });
  const { stores } = instances.instance(TEST_USER);
  return { app, stores, upstream };
}

function sentTo(upstream: ReturnType<typeof fakeUpstream>, index = 0) {
  const body = upstream.records[index]?.body as
    | { messages: { role: string; content: string }[] }
    | undefined;
  if (body === undefined) throw new Error("nothing reached upstream");
  return body.messages;
}

const chat = [
  { role: "user" as const, content: "Hi." },
  { role: "assistant" as const, content: "Hello.", reasoning: "A first thought." },
  { role: "user" as const, content: "And?" },
];

describe("prompt post-processing", () => {
  it("is none unless set for the model, and then sent exactly as the inspector shows", async () => {
    const { app, stores, upstream } = setup();
    const plain = promptPart(
      await responseParts(
        await app.request(
          "/api/chat",
          postJson({ model: "fake-model", clock: CLOCK, pickSeed: PICK_SEED, messages: chat }),
        ),
      ),
    );
    expect(plain.processing).toBe("none");
    expect(sentTo(upstream).filter((m) => m.role === "system").length).toBeGreaterThan(1);

    stores.settings.update({ promptProcessing: { "fake-model": "semiStrict" } });
    const processed = promptPart(
      await responseParts(
        await app.request(
          "/api/chat",
          postJson({ model: "fake-model", clock: CLOCK, pickSeed: PICK_SEED, messages: chat }),
        ),
      ),
    );
    const sent = sentTo(upstream, 1);
    expect(sent.filter((m) => m.role === "system")).toHaveLength(1);
    expect(sent[0]?.role).toBe("system");
    expect(processed.processing).toBe("semiStrict");
    expect(processed.messages.map(({ role, content }) => ({ role, content }))).toEqual(sent);
    expect(processed.messages[0]?.merged?.length).toBeGreaterThan(0);
  });

  it("refuses an unknown mode or none in the settings", async () => {
    const { app } = setup();
    for (const promptProcessing of [{ m: "loose" }, { m: "none" }]) {
      const response = await app.request("/api/settings", {
        method: "PATCH",
        headers: ownerHeaders(),
        body: JSON.stringify({ promptProcessing }),
      });
      expect(response.status).toBe(400);
    }
  });
});

describe("reasoning", () => {
  const withReasoning = (stores: ReturnType<typeof setup>["stores"], change: object) => {
    const preset = defaultPromptPreset("Thinking");
    return stores.presets.prompt.create(
      { ...preset, reasoning: { ...preset.reasoning, ...change } },
      crypto.randomUUID(),
    );
  };

  it("reads reasoning out of the reply text when the preset auto-parses it", async () => {
    const { app, stores } = setup({ chunks: ["<think>Weigh ", "it.</think>", "Aye."] });
    const promptPresetId = withReasoning(stores, { autoParse: true });
    const all = await responseParts(
      await app.request(
        "/api/chat",
        postJson({
          model: "fake-model",
          promptPresetId,
          clock: CLOCK,
          pickSeed: PICK_SEED,
          messages: [chat[0]],
        }),
      ),
    );
    const reasoning = all
      .filter((p) => p.type === "reasoning-delta")
      .map((p) => p.delta)
      .join("");
    const text = all
      .filter((p) => p.type === "text-delta")
      .map((p) => p.delta)
      .join("");
    expect(reasoning).toBe("Weigh it.");
    expect(text).not.toContain("<think>");
    expect(text).toContain("Aye.");
  });

  it("leaves tags in the text otherwise", async () => {
    const { app } = setup({ chunks: ["<think>Weigh</think>", "Aye."] });
    const all = await responseParts(
      await app.request(
        "/api/chat",
        postJson({ model: "fake-model", clock: CLOCK, pickSeed: PICK_SEED, messages: [chat[0]] }),
      ),
    );
    const text = all
      .filter((p) => p.type === "text-delta")
      .map((p) => p.delta)
      .join("");
    expect(text).toBe("<think>Weigh</think>Aye.");
  });

  it("reads only a block at the start, and keeps every character of the rest", async () => {
    const parsed = async (chunks: string[]) => {
      const { app, stores } = setup({ chunks });
      const promptPresetId = withReasoning(stores, { autoParse: true });
      const all = await responseParts(
        await app.request(
          "/api/chat",
          postJson({
            model: "fake-model",
            promptPresetId,
            clock: CLOCK,
            pickSeed: PICK_SEED,
            messages: [chat[0]],
          }),
        ),
      );
      const joined = (type: string) =>
        all
          .filter((p) => p.type === type)
          .map((p) => p.delta)
          .join("");
      return { reasoning: joined("reasoning-delta"), text: joined("text-delta") };
    };
    // The tag in pieces, after leading whitespace; the reply's own leading break goes.
    expect(await parsed([" \n<th", "ink>We", "igh.</thi", "nk>\n", "\nAye."])).toEqual({
      reasoning: "Weigh.",
      text: "Aye.",
    });
    // A tag later in the story is the story's.
    expect(await parsed(["Aye. ", "<think>not this</think>"])).toEqual({
      reasoning: "",
      text: "Aye. <think>not this</think>",
    });
    // What looked like the start of a tag, when the reply ends there, is text.
    expect(await parsed(["<thi"])).toEqual({ reasoning: "", text: "<thi" });
    expect(await parsed(["<think>Weigh.</think>Aye <", "/thi"])).toEqual({
      reasoning: "Weigh.",
      text: "Aye </thi",
    });
    // A block the reply never closes is all reasoning.
    expect(await parsed(["<think>Cut off mid-th", "ought </thi"])).toEqual({
      reasoning: "Cut off mid-thought </thi",
      text: "",
    });
  });

  it("sends the latest reasoning back only when the preset adds it", async () => {
    const { app, stores, upstream } = setup();
    await (
      await app.request(
        "/api/chat",
        postJson({ model: "fake-model", clock: CLOCK, pickSeed: PICK_SEED, messages: chat }),
      )
    ).text();
    expect(JSON.stringify(sentTo(upstream))).not.toContain("A first thought.");
    const promptPresetId = withReasoning(stores, { addToPrompts: true });
    await (
      await app.request(
        "/api/chat",
        postJson({
          model: "fake-model",
          promptPresetId,
          clock: CLOCK,
          pickSeed: PICK_SEED,
          messages: chat,
        }),
      )
    ).text();
    expect(sentTo(upstream, 1)).toContainEqual({
      role: "assistant",
      content: "<think>A first thought.</think>\nHello.",
    });
  });
});

describe("a card's Author's Note, from before the note moved to presets", () => {
  const note = { ...DEFAULT_AUTHORS_NOTE, text: "Keep the fog thick.", depth: 2 };
  const fields = {
    ...blankCard("Mara Voss"),
  };

  it("is refused as a sheet field, and discarded from unsupported imported extensions", async () => {
    const { app } = setup();
    const refused = await app.request(
      "/api/characters",
      postJson({ id: crypto.randomUUID(), fields: { ...fields, authors_note: note } }),
    );
    expect(refused.status).toBe(400);

    const card = {
      spec: "chara_card_v3",
      spec_version: "3.0",
      data: { ...blankCard("Mara Voss"), extensions: { ephemera: { authors_note: note } } },
    };
    const imported = await app.request(
      "/api/characters/import",
      formRequest("POST", fileForm(JSON.stringify(card), "mara.json")),
    );
    expect(imported.status).toBe(201);
    const { id } = (await imported.json()) as { id: string };

    const patched = await app.request(`/api/characters/${id}`, {
      method: "PATCH",
      headers: ownerHeaders(),
      body: JSON.stringify({ description: "A harbour pilot.", revision: 0 }),
    });
    expect(patched.status).toBe(200);
    const read = (await (
      await app.request(`/api/characters/${id}`, { headers: ownerHeaders() })
    ).json()) as { card: { description: string; extensions: Record<string, unknown> } };
    expect(read.card.description).toBe("A harbour pilot.");
    expect(read.card).not.toHaveProperty("extensions");

    const exported = (await (
      await app.request(`/api/characters/${id}/export.json`, { headers: ownerHeaders() })
    ).json()) as { data: { extensions: Record<string, unknown> } };
    expect(exported.data).not.toHaveProperty("extensions");
  });
});
