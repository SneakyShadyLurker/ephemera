import {
  type CharacterMemory,
  DEFAULT_SETTINGS,
  type MemoryState,
  type Settings,
  type StoredEpisode,
} from "@ephemera/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryMark } from "../chat/MemoryMark.tsx";
import { chatStore } from "../chat/session.ts";
import { type ChatMessage, NO_MEMORY } from "../chat/store.ts";
import { Thread } from "../chat/Thread.tsx";
import { settingsQuery } from "../settings/settings.ts";
import { reloadMemory } from "./EpisodeEditor.tsx";
import { MemoryBook } from "./MemoryScreen.tsx";
import { MEMORY_KEY } from "./queries.ts";

const CHARACTER = "5a1e2b3c-4d5e-4f60-8a1b-2c3d4e5f6a7b";

// The tab's own session stays out: the surfaces read a store of their own, chatting with Mira.
vi.mock("../chat/session.ts", async () => {
  const { createChatStore } = await import("../chat/store.ts");
  const chatStore = createChatStore(
    async function* () {},
    () => ({
      model: "model-a",
      samplerPresetId: null,
      promptPresetId: null,
      characterId: "5a1e2b3c-4d5e-4f60-8a1b-2c3d4e5f6a7b",
      personaId: null,
      reasoning: null,
    }),
    {
      clock: () => ({ now: 0, timeZone: "UTC" }),
      fetchPreview: () => Promise.reject(new Error("No previews here")),
    },
  );
  return {
    chatStore,
    // A static render reads the store as it is now (a server render would read its initial state).
    useChat: <T,>(selector: (state: ReturnType<typeof chatStore.getState>) => T) =>
      selector(chatStore.getState()),
  };
});
vi.mock("../chat/character.ts", async (importActual) => ({
  speakerName: (await importActual<typeof import("../chat/character.ts")>()).speakerName,
  useChatCharacter: () => ({ id: "5a1e2b3c-4d5e-4f60-8a1b-2c3d4e5f6a7b", name: "Mira" }),
  usePersona: () => undefined,
  useChatPersona: () => undefined,
}));
vi.mock("../chat/Presence.tsx", () => ({ Presence: () => null }));
vi.mock("../rework/session.ts", () => ({ useReworkLocked: () => false }));
/** A touch screen says why Remember now waits in a line of its own, where a pointer reads a tooltip. */
const pointer = vi.hoisted(() => ({ coarse: false }));
vi.mock("@/app/form-factor.ts", () => ({
  useFormFactor: () => "desktop",
  useCoarsePointer: () => pointer.coarse,
  useCanDock: () => false,
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  Link: ({
    children,
    to,
    params: _params,
    search: _search,
    ...props
  }: {
    children: ReactNode;
    to: string;
    params?: unknown;
    search?: unknown;
  }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useBlocker: () => ({ status: "idle" }),
}));

const user = (id: string, text: string): ChatMessage => ({
  id,
  role: "user",
  text,
  personaId: null,
  sentAt: 0,
});
const reply = (id: string, text: string): ChatMessage => ({
  id,
  role: "assistant",
  greeting: false,
  edited: false,
  shown: 0,
  replies: [{ id: `${id}-reply`, text, reasoning: "", thoughtMs: null, status: "complete" }],
});

const EPISODE: StoredEpisode = {
  id: "6b2f3c4d-5e6f-4a71-8b2c-3d4e5f6a7b8c",
  characterId: CHARACTER,
  seq: 0,
  kind: "episode",
  title: "The ferry at dawn",
  summary: "Mira and the ferryman crossed before the fog lifted.",
  cues: ["ferryman", "fog"],
  turns: 4,
  chapterId: null,
  pinned: false,
  revision: 0,
  createdAt: 0,
  updatedAt: 0,
};

const ON: MemoryState = {
  enabled: true,
  notebook: {
    situation: "Mira waits on the far bank.",
    relationships: ["Mira and the ferryman: wary, bound by the favour."],
    facts: ["The ferryman owes Mira a favour."],
    threads: [],
    cast: [],
  },
  opening: "> Location: The far bank, dawn\n\nMira waits by the ferry.",
  revision: 1,
  updatedAt: 0,
};

/** Renders `node` with the character's memory loaded, still loading (undefined) or failed. */
function render(
  node: ReactNode,
  memory: CharacterMemory | undefined | "failed",
  settings: Partial<Settings> = {},
) {
  const client = new QueryClient();
  client.setQueryData(settingsQuery.queryKey, {
    ...DEFAULT_SETTINGS,
    characterId: CHARACTER,
    ...settings,
  });
  if (memory === "failed") {
    client
      .getQueryCache()
      .build(client, { queryKey: MEMORY_KEY(CHARACTER) })
      .setState({ status: "error", error: new Error("unavailable"), fetchStatus: "idle" });
  } else if (memory !== undefined) client.setQueryData(MEMORY_KEY(CHARACTER), memory);
  return renderToStaticMarkup(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

const thread = () =>
  render(<Thread composer={{ current: null }} />, { state: ON, episodes: [EPISODE] });

afterEach(() => {
  chatStore.setState({ messages: [], memory: NO_MEMORY, editing: null });
  pointer.coarse = false;
});

describe("the thread with a memory", () => {
  const folded = [
    user("u1", "Take me across before the fog lifts."),
    reply("r1", "The ferryman pushes off without a word."),
    user("u2", "What do I owe you?"),
    reply("r2", "A favour, he says, to be named later."),
  ];
  const live = [user("u3", "We reach the far bank."), reply("r3", "Mira steps onto the stones.")];
  const remembered = () =>
    chatStore.setState({
      messages: [...folded, ...live],
      memory: {
        ...NO_MEMORY,
        horizon: 4,
        recap: [EPISODE.id],
        foldedLatest: { id: EPISODE.id, title: EPISODE.title, from: 0 },
      },
    });

  it("sets the seam at the horizon and keeps the folded turns out of sight until Show", () => {
    remembered();
    const out = thread();
    expect(out).toContain("data-memory-seam");
    expect(out).toContain("The ferry at dawn");
    expect(out).toContain("Remembered. 4 turns folded.");
    expect(out).toContain("Show the folded turns");
    expect(out).not.toContain("Take me across");
    expect(out.indexOf("data-memory-seam")).toBeLessThan(out.indexOf("We reach the far bank."));
  });

  it("shows the folded turns above the seam, dimmed and without their actions", () => {
    remembered();
    chatStore.getState().showFolded(true);
    const out = thread();
    expect(out).toContain("Hide the folded turns");
    expect(out.indexOf("Take me across")).toBeLessThan(out.indexOf("data-memory-seam"));
    expect(out.match(/data-folded=""/g)).toHaveLength(4);
    // Only the two live turns carry their More actions.
    expect(out.match(/aria-label="More actions, /g)).toHaveLength(2);
  });

  it("hides the actions of the turns being remembered while the call runs", () => {
    chatStore.setState({
      messages: [...folded, ...live],
      memory: {
        ...NO_MEMORY,
        status: "remembering",
        boundary: 4,
        pending: { attempt: EPISODE.id, boundary: 4, from: 0 },
      },
    });
    const out = thread();
    expect(out).toContain("Remembering…");
    expect(out).toContain("Take me across");
    expect(out.indexOf("Take me across")).toBeLessThan(out.indexOf("data-memory-seam"));
    expect(out.match(/aria-label="More actions, /g)).toHaveLength(2);
  });

  it("keeps the turns of an unconfirmed memory without their actions, and says they stay read-only", () => {
    chatStore.setState({
      messages: [...folded, ...live],
      memory: {
        ...NO_MEMORY,
        status: "failed",
        failure: "unreachable",
        boundary: 4,
        pending: { attempt: EPISODE.id, boundary: 4, from: 0 },
      },
    });
    const out = thread();
    expect(out).toContain("Those turns stay read-only until confirmed. Try again recovers it.");
    expect(out.indexOf("Take me across")).toBeLessThan(out.indexOf("data-memory-seam"));
    expect(out.match(/aria-label="More actions, /g)).toHaveLength(2);
  });

  it("sets the seam where held turns end: they stay in sight, read-only, still sent", () => {
    chatStore.setState({
      messages: [...folded, ...live],
      memory: { ...NO_MEMORY, held: [{ id: EPISODE.id, title: EPISODE.title, from: 0, to: 4 }] },
    });
    const out = thread();
    expect(out).toContain("The ferry at dawn");
    expect(out).toContain("Remembered. 4 turns still sent.");
    expect(out).not.toContain("Show the folded turns");
    expect(out.indexOf("Take me across")).toBeLessThan(out.indexOf("data-memory-seam"));
    expect(out).not.toContain('data-folded=""');
    expect(out.match(/aria-label="More actions, /g)).toHaveLength(2);
  });

  it("counts folded and held turns apart, and marks where the folded ones end once shown", () => {
    chatStore.setState({
      messages: [...folded, ...live],
      memory: {
        ...NO_MEMORY,
        horizon: 2,
        recap: [EPISODE.id],
        held: [{ id: crypto.randomUUID(), title: "The far bank", from: 2, to: 4 }],
      },
    });
    expect(thread()).toContain("Remembered. 2 turns folded, 2 still sent.");
    expect(thread()).not.toContain("data-fold-line");
    chatStore.getState().showFolded(true);
    const out = thread();
    expect(out.match(/data-folded=""/g)).toHaveLength(2);
    expect(out.indexOf("data-fold-line")).toBeGreaterThan(out.indexOf("Take me across"));
    expect(out.indexOf("data-fold-line")).toBeLessThan(out.indexOf("What do I owe you?"));
  });

  it("has no seam while nothing is remembered", () => {
    chatStore.setState({ messages: [...folded, ...live] });
    expect(thread()).not.toContain("data-memory-seam");
  });
});

describe("the memory mark", () => {
  it("shows only while the chat's character has memory on, a character never touched included", () => {
    expect(render(<MemoryMark />, { state: ON, episodes: [] })).toContain('aria-label="Memory"');
    expect(render(<MemoryMark />, { state: null, episodes: [] })).toContain('aria-label="Memory"');
    expect(render(<MemoryMark />, { state: { ...ON, enabled: false }, episodes: [] })).toBe("");
  });

  it("does not show while the memory loads or after it failed to load", () => {
    expect(render(<MemoryMark />, undefined)).toBe("");
    expect(render(<MemoryMark />, "failed")).toBe("");
  });
});

describe("the memory screen", () => {
  const screen = (memory: CharacterMemory, settings: Partial<Settings> = {}) =>
    render(<MemoryBook id={CHARACTER} name="Mira" memory={memory} />, memory, settings);

  it("invites the owner to turn memory back on once it is off, saying what is kept", () => {
    const out = screen({ state: { ...ON, enabled: false }, episodes: [] });
    expect(out).toContain("What Mira remembers");
    expect(out).toContain("Memory is off");
    expect(out).toMatch(/role="switch"[^>]*aria-checked="false"/);
    expect(out).toContain("The chat itself is never kept.");
    expect(out).not.toContain("Remember now");
  });

  it("shows the book with its switch on for a character never touched", () => {
    const out = screen({ state: null, episodes: [] });
    expect(out).toMatch(/role="switch"[^>]*aria-checked="true"/);
    expect(out).toContain("Remember the story");
    expect(out).toContain("The chat itself is never kept.");
    expect(out).toContain("Nothing remembered yet");
    expect(out).toContain("Memories arrive as the story grows.");
    expect(out).toContain("Remember now");
  });

  it("edits the next chat's opening under the situation", () => {
    const out = screen({ state: ON, episodes: [] });
    expect(out).toContain("Next chat opens with");
    expect(out).toContain("Mira waits by the ferry.");
    expect(out).toContain("Empty, the card&#x27;s own greeting opens it.");
    expect(out.indexOf("Next chat opens with")).toBeGreaterThan(
      out.indexOf("Mira waits on the far bank."),
    );
    expect(out.indexOf("Next chat opens with")).toBeLessThan(out.indexOf("Relationships"));
  });

  it("offers Regenerate beside the opening's label while there is something to write it from", () => {
    const out = screen({ state: ON, episodes: [] }, { model: "model-a" });
    const regenerate = out.match(/<button[^>]*>(?:(?!<\/button>).)*Regenerate<\/button>/)?.[0];
    expect(regenerate).toBeDefined();
    expect(regenerate).toContain('aria-disabled="false"');
    expect(out.indexOf("Next chat opens with")).toBeLessThan(out.indexOf("Regenerate"));
    expect(out.indexOf("Regenerate")).toBeLessThan(out.indexOf("Mira waits by the ferry."));
  });

  it("says why Regenerate waits: nothing remembered, or no model", () => {
    pointer.coarse = true;
    const empty: MemoryState = {
      ...ON,
      notebook: { situation: "", relationships: [], facts: [], threads: [], cast: [] },
    };
    const nothing = screen({ state: empty, episodes: [] }, { model: "model-a" });
    expect(nothing).toContain("Regenerate waits. Nothing is remembered yet to write it from.");
    expect(nothing).toMatch(/<button[^>]*data-disabled[^>]*>(?:(?!<\/button>).)*Regenerate/);
    // A memory alone is something to write from.
    expect(screen({ state: empty, episodes: [EPISODE] }, { model: "model-a" })).not.toContain(
      "Regenerate waits.",
    );
    expect(screen({ state: ON, episodes: [] })).toContain(
      "Regenerate waits. Choose a model in Settings to write it.",
    );
    // The memory model alone is enough.
    expect(screen({ state: ON, episodes: [] }, { memoryModel: "model-m" })).not.toContain(
      "Regenerate waits.",
    );
  });

  it("offers Forget everything for an opening alone, and not for nothing", () => {
    const empty = {
      ...ON,
      notebook: { situation: "", relationships: [], facts: [], threads: [], cast: [] },
    };
    expect(screen({ state: empty, episodes: [] })).toContain('aria-label="Memory actions"');
    expect(screen({ state: { ...empty, opening: "" }, episodes: [] })).not.toContain(
      'aria-label="Memory actions"',
    );
  });

  it("says nothing is remembered yet while the book is empty", () => {
    const out = screen({ state: ON, episodes: [] });
    expect(out).toContain("Mira waits on the far bank.");
    expect(out).toContain("The ferryman owes Mira a favour.");
    // Relationships edit as facts and threads do, a line each.
    expect(out).toContain('aria-label="Relationships, line 1"');
    expect(out).toContain("Mira and the ferryman: wary, bound by the favour.");
    expect(out).toContain("Add a relationship");
    expect(out).toContain("Nothing remembered yet");
    expect(out).toContain("Memories arrive as the story grows.");
  });

  it("lists the memories newest first, a chapter folding its members", () => {
    const later: StoredEpisode = { ...EPISODE, id: crypto.randomUUID(), seq: 1, title: "The bank" };
    const chapter: StoredEpisode = {
      ...EPISODE,
      id: crypto.randomUUID(),
      seq: 2,
      kind: "chapter",
      title: "The crossing",
      turns: 8,
    };
    const out = screen({
      state: ON,
      episodes: [{ ...EPISODE, chapterId: chapter.id }, later, chapter],
    });
    expect(out.indexOf("The crossing")).toBeLessThan(out.indexOf("The bank"));
    expect(out).toContain("Show the 1 memory it gathers");
    expect(out).toContain("A chapter of 1 memory, 8 turns.");
    expect(out).toContain("ferryman");
    expect(out).not.toContain("Nothing remembered yet");
  });

  it("counts a chapter's memories on one basis: those it gathers directly, a chapter among them as one", () => {
    const inner: StoredEpisode = {
      ...EPISODE,
      id: crypto.randomUUID(),
      seq: 2,
      kind: "chapter",
      title: "The crossing",
    };
    const outer: StoredEpisode = {
      ...EPISODE,
      id: crypto.randomUUID(),
      seq: 4,
      kind: "chapter",
      title: "The river",
      turns: 12,
    };
    const out = screen({
      state: ON,
      episodes: [
        { ...EPISODE, chapterId: inner.id },
        { ...EPISODE, id: crypto.randomUUID(), seq: 1, chapterId: inner.id },
        { ...inner, chapterId: outer.id },
        { ...EPISODE, id: crypto.randomUUID(), seq: 3, chapterId: outer.id },
        outer,
      ],
    });
    expect(out).toContain("A chapter of 2 memories, 12 turns.");
    expect(out).toContain("Show the 2 memories it gathers");
    expect(out).not.toContain("A chapter of 3 memories");
  });

  it("says Remember now waits for a message edit open in its span, not for one past it", () => {
    pointer.coarse = true;
    // Six messages, the newest four kept out (the default): the span is the first two.
    chatStore.setState({
      messages: [
        user("u1", "Take me across before the fog lifts."),
        reply("r1", "The ferryman pushes off without a word."),
        user("u2", "What do I owe you?"),
        reply("r2", "A favour, he says, to be named later."),
        user("u3", "We reach the far bank."),
        reply("r3", "Mira steps onto the stones."),
      ],
      editing: { id: "r1", text: "The ferryman pushes off at last.", target: "text" },
    });
    const waits = "Save or cancel the message edit in Chat first.";
    expect(screen({ state: ON, episodes: [] })).toContain(waits);
    chatStore.setState({ editing: { id: "r3", text: "Mira steps ashore.", target: "text" } });
    expect(screen({ state: ON, episodes: [] })).not.toContain(waits);
  });

  it("goes back to the character's sheet, or to the chat when the chat's mark opened it", () => {
    const book: CharacterMemory = { state: ON, episodes: [] };
    const fromSheet = render(<MemoryBook id={CHARACTER} name="Mira" memory={book} />, book);
    expect(fromSheet).toMatch(/<a href="\/characters\/\$id"[^>]*>.*Mira<\/span><\/a>/);
    expect(fromSheet).not.toContain("Back to chat");
    const fromChat = render(
      <MemoryBook id={CHARACTER} name="Mira" memory={book} from="chat" />,
      book,
    );
    expect(fromChat).toMatch(/<a href="\/" aria-label="Back to chat"[^>]*>.*Chat<\/a>/);
    expect(fromChat).not.toContain('href="/characters/$id"');
  });
});

describe("a conflict's Reload", () => {
  const book: CharacterMemory = { state: ON, episodes: [EPISODE] };
  const client = () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
    queryClient.setQueryData(MEMORY_KEY(CHARACTER), { state: null, episodes: [] });
    return queryClient;
  };

  it("fails when the memory could not be fetched, so the unsaved fields stay", async () => {
    vi.stubGlobal("fetch", async () => Promise.reject(new TypeError("offline")));
    try {
      const queryClient = client();
      expect(await reloadMemory(queryClient, CHARACTER)).toEqual({ isSuccess: false });
      expect(queryClient.getQueryData(MEMORY_KEY(CHARACTER))).toEqual({
        state: null,
        episodes: [],
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("succeeds once the saved memory is in", async () => {
    vi.stubGlobal("fetch", async () => Response.json(book));
    try {
      const queryClient = client();
      expect(await reloadMemory(queryClient, CHARACTER)).toEqual({ isSuccess: true });
      expect(queryClient.getQueryData(MEMORY_KEY(CHARACTER))).toEqual(book);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
