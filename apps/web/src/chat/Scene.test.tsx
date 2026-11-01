import { DEFAULT_SETTINGS, type Settings } from "@ephemera/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { charactersQuery } from "../characters/queries.ts";
import { settingsQuery } from "../settings/settings.ts";
import { type SceneBitmap, SceneButton, SceneView } from "./Scene.tsx";
import type { SceneItem, SceneRun } from "./scene-slice.ts";
import { chatStore } from "./session.ts";
import { type ChatMessage, NO_MEMORY } from "./store.ts";
import { Thread } from "./Thread.tsx";

// The tab's session, without its requests or its sign-in: a bare chat store the tests fill.
vi.mock("./session.ts", async () => {
  const { createChatStore } = await import("./store.ts");
  const chatStore = createChatStore(
    async function* () {},
    () => ({
      model: "model-a",
      samplerPresetId: null,
      promptPresetId: null,
      characterId: "ava",
      personaId: null,
      reasoning: null,
    }),
    {
      clock: () => ({ now: 0, timeZone: "UTC" }),
      fetchPreview: () => new Promise(() => {}),
    },
  );
  // A static render reads the store as it is now, not as it began.
  return {
    chatStore,
    useChat: <T,>(selector: (state: ReturnType<typeof chatStore.getState>) => T) =>
      selector(chatStore.getState()),
  };
});
vi.mock("@/app/form-factor.ts", async (original) => ({
  ...(await original<typeof import("@/app/form-factor.ts")>()),
  useFormFactor: () => "desktop",
  useCoarsePointer: () => false,
}));
vi.mock("@/app/reduced-motion.ts", () => ({
  useReducedMotion: () => false,
  scrollBehavior: () => "instant",
}));

const BITMAP: ImageBitmap = { width: 2, height: 3, close: () => {} };
const RUNNING: SceneRun = {
  status: "running",
  phase: "running",
  value: 3,
  max: 8,
  started: 0,
  heard: 0,
};

const noop = () => {};

function view(run: SceneRun, decoded: SceneBitmap = { status: "none" }) {
  return renderToStaticMarkup(
    <SceneView
      id="s1"
      run={run}
      name="Ava"
      decoded={decoded}
      onStop={noop}
      onRetry={noop}
      onHide={noop}
    />,
  );
}

