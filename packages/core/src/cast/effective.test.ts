import { describe, expect, it } from "vitest";
import { applyCastChanges, withKnownIdentities, withSheet } from "./apply.ts";
import {
  castIdentity,
  discoveredCastAnchor,
  discoveredCastEntry,
  effectiveCastAnchor,
  groundedCastChanges,
  memoryCastContext,
  memoryCastContextSchema,
} from "./effective.ts";
import { keeperInstructions, keeperMessage, sheetInstructions } from "./prompt.ts";
import {
  type CastEntry,
  type CastRegister,
  castChangesSchema,
  castEntrySchema,
  castSheetEntrySchema,
  clampCastChanges,
  emptyCastAnchor,
  emptyCastState,
} from "./register.ts";
import { castAnchorsText, castPeopleNotes, castStateText } from "./text.ts";

const person = (): CastEntry => ({
  id: "00000000-0000-4000-8000-000000000001",
  role: "principal",
  aka: ["Mara"],
  anchor: {
    ...emptyCastAnchor("Mara Holt", "female"),
    age: "30",
    hair: "long black hair",
    relationship: "single",
  },
  state: emptyCastState(true),
});
const quote = "Mara cut her hair short, married Ilse and turned 31.";
const changes = castChangesSchema.parse({
  cast: {
    "Mara Holt": {
      anchor: { hair: "keeper rewrite refused", skin: "freckled skin" },
      developments: {
        hair: { value: "short black hair", evidence: "cut her hair short" },
        relationship: { value: "married to Ilse", evidence: "married Ilse" },
        age: { value: "31", evidence: "turned 31" },
        experience: { value: "experienced", evidence: "an unseen encounter" },
      },
      continuity: {
        voice: { value: "calls Ilse captain", evidence: "Captain, come home." },
        goals: { value: "return home with Ilse", evidence: "come home" },
        knowledge: { value: "knows the hidden password", evidence: "unshown secret" },
      },
    },
  },
  absent: [],
});
const apply = (entry: CastEntry, shown: readonly string[] = []) =>
  applyCastChanges({ entries: [entry] }, changes, {
    player: null,
    newId: () => "unused",
    shown,
  });

function firstEntry(register: CastRegister): CastEntry {
  const entry = register.entries[0];
  if (entry === undefined) throw new Error("Expected an entry");
  return entry;
}

