import {
  DEFAULT_AUTHORS_NOTE,
  DEFAULT_NOTE_PROMPT,
  DEFAULT_PROMPT_ACTIONS,
  defaultPromptPreset,
  type InspectedPrompt,
} from "@ephemera/core";
import { describe, expect, it } from "vitest";
import { type FakeUpstreamOptions, fakeUpstream } from "./fake-upstream.ts";
import {
  CLOCK,
  PICK_SEED,
  postJson,
  promptPart,
  responseParts,
  TEST_USER,
  testApp,
} from "./helpers.ts";

const CANARY = "canary-m6-7c1d";

function setup(options: FakeUpstreamOptions = {}) {
  const upstream = fakeUpstream({ chunks: ["Aye."], ...options });
  const { app, lines, instances } = testApp({ fetch: upstream.fetch });
  const { stores } = instances.instance(TEST_USER);
  return { app, lines, stores, upstream };
}

type Sent = { messages: { role: string; content: string }[] };

/** The messages the fake upstream received in its `index`-th request. */
function sentTo(upstream: ReturnType<typeof fakeUpstream>, index = 0) {
  const body = upstream.records[index]?.body as Sent | undefined;
  if (body === undefined) throw new Error("nothing reached upstream");
  return body.messages;
}

const chat = [
  { role: "user" as const, content: `Where is the Heron? ${CANARY}-in` },
  { role: "assistant" as const, content: "She sank off the" },
];

