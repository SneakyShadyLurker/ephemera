import type { CharacterCard } from "../card/index.ts";
import type { Lorebook, LorebookEntry } from "../card/schema.ts";
import type { CastRegister } from "../cast/register.ts";
import { castAnchorsText, castStateText } from "../cast/text.ts";
import { type ChatTurn, type GenerationMode, type MacroRuntime, speakerOf } from "../chat.ts";
import { eventMessage } from "../events/event.ts";
import { activateLorebooks, type SentEntry } from "../lorebook/activate.ts";
import { combineLorebooks, type LorebookSource } from "../lorebook/combine.ts";
import type { LorebookState } from "../lorebook/timed.ts";
import { MEMORY_LIMITS } from "../memory/limits.ts";
import type { MemoryNotebook, StoredEpisode } from "../memory/memory.ts";
import {
  fillUserPlaceholder,
  memoryRecalledText,
  memoryStoryText,
  notebookHasContent,
} from "../memory/prompt.ts";
import { fitRecall, rankRecall, storyOrder } from "../memory/recall.ts";
import { DEFAULT_MAIN_PROMPT, SOURCE_PLACEHOLDER } from "../preset/defaults.ts";
import {
  type AuthorsNote,
  blockOrder,
  blockRole,
  DEFAULT_PROMPT_REASONING,
  type GenerationType,
  type Placeable,
  PRESET_LIMITS,
  type PromptBlock,
  type PromptPreset,
  type PromptReasoning,
  type PromptRole,
} from "../preset/index.ts";
import { DEFAULT_SETTINGS, type Settings } from "../settings.ts";
import { exampleBlocks } from "./examples.ts";
import type { LorebookReport, PromptSource } from "./inspect.ts";
import { cloneMacroState, emptyMacroState, type MacroState } from "./macro-state.ts";
import {
  AggregateMacroLimitError,
  createMacroWorkBudget,
  MAX_MACRO_OUTPUT,
  MAX_MACRO_WORK,
  type MacroContext,
  MacroLimitError,
  type MacroWorkBudget,
  substituteMacros,
} from "./macros.ts";

/** Request-local native prompt assembly keeps fixed sources, examples and history separate for fitting. The Author's Note follows preset injections at equal placement; the character note follows it. Nothing is persisted. */

export interface PromptMessage {
  role: PromptRole;
  content: string;
  /** Original history speaker and assembly's text prefix; request-local, never inspected or sent. */
  historySpeaker?: { name: string; prefixed: boolean };
  source: PromptSource;
  /** Other sources joined into this message: in-chat blocks sent as one, or post-processing. */
  merged?: PromptSource[];
}

type Segment =
  | { kind: "fixed"; message: PromptMessage }
  /** Example dialogue blocks, each whole, dropped from the last when the window is short. */
  | { kind: "examples"; blocks: PromptMessage[][] }
  | {
      kind: "history";
      turns: PromptMessage[];
      /** A Continue holds the last reply until after blocks following history. In-chat depths still count that reply. */
      continues: boolean;
      /** In-chat injection order. */
      injections: { depth: number; message: PromptMessage }[];
    };

export interface Assembly {
  segments: Segment[];
  macroState?: MacroState;
  generationType?: GenerationType;
  /** Which lorebook entries went in and why; null without a lorebook to read. */
  lorebook: LorebookReport | null;
  /** The timed state the next request carries; null without a book or a timed identity. */
  lorebookState: LorebookState | null;
  /** Request-local provenance, resolved before provider role shaping; never part of the inspector response. */
  lorebookDelivery?: {
    entries: ReadonlyMap<PromptMessage, readonly number[]>;
    finalize: (sent: ReadonlySet<number>) => Pick<Assembly, "lorebook" | "lorebookState">;
  };
  /** Whether the input's event went in; its text can fill to nothing. Absent without one. */
  eventSent?: boolean;
  /**
   * What of the character's memory went in, by id: this chat's recap
   * episodes in the story block, the episodes told before this chat, apart
   * from them, and the recalled ones. Absent without memory input.
   */
  memory?: { recap: string[]; before: string[]; recalled: string[] };
}

