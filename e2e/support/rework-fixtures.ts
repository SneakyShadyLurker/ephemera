/**
 * Synthetic content for AI Rework, shared by the mock upstream and the specs.
 * The owner's request carries two bases: `<base>-req` marks the request and
 * every piece of the proposal that must never persist (a rejected change,
 * the reasons, the summary), and `kept` marks what an accepted change writes,
 * which persists by design. A base from `canary()` makes the marks retention
 * canaries; `kept` must then be a base that is not one.
 */

/** The description's first anchor sentence; change 1 replaces it. */
export const ANCHOR_ONE = "Ada is 24 and keeps the placeholder archive in Testtown.";
/** The description's second anchor sentence; change 2 replaces it. */
export const ANCHOR_TWO = "She graduated from the slate college in 2009.";
/** The lorebook entry's anchor sentence; change 3 replaces it. */
const ANCHOR_LORE = "The ledger lists every placeholder that left the harbour.";

/** Neutral prose around the anchors, long enough that the review collapses unchanged runs. */
const FILLER = [
  "The reading room faces the harbour, and the light changes with the tide.",
  "She keeps the catalogue in pencil so that nothing written in it is ever final.",
  "Visitors come for maps, for old letters, and sometimes only for the quiet.",
  "Her desk holds a brass lamp, three unsorted boxes and a cup that is always cold.",
  "On market days she closes early and walks the long way home along the quay.",
  "She answers questions exactly and offers nothing she was not asked for.",
].join(" ");

/** The owner's request: free text holding both bases. */
export const ownerRequest = (base: string, kept: string) => `Make her older. ${base}-req ${kept}`;

/** The bases of a request written by `ownerRequest`, read back from the model's input. */
export function requestBases(text: string): { requestBase: string; keptBase: string } | undefined {
  const match = /([\w-]+?)-req ([\w-]+)/u.exec(text);
  return match?.[1] === undefined || match[2] === undefined
    ? undefined
    : { requestBase: match[1], keptBase: match[2] };
}

/**
 * The card JSON for `POST /api/characters`: a description holding both
 * anchors and a book with one entry holding the lorebook anchor. The name
 * takes the base's last eight characters so it stays unique.
 */
export function reworkCharacter(base: string) {
  return {
    name: `Ada Reed ${base.slice(-8)}`,
    nickname: "",
    description: [ANCHOR_ONE, FILLER, ANCHOR_TWO, FILLER].join(" "),
    personality: "Calm, curious and exact.",
    scenario: "Ada waits for {{user}} at the archive door.",
    firstMessage: "Ada looks up from the ledger.",
    alternateGreetings: [],
    exampleDialogue: "",
    systemPrompt: "",
    postHistoryInstructions: "",
    creatorNotes: "",
    tags: ["drama", "placeholder"],
    creator: "",
    characterVersion: "",
  };
}

/** The book `reworkCharacter`'s card carries, saved after the card (e2e/support/entities.ts). */
export function reworkBook() {
  return {
    entries: [
      {
        keys: ["ledger", "harbour"],
        content: `${ANCHOR_LORE} It is kept in the archive's back room.`,
        enabled: true,
        insertionOrder: 100,
        useRegex: false,
        comment: "The harbour ledger",
      },
    ],
  };
}

const block = (field: string, why: string, find: string, replace: string) =>
  [
    "<change>",
    `<field>${field}</field>`,
    `<why>${why}</why>`,
    `<find>${find}</find>`,
    `<replace>${replace}</replace>`,
    "</change>",
  ].join("\n");

/**
 * The model's answer to a rework: two changes on the description (the first
 * carries `keptBase`, the second `requestBase`, so a spec accepts one and
 * rejects the other), a third on the first entry when the card has one, a
 * fourth whose find is not in the card, then the summary. Every reason holds
 * `<requestBase>-why`; `hostile` prose goes into change 1's replacement.
 */
export function reworkAnswer({
  requestBase,
  keptBase,
  lore,
  hostile,
}: {
  requestBase: string;
  keptBase: string;
  /** Whether the card sent has a first lorebook entry. */
  lore: boolean;
  hostile?: string | undefined;
}): string {
  const why = `${requestBase}-why`;
  const one = `Replaced one ${keptBase}-acc.`;
  return [
    block(
      "description",
      `Her age now matches the request. ${why}`,
      ANCHOR_ONE,
      hostile === undefined ? one : `${one}\n\n${hostile}`,
    ),
    block(
      "description",
      `The graduation year follows the new age. ${why}`,
      ANCHOR_TWO,
      `Replaced two ${requestBase}-rej.`,
    ),
    ...(lore
      ? [
          block(
            "entry_1",
            `The ledger agrees with the card. ${why}`,
            ANCHOR_LORE,
            `${keptBase}-lore`,
          ),
        ]
      : []),
    block("personality", `A passage the card does not hold. ${why}`, "not in the card", "anything"),
    `<summary>Summary ${requestBase}-sum.</summary>`,
  ].join("\n");
}