/** Rendered with the settings and the gallery's character in the cache. */
function withQueries(
  node: ReactNode,
  address = "http://127.0.0.1:8188",
  models: Pick<Settings, "model" | "imagePromptModel"> = {
    model: "model-a",
    imagePromptModel: null,
  },
) {
  const client = new QueryClient();
  client.setQueryData(settingsQuery.queryKey, {
    ...DEFAULT_SETTINGS,
    ...models,
    characterId: "ava",
    comfyuiBaseUrl: address,
  });
  client.setQueryData(charactersQuery.queryKey, [
    {
      id: "ava",
      name: "Ava",
      nickname: "",
      creator: "",
      tags: [],
      portrait: null,
      createdAt: 0,
      updatedAt: 0,
    },
  ] as never);
  return renderToStaticMarkup(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

/** The live regions' words, in order. */
const live = (out: string) =>
  [...out.matchAll(/<span role="status" class="sr-only">([^<]*)<\/span>/g)].map(
    (match) => match[1],
  );

describe("a scene picture", () => {
  it("draws its picture on a named canvas, never as an image or a URL", () => {
    const out = view({ status: "complete" }, { status: "ready", bitmap: BITMAP, fresh: true });
    expect(out).toMatch(/<canvas[^>]*role="img"[^>]*aria-label="Scene with Ava"/);
    expect(out).toContain("develop-in");
    expect(out).not.toMatch(/<img\b/);
    expect(out).not.toMatch(/blob:|data:/);
    expect(out).not.toContain("Hide this picture");
  });

  it("comes back with a quick fade, not the develop, once shown before", () => {
    const out = view({ status: "complete" }, { status: "ready", bitmap: BITMAP, fresh: false });
    expect(out).not.toContain("develop-in");
  });

  it("says the stage while it is painted, with the step count to read but not announced, and Stop", () => {
    const out = view(RUNNING);
    expect(live(out)).toEqual(["Developing the picture"]);
    expect(out).toContain("Step 3 of 8");
    expect(out).toContain('aria-label="Stop the picture"');
    expect(out).toContain('data-lamplight="busy"');
    expect(out).not.toContain("<canvas");
    expect(out).not.toContain("Paint it again");
  });

  it("waits for a sign-in with Stop", () => {
    const out = view({ status: "waiting" });
    expect(live(out)).toEqual(["Waiting for sign-in"]);
    expect(out).toContain('aria-label="Stop the picture"');
    expect(out).not.toContain("data-lamplight");
  });

  it("says why it failed, with Paint it again and Hide", () => {
    const out = view({ status: "failed", code: "comfyui" });
    expect(live(out)).toEqual([
      "The picture failed. ComfyUI failed or returned an unusable picture.",
    ]);
    expect(out).toContain('<span class="text-ember">failed</span>');
    expect(out).toContain(">Paint it again</button>");
    expect(out).toContain('aria-label="Hide this picture"');
    expect(out).not.toContain("Stop the picture");
  });

  it("is skipped while ComfyUI is not ready, and stopped, each with Paint it again and Hide", () => {
    const skipped = view({ status: "skipped", reason: "unavailable" });
    expect(live(skipped)[0]).toContain("ComfyUI is not ready");
    expect(skipped).toContain(">Paint it again</button>");
    expect(skipped).toContain('aria-label="Hide this picture"');
    const stopped = view({ status: "stopped" });
    expect(live(stopped)).toEqual([""]);
    expect(stopped).toContain("Stopped");
    expect(stopped).toContain(">Paint it again</button>");
    expect(stopped).toContain('aria-label="Hide this picture"');
  });

  it("says when its picture cannot be shown, with Hide only", () => {
    const out = view({ status: "complete" }, { status: "failed" });
    expect(live(out)).toEqual(["The picture could not be shown"]);
    expect(out).toContain('aria-label="Hide this picture"');
    expect(out).not.toContain("Paint it again");
    expect(out).not.toContain("<canvas");
  });
});

describe("Picture this scene", () => {
  const reply: ChatMessage = {
    id: "m1",
    role: "assistant",
    greeting: true,
    edited: false,
    shown: 0,
    replies: [{ id: "r1", text: "Hello.", reasoning: "", thoughtMs: null, status: "complete" }],
  };

  it("is hidden without a ComfyUI address, and always named as the whole action", () => {
    chatStore.setState({ messages: [reply], scenes: [], memory: NO_MEMORY });
    expect(withQueries(<SceneButton wide />, "")).toBe("");
    const wide = withQueries(<SceneButton wide />);
    expect(wide).toContain('aria-label="Picture this scene"');
    expect(wide).toContain('<span class="max-desktop:hidden"> this scene</span>');
    expect(wide).toContain(`aria-disabled="false"`);
    const narrow = withQueries(<SceneButton wide={false} />);
    expect(narrow).toContain('aria-label="Picture this scene"');
    expect(narrow).not.toContain("this scene</span>");
  });

  it("waits for a model, which Settings' image prompt model supplies without a chat model", () => {
    chatStore.setState({ messages: [reply], scenes: [], memory: NO_MEMORY });
    const address = "http://127.0.0.1:8188";
    expect(
      withQueries(<SceneButton wide />, address, { model: null, imagePromptModel: null }),
    ).toContain(`aria-disabled="true"`);
    expect(
      withQueries(<SceneButton wide />, address, { model: null, imagePromptModel: "model-b" }),
    ).toContain(`aria-disabled="false"`);
  });

  it("is held while a picture is on its way, which describes it", () => {
    const running: SceneItem = {
      id: "s1",
      anchorId: "m1",
      run: RUNNING,
      request: { characterId: "ava", personaId: null, model: "model-a", workflow: "w", turns: [] },
    };
    chatStore.setState({ messages: [reply], scenes: [running], memory: NO_MEMORY });
    const out = withQueries(<SceneButton wide />);
    expect(out).toContain(`aria-disabled="true"`);
    expect(out).toContain('aria-describedby="scene-stage-s1"');
  });
});

describe("the thread's pictures", () => {
  const messages: ChatMessage[] = [
    { id: "u1", role: "user", text: "Hi", personaId: null, sentAt: 0 },
    {
      id: "a1",
      role: "assistant",
      greeting: false,
      edited: false,
      shown: 0,
      replies: [{ id: "r1", text: "Hello.", reasoning: "", thoughtMs: null, status: "complete" }],
    },
    { id: "u2", role: "user", text: "Look", personaId: null, sentAt: 0 },
    {
      id: "a2",
      role: "assistant",
      greeting: false,
      edited: false,
      shown: 0,
      replies: [{ id: "r2", text: "There.", reasoning: "", thoughtMs: null, status: "complete" }],
    },
  ];
  const item = (id: string, anchorId: string): SceneItem => ({
    id,
    anchorId,
    run: { status: "stopped" },
    request: { characterId: "ava", personaId: null, model: "model-a", workflow: "w", turns: [] },
  });
  const pictures = () => {
    const out = withQueries(<Thread composer={{ current: null }} />);
    return [...out.matchAll(/<li data-scene=""/g)].length;
  };

  it("show with the message they follow: folded away with it, back when the folded turns are shown or unfold", () => {
    chatStore.setState({
      messages,
      scenes: [item("early", "a1"), item("late", "a2")],
      memory: { ...NO_MEMORY, horizon: 2 },
    });
    expect(pictures()).toBe(1);
    chatStore.setState({ memory: { ...NO_MEMORY, horizon: 2, shown: true } });
    expect(pictures()).toBe(2);
    chatStore.setState({ memory: NO_MEMORY });
    expect(pictures()).toBe(2);
  });
});