export interface AssemblyInput {
  preset: PromptPreset;
  macroState?: MacroState;
  generationType?: GenerationType;
  macroRuntime?: MacroRuntime;
  /** Resolved model values, supplied by the request owner. */
  runtime?: { model: string; window: number; reserve: number };
  character: CharacterCard | null;
  persona: { name: string; description: string } | null;
  /** Oldest first. */
  history: ChatTurn[];
  /** User turns before the live history, held by memories; count toward the Author's Note. */
  foldedUsers?: number;
  clock: MacroContext["clock"];
  pickSeed: MacroContext["pickSeed"];
  random: () => number;
  /** Whether card instructions replace the preset's corresponding text; both are preferred by default. */
  prefer?: Pick<Settings, "preferCharacterPrompt" | "preferCharacterInstructions">;
  /** A reply when absent. */
  mode?: GenerationMode;
  /**
   * What the character's lorebooks need: the model's window and the tokens of
   * an entry; the library books linked to the character, in link order,
   * activated after the card's own (none by default); for timed effects, the
   * state the request carried, the character's id and a digest of an entry
   * (timed.ts). Without `characterId` and `digest` no sticky or cooldown
   * effect applies and no state is returned. `folded` turns before the
   * history, held by memories, count toward delay.
   */
  lorebook?: {
    window: number;
    count: (text: string) => number;
    linked?: { id: string; name: string; book: Lorebook }[];
    state?: LorebookState | null;
    characterId?: string;
    digest?: (entry: LorebookEntry) => string;
    folded?: number;
  };
  /**
   * The event rolled for this reply (events/state.ts): its text, filled by
   * the macros and wrapped, goes in as a system message after the latest
   * turn, or last when the preset sends no history. Never merged with
   * another message, never trimmed.
   */
  event?: { text: string } | null;
  /**
   * The chat's cast register as it stands. Its fixed anchors go in at the
   * preset's `castAnchors` block, or where `castAnchorsPlace` puts them for a
   * preset without one; its state goes into the chat at `CAST_STATE_DEPTH`
   * as its own user message, or right after the story block when the preset
   * sends no history. Literal, never macro-filled; an empty register adds
   * nothing.
   */
  cast?: CastRegister;
  /**
   * The character's memory, when it is on: the notebook and this chat's
   * episodes (`recap`, in order) go in as one system message right before
   * the history; `candidates`, the rest of the book, may be recalled into
   * the chat at `MEMORY_RECALL_DEPTH` as a user message, or right after the
   * story block when the preset sends no history. Both together take at most
   * `MEMORY_LIMITS.share` of `window` by `count`: the notebook always goes
   * in, the recap newest first while it fits (older episodes left out may
   * be recalled instead), then recall in rank order while it fits
   * (`fitRecall`). `recall: false` recalls nothing, the recap's left-out
   * episodes included. Memory text is literal, never macro-filled.
   * `before`, the book's story outside this chat in story order, goes in
   * under "Before this chat", fitted after the recap: this chat's own
   * episodes newest first, then these newest first, the ones left out
   * joining the candidates. `fresh`, while the chat has no memory of its
   * own, frames the chat as a new scene, or with `continued`, when its
   * greeting in play is the memory's opening, as the last scene going on.
   */
  memory?: {
    notebook: MemoryNotebook;
    recap: StoredEpisode[];
    before?: StoredEpisode[];
    /** Whether the chat has no memory of its own; false when absent. */
    fresh?: boolean;
    /** Whether the greeting in play is the memory's opening; false when absent. */
    continued?: boolean;
    candidates: StoredEpisode[];
    count: (text: string) => number;
    window: number;
    /** Whether anything is recalled; true when absent. */
    recall?: boolean;
  } | null;
}

export type MacroInput = Pick<
  AssemblyInput,
  "character" | "persona" | "clock" | "pickSeed" | "random"
> &
  Partial<
    Pick<
      AssemblyInput,
      "preset" | "history" | "prefer" | "macroState" | "macroRuntime" | "runtime" | "generationType"
    >
  >;

/** Where recalled memories go in the chat: before the fourth turn from the end. */
const MEMORY_RECALL_DEPTH = 4;
/** Where the cast's state goes in the chat: before the latest turn. */
const CAST_STATE_DEPTH = 1;

const CAST_ANCHORS: PromptBlock = { kind: "source", id: "castAnchors", enabled: true };

/**
 * The preset's blocks with the cast's anchors placed for a preset without
 * the block: after the scenario when it is on, else after the later of the
 * description and personality that is on, else before the lorebook's after
 * block when it is on, else before the chat history. The preset editor adds
 * the block back at the same place.
 */
export function castAnchorsPlace(blocks: readonly PromptBlock[]): readonly PromptBlock[] {
  if (blocks.some((block) => block.id === "castAnchors")) return blocks;
  const on = (id: PromptBlock["id"]) =>
    blocks.findIndex((block) => block.id === id && block.enabled !== false);
  const scenario = on("scenario");
  const character = Math.max(on("charDescription"), on("charPersonality"));
  const lorebookAfter = on("lorebookAfter");
  const at =
    scenario !== -1
      ? scenario + 1
      : character !== -1
        ? character + 1
        : lorebookAfter !== -1
          ? lorebookAfter
          : blocks.findIndex((block) => block.kind === "chatHistory");
  return at === -1 ? [...blocks, CAST_ANCHORS] : blocks.toSpliced(at, 0, CAST_ANCHORS);
}

/** `{{char}}` without a character. */
export const NO_CHARACTER_NAME = "Assistant";
/** `{{user}}` without a persona (PRODUCT.md). */
export const NO_PERSONA_NAME = "User";

/** Deeper injections go first, then lower order, then assistant, user and system. Equal placement joins custom blocks, Author's Note and character note with line breaks. */
const ROLE_RANK: Record<PromptRole, number> = { assistant: 0, user: 1, system: 2 };

/** Where an in-chat message goes: its depth, order and role. */
interface InChatPlace {
  depth: number;
  order: number;
  role: PromptRole;
}

/** Shared in-chat ordering for assembly and editor. */
export const compareInChat = (a: InChatPlace, b: InChatPlace) =>
  // Deeper first: where depths pass the history's start they meet at its top, deepest first.
  b.depth - a.depth || a.order - b.order || ROLE_RANK[a.role] - ROLE_RANK[b.role];

interface Injection {
  depth: number;
  order: number;
  message: PromptMessage;
}

/** One message per depth, order and role, in sending order. */
function injectionMessages(
  injections: Injection[],
  provenance: Map<PromptMessage, readonly number[]>,
): { depth: number; message: PromptMessage }[] {
  const groups = Map.groupBy(
    injections,
    ({ depth, order, message }) => `${depth}/${order}/${message.role}`,
  );
  return [...groups.values()]
    .sort((a, b) => {
      const [first, second] = [a[0], b[0]];
      if (first === undefined || second === undefined) return 0;
      return compareInChat(
        { ...first, role: first.message.role },
        { ...second, role: second.message.role },
      );
    })
    .flatMap((group) => {
      const [head, ...rest] = group;
      if (head === undefined) return [];
      const message: PromptMessage =
        rest.length === 0
          ? head.message
          : {
              ...head.message,
              content: group.map(({ message: part }) => part.content).join("\n"),
              merged: [
                ...(head.message.merged ?? []),
                ...rest.flatMap(({ message: part }) => [part.source, ...(part.merged ?? [])]),
              ],
            };
      if (rest.length > 0) {
        const entries = group.flatMap(({ message }) => provenance.get(message) ?? []);
        if (entries.length > 0) provenance.set(message, entries);
      }
      return [{ depth: head.depth, message }];
    });
}