describe("durable developments and compact continuity", () => {
  it("keeps baseline bytes stable and gives all current readers grounded effective facts", () => {
    const initial = person();
    const baseline = { entries: [initial] };
    // Empty baseline filling is separate from developments; hold it fixed for the byte check.
    initial.anchor.skin = "freckled skin";
    const next = apply(initial, [quote, "Captain, come home."]);
    const entry = firstEntry(next);
    expect(castAnchorsText(next)).toBe(castAnchorsText(baseline));
    expect(entry.anchor.hair).toBe("long black hair");
    expect(effectiveCastAnchor(entry)).toMatchObject({
      age: "31",
      hair: "short black hair",
      relationship: "married to Ilse",
      experience: "",
    });
    expect(entry.continuity).toEqual({
      voice: "calls Ilse captain",
      goals: "return home with Ilse",
    });
    expect(castStateText(next)).toContain("authoritative over <cast> baseline");
    expect(castStateText(next)).toContain(
      "voice: calls Ilse captain; goals: return home with Ilse",
    );
    expect(castStateText(next)).not.toContain("long black hair");
    expect(castStateText(next)).not.toContain("knowledge:");
    expect(castPeopleNotes(next)).toContain("31 years old");
    expect(castPeopleNotes(next)).not.toContain("long black hair");
    const message = keeperMessage({
      canon: null,
      names: { char: "Mara", user: "Rowan" },
      register: next,
      turns: [],
      mode: "update",
      full: false,
    });
    expect(message).toContain('"hair":"short black hair"');
    expect(message).not.toContain("long black hair");
  });

  it("does not admit extensions without exact batch evidence, including empty and cross-turn quotes", () => {
    expect(
      castChangesSchema.safeParse({
        cast: { Mara: { developments: { hair: { value: "short hair", evidence: " " } } } },
      }).success,
    ).toBe(false);
    expect(apply(person()).entries[0]?.developments).toBeUndefined();
    expect(apply(person(), ["cut her", "hair short"]).entries[0]?.developments).toBeUndefined();
    const accepted = firstEntry(apply(person(), [quote]));
    expect(accepted.anchor.skin).toBe("freckled skin");
    expect(accepted.developments?.experience).toBeUndefined();
    expect(accepted.continuity).toBeUndefined();
  });

  it("fills an empty baseline only through the original anchor path", () => {
    const initial = person();
    initial.anchor.hair = "";
    const result = applyCastChanges(
      { entries: [initial] },
      castChangesSchema.parse({
        cast: {
          Mara: {
            anchor: { age: "99", skin: "freckled skin" },
            developments: { hair: { value: "short black hair", evidence: "cut her hair short" } },
          },
        },
      }),
      { player: null, newId: () => "unused", shown: [quote] },
    );
    expect(firstEntry(result).anchor).toMatchObject({ age: "30", skin: "freckled skin", hair: "" });
    expect(firstEntry(result).developments).toBeUndefined();
  });

  it("locks corrected fields, including explicit empty corrections, against both keeper paths", () => {
    const entry = person();
    entry.developments = { hair: "short black hair" };
    const result = firstEntry(
      applyCastChanges({ entries: [entry] }, changes, {
        player: null,
        newId: () => "unused",
        shown: [quote],
        corrected: { [entry.id]: { anchor: { hair: "", skin: "" } } },
      }),
    );
    expect(result.developments?.hair).toBe("short black hair");
    expect(result.anchor.skin).toBe("");
    expect(effectiveCastAnchor(result, { hair: "" }).hair).toBe("");
  });

  it("preserves developments and continuity across card and notebook overlays", () => {
    const entry = firstEntry(apply(person(), [quote, "Captain, come home."]));
    const sheet = { entries: [{ ...castIdentity(entry), anchor: person().anchor }] };
    const overlaid = withSheet(sheet, { entries: [entry] });
    const filled = withSheet(sheet, overlaid, { fillOnly: true });
    expect(effectiveCastAnchor(firstEntry(filled)).hair).toBe("short black hair");
    expect(filled.entries[0]?.continuity).toEqual(entry.continuity);
  });

  it("recovers identity and baseline without future developments or continuity", () => {
    const future = apply(person(), [quote, "Captain, come home."]);
    const recovered = firstEntry(withKnownIdentities({ entries: [] }, future));
    expect(recovered.id).toBe(person().id);
    expect(recovered.anchor.hair).toBe("long black hair");
    expect(recovered.developments).toBeUndefined();
    expect(recovered.continuity).toBeUndefined();
    const replayed = firstEntry(
      applyCastChanges(
        { entries: [] },
        castChangesSchema.parse({ cast: { Mara: { state: { mood: "calm" } } } }),
        {
          player: null,
          newId: () => "unused",
          previous: future,
        },
      ),
    );
    expect(replayed.id).toBe(person().id);
    expect(replayed.developments).toBeUndefined();
    expect(replayed.continuity).toBeUndefined();
  });

  it("clamps developments and continuity and keeps stored sheet shapes unchanged", () => {
    expect(castChangesSchema.parse(clampCastChanges(changes))).toEqual(changes);
    const extended = { ...person(), developments: { age: "31" }, continuity: { voice: "terse" } };
    expect(castEntrySchema.safeParse(extended).success).toBe(true);
    const { state: _state, ...sheet } = extended;
    expect(castSheetEntrySchema.safeParse(sheet).success).toBe(false);
    expect(
      castEntrySchema.safeParse({ ...extended, developments: { name: "Other" } }).success,
    ).toBe(false);
    expect(
      castEntrySchema.safeParse({ ...extended, continuity: { voice: "x".repeat(241) } }).success,
    ).toBe(false);
    const clamped = castChangesSchema.parse(
      clampCastChanges({
        cast: {
          Mara: {
            continuity: {
              voice: { value: "x".repeat(400), evidence: "y".repeat(400), unknown: true },
            },
          },
        },
      }),
    );
    expect(clamped.cast.Mara?.continuity?.voice?.value.length).toBeLessThanOrEqual(240);
    expect(clamped.cast.Mara?.continuity?.voice?.evidence.length).toBeLessThanOrEqual(240);
  });

  it("shapes archivist input to effective anchors and continuity only", () => {
    const register = apply(person(), [quote, "Captain, come home."]);
    const context = memoryCastContext(register);
    expect(memoryCastContextSchema.parse(context)).toEqual(context);
    expect(context[0]?.anchor.hair).toBe("short black hair");
    expect(Object.keys(context[0] ?? {})).toEqual(["anchor", "continuity"]);
    expect(JSON.stringify(context)).not.toContain(person().id);
    for (const extra of [{ id: person().id }, { aka: ["Mara"] }, { state: emptyCastState(true) }]) {
      expect(memoryCastContextSchema.safeParse([{ ...context[0], ...extra }]).success).toBe(false);
    }
  });

  it("asks for grounded developments and removes independent gap filling", () => {
    expect(keeperInstructions()).toContain('"developments"');
    expect(keeperInstructions()).toContain("exact short quote");
    expect(keeperInstructions()).toContain("Leave unknown fields empty or omitted");
    expect(sheetInstructions()).toContain("Leave unknown anchor fields empty or omitted");
    expect(sheetInstructions()).not.toContain("fill a gap consistently");
  });
});

