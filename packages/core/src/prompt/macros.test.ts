import { describe, expect, it } from "vitest";
import { normalizeMacroAliases } from "../imports/aliases.ts";
import {
  cloneMacroState,
  emptyMacroState,
  MACRO_STATE_LIMITS,
  macroStateSchema,
} from "./macro-state.ts";
import {
  humanizeIdleDuration,
  isTimeZone,
  MAX_DATE_FORMAT,
  MAX_MACRO_NESTING,
  type MacroContext,
  MacroLimitError,
  type MacroWorkBudget,
  substituteMacros,
} from "./macros.ts";

/** 2026-09-29T19:42:00Z: 21:42 in Berlin, 03:42 the next day in Tokyo. */
const NOW = Date.UTC(2026, 8, 29, 19, 42);

function context(overrides: Partial<MacroContext> = {}): MacroContext {
  return {
    char: "Mara",
    user: "Aria",
    description: "A captain.",
    personality: "Wry.",
    scenario: "A storm.",
    persona: "A clerk.",
    original: "",
    clock: { now: NOW, timeZone: "Europe/Berlin" },
    pickSeed: 0,
    random: () => 0,
    ...overrides,
  };
}

const run = (text: string, overrides: Partial<MacroContext> = {}) =>
  substituteMacros(text, context(overrides));

describe("macros", () => {
  it("fills names and card fields, case-insensitively", () => {
    expect(run("{{char}} and {{user}}; {{CHAR}} {{User}}")).toBe("Mara and Aria; Mara Aria");
    expect(run("{{description}} {{personality}} {{scenario}} {{persona}}")).toBe(
      "A captain. Wry. A storm. A clerk.",
    );
    expect(run("{{ char }}")).toBe("Mara");
  });

  it("gives the time and date in the browser's time zone", () => {
    expect(run("{{time}}, {{date}}")).toBe("9:42 PM, September 29, 2026");
    expect(run("{{time}}, {{date}}", { clock: { now: NOW, timeZone: "Asia/Tokyo" } })).toBe(
      "4:42 AM, September 30, 2026",
    );
  });

  it("picks from a random list, with both separators and escaped commas", () => {
    expect(run("{{random:red,green,blue}}", { random: () => 0.5 })).toBe("green");
    expect(run("{{random::a, b::c}}", { random: () => 0 })).toBe("a, b");
    expect(run("{{random:one\\, two,three}}", { random: () => 0 })).toBe("one, two");
    expect(run("{{random:x,y}}", { random: () => 0.999 })).toBe("y");
  });

  it("rolls dice in XdY+Z form, a bare N meaning dN", () => {
    const high = { random: () => 0.999 };
    expect(run("{{roll:1d6}}", high)).toBe("6");
    expect(run("{{roll:2d6+3}}", high)).toBe("15");
    expect(run("{{roll::d20-1}}", { random: () => 0 })).toBe("0");
    expect(run("{{roll:20}}", high)).toBe("20");
    expect(run("{{roll 3d4}}", { random: () => 0 })).toBe("3");
  });

  it("leaves oversized or malformed rolls as written", () => {
    expect(run("{{roll:101d6}}")).toBe("{{roll:101d6}}");
    expect(run("{{roll:1d1000001}}")).toBe("{{roll:1d1000001}}");
    expect(run("{{roll:banana}}")).toBe("{{roll:banana}}");
  });

  it("resolves inner macros first", () => {
    expect(run("{{random::{{char}}::x}}", { random: () => 0 })).toBe("Mara");
  });

  it("removes comments, trims around {{trim}}, and writes newlines", () => {
    expect(run("a{{// a note for the author}}b")).toBe("ab");
    expect(run("line\n\n{{trim}}\n\nnext")).toBe("linenext");
    expect(run("a{{newline}}b{{newline::2}}c")).toBe("a\nb\n\nc");
    expect(run("a{{noop}}b")).toBe("ab");
  });

  it("inserts the replaced prompt with {{original}}", () => {
    expect(run("{{original}} Also: be brief.", { original: "Write the reply." })).toBe(
      "Write the reply. Also: be brief.",
    );
  });

  it("keeps unknown macros and unmatched braces as written", () => {
    expect(run("{{unknownMacro}} {{char")).toBe("{{unknownMacro}} {{char");
    expect(run("}} {{}}")).toBe("}} {{}}");
  });

  it("never interprets markup", () => {
    expect(run("<b>{{char}}</b>", { char: "<script>x</script>" })).toBe(
      "<b><script>x</script></b>",
    );
  });
});