/** Add to Prompts: a reply's reasoning in the preset's tag, a line break before the reply. */
const reasoningBlock = (tag: string, turn: ChatTurn): string =>
  `<${tag}>${(turn.reasoning ?? "").trim()}</${tag}>\n`;

/**
 * Template metadata for an explicit foreground action, with the card's
 * example dialogue expanded on its working state.
 */
function templateContext(input: MacroInput, workBudget: MacroWorkBudget): MacroContext {
  const {
    character,
    persona,
    clock,
    pickSeed,
    random,
    history = [],
    macroRuntime = {},
    runtime,
  } = input;
  const state = cloneMacroState(input.macroState ?? emptyMacroState());
  const prefer = input.prefer ?? DEFAULT_SETTINGS;
  const locked = (id: "main" | "postHistory") =>
    input.preset?.blocks.some(
      (block) => block.id === id && block.kind === "text" && block.forbidOverrides === true,
    ) ?? false;
  const last = history.at(-1);
  const reasoningTag = (input.preset?.reasoning ?? DEFAULT_PROMPT_REASONING).tag;
  const characterSystemPrompt =
    prefer.preferCharacterPrompt && !locked("main") ? (character?.systemPrompt ?? "") : "";
  const base: MacroContext = {
    char: character?.name ?? NO_CHARACTER_NAME,
    user: persona?.name ?? NO_PERSONA_NAME,
    description: "",
    personality: "",
    scenario: "",
    persona: "",
    original: "",
    clock,
    pickSeed,
    random,
    state,
    workBudget,
    characterSystemPrompt,
    systemPrompt:
      characterSystemPrompt.trim() === ""
        ? ((
            input.preset?.blocks.find((block) => block.kind === "text" && block.id === "main") as
              | { content: string }
              | undefined
          )?.content ?? DEFAULT_MAIN_PROMPT)
        : characterSystemPrompt,
    defaultSystemPrompt: DEFAULT_MAIN_PROMPT,
    /** The preset note's text is available even when it is not due. */
    authorsNote: input.preset?.authorsNote.text ?? "",
    reasoningPrefix: `<${reasoningTag}>`,
    reasoningSuffix: `</${reasoningTag}>`,
    reasoningSeparator: "\n",
    postHistoryInstructions:
      prefer.preferCharacterInstructions && !locked("postHistory")
        ? (character?.postHistoryInstructions ?? "")
        : "",
    characterNote: character === null ? "" : (character.characterNote?.prompt ?? ""),
    creatorNotes: character?.creatorNotes ?? "",
    characterVersion: character?.characterVersion ?? "",
    firstMessage: character?.firstMessage ?? "",
    alternateGreetings: character?.alternateGreetings ?? [],
    lastMessage: last?.content ?? "",
    ...(last === undefined ? {} : { lastMessageId: history.length - 1 }),
    lastUserMessage: history.findLast((turn) => turn.role === "user")?.content ?? "",
    lastCharMessage: history.findLast((turn) => turn.role === "assistant")?.content ?? "",
    ...(macroRuntime.firstDisplayedMessageId !== undefined
      ? { firstDisplayedMessageId: macroRuntime.firstDisplayedMessageId }
      : history.length > 0
        ? { firstDisplayedMessageId: 0 }
        : {}),
    ...(macroRuntime.firstIncludedMessageId === undefined
      ? {}
      : { firstIncludedMessageId: macroRuntime.firstIncludedMessageId }),
    ...(last?.role === "assistant" && macroRuntime.lastSwipeId !== undefined
      ? { lastSwipeId: macroRuntime.lastSwipeId }
      : {}),
    ...(last?.role === "assistant" && macroRuntime.currentSwipeId !== undefined
      ? { currentSwipeId: macroRuntime.currentSwipeId }
      : {}),
    allChatRange: history.length > 0 ? `0-${history.length - 1}` : "",
    isMobile: macroRuntime.isMobile ?? false,
    input: macroRuntime.input ?? "",
    ...(macroRuntime.idleDuration === undefined ? {} : { idleDuration: macroRuntime.idleDuration }),
    lastGenerationType: input.generationType ?? "normal",
    ...(runtime === undefined
      ? {}
      : {
          model: runtime.model,
          maxContextTokens: runtime.window,
          maxResponseTokens: runtime.reserve,
          maxPrompt: runtime.window - runtime.reserve,
        }),
  };
  const fill = (text: string) => substituteMacros(text, base);
  const examples = fill(character?.exampleDialogue ?? "");
  base.exampleDialogue = examples;
  return base;
}

/** Adds the blind card fields to a template context. */
function withCardFields(base: MacroContext, input: MacroInput): MacroContext {
  const { character, persona } = input;
  const state = base.state ?? emptyMacroState();
  const raw = {
    description: character?.description ?? "",
    personality: character?.personality ?? "",
    scenario: character?.scenario ?? "",
    persona: persona?.description ?? "",
  };
  // The blind base keeps references to other card fields empty, including cycles.
  let fieldWork = 0;
  return {
    ...base,
    resolveCardField(field) {
      fieldWork += raw[field].length + 1;
      if (fieldWork > MAX_MACRO_WORK) throw new AggregateMacroLimitError();
      return substituteMacros(raw[field], {
        ...base,
        state: this.state ?? state,
        ...(this.workBudget === undefined ? {} : { workBudget: this.workBudget }),
      });
    },
  };
}

