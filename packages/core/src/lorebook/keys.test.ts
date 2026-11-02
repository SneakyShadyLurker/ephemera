import { describe, expect, it } from "vitest";
import { CPU_BOUND_TEST_TIMEOUT_MS, cpuMs } from "../../test-fixtures/cpu.ts";
import type { LorebookEntry } from "../card/schema.ts";
import { keyProblem, splitKeywords } from "./keys.ts";
import { type ActivationInput, activateLorebook } from "./test-support.ts";

describe("keyword splitting", () => {
  it.each<[string, string[]]>([
    ["", []],
    [",, alpha, beta,,", ["alpha", "beta"]],
    ["/ab{1,3}/i, harbour", ["/ab{1,3}/i", "harbour"]],
    ["/a,\n b/s, tide", ["/a,\n b/s", "tide"]],
    ["/a/q, tide", ["/a/q", "tide"]],
    ["/a/ G,c", ["/a/ G,c"]],
    ["/a/ i,c", ["/a/ i,c"]],
    ["/a/ \t,c", ["/a/", "c"]],
    ["//,next", ["//,next"]],
    ["///,next", ["///", "next"]],
    ["/a\\/b/i,c", ["/a\\/b/i", "c"]],
    ["/, alpha, beta", ["/, alpha, beta"]],
    ["/a/U, b/,c", ["/a/U, b/", "c"]],
    ["\uFEFF /x/, \u00a0term \uFEFF", ["/x/", "term"]],
  ])("preserves comma, slash and trimming behavior for %j", (text, expected) => {
    expect(splitKeywords(text)).toEqual(expected);
  });

  it(
    "splits a long incomplete slash key without repeatedly scanning its prefix",
    () => {
      const text = `/${",".repeat(100_000)}`;
      const { result, ms } = cpuMs(() => splitKeywords(text));
      expect(result).toEqual([text]);
      expect(splitKeywords(`${text}/i, tide`)).toEqual([`${text}/i`, "tide"]);
      expect(ms).toBeLessThan(1_000);
    },
    CPU_BOUND_TEST_TIMEOUT_MS,
  );
});

const entry = (overrides: Partial<LorebookEntry> = {}): LorebookEntry => ({
  keys: [],
  content: "Lore.",

  enabled: true,
  insertionOrder: 100,
  useRegex: false,
  ...overrides,
});

type Turn = ActivationInput["turns"][number];
const user = (content: string): Turn => ({ role: "user", content });
const char = (content: string): Turn => ({ role: "assistant", content });

/** Activates one entry against `turns` and returns its report line and the key problems. */
function scan(overrides: Partial<LorebookEntry>, turns: Turn[], scanDepth = turns.length) {
  const { report } = activateLorebook({
    book: { entries: [entry(overrides)] },
    turns,
    names: { char: "Mara", user: "Aria" },
    macros: (text) => text,
    count: (text) => text.length,
    budget: 10_000,
    scanDepth,
    blocks: { before: true, after: true, examples: true, authorsNote: true },
    random: () => 0,
  });
  const line = report.entries[0];
  return {
    status: line?.status,
    reason: line?.reason,
    problems: report.keyProblems,
  };
}

const matched = (keys: string[], turns: Turn[], overrides: Partial<LorebookEntry> = {}) => {
  const { reason } = scan({ keys, ...overrides }, turns);
  return reason?.kind === "key" ? reason.matched : null;
};

describe("plain keys", () => {
  it("match case-insensitively unless the entry is case-sensitive", () => {
    expect(matched(["KING"], [user("Long live the king")])).toBe("king");
    expect(
      matched(["KING"], [user("Long live the king")], { settings: { caseSensitive: true } }),
    ).toBeNull();
    expect(matched(["King"], [user("the King rides")], { settings: { caseSensitive: true } })).toBe(
      "King",
    );
  });

  it("match whole words by segmenter boundaries", () => {
    expect(matched(["king"], [user("long live the king")])).toBe("king");
    expect(matched(["king"], [user("I am liking this")])).toBeNull();
    expect(matched(["東京"], [user("東京に行く")])).toBe("東京");
    expect(matched(["#hello"], [user("say #hello there")])).toBe("#hello");
  });

  it("match phrases anywhere, keeping the chat's casing", () => {
    expect(matched(["iron crown"], [user("the IRON CROWNS gleam")])).toBe("IRON CROWN");
  });

  it("never span two messages", () => {
    expect(matched(["the king"], [user("long live the"), char("king of all")])).toBeNull();
  });

  it("include speaker names, so a name key matches that speaker's messages", () => {
    expect(matched(["mara"], [char("I nod.")])).toBe("Mara");
    expect(matched(["Aria"], [user("hello")])).toBe("Aria");
  });

  it("ignore blank keys and try each key in order", () => {
    const { reason } = scan({ keys: ["", "  ", "moon", "sun"] }, [user("sun and moon")]);
    expect(reason).toEqual({ kind: "key", key: "moon", matched: "moon" });
    expect(scan({ keys: ["", " "] }, [user("anything")]).status).toBe("notMatched");
  });
});