describe("pick", () => {
  const options = "{{pick::a::b::c::d::e::f::g::h}}";

  it("chooses the same item every time for one seed and text", () => {
    const text = `${options} and ${options}`;
    const first = run(text, { pickSeed: 7 });
    for (let i = 0; i < 5; i += 1) expect(run(text, { pickSeed: 7 })).toBe(first);
    expect(first).toMatch(/^[a-h] and [a-h]$/);
    // It never draws on the re-rolling source {{random}} uses.
    expect(run(text, { pickSeed: 7, random: () => 0.999 })).toBe(first);
  });

  it("chooses afresh with another seed", () => {
    const chosen = new Set(
      Array.from({ length: 16 }, (_, seed) => run(options, { pickSeed: seed * 7_919 })),
    );
    expect(chosen.size).toBeGreaterThan(1);
  });

  it("depends on the macro's position in the text", () => {
    const text = Array.from({ length: 16 }, () => options).join(" ");
    expect(new Set(run(text, { pickSeed: 1 }).split(" ")).size).toBeGreaterThan(1);
    // The same macro later in a longer text is its own choice.
    const alone = new Set(
      Array.from({ length: 16 }, (_, pad) => run(`${" ".repeat(pad)}${options}`, { pickSeed: 1 })),
    );
    expect(alone.size).toBeGreaterThan(1);
  });

  it("depends on the text it is in", () => {
    const chosen = new Set(
      Array.from({ length: 16 }, (_, i) => run(`${i}${options}`, { pickSeed: 1 }).slice(-1)),
    );
    expect(chosen.size).toBeGreaterThan(1);
  });

  it("takes both argument forms, and escaped commas", () => {
    for (let seed = 0; seed < 8; seed += 1) {
      expect(["red", "green", "blue"]).toContain(
        run("{{pick:red,green,blue}}", { pickSeed: seed }),
      );
      expect(["one, two", "three"]).toContain(run("{{pick:one\\, two,three}}", { pickSeed: seed }));
      expect(["a, b", "c"]).toContain(run("{{pick::a, b::c}}", { pickSeed: seed }));
      expect(["x y", "z"]).toContain(run("{{pick x y,z}}", { pickSeed: seed }));
    }
    expect(run("{{pick::only}}")).toBe("only");
    expect(run("{{pick}}")).toBe("{{pick}}");
  });

  it("fills macros inside its options", () => {
    const seen = new Set(
      Array.from({ length: 16 }, (_, seed) =>
        run("{{pick::{{char}}::{{user}}}}", { pickSeed: seed }),
      ),
    );
    expect(seen).toEqual(new Set(["Mara", "Aria"]));
  });
});