function baseMacroContext(
  input: MacroInput,
  workBudget: MacroWorkBudget = createMacroWorkBudget(),
): MacroContext {
  return withCardFields(templateContext(input, workBudget), input);
}

/** Cached source fields and dynamic metadata share one foreground working state. */
export function macroContext(input: MacroInput, workBudget?: MacroWorkBudget): MacroContext {
  const context = baseMacroContext(input, workBudget);
  for (const field of ["description", "personality", "scenario", "persona"] as const) {
    context[field] = context.resolveCardField?.(field) ?? "";
  }
  return context;
}

/** New chat text with its macros filled, and the memory state the caller commits. */
export interface FilledText {
  content: string;
  macroState: MacroState;
}

/**
 * Fills several texts from one input: the example dialogue is expanded
 * once, and each text starts from its own copy of the state after it.
 */
export function chatTextFiller(
  input: MacroInput,
  workBudget: MacroWorkBudget = createMacroWorkBudget(),
): (text: string) => FilledText {
  const template = templateContext(input, workBudget);
  const after = template.state ?? emptyMacroState();
  return (text) => {
    const context = withCardFields({ ...template, state: cloneMacroState(after) }, input);
    const content = substituteMacros(text, context);
    return { content, macroState: context.state ?? emptyMacroState() };
  };
}

/** Expand new greeting/user/model text once; the caller commits the returned memory state. */
export function fillChatText(
  text: string,
  input: MacroInput,
  workBudget?: MacroWorkBudget,
): FilledText {
  const context = baseMacroContext(input, workBudget);
  const content = substituteMacros(text, context);
  return { content, macroState: context.state ?? emptyMacroState() };
}

/** Where a message `depth` turns from the end goes among `turns` turns: before that turn. */
export const injectionSlot = (turns: number, depth: number) => Math.max(0, turns - depth);

/**
 * Add to Prompts: the history indexes of the latest `maxAdditions` replies
 * with reasoning, none when the preset sends none back.
 */
export function reasoningSentBack(
  history: ChatTurn[],
  { addToPrompts, maxAdditions }: Pick<PromptReasoning, "addToPrompts" | "maxAdditions">,
): Set<number> {
  if (!addToPrompts) return new Set();
  return new Set(
    history
      .flatMap((turn, index) =>
        turn.role === "assistant" && (turn.reasoning ?? "").trim() !== "" ? [index] : [],
      )
      .slice(-maxAdditions),
  );
}