describe("player discoveries", () => {
  const shown = ["Mara arrives in a long coat. She says, ‘I am 31.’"];
  const answer = castChangesSchema.parse({
    cast: {
      "Mara Holt": {
        anchor: { age: "31", intimate: "canonical hidden anatomy", personality: "guarded" },
        introduce: { evidence: "Mara arrives" },
        discovered: {
          age: { value: "early thirties", basis: "seen", evidence: "Mara arrives" },
          build: { value: "curvy beneath her coat", basis: "seen", evidence: "long coat" },
          personality: {
            value: "guarded",
            basis: "demonstrated",
            evidence: "This was never shown.",
          },
        },
      },
    },
  });

  it("keeps full canon separate from grounded public knowledge", () => {
    const result = firstEntry(
      applyCastChanges({ entries: [] }, answer, {
        player: null,
        newId: () => person().id,
        shown,
      }),
    );
    expect(result.introduced).toBe(true);
    expect(result.anchor).toMatchObject({ age: "31", intimate: "canonical hidden anatomy" });
    expect(result.discovered?.personality).toBeUndefined();
    expect(discoveredCastAnchor(result)).toMatchObject({
      age: "early thirties",
      build: "curvy beneath her coat",
      intimate: "",
      personality: "",
    });
    const publicEntry = discoveredCastEntry(result);
    expect(publicEntry.developments).toBeUndefined();
    expect(publicEntry.continuity).toBeUndefined();
  });

  it("retains and refines discoveries without reintroducing someone", () => {
    const initial = applyCastChanges({ entries: [] }, answer, {
      player: null,
      newId: () => person().id,
      shown,
    });
    const refined = castChangesSchema.parse({
      cast: {
        "Mara Holt": {
          discovered: {
            age: { value: "31", basis: "told", evidence: "I am 31" },
            intimate: { value: "canonical hidden anatomy", basis: "seen", evidence: "not shown" },
          },
        },
      },
    });
    const next = firstEntry(
      applyCastChanges(initial, refined, {
        player: null,
        newId: () => "unused",
        shown,
      }),
    );
    expect(next.introduced).toBe(true);
    expect(discoveredCastAnchor(next).age).toBe("31");
    expect(discoveredCastAnchor(next).intimate).toBe("");
    expect(discoveredCastAnchor(next).build).toBe("curvy beneath her coat");
  });

  it("drops an ungrounded introduction and all future knowledge on identity recovery", () => {
    const ungrounded = applyCastChanges({ entries: [] }, answer, {
      player: null,
      newId: () => person().id,
      shown: ["Another scene entirely."],
    });
    expect(ungrounded.entries[0]?.introduced).toBeUndefined();
    expect(ungrounded.entries[0]?.discovered).toBeUndefined();
    const introduced = applyCastChanges({ entries: [] }, answer, {
      player: null,
      newId: () => person().id,
      shown,
    });
    const recovered = firstEntry(withKnownIdentities({ entries: [] }, introduced));
    expect(recovered.introduced).toBeUndefined();
    expect(recovered.discovered).toBeUndefined();
  });
});