describe("date macros", () => {
  const berlin = { clock: { now: NOW, timeZone: "Europe/Berlin" } };
  const tokyo = { clock: { now: NOW, timeZone: "Asia/Tokyo" } };
  const newYork = { clock: { now: NOW, timeZone: "America/New_York" } };

  it("gives the weekday, ISO time and ISO date in the clock's zone", () => {
    expect(run("{{weekday}} {{isodate}} {{isotime}}", berlin)).toBe("Tuesday 2026-09-29 21:42");
    expect(run("{{weekday}} {{isodate}} {{isotime}}", tokyo)).toBe("Wednesday 2026-09-30 04:42");
    expect(run("{{WeekDay}} {{ISOTIME}}", newYork)).toBe("Tuesday 15:42");
    expect(
      run("{{isotime}}", { clock: { now: Date.UTC(2026, 0, 1, 0, 5), timeZone: "UTC" } }),
    ).toBe("00:05");
  });

  it("formats with moment-style tokens, in both forms", () => {
    expect(run("{{datetimeformat::YYYY-MM-DD HH:mm:ss}}", berlin)).toBe("2026-09-29 21:42:00");
    expect(run("{{datetimeformat DD.MM.YYYY HH:mm}}", tokyo)).toBe("30.09.2026 04:42");
    expect(run("{{datetimeformat::dddd, MMMM D, YYYY h:mm A}}", newYork)).toBe(
      "Tuesday, September 29, 2026 3:42 PM",
    );
    // Brackets escape text; tokens outside dayjs's core set stay literal.
    expect(run("{{datetimeformat::[Year] YYYY, [day] DD, Q}}", berlin)).toBe(
      "Year 2026, day 29, Q",
    );
    expect(run("{{datetimeformat::Z}}", tokyo)).toBe("+09:00");
  });

  it("keeps a format past its bound as written", () => {
    const fits = "Y".repeat(MAX_DATE_FORMAT);
    expect(run(`{{datetimeformat::${fits}}}`)).not.toContain("{{");
    const long = `{{datetimeformat::${"Y".repeat(MAX_DATE_FORMAT + 1)}}}`;
    expect(run(long)).toBe(long);
  });

  it("treats hostile formats as text", () => {
    expect(run("{{datetimeformat::<b>HH</b>}}", berlin)).toBe("<b>21</b>");
    expect(run("{{datetimeformat::[}}", berlin)).toBe("[");
    // Inner macros resolve first; their text is then a format like any other.
    expect(run("{{datetimeformat::[{{char}}] HH}}", berlin)).toBe("Mara 21");
    const started = performance.now();
    run(`{{datetimeformat::${"[".repeat(MAX_DATE_FORMAT)}}}`.repeat(1_000));
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("time zones", () => {
  it("accepts IANA zones and refuses anything else", () => {
    expect(isTimeZone("Europe/Berlin")).toBe(true);
    expect(isTimeZone("UTC")).toBe(true);
    expect(isTimeZone("Mars/Olympus")).toBe(false);
    expect(isTimeZone("")).toBe(false);
  });
});

describe("hostile text", () => {
  it("survives deep nesting and long unmatched braces quickly", () => {
    const deep = `${"{{".repeat(50_000)}char${"}}".repeat(50_000)}`;
    const started = performance.now();
    expect(run(deep).length).toBeGreaterThan(0);
    expect(run("{{".repeat(100_000))).toBe("{{".repeat(100_000));
    expect(run(`${"x}}".repeat(50_000)}{{char}}`)).toBe(`${"x}}".repeat(50_000)}Mara`);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("expansion bounds", () => {
  it("refuses text that would expand past the limit, however it is built", () => {
    const description = "d".repeat(256 * 1024);
    expect(() => run("{{description}}".repeat(400), { description })).toThrow(MacroLimitError);
    expect(run("{{description}}".repeat(3), { description })).toHaveLength(3 * 256 * 1024);
  });

  it("trims long runs of newlines in linear time", () => {
    const started = performance.now();
    const text = `${"\n".repeat(160_000)}x${"{{trim}}".repeat(20)}`;
    expect(run(text)).toBe(`${"\n".repeat(160_000)}x`);
    expect(run(`${"\n".repeat(160_000)}{{trim}}x`)).toBe("x");
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe("output limit", () => {
  it("throws past a smaller limit and keeps the default otherwise", () => {
    expect(() => substituteMacros("{{char}}{{char}}", context(), 6)).toThrow(MacroLimitError);
    expect(substituteMacros("{{char}}", context(), 4)).toBe("Mara");
    expect(() => substituteMacros("abcdefgh", context(), 7)).toThrow(MacroLimitError);
    expect(substituteMacros("{{char}}{{char}}", context())).toBe("MaraMara");
  });
});

describe("memory-only macro variables", () => {
  it("accounts for the current state and expansion without caching external mutations", () => {
    const state = emptyMacroState();
    state.local.kept = "old";
    let expansion = 0;
    const workBudget: MacroWorkBudget = (units) => {
      expansion += units;
    };
    expect(run("{{setvar::new::value}}{{getvar::new}}", { state, workBudget })).toBe("value");
    expect(run("{{deletevar::kept}}{{getvar::new}}", { state, workBudget })).toBe("value");
    state.global.external = "added";
    expect(run("{{char}}/\\{\\{char}}/{{unknown}}", { state, workBudget })).toBe(
      "Mara/{{char}}/{{unknown}}",
    );
    expect(expansion).toBeGreaterThan(0);
    state.global.external = "x".repeat(MACRO_STATE_LIMITS.value + 1);
    expect(() => run("plain", { state, workBudget })).toThrow(MacroLimitError);
  });

  it("resynchronizes variable limits after a nested field evaluation", () => {
    const state = emptyMacroState();
    for (let index = 0; index < MACRO_STATE_LIMITS.variables - 1; index += 1)
      state.local[`key${index}`] = "value";
    const value = context({
      state,
      resolveCardField() {
        return substituteMacros("{{setvar::last::value}}", context({ state }));
      },
    });
    expect(() => substituteMacros("{{description}}{{setvar::extra::value}}", value)).toThrow(
      MacroLimitError,
    );
    expect(state.local.last).toBe("value");
    expect(state.local.extra).toBeUndefined();
  });

  it("shares an explicit working state across substitutions but isolates omitted state", () => {
    const state = emptyMacroState();
    expect(run("{{setvar::style::quiet}}{{getvar::style}}", { state })).toBe("quiet");
    expect(run("{{getvar style}}", { state })).toBe("quiet");
    expect(run("{{getvar style}}")).toBe("");
    const copy = cloneMacroState(state);
    run("{{setvar::style::bright}}", { state: copy });
    expect(state.local.style).toBe("quiet");
    expect(copy.local.style).toBe("bright");
    expect(Object.getPrototypeOf(copy.local)).toBeNull();
  });

  it("supports all local/global variable functions without crossing namespaces", () => {
    const state = emptyMacroState();
    expect(
      run(
        "{{setvar::count::2}}{{setglobalvar::count::10}}{{incvar count}}/{{decglobalvar count}}",
        { state },
      ),
    ).toBe("3/9");
    expect(
      run(
        "{{addvar::count::5}}{{addglobalvar::count::tail}}{{getvar::count}}/{{getglobalvar::count}}",
        { state },
      ),
    ).toBe("8/9tail");
    expect(
      run(
        "{{hasvar::count}}/{{hasglobalvar::count}}{{deletevar::count}}{{deleteglobalvar::count}}/{{hasvar::count}}/{{hasglobalvar::count}}",
        { state },
      ),
    ).toBe("true/true/false/false");
    expect(run("{{incvar fresh}}/{{decglobalvar fresh}}", { state })).toBe("1/-1");
  });

  it("resolves spaced separators and nested names/values before storing them", () => {
    expect(
      run(
        "{{ setvar :: {{user}}-mood :: Hello, {{ char }}! }}[{{ getvar :: {{ user }}-mood }}] {{reverse {{getvar {{user}}-mood}}}}",
      ),
    ).toBe("[Hello, Mara!] !araM ,olleH");
    expect(run('{{setvar::object::{"port":"north"} }}{{getvar::object}}')).toBe('{"port":"north"}');
    expect(
      run("{{setvar::value::{{description}}}}{{getvar::value}}", { description: "a::b" }),
    ).toBe("a::b");
  });

  it("does not read inherited properties, stores hostile own names and never __proto__", () => {
    const state = { local: {}, global: {} };
    expect(run("{{getvar::constructor}}/{{hasvar::__proto__}}", { state })).toBe("/false");
    expect(
      run(
        "{{setvar::__proto__::safe}}{{setglobalvar::constructor::own}}{{getvar::__proto__}}/{{getglobalvar::constructor}}",
        { state },
      ),
    ).toBe("/own");
    expect(Object.getPrototypeOf(state.local)).toBe(Object.prototype);
    expect(Object.hasOwn(state.local, "__proto__")).toBe(false);
    const copy = cloneMacroState(state);
    expect(Object.getOwnPropertyDescriptor(copy.global, "constructor")?.value).toBe("own");
    expect(Object.getPrototypeOf(copy.local)).toBeNull();
    // The state crosses the wire as JSON: a reserved name is refused, not silently dropped.
    const wire = JSON.parse('{"local":{"__proto__":"x","normal":"ok"},"global":{}}');
    expect(macroStateSchema.safeParse(wire).success).toBe(false);
  });

  it("validates the whole DTO and bounds both namespaces together", () => {
    const state = emptyMacroState();
    expect(macroStateSchema.safeParse(state).success).toBe(true);
    expect(macroStateSchema.safeParse({ ...state, persisted: true }).success).toBe(false);
    expect(macroStateSchema.safeParse({ local: { bad: 1 }, global: {} }).success).toBe(false);
    // Names and values count UTF-16 units, as the evaluator's writes do.
    const wide = "😀".repeat(MACRO_STATE_LIMITS.name / 2 + 1);
    expect(macroStateSchema.safeParse({ local: { [wide]: "x" }, global: {} }).success).toBe(false);
    const value = "x".repeat(MACRO_STATE_LIMITS.value);
    state.local.first = value;
    state.local.second = value;
    state.global.third = value;
    expect(macroStateSchema.safeParse(state).success).toBe(true);
    state.global.fourth = value;
    expect(macroStateSchema.safeParse(state).success).toBe(false);
    expect(() => run("{{getvar::first}}", { state })).toThrow(MacroLimitError);
  });

  it("bounds repeated append, the number of keys, and key length", () => {
    const state = emptyMacroState();
    run("{{setvar::buffer::{{description}}}}", {
      state,
      description: "x".repeat(MACRO_STATE_LIMITS.value),
    });
    expect(() => run("{{addvar::buffer::x}}", { state })).toThrow(MacroLimitError);
    expect(state.local.buffer).toHaveLength(MACRO_STATE_LIMITS.value);
    expect(() => run(`{{setvar::${"x".repeat(MACRO_STATE_LIMITS.name + 1)}::v}}`)).toThrow(
      MacroLimitError,
    );
    const many = Array.from(
      { length: MACRO_STATE_LIMITS.variables + 1 },
      (_, index) => `{{setvar::key-${index}::v}}`,
    ).join("");
    expect(() => run(many)).toThrow(MacroLimitError);
  });
});

describe("scoped and conditional macros", () => {
  it("trims and dedents scoped content, preserving it exactly with #", () => {
    expect(run("{{setvar note}}\n    First\n      {{user}}\n{{/setvar}}[{{getvar note}}]")).toBe(
      "[First\n  Aria]",
    );
    expect(run("{{#setvar note}}\n  left | right  \n{{/setvar}}[{{getvar note}}]")).toBe(
      "[\n  left | right  \n]",
    );
    expect(run("{{ reverse }}\n  Hello {{user}}\n{{ / reverse }}")).toBe("airA olleH");
  });

  it("matches observed scoped comment removal, including nested variable effects", () => {
    expect(run("A{{ // }}\nHidden {{setvar::flag::set}} text.\n{{ /// }}B={{getvar::flag}}")).toBe(
      "AB=set",
    );
    expect(run("{{// hidden {{incvar::count}}}}{{getvar::count}}")).toBe("1");
  });

  it("executes only the selected if/else branch", () => {
    const state = emptyMacroState();
    expect(
      run(
        "{{setvar::probe::untouched}}{{if false}}{{setvar::probe::bad}}BAD{{else}}ELSE{{/if}}/{{if true}}THEN{{else}}{{setvar::probe::bad}}BAD{{/if}}/{{getvar::probe}}",
        { state },
      ),
    ).toBe("ELSE/THEN/untouched");
    expect(run("{{if false}}{{incvar::hidden}}{{/if}}{{hasvar::hidden}}", { state })).toBe("false");
  });

  it.each([
    ["", "F"],
    ["false", "F"],
    ["0", "F"],
    ["off", "F"],
    ["no", "T"],
    ["yes", "T"],
  ])("uses ST 1.19.0's observed truthiness for %j", (value, expected) => {
    expect(
      run("{{if {{getvar::flag}}}}T{{else}}F{{/if}}", {
        state: { local: { flag: value }, global: {} },
      }),
    ).toBe(expected);
  });

  it("supports field conditions, inversion, variable conditions and nested if/else", () => {
    expect(run("{{if personality}}P{{else}}E{{/if}}/{{if !scenario}}E{{else}}S{{/if}}")).toBe(
      "P/S",
    );
    expect(
      run("{{.flag = false}}{{if !.flag}}{{if true}}INNER{{else}}BAD{{/if}}{{else}}BAD{{/if}}"),
    ).toBe("INNER");
  });

  it("bounds scoped nesting without executing deeper side effects", () => {
    const state = emptyMacroState();
    const source = `${"{{if true}}".repeat(MAX_MACRO_NESTING + 2)}{{setvar::hidden::bad}}${"{{/if}}".repeat(MAX_MACRO_NESTING + 2)}`;
    expect(run(source, { state })).toContain("{{setvar::hidden::bad}}");
    expect(Object.hasOwn(state.local, "hidden")).toBe(false);
  });

  it("bounds intermediate work when comments repeatedly discard large expansions", () => {
    expect(() =>
      run("{{// {{description}}}}".repeat(180), { description: "x".repeat(256 * 1024) }),
    ).toThrow(MacroLimitError);
  });

  it("evaluates nested side effects once even inside an unknown macro", () => {
    expect(run("{{unknown::{{incvar::counter}}}}/{{getvar::counter}}")).toBe("{{unknown::1}}/1");
    expect(run("{{newline::{{incvar::counter}}::bad}}/{{getvar::counter}}")).toBe(
      "{{newline::1::bad}}/1",
    );
  });
});

describe("variable shorthands", () => {
  it("keeps fallback expressions lazy for both retrieval and assignment", () => {
    expect(
      run(
        "{{.name = kept}}{{.empty = }}{{.zero = 0}}{{.probe = 0}}{{.name || {{incvar::probe}}}}/{{.zero ?? {{incvar::probe}}}}/{{.name ||= {{incvar::probe}}}}/[{{.empty ??= {{incvar::probe}}}}]/{{.probe}}",
      ),
    ).toBe("kept/0/kept/[]/0");
    expect(
      run(
        "{{.zero = 0}}{{.zero || {{incvar::probe}}}}/{{.missing ?? {{incvar::probe}}}}/{{.new ??= Guest}}/{{.new}}/{{.probe}}",
      ),
    ).toBe("1/2/Guest/Guest/2");
  });

  it("supports arithmetic, concatenation, comparisons and the global prefix", () => {
    expect(
      run(
        "{{.count = 2}}{{.count++}}/{{.count--}}/{{.count += 3}}{{.count -= 1}}{{.count}}/{{.count == 4}}/{{.count != 3}}/{{.count > 3}}/{{.count >= 4}}/{{.count < 5}}/{{.count <= 4}}",
      ),
    ).toBe("3/2/4/true/true/true/true/true/true");
    expect(
      run("{{.text = hello}}{{.text += {{noop}} | world}}{{.text}}/{{$name ||= Global}}/{{$name}}"),
    ).toBe("hello | world/Global/Global");
    expect(run("{{.text = hello}}{{.text -= bad}}{{.text}}/{{.absent == }}")).toBe("hello/true");
  });
});

describe("participant, card and runtime macros", () => {
  it("substitutes legacy names and solo participant aliases", () => {
    expect(
      run(
        normalizeMacroAliases(
          "{{char}}/<CHAR>/<USER>/<GROUP>/<CHARIFNOTGROUP>/{{group}}/{{groupNotMuted}}/{{charIfNotGroup}}/{{notChar}}",
        ),
      ),
    ).toBe("Mara/Mara/Aria/Mara/Mara/Mara/Mara/Mara/Aria");
  });

  it("keeps injected card/name values as text instead of evaluating them again", () => {
    const state = emptyMacroState();
    const char = "{{setvar::hidden::bad}}";
    expect(run("{{char}}/{{char}}/{{hasvar::hidden}}", { char, state })).toBe(
      `${char}/${char}/false`,
    );
  });

  it("unescapes literal braces without evaluating the escaped macro", () => {
    expect(run("\\{\\{char\\}\\}/\\{\\{user}}/{{char}}")).toBe("{{char}}/{{user}}/Mara");
  });

  it("uses typed caller values for card metadata, greetings, history and limits", () => {
    expect(
      run(
        "{{characterSystemPrompt}}/{{postHistoryInstructions}}/{{characterNote}}/{{creatorNotes}}/{{characterVersion}}/{{firstMessage}}/{{firstMessage::1}}/{{lastMessage}}/{{lastMessageId}}/{{firstIncludedMessageId}}/{{maxPrompt}}/{{model}}/{{isMobile}}/{{lastGenerationType}}",
        {
          characterSystemPrompt: "Main",
          postHistoryInstructions: "Post",
          characterNote: "Depth",
          creatorNotes: "Notes",
          characterVersion: "v1",
          firstMessage: "Hello",
          alternateGreetings: ["Hi"],
          lastMessage: "Reply",
          lastMessageId: 3,
          maxPrompt: 1000,
          model: "probe",
          isMobile: true,
          lastGenerationType: "swipe",
        },
      ),
    ).toBe("Main/Post/Depth/Notes/v1/Hello/Hi/Reply/3//1000/probe/true/swipe");
  });

  it("provides safe empty defaults for unavailable summary/history and CC-only templates", () => {
    expect(
      run(
        "[{{summary}}][{{lastMessage}}][{{firstIncludedMessageId}}][{{currentSwipeId}}][{{instructUserPrefix}}]/{{hasExtension::Summarize}}/{{isMobile}}",
      ),
    ).toBe("[][][][][{{instructUserPrefix}}]/{{hasExtension::Summarize}}/false");
    expect(run("{{hasExtension::sample}}")).toBe("{{hasExtension::sample}}");
    expect(run("a{{space}}b{{space::2}}c{{space::101}}")).toBe("a b  c{{space::101}}");
  });
});

describe("indexed variable macros", () => {
  it("supports both local/global aliases and stores every set value as a string", () => {
    const state = emptyMacroState();
    expect(
      run(
        '{{setvarkey::object::port::north}}{{setvarindex::array::0::south}}{{setvarindex::array::1::7}}{{setglobalvarkey::global::item::{"ok":true} }}{{setglobalvarindex::global-array::0::false}}{{getvarindex::object::port}}/{{getvarkey::array::0}}/{{getglobalvarindex::global::item}}/{{getglobalvarkey::global-array::0}}',
        { state },
      ),
    ).toBe('north/south/{"ok":true}/false');
    expect(state.local.object).toBe('{"port":"north"}');
    expect(state.local.array).toBe('["south","7"]');
    expect(state.global.global).toBe('{"item":"{\\"ok\\":true}"}');
    expect(state.global["global-array"]).toBe('["false"]');
  });

  it("reads JSON object/array values and returns raw invalid/primitive values", () => {
    const state = emptyMacroState();
    state.local.nested =
      '{"item":{"code":7},"list":[true,null],"number":7,"flag":false,"nothing":null}';
    state.local.invalid = "plain text";
    state.local.primitive = "7";
    expect(
      run(
        "{{getvarkey::nested::item}}/{{getvarindex::nested::list}}/{{getvarkey::nested::number}}/{{getvarkey::nested::flag}}/{{getvarkey::nested::nothing}}/{{getvarkey::invalid::item}}/{{getvarkey::primitive::0}}/{{getvarkey::absent::item}}/{{getvarkey::nested::absent}}",
        { state },
      ),
    ).toBe('{"code":7}/[true,null]/7/false/null/plain text/7//');
    run("{{setvarkey::invalid::item::new}}{{setvarindex::primitive::0::new}}", { state });
    expect(state.local.invalid).toBe("plain text");
    expect(state.local.primitive).toBe("7");
  });

  it("normalizes numeric keys, supports sparse/blank keys and discards array properties in JSON", () => {
    const state = emptyMacroState();
    run(
      "{{setvarindex::array::2::third}}{{setvarkey::array::-1::negative}}{{setvarindex::array::01::leading}}{{setvarkey::blank::::empty-key}}",
      { state },
    );
    expect(state.local.array).toBe('[null,"leading","third"]');
    expect(state.local.blank).toBe('["empty-key"]');
    expect(
      run("{{getvarindex::array::01}}/{{getvarkey::array::-1}}/{{getvarindex::blank::}}", {
        state,
      }),
    ).toBe("leading//empty-key");
  });

  it("supports a scoped final value with dedent and preserve", () => {
    const state = emptyMacroState();
    expect(
      run(
        "{{setvarkey::object::port}}\n  {{user}} | north\n{{/setvarkey}}{{#setglobalvarindex::array::0}} left | right  {{/setglobalvarindex}}{{getvarkey::object::port}}/[{{getglobalvarkey::array::0}}]",
        { state },
      ),
    ).toBe("Aria | north/[ left | right  ]");
  });

  it("keeps malformed brace parsing compatible with recorded input", () => {
    expect(
      run('{{setglobalvarkey::object::nested::{"ok":true}}}{{getglobalvarkey::object::nested}}'),
    ).toBe('}{"ok":true');
  });

  it("uses own properties for hostile keys and never changes object prototypes", () => {
    const state = emptyMacroState();
    const inherited = Object.getOwnPropertyDescriptor(Object.prototype, "polluted");
    run("{{setvarkey::object::__proto__::safe}}{{setvarkey::object::constructor::own}}", { state });
    expect(
      run(
        "{{getvarkey::object::__proto__}}/{{getvarkey::object::constructor}}/{{getvarkey::object::toString}}",
        { state },
      ),
    ).toBe("safe/own/");
    expect(state.local.object).toBe('{"__proto__":"safe","constructor":"own"}');
    expect(Object.getOwnPropertyDescriptor(Object.prototype, "polluted")).toEqual(inherited);
  });

  it("bounds indexes, lengths, keys and values before writing state", () => {
    const state = emptyMacroState();
    for (const key of [
      String(MACRO_STATE_LIMITS.indexedArray),
      "4294967294",
      "1e100",
      "Infinity",
    ]) {
      expect(() => run(`{{setvarindex::array::${key}::value}}`, { state })).toThrow(
        MacroLimitError,
      );
      expect(state.local.array).toBeUndefined();
    }
    expect(() =>
      run(`{{setvarkey::object::${"x".repeat(MACRO_STATE_LIMITS.name + 1)}::value}}`, { state }),
    ).toThrow(MacroLimitError);
    expect(() =>
      run("{{setvarkey::object::key::{{description}}}}", {
        state,
        description: "x".repeat(MACRO_STATE_LIMITS.value + 1),
      }),
    ).toThrow(MacroLimitError);
    state.local.array = "[]";
    expect(() => run("{{setvarindex::array::length::4294967295}}", { state })).toThrow(
      MacroLimitError,
    );
    expect(state.local.array).toBe("[]");
    expect(state.local.object).toBeUndefined();
  });

  it("rejects serialized string amplification without mutating the original value", () => {
    const state = emptyMacroState();
    state.local.object = '{"key":"small"}';
    expect(() =>
      run("{{setvarkey::object::key::{{description}}}}", {
        state,
        description: '"'.repeat(MACRO_STATE_LIMITS.value),
      }),
    ).toThrow(MacroLimitError);
    expect(state.local.object).toBe('{"key":"small"}');
  });
  it("bounds JSON depth before recursively serializing a selected subtree", () => {
    const state = emptyMacroState();
    state.local.deep =
      `${'{"x":'.repeat(MACRO_STATE_LIMITS.jsonDepth + 2)}'end'${"}".repeat(MACRO_STATE_LIMITS.jsonDepth + 2)}`.replace(
        "'end'",
        '"end"',
      );
    expect(() => run("{{getvarkey::deep::x}}", { state })).toThrow(MacroLimitError);
  });
});

describe("captured time arguments", () => {
  const clock = { now: Date.UTC(2026, 8, 30, 12), timeZone: "Europe/Berlin" };
  it("uses integer UTC offsets and falls back to local time for fractional/invalid arguments", () => {
    expect(
      run("{{time::UTC+2}}/{{time::UTC-5}}/{{time::UTC+5.5}}/{{time::UTC+bad}}", { clock }),
    ).toBe("2:00 PM/7:00 AM/2:00 PM/2:00 PM");
  });
  it("uses minutes from magnitude 16 and requires uppercase UTC arguments", () => {
    expect(
      run(
        "{{time::UTC+15}}/{{time::UTC+16}}/{{time::UTC+17}}/{{time::UTC-16}}/{{time::UTC-30}}/{{time::utc+5}}/{{time::UTC+5}}/{{time::UTC+02:30}}/{{time::UTC+0}}",
        { clock },
      ),
    ).toBe("3:00 AM/12:16 PM/12:17 PM/11:44 AM/11:30 AM/2:00 PM/5:00 PM/2:00 PM/12:00 PM");
  });
  it("keeps signed relative suffixes and reports invalid dates", () => {
    expect(
      run(
        "{{timeDiff::2026-09-30T12:00:00Z::2026-09-30T12:00:30Z}}/{{timeDiff::2026-09-30T12:00:00Z::2026-09-30T12:01:00Z}}/{{timeDiff::2026-09-30T12:00:00Z::2026-09-30T13:00:00Z}}/{{timeDiff::2026-09-30T12:00:00Z::2026-10-02T12:00:00Z}}/{{timeDiff::2026-10-02T12:00:00Z::2026-09-30T12:00:00Z}}/{{timeDiff::invalid::2026-09-30T12:00:00Z}}",
        { clock },
      ),
    ).toBe("a few seconds ago/a minute ago/an hour ago/2 days ago/in 2 days/Invalid date");
  });
  it("interprets naive timestamps in the caller's zone across DST, while respecting explicit offsets", () => {
    const text =
      "{{timeDiff::2026-10-25T01:30:00::2026-10-25T03:30:00}}/{{timeDiff::2026-10-25T03:30:00::2026-10-25T01:30:00}}/{{timeDiff::2026-10-25T01:30:00Z::2026-10-25T03:30:00Z}}";
    expect(run(text, { clock })).toBe("3 hours ago/in 3 hours/2 hours ago");
    expect(run(text, { clock: { ...clock, timeZone: "UTC" } })).toBe(
      "2 hours ago/in 2 hours/2 hours ago",
    );
  });
});

describe("humanizeIdleDuration", () => {
  it("distinguishes no prior turn from an elapsed interval without suffix", () => {
    expect(humanizeIdleDuration(null)).toBe("just now");
    expect(humanizeIdleDuration(0)).toBe("a few seconds");
    expect(humanizeIdleDuration(30_000)).toBe("a few seconds");
    expect(humanizeIdleDuration(60_000)).toBe("a minute");
    expect(humanizeIdleDuration(3_600_000)).toBe("an hour");
    expect(humanizeIdleDuration(-172_800_000)).toBe("2 days");
  });
  it("rejects non-finite input without exposing it", () => {
    expect(() => humanizeIdleDuration(Number.POSITIVE_INFINITY)).toThrow(MacroLimitError);
  });
});