export function assemblePrompt(input: AssemblyInput): Assembly {
  const { preset, character, mode = "reply" } = input;
  const generationType = input.generationType ?? (mode === "reply" ? "normal" : mode);
  const context = macroContext({ ...input, generationType });
  let expandedSize = 0;
  const chargeOutput = (filled: string) => {
    expandedSize += filled.length;
    if (expandedSize > MAX_MACRO_WORK) throw new AggregateMacroLimitError();
    return filled;
  };
  const macros = (text: string, extra: Partial<MacroContext> = {}) =>
    chargeOutput(substituteMacros(text, { ...context, ...extra }));

  const segments: Segment[] = [];
  const provenance = new Map<PromptMessage, readonly number[]>();
  const fixed = (
    role: PromptRole,
    content: string,
    source: PromptSource,
    entries: readonly number[] = [],
  ) => {
    if (content.trim() !== "") {
      const message = { role, content, source };
      segments.push({ kind: "fixed", message });
      if (entries.length > 0) provenance.set(message, entries);
    }
  };
  /**
   * A card's own prompt replaces the preset's when preferred; `{{original}}`
   * inserts the preset's.
   */
  const overridden = (own: string | undefined, preset: string, preferred: boolean) => {
    const original = macros(preset);
    return preferred && own !== undefined && own.trim() !== ""
      ? macros(own, { original })
      : original;
  };
  const prefer = input.prefer ?? DEFAULT_SETTINGS;
  const injections: Injection[] = [];
  const text = new Map<PromptBlock, string>();
  let historySize = 0;

  // Add to Prompts: the reasoning of the latest replies in the tag, then a line
  /** Reasoning precedes the reply with a line break. */
  const { reasoning } = preset;
  const sentBack = reasoningSentBack(input.history, reasoning);
  const withReasoning = (turn: ChatTurn, index: number) =>
    sentBack.has(index) ? `${reasoningBlock(reasoning.tag, turn)}${turn.content}` : turn.content;
  const generatedHistory = (turn: ChatTurn, index: number) => {
    const state = cloneMacroState(context.state ?? emptyMacroState());
    const transaction = { ...context, state };
    let content: string;
    try {
      const prefixLength = turn.macroPrefixLength ?? 0;
      if (prefixLength === 0) {
        // Preserve the existing substitution order and seeded source for unedited replies.
        content = substituteMacros(withReasoning(turn, index), transaction);
      } else {
        const literal = turn.content.slice(0, prefixLength);
        const raw = turn.content.slice(prefixLength);
        const reasoningText = sentBack.has(index) ? reasoningBlock(reasoning.tag, turn) : "";
        const filledReasoning = substituteMacros(reasoningText, transaction);
        const filled = substituteMacros(
          raw,
          transaction,
          MAX_MACRO_OUTPUT - filledReasoning.length,
        );
        content = filledReasoning + literal + filled;
      }
      context.state = state;
    } catch (error) {
      if (!(error instanceof MacroLimitError) || error instanceof AggregateMacroLimitError)
        throw error;
      // Generated text may become unexpandable after later state changes.
      // Keep it literal, with all of this turn's tentative effects discarded.
      content = withReasoning(turn, index);
    }
    return chargeOutput(content);
  };

  const triggered = (block: Exclude<PromptBlock, { kind: "chatHistory" }>) =>
    block.triggers === undefined ||
    block.triggers.length === 0 ||
    block.triggers.includes(generationType);
  const placed = (block: Placeable, content: string, source: PromptSource) => {
    const fallback = block.kind === "source" && !triggered(block);
    const role = fallback ? "system" : blockRole(block);
    const depth = block.depth == null ? null : fallback ? 0 : block.depth;
    if (depth === null) fixed(role, content, source);
    else if (content.trim() !== "")
      injections.push({
        depth,
        order: fallback ? PRESET_LIMITS.defaultOrder : blockOrder(block),
        message: { role, content, source },
      });
  };
  const add = (block: PromptBlock) => {
    switch (block.kind) {
      case "text":
        if (triggered(block)) placed(block, text.get(block) ?? "", { kind: "block", id: block.id });
        break;
      case "custom":
        if (triggered(block))
          placed(block, text.get(block) ?? "", {
            kind: "custom",
            id: block.id,
            name: block.name,
            depth: block.depth,
          });
        break;
      case "source":
        switch (block.id) {
          case "personaDescription": {
            // The source is fresh, but crossfield references read prepared source fields.
            const persona = macros(input.persona?.description ?? "", {
              resolveCardField: (field) => context[field],
            });
            placed(block, templated(persona, block.template), { kind: "block", id: block.id });
            break;
          }
          case "charDescription":
            placed(block, templated(context.description, block.template), {
              kind: "block",
              id: block.id,
            });
            break;
          case "charPersonality":
            placed(block, templated(context.personality, block.template), {
              kind: "block",
              id: block.id,
            });
            break;
          case "scenario":
            placed(block, templated(context.scenario, block.template), {
              kind: "block",
              id: block.id,
            });
            break;
          case "castAnchors":
            fixed("system", templated(castAnchors, block.template), {
              kind: "block",
              id: block.id,
            });
            break;
          case "dialogueExamples": {
            const wrapper = (content: string) => templated(content, block.template);
            const blocks = [
              ...loreExamples("before", lore?.examples.before ?? [], wrapper, provenance),
              ...exampleBlocks(macros(character?.exampleDialogue ?? ""), wrapper),
              ...loreExamples("after", lore?.examples.after ?? [], wrapper, provenance),
            ];
            if (blocks.length > 0) segments.push({ kind: "examples", blocks });
            break;
          }
          case "lorebookBefore":
          case "lorebookAfter": {
            const position = block.id === "lorebookBefore" ? "before" : "after";
            const entries = lore?.[position] ?? [];
            if (entries.length === 0) break;
            const wrapped = templated(
              entries.map((entry) => entry.content).join("\n"),
              block.template,
            );
            fixed(
              "system",
              wrapped,
              {
                kind: "lorebook",
                position,
                entries: entries.length,
              },
              entries.map((entry) => entry.index),
            );
            break;
          }
        }
        break;
      case "chatHistory": {
        segments.push({
          kind: "history",
          turns: input.history.map((turn, index) => {
            const name = speakerOf(turn, context);
            const prefix = turn.role === "user" && name !== context.user;
            const content = `${prefix ? `${name}: ` : ""}${
              turn.role === "assistant" && turn.macroEligible === true
                ? generatedHistory(turn, index)
                : withReasoning(turn, index)
            }`;
            historySize += content.length;
            if (historySize > MAX_MACRO_WORK) throw new AggregateMacroLimitError();
            return {
              role: turn.role,
              content,
              historySpeaker: { name, prefixed: prefix },
              source: { kind: "history" as const, index },
            };
          }),
          continues: mode === "continue",
          injections: [],
        });
        break;
      }
    }
  };

  /** Expand a wrapper once; source data is already expanded and remains inert. */
  const templated = (content: string, template?: string): string => {
    if (content.trim() === "" || !template) return content;
    const format = macros(template);
    const parts = format.split(SOURCE_PLACEHOLDER);
    if (format.length + (parts.length - 1) * content.length > MAX_MACRO_OUTPUT)
      throw new MacroLimitError();
    return chargeOutput(parts.join(content));
  };

  const memory = input.memory == null ? null : memoryMessages(input.memory, input, context.user);
  /** Where the memory went in, right after the story block: the history's place. */
  let afterStory: number | null = null;
  const placeStory = () => {
    if (afterStory !== null || memory === null) return;
    if (memory.story !== null) segments.push({ kind: "fixed", message: memory.story });
    afterStory = segments.length;
  };

  const due = authorsNote(input, context);
  const lore = lorebook(input, context, due !== null);
  const noteMessage = due === null ? null : withNoteEntries(due, lore?.authorsNote);
  if (noteMessage !== null && lore !== null) {
    const entries = [...lore.authorsNote.top, ...lore.authorsNote.bottom];
    if (entries.length > 0)
      provenance.set(
        noteMessage,
        entries.map((entry) => entry.index),
      );
  }
  const note = due === null || noteMessage === null ? null : { ...due, message: noteMessage };
  // Text substitutions precede source placement and raw generated history expansion.
  // Cached strings survive flattening, token budgeting and post-processing retries.
  for (const block of preset.blocks) {
    if (!block.enabled || (block.kind !== "text" && block.kind !== "custom") || !triggered(block))
      continue;
    text.set(
      block,
      block.kind === "custom"
        ? macros(block.content)
        : block.id === "main"
          ? overridden(
              character?.systemPrompt,
              block.content,
              prefer.preferCharacterPrompt && !block.forbidOverrides,
            )
          : overridden(
              character?.postHistoryInstructions,
              block.content,
              prefer.preferCharacterInstructions && !block.forbidOverrides,
            ),
    );
  }
  const castAnchors = input.cast === undefined ? "" : castAnchorsText(input.cast);
  const blocks = castAnchors === "" ? preset.blocks : castAnchorsPlace(preset.blocks);
  for (const block of blocks) {
    // The memory block keeps the history's place even when the preset sends no history.
    if (block.kind === "chatHistory") placeStory();
    if (block.kind === "chatHistory" ? block.enabled !== false : block.enabled) add(block);
    if (block.id === "main" && note?.position === "afterMain") {
      segments.push({ kind: "fixed", message: note.message });
    }
  }
  if (note?.position === "inChat") {
    injections.push({
      depth: note.depth,
      order: PRESET_LIMITS.defaultOrder,
      message: note.message,
    });
  }
  const characterNote = character?.characterNote ?? null;
  if (characterNote !== null) {
    const content = macros(characterNote.prompt);
    if (content.trim() !== "") {
      injections.push({
        depth: characterNote.depth,
        order: PRESET_LIMITS.defaultOrder,
        message: {
          role: characterNote.role,
          content,
          source: { kind: "characterNote", depth: characterNote.depth },
        },
      });
    }
  }
  /** Depth entries follow the notes at their depth and role. */
  // `wi-depth-order`); outside the history, so trimming keeps them like every injection.
  for (const group of lore?.depth ?? []) {
    const message: PromptMessage = {
      role: group.role,
      content: group.entries.map((entry) => entry.content).join("\n"),
      source: {
        kind: "lorebook",
        position: "depth",
        depth: group.depth,
        role: group.role,
        entries: group.entries.length,
      },
    };
    provenance.set(
      message,
      group.entries.map((entry) => entry.index),
    );
    injections.push({
      depth: group.depth,
      order: PRESET_LIMITS.defaultOrder,
      message,
    });
  }
  placeStory();
  const hasHistory = segments.some((segment) => segment.kind === "history");
  /** Where a message follows the story block without a history to sit in. */
  let afterMemory = afterStory ?? segments.length;
  if (memory?.recalled != null) {
    if (hasHistory) {
      injections.push({
        depth: MEMORY_RECALL_DEPTH,
        order: PRESET_LIMITS.defaultOrder,
        message: memory.recalled,
      });
    } else {
      // Without a history to sit in, the recalled block follows the story block.
      segments.splice(afterMemory, 0, { kind: "fixed", message: memory.recalled });
      afterMemory += 1;
    }
  }
  const castState = input.cast === undefined ? "" : castStateText(input.cast);
  if (castState !== "") {
    const message: PromptMessage = {
      role: "user",
      content: castState,
      source: { kind: "castState", depth: CAST_STATE_DEPTH },
    };
    // One order past the notes': its own message after the Author's Note at its depth.
    if (hasHistory)
      injections.push({
        depth: CAST_STATE_DEPTH,
        order: PRESET_LIMITS.defaultOrder + 1,
        message,
      });
    else segments.splice(afterMemory, 0, { kind: "fixed", message });
  }
  const eventText = input.event == null ? "" : macros(input.event.text);
  const event: PromptMessage | null =
    eventText.trim() === ""
      ? null
      : { role: "system", content: eventMessage(eventText), source: { kind: "event" } };
  /** Action instructions follow the completed prompt. */
  if (mode === "impersonate" || mode === "continue") {
    fixed(
      "system",
      macros(mode === "continue" ? preset.actions.continue : preset.actions.writeForMe),
      { kind: "instruction", id: mode },
    );
  }

  const ordered = injectionMessages(injections, provenance);
  // The event follows every other depth-0 message, apart from them; without a history, last.
  if (event !== null) {
    if (segments.some((segment) => segment.kind === "history"))
      ordered.push({ depth: 0, message: event });
    else segments.push({ kind: "fixed", message: event });
  }
  for (const segment of segments) if (segment.kind === "history") segment.injections = ordered;
  const rendered = new Set(
    lore === null
      ? []
      : flatten({ segments, lorebook: null, lorebookState: null }).flatMap(
          (message) => provenance.get(message) ?? [],
        ),
  );
  const finalize = (sent: ReadonlySet<number>): Pick<Assembly, "lorebook" | "lorebookState"> => {
    const final = lore?.finalize(sent, rendered);
    return { lorebook: final?.report ?? null, lorebookState: final?.state ?? null };
  };
  return {
    segments,
    ...finalize(rendered),
    ...(lore === null ? {} : { lorebookDelivery: { entries: provenance, finalize } }),
    ...(input.event == null ? {} : { eventSent: event !== null }),
    ...(memory === null ? {} : { memory: memory.report }),
    macroState: context.state ?? emptyMacroState(),
    generationType,
  };
}

