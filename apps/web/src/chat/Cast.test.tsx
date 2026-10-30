import {
  CAST_LIMITS,
  type CastEntry,
  type CastState,
  DEFAULT_SETTINGS,
  emptyCastAnchor,
  emptyCastState,
} from "@ephemera/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { charactersQuery } from "../characters/queries.ts";
import { settingsQuery } from "../settings/settings.ts";
import { CastPanel, EditRecord, RecordText } from "./Cast.tsx";
import { type ChatCast, EMPTY_CAST } from "./cast-slice.ts";
import { openCast, removeFromCast, undoCastRemoval, useCastSurface } from "./cast-ui.ts";
import { Presence } from "./Presence.tsx";
import { chatStore } from "./session.ts";
import type { ChatMessage } from "./store.ts";

// A bare chat store the tests fill; a static render reads it as it is now.
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
    { clock: () => ({ now: 0, timeZone: "UTC" }), fetchPreview: () => new Promise(() => {}) },
  );
  return {
    chatStore,
    useChat: <T,>(selector: (state: ReturnType<typeof chatStore.getState>) => T) =>
      selector(chatStore.getState()),
  };
});
// The surface's store read as it is now too: a server render would read its initial state.
vi.mock("zustand", async (original) => ({
  ...(await original<typeof import("zustand")>()),
  useStore: <S, T>(api: { getState: () => S }, selector?: (state: S) => T) =>
    selector === undefined ? api.getState() : selector(api.getState()),
}));
const motion = vi.hoisted(() => ({ reduced: false, factor: "desktop" }));
vi.mock("@/app/form-factor.ts", async (original) => ({
  ...(await original<typeof import("@/app/form-factor.ts")>()),
  useFormFactor: () => motion.factor,
  useCoarsePointer: () => false,
}));
vi.mock("@/app/reduced-motion.ts", () => ({
  useReducedMotion: () => motion.reduced,
  scrollBehavior: () => "instant",
}));

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function person(
  n: number,
  name: string,
  { gender = "female", age = "18", state = {}, present = true } = {} as {
    gender?: "female" | "male" | "other";
    age?: string;
    state?: Partial<CastState>;
    present?: boolean;
  },
): CastEntry {
  return {
    id: uuid(n),
    role: "principal",
    anchor: { ...emptyCastAnchor(name, gender), age },
    aka: [],
    state: { ...emptyCastState(present), ...state },
  };
}

const reply = (id: string, replyId: string): ChatMessage => ({
  id,
  role: "assistant",
  greeting: false,
  edited: false,
  shown: 0,
  replies: [{ id: replyId, text: "Hello.", reasoning: "", thoughtMs: null, status: "complete" }],
});

/** A chat whose one reply holds a snapshot of `entries`, with `cast` laid over. */
function chat(entries: CastEntry[], cast: Partial<ChatCast> = {}) {
  chatStore.setState({
    messages: [reply("m1", "r1")],
    cast: {
      ...EMPTY_CAST,
      snapshots: { r1: { register: { entries }, usage: null, at: 1 } },
      ...cast,
    },
  });
}

