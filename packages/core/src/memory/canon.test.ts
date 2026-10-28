import { describe, expect, it } from "vitest";
import { blankCard, type LorebookEntry } from "../card/index.ts";
import { memoryCanon } from "./canon.ts";

const entry = (overrides: Partial<LorebookEntry>): LorebookEntry => ({
  keys: [],
  content: "",

  enabled: true,
  insertionOrder: 100,
  useRegex: false,
  ...overrides,
});

const names = { char: "Maren", user: "Ash" };
const span = [
  { role: "assistant" as const, content: "The lamp needs trimming." },
  { role: "user" as const, content: "Then we row out at dawn." },
  { role: "assistant" as const, content: "Fine." },
];

const card = (entries: LorebookEntry[]) => ({
  ...blankCard("Maren"),
  description: "{{char}} keeps the Skerry light for <USER>.",
  personality: "Dry, patient.",
  scenario: "",
  lorebook: { entries },
});

const canonOf = (
  entries: LorebookEntry[],
  overrides: Partial<Parameters<typeof memoryCanon>[0]> = {},
) =>
  memoryCanon({
    card: card(entries),
    names,
    linked: [],
    turns: span,
    window: 100_000,
    count: (text) => text.length,
    ...overrides,
  });

/** A linked book: one constant entry, one matched by the span's "dawn". */
const coast = {
  id: "00000000-0000-4000-8000-000000000009",
  name: "Coast",
  book: {
    entries: [
      entry({ constant: true, content: "Ferries never stop for {{user}}." }),
      entry({ keys: ["dawn"], content: "At dawn {{user}} rows for {{char}}." }),
    ],
  },
};

describe("memory canon", () => {
  it("matches lore against the span's original speakers after the current names change", () => {
    const entries = ["Alice", "Bob", "Old Captain", "Mara"].map((name) =>
      entry({ keys: [`${name}:`], content: `${name}'s lore.` }),
    );
    const overrides = {
      names: { user: "Bob", char: "Mara" },
      turns: [
        { role: "user" as const, name: "Alice", content: "Hello." },
        { role: "assistant" as const, name: "Old Captain", content: "Welcome." },
      ],
    };
    const named = canonOf(entries, overrides);
    expect(named).toContain("Alice's lore.");
    expect(named).toContain("Old Captain's lore.");
    expect(named).not.toContain("Bob's lore.");
    expect(named).not.toContain("Mara's lore.");
    const unnamed = canonOf(entries, {
      ...overrides,
      turns: overrides.turns.map(({ role, content }) => ({ role, content })),
    });
    expect(unnamed).toContain("Bob's lore.");
    expect(unnamed).toContain("Mara's lore.");
    expect(unnamed).not.toContain("Alice's lore.");
    expect(unnamed).not.toContain("Old Captain's lore.");
  });

  it("gives the card's fields with the two names filled, empty ones left out", () => {
    const canon = canonOf([]);
    expect(canon).toBe(
      "Description:\nMaren keeps the Skerry light for Ash.\n\nPersonality:\nDry, patient.",
    );
  });

  it("gives the persona's description, names filled, after the card's fields", () => {
    const canon = canonOf([], { persona: "{{user}} rows for {{char}}." });
    expect(canon).toBe(
      "Description:\nMaren keeps the Skerry light for Ash.\n\nPersonality:\nDry, patient.\n\nPersona (Ash):\nAsh rows for Maren.",
    );
    expect(canonOf([], { persona: "  " })).not.toContain("Persona (");
  });

  it("takes constant entries and those whose keys the whole span matches, from every book", () => {
    const canon = canonOf(
      [
        entry({ constant: true, content: "The Skerry is a tidal island." }),
        // Matched by the span's oldest turn, past the book's own scan depth of 2.
        entry({ keys: ["lamp"], content: "The lamp burns whale oil." }),
        entry({ keys: ["harpoon"], content: "Nobody here owns a harpoon." }),
      ],
      {
        linked: [
          {
            id: "00000000-0000-4000-8000-000000000009",
            name: "Coast",
            book: {
              entries: [entry({ keys: ["dawn"], content: "At dawn {{user}} rows for {{char}}." })],
            },
          },
        ],
      },
    );
    expect(canon).toContain("Lorebook:\nThe Skerry is a tidal island.");
    expect(canon).toContain("The lamp burns whale oil.");
    expect(canon).toContain("At dawn Ash rows for Maren.");
    expect(canon).not.toContain("harpoon");
  });

  it("gives a span's canon exactly: fields, then constant and matched entries in order", () => {
    const canon = canonOf(
      [
        entry({ keys: ["lamp"], content: "The lamp burns whale oil." }),
        entry({ constant: true, content: "The Skerry is a tidal island." }),
        entry({ keys: ["harpoon"], content: "Nobody here owns a harpoon." }),
      ],
      { linked: [coast] },
    );
    expect(canon).toBe(
      [
        "Description:\nMaren keeps the Skerry light for Ash.",
        "Personality:\nDry, patient.",
        "Lorebook:\nThe lamp burns whale oil.",
        "The Skerry is a tidal island.",
        "Ferries never stop for Ash.",
        "At dawn Ash rows for Maren.",
      ].join("\n\n"),
    );
  });

  it("takes only the constant entries of every book when there are no turns", () => {
    const canon = canonOf(
      [
        entry({ keys: ["lamp"], content: "The lamp burns whale oil." }),
        entry({ constant: true, content: "The Skerry is a tidal island." }),
        entry({ constant: true, enabled: false, content: "Switched off." }),
      ],
      { linked: [coast], turns: [] },
    );
    expect(canon).toBe(
      [
        "Description:\nMaren keeps the Skerry light for Ash.",
        "Personality:\nDry, patient.",
        "Lorebook:\nThe Skerry is a tidal island.",
        "Ferries never stop for Ash.",
      ].join("\n\n"),
    );
  });

  it("keeps constant entries without turns within the lorebook budget", () => {
    const long = "x".repeat(400);
    const entries = [entry({ constant: true, content: long })];
    expect(canonOf(entries, { turns: [], window: 100_000 })).toContain(long);
    expect(canonOf(entries, { turns: [], window: 1_000 })).not.toContain(long);
  });

  it("sets chance and timed effects aside, so the same input gives the same canon", () => {
    const entries = [
      entry({
        keys: ["lamp"],
        content: "Rarely told.",
        settings: { useProbability: true, probability: 1, delay: 50, cooldown: 3, scanDepth: 1 },
      }),
    ];
    expect(canonOf(entries)).toContain("Rarely told.");
    expect(canonOf(entries)).toBe(canonOf(entries));
  });

  it("keeps the entries within the lorebook budget the window leaves after the fields", () => {
    const long = "x".repeat(400);
    const entries = [entry({ constant: true, content: long })];
    expect(canonOf(entries, { window: 100_000 })).toContain(long);
    // A quarter of a 1,000-token window, less the fields, cannot hold the entry.
    expect(canonOf(entries, { window: 1_000 })).not.toContain(long);
  });

  it("is null when the card says nothing and no entry applies", () => {
    expect(
      memoryCanon({
        card: { ...blankCard("Maren"), description: "", personality: "", scenario: "" },
        names,
        linked: [],
        turns: span,
        window: 100_000,
        count: (text) => text.length,
      }),
    ).toBeNull();
  });
});