/**
 * The memory's two messages within `MEMORY_LIMITS.share` of the window: the
 * story block with the notebook, always, and the newest of this chat's
 * recap, or of the episodes told before it, while they fit; then, unless
 * recall is off, the recalled block with the ranked candidates, the left-out
 * episodes among them, that fit. Episodes from the book at large go in
 * story order (`storyOrder`). The notebook and the episodes read the
 * persona's placeholder as `user`, the persona's name, before anything
 * ranks, measures or tells them.
 */
function memoryMessages(
  memory: NonNullable<AssemblyInput["memory"]>,
  input: AssemblyInput,
  user: string,
): {
  story: PromptMessage | null;
  recalled: PromptMessage | null;
  report: NonNullable<Assembly["memory"]>;
} {
  const { fresh = false, continued = false, count, window, recall = true } = memory;
  const named = (text: string) => fillUserPlaceholder(text, user);
  const namedEpisode = (episode: StoredEpisode): StoredEpisode => ({
    ...episode,
    title: named(episode.title),
    summary: named(episode.summary),
    cues: episode.cues.map(named),
  });
  const notebook: MemoryNotebook = {
    situation: named(memory.notebook.situation),
    relationships: memory.notebook.relationships.map(named),
    facts: memory.notebook.facts.map(named),
    threads: memory.notebook.threads.map(named),
    // Remembered anchors reach the narrator only through the corrected cast register.
    cast: [],
  };
  const recap = memory.recap.map(namedEpisode);
  const before = memory.before?.map(namedEpisode);
  const candidates = memory.candidates.map(namedEpisode);
  const limit = Math.floor(MEMORY_LIMITS.share * window);
  const hasNotebook = notebookHasContent(notebook);
  const book = [...recap, ...(before ?? []), ...candidates];
  // The episodes the story block may tell, oldest first: those before this chat, then its own.
  const tellable = [...storyOrder(before ?? [], book), ...recap];
  const isBefore = new Set((before ?? []).map((episode) => episode.id));
  const storyText = (told: readonly StoredEpisode[]) =>
    memoryStoryText(notebook, {
      recap: told.filter((episode) => !isBefore.has(episode.id)),
      before: told.filter((episode) => isBefore.has(episode.id)),
      fresh,
      continued,
    });
  // How many of the newest episodes go in: the most that fit with the notebook. A longer
  // suffix only adds text, so the fit is monotonic in the count and a binary search finds it
  // with a few exact counts instead of one per episode.
  const counted = new Map<number, number>();
  const storyTokens = (kept: number) => {
    let tokens = counted.get(kept);
    if (tokens === undefined) {
      tokens = count(storyText(tellable.slice(tellable.length - kept)));
      counted.set(kept, tokens);
    }
    return tokens;
  };
  let kept = 0;
  let over = tellable.length + 1;
  while (over - kept > 1) {
    const middle = Math.floor((kept + over) / 2);
    if (storyTokens(middle) <= limit) kept = middle;
    else over = middle;
  }
  const told = tellable.slice(tellable.length - kept);
  const left = tellable.slice(0, tellable.length - kept);
  // A chat opened on the memory's opening is told it continues, even with nothing else to tell.
  const content = hasNotebook || told.length > 0 || (fresh && continued) ? storyText(told) : null;
  const toldBefore = told.filter((episode) => isBefore.has(episode.id));
  const toldRecap = told.filter((episode) => !isBefore.has(episode.id));
  const story: PromptMessage | null =
    content === null
      ? null
      : {
          role: "system",
          content,
          source: {
            kind: "memory",
            part: "story",
            notebook: hasNotebook,
            episodes: told.length,
          },
        };
  const room = limit - (content === null ? 0 : storyTokens(kept));
  // Ranking needs room for the recalled block's heading at least.
  const pool = [...left, ...candidates];
  // Generated replies keep their macros until sent: the persona's reads as its name here too.
  const spoken = input.history.map((turn) => ({ content: named(turn.content) }));
  const chosen =
    recall && room >= count(memoryRecalledText([]))
      ? storyOrder(fitRecall(rankRecall(pool, spoken), count, room, undefined, pool), book)
      : [];
  // The user role, as the preset's Author's Note takes: CLIProxyAPI hoists a mid-chat system
  // message into Claude's system prompt, which would change the stable prefix with each recall.
  const recalled: PromptMessage | null =
    chosen.length === 0
      ? null
      : {
          role: "user",
          content: memoryRecalledText(chosen),
          source: {
            kind: "memory",
            part: "recalled",
            episodes: chosen.length,
            depth: MEMORY_RECALL_DEPTH,
          },
        };
  return {
    story,
    recalled,
    report: {
      recap: toldRecap.map((episode) => episode.id),
      before: toldBefore.map((episode) => episode.id),
      recalled: chosen.map((episode) => episode.id),
    },
  };
}