describe("pattern keys", () => {
  it("run /pattern/flags keys", () => {
    expect(matched(["/bells? (?:toll|ring)s?/i"], [user("The Bells Toll at dusk")])).toBe(
      "Bells Toll",
    );
    expect(matched(["/bells? (?:toll|ring)s?/"], [user("The Bells Toll")])).toBeNull();
    expect(matched(["/^tide$/m"], [user("low\ntide\nnow")])).toBe("tide");
    expect(matched(["/a.b/s"], [user("a\nb")])).toBe("a\nb");
    expect(matched(["/toll/giu"], [user("TOLL")])).toBe("TOLL");
  });

  it("run whole keys as patterns with useRegex, ignoring caseSensitive", () => {
    expect(matched(["bel+s"], [user("bells")], { useRegex: true })).toBe("bells");
    expect(matched(["BELLS"], [user("bells")], { useRegex: true })).toBeNull();
    expect(matched(["/BELLS/i"], [user("bells")], { useRegex: true })).toBe("bells");
  });

  it("never match invalid, lookaround or backreference patterns, and report them", () => {
    const turns = [user("aa xb yes")];
    const found = scan({ keys: ["/(?<=x)b/", "/(a)\\1/", "/yes/q", "/[a/", "/a{101}/"] }, turns);
    expect(found.status).toBe("notMatched");
    expect(found.problems).toEqual([
      { index: 0, key: "/(?<=x)b/", problem: "unsupportedPattern" },
      { index: 0, key: "/(a)\\1/", problem: "unsupportedPattern" },
      { index: 0, key: "/[a/", problem: "invalidPattern" },
      { index: 0, key: "/a{101}/", problem: "repeatTooLarge" },
    ]);
  });

  it("finish hostile patterns in linear time with the right answer", () => {
    const started = performance.now();
    expect(matched(["/(a+)+$/"], [user(`${"a".repeat(50_000)}!`)])).toBeNull();
    expect(matched(["/(a+)+!$/"], [user(`${"a".repeat(50_000)}!`)])).not.toBeNull();
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe("keyProblem", () => {
  it("classifies keys for the editor", () => {
    expect(keyProblem("tide", false)).toBeNull();
    expect(keyProblem("(?=x)", false)).toBeNull();
    expect(keyProblem("/tide/i", false)).toBeNull();
    expect(keyProblem("ti(de", true)).toBe("invalidPattern");
    expect(keyProblem("/(?=x)y/", false)).toBe("unsupportedPattern");
    expect(keyProblem("/(?<!x)y/", false)).toBe("unsupportedPattern");
    expect(keyProblem("(a)\\1", true)).toBe("unsupportedPattern");
    expect(keyProblem("/a{2,500}/", false)).toBe("repeatTooLarge");
    expect(keyProblem("/a{100}/", false)).toBeNull();
    expect(keyProblem("/a/x", false)).toBeNull();
  });
});

describe("review fixes", () => {
  it("match a single-word key before a possessive or other punctuation, not inside a word", () => {
    expect(scan({ keys: ["maren"] }, [user("I took Maren's sword.")]).status).toBe("sent");
    expect(scan({ keys: ["king"] }, [user("the king’s crown")]).status).toBe("sent");
    expect(scan({ keys: ["king"] }, [user("a liking for crowns")]).status).toBe("notMatched");
    expect(scan({ keys: ["東京"] }, [user("東京に行く")]).status).toBe("sent");
  });

  it("read a slash key whose flags are not JavaScript's as plain text", () => {
    expect(keyProblem("/r/rpg", false)).toBeNull();
    expect(keyProblem("/usr/bin", false)).toBeNull();
    expect(scan({ keys: ["/r/rpg"] }, [user("posted on /r/rpg today")]).status).toBe("sent");
    expect(scan({ keys: ["/r/rpg"] }, [user("r")]).status).toBe("notMatched");
  });

  it("run JavaScript unicode escapes in patterns", () => {
    expect(keyProblem("/\\u0041/", false)).toBeNull();
    expect(scan({ keys: ["/\\u0041b/"] }, [user("xAb")]).status).toBe("sent");
    expect(scan({ keys: ["/\\u{1F600}/"] }, [user("hi 😀")]).status).toBe("sent");
  });
});