describe("a quote as evidence", () => {
  const shown = [
    "Mara arrives in a long coat.\nShe says, ‘I am 31…’ and  *laughs*.",
    'Lena (24): :rose["Stay a while."] She pours the wine — slowly.',
  ];
  const grounds = (evidence: string) =>
    groundedCastChanges(
      castChangesSchema.parse({ cast: { Mara: { introduce: { evidence } } } }),
      shown,
    ).cast.Mara?.introduce !== undefined;

  it.each([
    "Mara arrives in a long coat.",
    "mara arrives in a long coat",
    "'I am 31...'",
    "She says, 'I am 31...' and laughs.",
    "arrives in a long coat. She says",
    '"Stay a while."',
    '"...Stay a while..."',
    "She pours the wine - slowly.",
  ])("holds across markup, typography, case and spacing: %s", (evidence) => {
    expect(grounds(evidence)).toBe(true);
  });

  it.each(["Mara leaves in a long coat.", "Stay a while. She pours the tea", '"…"', "*"])(
    "is refused when no shown turn has its words: %s",
    (evidence) => {
      expect(grounds(evidence)).toBe(false);
    },
  );

  it("is never found across two turns", () => {
    expect(grounds("laughs. Lena (24)")).toBe(false);
  });
});

describe("an introduction by name", () => {
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const away = (n: number, name: string, overrides: Partial<CastEntry> = {}): CastEntry => ({
    id: uuid(n),
    role: "principal",
    aka: [],
    anchor: emptyCastAnchor(name, "female"),
    state: emptyCastState(false),
    ...overrides,
  });
  const nothing = castChangesSchema.parse({ cast: {} });
  const introduced = (
    entries: CastEntry[],
    shown: readonly string[],
    options: { player?: string | null; removed?: Set<string> } = {},
  ) =>
    applyCastChanges({ entries }, nothing, {
      player: options.player ?? null,
      newId: () => "unused",
      shown,
      ...(options.removed === undefined ? {} : { removed: options.removed }),
    })
      .entries.filter((entry) => entry.introduced === true)
      .map((entry) => entry.anchor.name);

  it("introduces everyone a shown turn names, whatever the keeper answered", () => {
    const entries = [away(1, "Mara Holt"), away(2, "Lena Voss"), away(3, "Ilse Brandt")];
    const shown = ['Lena (24): :rose["Mara, the door."] She waves you in.'];
    expect(introduced(entries, shown)).toEqual(["Mara Holt", "Lena Voss"]);
  });

  it("takes the whole name, an earlier name, or a first name only one entry has", () => {
    const sisters = [away(1, "Anna Meyer"), away(2, "Anna Schmidt", { aka: ["the Baroness"] })];
    expect(introduced(sisters, ["Anna waves."])).toEqual([]);
    expect(introduced(sisters, ["Anna Meyer waves."])).toEqual(["Anna Meyer"]);
    expect(introduced(sisters, ["You bow to the Baroness."])).toEqual(["Anna Schmidt"]);
  });

  it("reads names as whole words, as written", () => {
    const entries = [away(1, "Rose Tyler"), away(2, "Ann")];
    expect(
      introduced(entries, ["She rose and crossed to Annabel's Rosewood desk. Ann-Marie is out."]),
    ).toEqual([]);
    expect(introduced(entries, ["Rose's coat hangs by the door. “Ann?” you call."])).toEqual([
      "Rose Tyler",
      "Ann",
    ]);
  });

  it("never takes a title or the player's own first name for someone's", () => {
    const entries = [away(1, "Mara Holt"), away(2, "Doctor Elena Voss")];
    expect(introduced(entries, ["Mara nods at the Doctor."], { player: "Mara Stone" })).toEqual([]);
    expect(introduced(entries, ["Doctor Elena Voss looks up."], { player: "Mara Stone" })).toEqual([
      "Doctor Elena Voss",
    ]);
  });

  it("leaves a removed entry and an unnamed one as they were, and keeps the rest untouched", () => {
    const entries = [away(1, "Mara Holt"), away(2, "Lena Voss")];
    const result = applyCastChanges({ entries }, nothing, {
      player: null,
      newId: () => "unused",
      shown: ["Mara and Lena look up."],
      removed: new Set([uuid(1)]),
    });
    expect(result.entries[0]).toBe(entries[0]);
    expect(result.entries[1]).toEqual({ ...entries[1], introduced: true });
    expect(introduced(entries, [])).toEqual([]);
  });

  it("introduces someone the keeper adds in the same answer", () => {
    const added = castChangesSchema.parse({
      cast: { "Ilse Brandt": { gender: "female", state: { activity: "pouring a drink" } } },
    });
    const result = applyCastChanges({ entries: [] }, added, {
      player: null,
      newId: () => uuid(9),
      shown: ["Ilse sets a glass on the bar."],
    });
    expect(result.entries[0]).toMatchObject({ introduced: true, state: { present: true } });
  });
});