/** Native example passages retain narration and speaker labels. Original source ranges identify the entries contributing to each passage. */
function loreExamples(
  side: "before" | "after",
  entries: SentEntry[],
  wrapper: (content: string) => string,
  provenance: Map<PromptMessage, readonly number[]>,
): PromptMessage[][] {
  if (entries.length === 0) return [];
  let offset = 0;
  const ranges = entries.map((entry) => {
    const start = offset;
    offset += entry.content.length + 1;
    return { index: entry.index, start, end: offset - 1 };
  });
  let at = 0;
  const text = entries.map((entry) => entry.content).join("\n");
  const blocks = exampleBlocks(text, wrapper, (message, start, end) => {
    while (at < ranges.length && (ranges[at]?.end ?? 0) <= start) at += 1;
    const contributors: number[] = [];
    for (let index = at; index < ranges.length; index += 1) {
      const range = ranges[index];
      if (range === undefined || range.start >= end) break;
      contributors.push(range.index);
    }
    if (contributors.length > 0) provenance.set(message, contributors);
  });
  for (const [index, block] of blocks.entries()) {
    for (const [line, message] of block.entries()) {
      message.source = {
        kind: "lorebook",
        position: "examples",
        side,
        index,
        line,
        entries: entries.length,
      };
    }
  }
  return blocks;
}