const panel = () => renderToStaticMarkup(<CastPanel placement="float" />);
const status = (out: string) => /data-cast-status=""[^>]*>([^<]*)</.exec(out)?.[1];
const entries = (out: string) =>
  [...out.matchAll(/data-cast-entry=""[\s\S]*?<span class="[^"]*">([^<]+)</g)].map((m) => m[1]);

beforeEach(() => {
  motion.reduced = false;
  motion.factor = "desktop";
  vi.useRealTimers();
});

describe("the roster", () => {
  it("shows effective ages and fields in roster, record and edit controls", () => {
    const mara = { ...person(1, "Mara"), developments: { age: "31", hair: "short silver hair" } };
    mara.anchor.hair = "long black hair";
    chat([mara]);
    expect(panel()).toContain("(31)</span>");
    const record = renderToStaticMarkup(<RecordText entry={mara} />);
    const edit = renderToStaticMarkup(<EditRecord entry={mara} onDone={() => {}} />);
    expect(record).toContain("short silver hair");
    expect(edit).toContain("short silver hair");
    expect(record + edit).not.toContain("long black hair");
  });
  it("lists women only, each with the age's first token and a clamped state line of mood and activity", () => {
    chat([
      person(1, "Mara Battin", {
        age: "18, looks younger",
        state: { activity: "scrolling her phone", mood: "nervous", outfit: "a hoodie" },
      }),
      person(2, "Jonas Reyes", { gender: "male", age: "34" }),
      person(3, "Kim", { gender: "other" }),
    ]);
    const out = panel();
    expect(entries(out)).toEqual(["Mara Battin"]);
    expect(out).toContain('<span class="font-normal text-reed"> (18)</span>');
    expect(out).toContain(">nervous, scrolling her phone</span>");
    // Cut at whole lines with an ellipsis, a line more in a roomy column.
    expect(out).toMatch(
      /class="[^"]*line-clamp-2 @chat-roomy\/chat:line-clamp-3[^"]*"[^>]*>nervous/,
    );
    expect(out).not.toContain("max-h-[2lh]");
    expect(out).not.toContain("a hoodie");
    expect(out).toMatch(/<ul aria-label="Cast"/);
    expect(out).toMatch(
      /data-cast-entry="" data-present="true" aria-haspopup="dialog" aria-expanded="false"/,
    );
    expect(out).toContain("touch:min-h-11");
  });

  it("shows five present, then the rest behind a disclosure, and the away by name or count", () => {
    const present = [1, 2, 3, 4, 5, 6, 7].map((n) => person(n, `Woman ${n}`));
    chat([
      ...present,
      person(8, "Ana Pires", { present: false, state: { position: "behind the bar" } }),
    ]);
    let out = panel();
    expect(out.split("<details").length - 1).toBe(2);
    expect(out).toMatch(/<summary[^>]*>and 2 more/);
    expect(out).toContain(">and Ana Pires away");
    expect(out).toContain(">last seen: behind the bar</span>");
    expect(out).toMatch(/data-present="false"/);

    chat([person(1, "Ana", { present: false }), person(2, "Bea", { present: false })]);
    out = panel();
    expect(out).toContain(">and 2 away");
    expect(out).not.toContain('aria-label="Cast"');
  });

  it("gives an age that leads with a number, and none for one in words", () => {
    chat([person(1, "Mara", { age: "late twenties" }), person(2, "Bea", { age: "31." })]);
    const out = panel();
    expect(out).not.toContain("(late)");
    expect(out).toMatch(/>Mara<\/span>/);
    expect(out).toContain('<span class="font-normal text-reed"> (31)</span>');
  });

  it("shows nothing with no woman in the register, a present man included", () => {
    chat([person(1, "Jonas Reyes", { gender: "male" })]);
    expect(panel()).toBe("");
  });

  it("keeps a narrow column to names and ages, the away as a count", () => {
    motion.factor = "tablet";
    chat([
      person(1, "Mara Battin", { state: { activity: "reading", mood: "calm" } }),
      person(2, "Ana Pires", { present: false }),
    ]);
    const out = panel();
    expect(entries(out)).toEqual(["Mara Battin", "Ana Pires"]);
    expect(out).not.toContain("reading, calm");
    expect(out).toMatch(/<summary[^>]*>1 away/);
  });

  it("leaves a quiet line with Undo where a removed entry was, until the next snapshot lands", () => {
    const mara = person(1, "Mara");
    const bea = person(2, "Bea");
    chat([mara, bea]);
    removeFromCast(mara);
    let out = panel();
    expect(entries(out)).toEqual(["Bea"]);
    expect(out).toMatch(/aria-live="polite"[^>]*>Mara removed\.<\/span>/);
    expect(out).toContain('aria-label="Undo removing Mara"');
    expect(out.indexOf("Mara removed.")).toBeLessThan(out.indexOf(">Bea<"));

    chatStore.setState((state) => ({
      messages: [...state.messages, reply("m2", "r2")],
      cast: {
        ...state.cast,
        snapshots: {
          ...state.cast.snapshots,
          r2: { register: { entries: [bea] }, usage: null, at: 2 },
        },
      },
    }));
    out = panel();
    expect(out).not.toContain("Mara removed.");
    expect(entries(out)).toEqual(["Bea"]);
  });

  it("stays mounted for the line when the last woman is removed, and Undo brings her back", () => {
    const mara = person(1, "Mara");
    chat([mara]);
    removeFromCast(mara);
    let out = panel();
    expect(out).toContain('data-cast=""');
    expect(out).toContain("Mara removed.");
    expect(out).not.toContain("data-cast-entry");
    undoCastRemoval();
    out = panel();
    expect(entries(out)).toEqual(["Mara"]);
    expect(out).not.toContain("removed.");
  });

  it("ends the line once the panel is used again", () => {
    const mara = person(1, "Mara");
    chat([mara, person(2, "Bea")]);
    removeFromCast(mara);
    openCast(null, null);
    expect(panel()).not.toContain("Mara removed.");
  });

  it("lets go of the whole surface on Clear, the control it hung from included", () => {
    chat([person(1, "Mara")]);
    openCast(
      "00000000-0000-4000-8000-000000000001",
      // A roster control of the old thread; the render has no DOM.
      {} as HTMLElement,
      "inline-end",
    );
    function Surface() {
      const [open, anchored, shown] = [
        useCastSurface((surface) => surface.open),
        useCastSurface((surface) => surface.anchor !== null),
        useCastSurface((surface) => surface.entryId),
      ];
      return <p>{`${open} ${anchored} ${shown}`}</p>;
    }
    expect(renderToStaticMarkup(<Surface />)).toContain("true true 00000000");
    chatStore.getState().clear();
    expect(renderToStaticMarkup(<Surface />)).toContain("false false null");
  });
});

describe("the status line", () => {
  const woman = [person(1, "Mara")];

  it("reads the card before anyone is known", () => {
    chatStore.setState({ messages: [], cast: { ...EMPTY_CAST, sheetStatus: "loading" } });
    const out = panel();
    expect(status(out)).toBe("Reading the card");
    expect(out).toContain('aria-live="polite"');
    expect(out).not.toContain("data-cast-entry");
  });

  it("says a failure in the interface's voice, with Try again", () => {
    chat(woman, { status: "failed", failure: "cast_failed", failures: 1 });
    chatStore.setState((state) => ({ messages: [...state.messages, reply("m2", "r2")] }));
    const out = panel();
    expect(status(out)).toBe("Cast couldn&#x27;t update.");
    expect(out).toContain('aria-label="Try again to update the cast"');
    chatStore.setState((state) => ({ cast: { ...state.cast, failures: 3 } }));
    expect(status(panel())).toBe("Showing the last known cast.");
    chatStore.setState((state) => ({
      cast: { ...state.cast, failure: "upstream_busy", failures: 1 },
    }));
    expect(status(panel())).toBe("Cast couldn&#x27;t update: the cast model is busy.");
  });

  it.each([
    ["complete", "length", "Partial"],
    ["complete", "content-filter", "Partial"],
    ["stopped", undefined, "Stopped"],
    ["failed", undefined, ""],
    ["streaming", undefined, "Streaming"],
  ] as const)(
    "hides a failed C1 behind %s/%s C2 until C1 is shown again",
    (ending, finishReason, text) => {
      chat(woman, { status: "failed", failure: "upstream_busy", failures: 1 });
      const message = reply("m2", "c1");
      if (message.role !== "assistant") throw new Error("assistant fixture");
      const c1 = message.replies[0];
      if (c1 === undefined) throw new Error("reply fixture");
      message.replies.push({
        ...c1,
        id: "c2",
        status: ending,
        text,
        ...(finishReason === undefined ? {} : { finishReason }),
      });
      message.shown = 1;
      chatStore.setState((state) => ({ messages: [...state.messages, message] }));
      const failure = chatStore.getState().cast;
      let out = panel();
      expect(status(out)).toBe(text === "" ? "" : "As of the previous reply");
      expect(out).not.toContain("Try again");
      expect(entries(out)).toEqual(["Mara"]);
      chatStore.setState((state) => ({
        messages: [...state.messages.slice(0, 1), { ...message, shown: 0 }],
      }));
      out = panel();
      expect(status(out)).toBe("Cast couldn&#x27;t update: the cast model is busy.");
      expect(out).toContain('aria-label="Try again to update the cast"');
      expect(chatStore.getState().cast).toBe(failure);
    },
  );

  it("hides the keeper failure while C1 is being continued behind covered B", () => {
    chat(woman, { status: "failed", failure: "cast_failed", failures: 1 });
    const message = reply("m2", "c1");
    if (message.role !== "assistant") throw new Error("assistant fixture");
    message.replies = message.replies.map((reply) => ({ ...reply, status: "streaming" }));
    chatStore.setState((state) => ({ messages: [...state.messages, message] }));
    expect(status(panel())).toBe("As of the previous reply");
    expect(panel()).not.toContain("Try again");
    expect(chatStore.getState().cast).toMatchObject({ status: "failed", failure: "cast_failed" });
  });

  it("keeps the sheet retry available during a first keeper with no entries", () => {
    chatStore.setState({
      messages: [reply("m1", "r1")],
      cast: {
        ...EMPTY_CAST,
        status: "updating",
        sheetStatus: "failed",
      },
    });
    const out = panel();
    expect(status(out)).toBe("Couldn&#x27;t read the cast from the card.");
    expect(out).toContain('aria-label="Try again to read the cast from the card"');
    expect(out).not.toContain('aria-label="Try again to update the cast"');
  });

  it("says the card could not be read when nobody is known yet, with its own Try again", () => {
    chatStore.setState({ messages: [], cast: { ...EMPTY_CAST, sheetStatus: "failed" } });
    const out = panel();
    expect(status(out)).toBe("Couldn&#x27;t read the cast from the card.");
    expect(out).toContain('aria-label="Try again to read the cast from the card"');
    expect(out).not.toContain('aria-label="Try again to update the cast"');
    // With someone known, the panel shows them and stays quiet about the sheet.
    chat(woman, { sheetStatus: "failed" });
    expect(status(panel())).toBe("");
  });

  it("keeps the sheet retry visible for uncovered B behind empty failed C", () => {
    const empty = reply("m2", "r2");
    if (empty.role === "assistant")
      empty.replies = [{ id: "r2", text: "", reasoning: "", thoughtMs: null, status: "failed" }];
    chatStore.setState({
      messages: [reply("m1", "r1"), empty],
      cast: { ...EMPTY_CAST, sheetStatus: "failed" },
    });
    const out = panel();
    expect(status(out)).toBe("Couldn&#x27;t read the cast from the card.");
    expect(out).toContain('aria-label="Try again to read the cast from the card"');
  });

  it.each(["length", "content-filter"] as const)(
    "keeps partial %s text visibly stale after older B has a snapshot",
    (finishReason) => {
      chat(woman);
      const partial = reply("m2", "r2");
      if (partial.role === "assistant")
        partial.replies = partial.replies.map((reply) => ({ ...reply, finishReason }));
      chatStore.setState((state) => ({ messages: [...state.messages, partial] }));
      const out = panel();
      expect(status(out)).toBe("As of the previous reply");
      expect(out).not.toContain("Try again");
    },
  );

  it("says the cast is as of the previous reply when the shown one has no snapshot", () => {
    chat(woman);
    chatStore.setState((state) => ({ messages: [...state.messages, reply("m2", "r2")] }));
    const out = panel();
    expect(status(out)).toBe("As of the previous reply");
    expect(out).not.toContain("Try again");
  });

  it("breathes a hairline while updating, and says Updating in still text under reduced motion", () => {
    chat(woman, { status: "updating" });
    let out = panel();
    expect(out).toContain("data-cast-breath");
    expect(out).toContain("animate-[breathe");
    expect(status(out)).toBe("");
    motion.reduced = true;
    out = panel();
    expect(out).not.toContain("data-cast-breath");
    expect(out).not.toContain("animate-[breathe");
    expect(status(out)).toBe("Updating");
  });
});

describe("a record", () => {
  const mara = person(1, "Mara Battin", {
    state: { outfit: "grey hoodie", activity: "reading" },
  });
  mara.anchor = {
    ...mara.anchor,
    ethnicity: "Portuguese",
    hair: "dark, shoulder-length",
    intimate: "C cup",
    personality: "shy, curious",
    fetishes: "fetishes: none",
  };

  const headings = (out: string) => [...out.matchAll(/<h3[^>]*>([^<]+)</g)].map((m) => m[1]);
  const labels = (out: string) => [...out.matchAll(/<dt[^>]*>([^<]+)</g)].map((m) => m[1]);

  it("reads in labelled sections, the state first with the activity as its lead, toned as before", () => {
    chat([mara]);
    const out = renderToStaticMarkup(<RecordText entry={mara} />);
    expect(headings(out)).toEqual(["Now", "Looks", "Character", "Intimate"]);
    expect(out).toMatch(/<span class="sr-only">Activity: <\/span><span data-cast-field="activity"/);
    expect(labels(out)).toEqual([
      "Outfit",
      "Ethnicity",
      "Hair",
      "Personality",
      "Intimate body",
      "Fetishes and taboos",
    ]);
    expect(out).toMatch(/<dt[^>]*>Ethnicity<\/dt><dd[^>]*><span data-cast-field="ethnicity"/);
    expect(out).toMatch(/data-cast-field="intimate"[^>]*data-tone="iris"/);
    expect(out).toMatch(/data-cast-field="fetishes"[^>]*data-tone="rose"/);
    expect(out).not.toContain('data-cast-field="age"');
    expect(out).not.toContain("Revert");
    expect(out).not.toContain("Last seen");
  });

  it("sets a short keyword list apart, each word its own highlight, and a phrase as written", () => {
    chat([mara]);
    const out = renderToStaticMarkup(<RecordText entry={mara} />);
    // A hidden comma between the words, so they read aloud and copy apart.
    expect(out).toMatch(
      /data-cast-field="personality"[^>]*><span data-tone="sage" class="tone-wash">shy<\/span><span data-tone="sage" class="tone-wash"><span class="sr-only">, <\/span>curious<\/span>/,
    );
    for (const personality of [
      "quiet until she trusts you",
      "shy, but warms up",
      "shy, curious, and loyal",
      "loyal, if guarded",
    ]) {
      const prose = { ...mara, anchor: { ...mara.anchor, personality } };
      chat([prose]);
      expect(renderToStaticMarkup(<RecordText entry={prose} />)).toContain(
        `data-cast-field="personality" data-tone="sage" class="tone-wash">${personality}<`,
      );
    }
  });

  it("keeps a keyword list's correction hairline and Revert on the field", () => {
    chat([mara], {
      corrections: { [mara.id]: { anchor: { personality: "shy, curious" }, state: {} } },
    });
    const out = renderToStaticMarkup(<RecordText entry={mara} />);
    expect(out).toMatch(/data-cast-field="personality" data-cast-corrected="" class="flex/);
    expect(out).toContain(">Revert personality</button>");
  });

  it("marks a corrected field with its hairline, and puts its Revert under its row", () => {
    chat([mara], {
      corrections: {
        [mara.id]: {
          anchor: { hair: "dark, shoulder-length" },
          state: { outfit: { value: "grey hoodie", version: 1 } },
        },
      },
    });
    const out = renderToStaticMarkup(<RecordText entry={mara} />);
    expect(out).toMatch(/data-cast-field="hair" data-cast-corrected=""/);
    expect(out).toMatch(
      /shoulder-length<\/span><div[^>]*><button[^>]*>Revert hair<\/button><\/div><\/dd>/,
    );
    expect(out).toMatch(
      /grey hoodie<\/span><div[^>]*><button[^>]*>Revert outfit<\/button><\/div><\/dd>/,
    );
  });

  it("keeps a corrected field cleared to nothing, so its Revert stays", () => {
    chat([mara], { corrections: { [mara.id]: { anchor: { ethnicity: "" }, state: {} } } });
    const cleared = { ...mara, anchor: { ...mara.anchor, ethnicity: "" } };
    const out = renderToStaticMarkup(<RecordText entry={cleared} />);
    expect(labels(out)).toContain("Ethnicity");
    expect(out).toContain(">Revert ethnicity</button>");
  });

  it("keeps a cleared, corrected activity as the lead with its Revert", () => {
    const cleared = { ...mara, state: { ...mara.state, activity: "" } };
    chat([cleared], {
      corrections: { [mara.id]: { anchor: {}, state: { activity: { value: "", version: 1 } } } },
    });
    const out = renderToStaticMarkup(<RecordText entry={cleared} />);
    expect(out).toMatch(
      /Activity: <\/span><span data-cast-field="activity" data-cast-corrected=""/,
    );
    expect(out).toContain(">Revert activity</button>");
  });

  it("shows only a minor entry's sections that hold something, an absent one as last seen", () => {
    const minor = person(2, "Waitress", { present: false, state: { position: "by the door" } });
    minor.anchor = { ...minor.anchor, ethnicity: "Thai" };
    chat([minor]);
    const out = renderToStaticMarkup(<RecordText entry={minor} />);
    expect(headings(out)).toEqual(["Last seen", "Looks"]);
    expect(labels(out)).toEqual(["Position", "Ethnicity"]);
  });

  it("says so when nothing past the name and age is recorded, and shows an age in words", () => {
    const bare = person(3, "Bea", { age: "late twenties" });
    chat([bare]);
    const out = renderToStaticMarkup(<RecordText entry={bare} />);
    expect(headings(out)).toEqual(["Looks"]);
    expect(labels(out)).toEqual(["Age"]);
    const nothing = person(4, "Cleo");
    chat([nothing]);
    expect(renderToStaticMarkup(<RecordText entry={nothing} />)).toContain(
      "No other details recorded yet.",
    );
  });

  it("washes the fields the newest snapshot changed as it lands, and not once remounted after", () => {
    const at = Date.UTC(2026, 9, 25, 12);
    const before = person(1, "Mara Battin", { state: { activity: "reading" } });
    const after = person(1, "Mara Battin", { state: { activity: "dancing" } });
    chatStore.setState({
      messages: [
        reply("m1", "r1"),
        { id: "u1", role: "user", text: "Hi", personaId: null, sentAt: 0 },
        reply("m2", "r2"),
      ],
      cast: {
        ...EMPTY_CAST,
        snapshots: {
          r1: { register: { entries: [before] }, usage: null, at: at - 60_000 },
          r2: { register: { entries: [after] }, usage: null, at },
        },
      },
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at + 100);
    const fresh = renderToStaticMarkup(<RecordText entry={after} />);
    expect(fresh).toMatch(/data-cast-field="activity" data-cast-changed=""/);
    expect(fresh).not.toMatch(/data-cast-field="outfit" data-cast-changed/);
    expect(panel()).toMatch(/data-cast-changed=""[^>]*>dancing</);
    // Mounted again later (Presence moved to the next reply): the wash has run, so none.
    vi.setSystemTime(at + 5_000);
    expect(renderToStaticMarkup(<RecordText entry={after} />)).not.toContain("data-cast-changed");
    expect(panel()).not.toContain("data-cast-changed");
  });

  it("edits the fields under the reading mode's sections, in its order", () => {
    const out = renderToStaticMarkup(<EditRecord entry={mara} onDone={() => {}} />);
    expect([...out.matchAll(/<legend[^>]*>([^<]+)</g)].map((m) => m[1])).toEqual([
      "Now",
      "Looks",
      "Character",
      "Intimate",
    ]);
    expect(out.indexOf('data-cast-field="activity"')).toBeLessThan(
      out.indexOf('data-cast-field="mood"'),
    );
    expect(out).toMatch(/<textarea[^>]*class="cast-field/);
  });

  it("holds every field to the register's length bound", () => {
    const out = renderToStaticMarkup(<EditRecord entry={mara} onDone={() => {}} />);
    const textareas = [...out.matchAll(/<textarea[^>]*>/g)].map((m) => m[0]);
    expect(textareas.length).toBeGreaterThan(0);
    for (const textarea of textareas) {
      expect(textarea).toContain(`maxLength="${CAST_LIMITS.field}"`);
    }
  });

  it("edits every field under a visible label, empty ones included, with help, Save and Cancel", () => {
    const out = renderToStaticMarkup(<EditRecord entry={mara} onDone={() => {}} />);
    expect(out.split("<textarea").length - 1).toBe(21);
    expect(out).toContain('<span class="font-sans text-meta text-reed">Skin</span>');
    expect(out).toMatch(/<textarea[^>]*data-cast-field="skin"/);
    expect(out).toContain(
      "Looks and character hold for this chat. Current state yields to the next update.",
    );
    expect(out).toContain(">Save</button>");
    expect(out).toContain(">Cancel</button>");
    expect(out).not.toContain("Updated behind this edit");
  });
});

describe("Presence and the cast", () => {
  function withCharacter(node: ReactNode, characterId: string | null) {
    const client = new QueryClient();
    client.setQueryData(settingsQuery.queryKey, {
      ...DEFAULT_SETTINGS,
      characterId,
      comfyuiBaseUrl: "",
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

  it("builds the float for the roster without a portrait", () => {
    chat([person(1, "Mara")]);
    const out = withCharacter(<Presence placement="float" />, "ava");
    expect(out).toContain("data-presence");
    expect(out).toContain("data-cast");
  });

  it("shows nothing in the float with neither a portrait nor anyone to list", () => {
    chat([person(1, "Jonas", { gender: "male" })]);
    expect(withCharacter(<Presence placement="float" />, "ava")).toBe("");
  });

  it("shows nothing without a character, whatever the register holds", () => {
    chat([person(1, "Mara")]);
    expect(withCharacter(<Presence placement="float" />, null)).toBe("");
    expect(withCharacter(<Presence placement="band" />, null)).toBe("");
  });

  it("lays the band's roster under the name", () => {
    chat([person(1, "Mara")]);
    const out = withCharacter(<Presence placement="band" />, "ava");
    expect(out.indexOf(">Ava</p>")).toBeLessThan(out.indexOf("data-cast"));
    expect(out).toContain("flex-wrap");
  });
});