describe("POST /api/chat, generation modes", () => {
  it("continues the last reply with the nudge sent last and names the mode", async () => {
    const { app, upstream } = setup();
    const all = await responseParts(
      await app.request(
        "/api/chat",
        postJson({
          model: "fake-model",
          clock: CLOCK,
          pickSeed: PICK_SEED,
          mode: "continue",
          messages: chat,
        }),
      ),
    );
    const sent = upstream.records[0]?.body as Sent;
    expect(sent.messages.at(-2)).toEqual({ role: "assistant", content: "She sank off the" });
    expect(sent.messages.at(-1)).toEqual({
      role: "system",
      content: DEFAULT_PROMPT_ACTIONS.continue,
    });
    const prompt = promptPart(all);
    expect(prompt).toMatchObject({ mode: "continue" });
    expect(prompt.messages.at(-1)?.source).toEqual({ kind: "instruction", id: "continue" });
  });

  it("uses the chosen preset's action instruction", async () => {
    const { app, stores, upstream } = setup();
    const preset = defaultPromptPreset("Mine");
    const promptPresetId = stores.presets.prompt.create(
      {
        ...preset,
        actions: { ...preset.actions, continue: "[Go on, {{char}}.]" },
      },
      crypto.randomUUID(),
    );
    const all = await responseParts(
      await app.request(
        "/api/chat",
        postJson({
          model: "fake-model",
          promptPresetId,
          clock: CLOCK,
          pickSeed: PICK_SEED,
          mode: "continue",
          messages: chat,
        }),
      ),
    );
    expect(sentTo(upstream).at(-1)?.content).toBe("[Go on, Assistant.]");
    expect(promptPart(all)).not.toHaveProperty("continuePostfix");
  });

  it("writes the user's next message after the impersonation prompt, even in an empty chat", async () => {
    const { app, upstream } = setup();
    for (const messages of [chat, []]) {
      await (
        await app.request(
          "/api/chat",
          postJson({
            model: "fake-model",
            clock: CLOCK,
            pickSeed: PICK_SEED,
            mode: "impersonate",
            messages,
          }),
        )
      ).text();
    }
    for (const record of upstream.records) {
      expect((record.body as Sent).messages.at(-1)).toEqual({
        role: "system",
        content: DEFAULT_PROMPT_ACTIONS.writeForMe
          .replaceAll("{{user}}", "User")
          .replaceAll("{{char}}", "Assistant"),
      });
    }
    expect(upstream.records).toHaveLength(2);
  });

  it.each([
    ["a continue after the user's turn", "continue", [chat[0]]],
    ["a reply after a reply", "reply", chat],
  ])("refuses %s without calling upstream", async (_label, mode, messages) => {
    const { app, upstream } = setup();
    const response = await app.request(
      "/api/chat",
      postJson({ model: "fake-model", clock: CLOCK, pickSeed: PICK_SEED, mode, messages }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
    expect(upstream.records).toHaveLength(0);
  });
});

describe("POST /api/chat, Author's Note", () => {
  const authorsNote = {
    ...DEFAULT_AUTHORS_NOTE,
    text: `Keep {{char}} guarded. ${CANARY}-note`,
    role: "system" as const,
  };
  const withNote = (stores: ReturnType<typeof setup>["stores"]) =>
    stores.presets.prompt.create({ ...defaultPromptPreset(), authorsNote }, crypto.randomUUID());
  const messages = [...chat, { role: "user" as const, content: "And the crew?" }];

  it("reaches upstream from the preset at its depth, labelled for the inspector, and is never logged", async () => {
    const { app, upstream, lines, stores } = setup();
    const promptPresetId = withNote(stores);
    const all = await responseParts(
      await app.request(
        "/api/chat",
        postJson({
          model: "fake-model",
          clock: CLOCK,
          pickSeed: PICK_SEED,
          promptPresetId,
          messages,
        }),
      ),
    );
    const sent = sentTo(upstream);
    expect(sent.slice(-3)).toEqual([
      { role: "assistant", content: "She sank off the" },
      { role: "system", content: `Keep Assistant guarded. ${CANARY}-note` },
      { role: "user", content: "And the crew?" },
    ]);
    expect(promptPart(all).messages.at(-2)?.source).toEqual({ kind: "authorsNote", depth: 1 });
    expect(lines.join("\n")).not.toContain(CANARY);
  });

  it("is in the preview too", async () => {
    const { app, upstream, stores } = setup();
    const promptPresetId = withNote(stores);
    const response = await app.request(
      "/api/chat/preview",
      postJson({
        model: "fake-model",
        clock: CLOCK,
        pickSeed: PICK_SEED,
        promptPresetId,
        messages: [chat[0]],
      }),
    );
    const { prompt } = (await response.json()) as { prompt: InspectedPrompt };
    expect(prompt.messages.find((m) => m.source.kind === "authorsNote")?.content).toBe(
      `Keep Assistant guarded. ${CANARY}-note`,
    );
    expect(prompt.mode).toBe("reply");
    expect(upstream.records).toHaveLength(0);
  });

  it("is the default note, as the user, before the last turn when no preset is chosen", async () => {
    const { app, upstream } = setup();
    await (
      await app.request(
        "/api/chat",
        postJson({ model: "fake-model", clock: CLOCK, pickSeed: PICK_SEED, messages }),
      )
    ).text();
    expect(sentTo(upstream).slice(-2)).toEqual([
      { role: "user", content: DEFAULT_NOTE_PROMPT.replaceAll("{{user}}", "User") },
      { role: "user", content: "And the crew?" },
    ]);
  });
});

describe("POST /api/chat, reasoning", () => {
  it("streams reasoning apart from the text", async () => {
    const { app } = setup({ reasoning: [`Think ${CANARY}-think`], chunks: ["Aye."] });
    const all = await responseParts(
      await app.request(
        "/api/chat",
        postJson({ model: "fake-model", clock: CLOCK, pickSeed: PICK_SEED, messages: [chat[0]] }),
      ),
    );
    expect(all.filter((p) => p.type === "reasoning-delta").map((p) => p.delta)).toEqual([
      `Think ${CANARY}-think`,
    ]);
    expect(all.filter((p) => p.type === "text-delta").map((p) => p.delta)).toEqual(["Aye."]);
  });
});