/** Note entries above and below its text join with line breaks. Empty note text retains its line when entries are present; nothing is sent when every part is empty. */
function withNoteEntries(
  note: Pick<AuthorsNote, "position" | "depth"> & { message: PromptMessage },
  entries: { top: SentEntry[]; bottom: SentEntry[] } | undefined,
): PromptMessage | null {
  const top = entries?.top ?? [];
  const bottom = entries?.bottom ?? [];
  const count = top.length + bottom.length;
  if (count === 0) return note.message.content.trim() === "" ? null : note.message;
  const texts = (list: SentEntry[]) => list.map((entry) => entry.content);
  return {
    ...note.message,
    content: [...texts(top), note.message.content, ...texts(bottom)].join("\n"),
    merged: [
      {
        kind: "lorebook",
        position: "authorsNote",
        depth: note.position === "inChat" ? note.depth : null,
        entries: count,
      },
    ],
  };
}

/**
 * The character's books activated together against this request, the
 * card's own first, then the linked ones: their entries fill the preset's
 * lorebook blocks, the example dialogue, the Author's Note (when `noteDue`)
 * and the chat, reading the same macro context.
 */
function lorebook(input: AssemblyInput, context: MacroContext, noteDue: boolean) {
  if (input.lorebook === undefined) return null;
  const book = input.character?.lorebook;
  const sources: LorebookSource[] = [
    ...(book === undefined ? [] : [{ id: null, name: book.name ?? "", book }]),
    ...(input.lorebook.linked ?? []),
  ];
  if (sources.length === 0) return null;
  const enabled = (id: "lorebookBefore" | "lorebookAfter" | "dialogueExamples") =>
    input.preset.blocks.some(
      (block) => block.id === id && block.kind === "source" && block.enabled,
    );
  const { state, characterId, digest, folded } = input.lorebook;
  const history = input.preset.blocks.some(
    (block) => block.kind === "chatHistory" && block.enabled !== false,
  );
  const { books, budget } = combineLorebooks(sources, input.lorebook.window);
  return activateLorebooks({
    books,
    turns: input.history,
    names: { char: context.char, user: context.user },
    macros: (text, limit, workBudget) =>
      substituteMacros(
        text,
        workBudget === undefined
          ? context
          : {
              ...context,
              workBudget: (units) => {
                context.workBudget?.(units);
                workBudget(units);
              },
            },
        limit,
      ),
    count: input.lorebook.count,
    budget,
    blocks: {
      before: enabled("lorebookBefore"),
      after: enabled("lorebookAfter"),
      examples: enabled("dialogueExamples"),
      authorsNote: noteDue && (input.preset.authorsNote.position !== "inChat" || history),
      history,
    },
    timed:
      characterId === undefined || digest === undefined
        ? null
        : { state: state ?? null, characterId, digest },
    ...(folded === undefined ? {} : { folded }),
    random: input.random,
  });
}

/**
 * The preset's Author's Note when it is on and due by its frequency,
 * whatever its text; its message may be empty, and then only its entries
 * make it sent.
 */
function authorsNote(
  input: AssemblyInput,
  context: MacroContext,
): (Pick<AuthorsNote, "position" | "depth"> & { message: PromptMessage }) | null {
  const note = input.preset.authorsNote;
  if (!note.enabled || note.frequency === 0) return null;
  // Every n-th user turn: 1 is every request; a larger n needs n turns first.
  const users =
    (input.foldedUsers ?? 0) + input.history.filter((turn) => turn.role === "user").length;
  if (note.frequency > 1 && (users === 0 || users % note.frequency !== 0)) return null;
  const content = substituteMacros(note.text, context);
  return {
    position: note.position,
    depth: note.depth,
    message: {
      role: note.role,
      content,
      source: { kind: "authorsNote", depth: note.position === "inChat" ? note.depth : null },
    },
  };
}

/** How much of the droppable parts to keep; everything when absent. */
export interface Kept {
  /** Example blocks, from the first. */
  examples: number;
  /** History turns, from the latest. */
  turns: number;
}

/**
 * The messages that are sent, in order: the kept examples and turns, each
 * injection at its depth, and a continued reply held back until just
 * before the Continue nudge. Post-processing joins messages, not this.
 */
export function flatten(assembly: Assembly, kept?: Kept): PromptMessage[] {
  const messages: PromptMessage[] = [];
  /** The reply a Continue extends, held back until just before the nudge. */
  let continued: PromptMessage | null = null;
  for (const segment of assembly.segments) {
    if (segment.kind === "fixed") {
      if (continued !== null && segment.message.source.kind === "instruction") {
        messages.push(continued);
        continued = null;
      }
      messages.push(segment.message);
    } else if (segment.kind === "examples") {
      messages.push(...segment.blocks.slice(0, kept?.examples ?? segment.blocks.length).flat());
    } else {
      const turns = segment.turns.slice(
        segment.turns.length - (kept?.turns ?? segment.turns.length),
      );
      const last = segment.continues ? turns.at(-1) : undefined;
      const slots = Map.groupBy(segment.injections, ({ depth }) =>
        injectionSlot(turns.length, depth),
      );
      // Depth 0 goes after the last turn, depth n before the n-th from the end; deeper, at the top.
      for (let slot = 0; slot <= turns.length; slot += 1) {
        for (const { message } of slots.get(slot) ?? []) messages.push(message);
        const turn = turns[slot];
        if (turn === undefined) continue;
        if (turn === last) continued = turn;
        else messages.push(turn);
      }
    }
  }
  if (continued !== null) messages.push(continued);
  return messages;
}
