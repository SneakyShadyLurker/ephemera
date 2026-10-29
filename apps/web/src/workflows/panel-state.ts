import {
  type ArtFamily,
  type BlockedNode,
  type BlockedReason,
  type FinalizeResult,
  finalizeWorkflow,
  type Inspection,
  type NodeTitles,
  type WorkflowChoices,
  type WorkflowGraph,
  type WorkflowRefusalCode,
  type WorkflowSummary,
} from "@ephemera/core";
import { nameTakenLine, renameProblem } from "../settings/portraits.ts";
import { refusalText, SERVER_NAME_NOTE, type TabRefusal } from "./copy.ts";
import type { WorkflowFailure } from "./queries.ts";

/*
 * The import panel's state, as a pure reducer. The file, its parsed JSON,
 * the inspected graph and the draft live here, in the panel's component
 * state only: disposed when it closes, never in a URL, browser storage or
 * the query or mutation cache. A result for a request the panel has
 * moved on from is ignored by its id.
 */

/** A file as read in the tab: its name, for the panel only, and its parsed JSON. */
export interface ReadFile {
  fileName: string;
  source: unknown;
}

/** Where a save goes: a new workflow under the id the tab chose, or over one of the user's. */
export type SaveTarget =
  | { mode: "create"; id: string }
  | { mode: "replace"; workflow: WorkflowSummary };

/** A place the user may have to choose a node for, as `WorkflowChoices` names it. */
export type ChoicePlace = "prompt" | "latent" | "output";

/** An inspected file on its way to a save, and what the user made of it. */
export interface Draft {
  /** The read that inspected this file; a save result for another is stale. */
  request: number;
  inspection: Inspection;
  titles: NodeTitles;
  choices: WorkflowChoices;
  /** Core's finalization of the graph with `choices`, run again after each choice. */
  final: FinalizeResult;
  name: string;
  family: ArtFamily;
  target: SaveTarget;
  /** The name the server last said is taken. */
  takenName: string | null;
  /** The inspection's blocked nodes, and any a save was refused for. */
  blocked: BlockedNode[];
  /** The classes the last save was refused for, listed even where the kept graph lacks them. */
  refusedClasses: string[];
  /**
   * Replace file: the graph is saved at this revision; only the name or family
   * still waits. A changed choice clears it, so the graph is sent again.
   */
  graphRevision: number | null;
  /** A create came back unreachable: the next Save looks for it in the list first. */
  unanswered: boolean;
}

/** Why a file cannot be imported at all. */
export type FileRefusal =
  | TabRefusal
  | { kind: "invalid_workflow"; code: WorkflowRefusalCode; nodes: string[] };

/** An inspection that did not answer, the file kept for Try again. */
export type InspectStall = "busy" | "comfyui_required" | "unreachable";

/** A save that did not go through; the draft stays. */
export type SaveFailure =
  | { kind: "full" }
  | { kind: "unreachable" }
  | { kind: "not_found" }
  | { kind: "conflict"; revision: number }
  | { kind: "refused"; code: WorkflowRefusalCode; nodes: string[] };

export type PanelState =
  | { phase: "idle" }
  | {
      phase: "reading";
      request: number;
      controller: AbortController;
      fileName: string;
      /** Null until the tab has read and parsed it. */
      file: ReadFile | null;
    }
  | { phase: "refused"; fileName: string; refusal: FileRefusal }
  | { phase: "failed"; stage: "inspect"; file: ReadFile; failure: InspectStall }
  | { phase: "inspected"; file: ReadFile; draft: Draft }
  | { phase: "saving"; file: ReadFile; draft: Draft }
  | { phase: "failed"; stage: "save"; file: ReadFile; draft: Draft; failure: SaveFailure };

export type PanelAction =
  | { type: "read"; request: number; controller: AbortController; fileName: string }
  | { type: "parsed"; request: number; file: ReadFile }
  /** `request` null: refused before any request was made (too large). */
  | { type: "refused"; request: number | null; fileName: string; refusal: TabRefusal }
  | { type: "inspected"; request: number; inspection: Inspection; target: SaveTarget }
  | {
      type: "inspectFailed";
      request: number;
      failure: Extract<
        WorkflowFailure,
        { reason: "busy" | "comfyui_required" | "invalid_workflow" | "too_large" | "unreachable" }
      >;
    }
  | { type: "retry"; request: number; controller: AbortController }
  | { type: "choose"; place: ChoicePlace; node: string }
  | { type: "name"; name: string }
  | { type: "family"; family: ArtFamily }
  | { type: "save" }
  /** Save results carry the draft's `request`; one for a draft the panel left is ignored. */
  | { type: "graphSaved"; request: number; revision: number }
  | { type: "saveFailed"; request: number; failure: WorkflowFailure }
  | { type: "importAsNew"; id: string }
  /** A create that answered unreachable is in the list after all: the draft replaces it. */
  | { type: "landed"; workflow: WorkflowSummary }
  | { type: "saved"; request: number }
  | { type: "close" };

export const INITIAL_PANEL: PanelState = { phase: "idle" };

/** The refusal each place reports while no node fills it. */
const PLACE_CODES: Record<ChoicePlace, WorkflowRefusalCode> = {
  output: "no_output",
  latent: "no_size_slot",
  prompt: "no_prompt_slot",
};
const isPlaceCode = (code: WorkflowRefusalCode): boolean =>
  Object.values(PLACE_CODES).includes(code);

const finalize = (inspection: Inspection, choices: WorkflowChoices, titles: NodeTitles) =>
  finalizeWorkflow(
    { graph: inspection.graph, ...inspection.report },
    inspection.detection,
    choices,
    undefined,
    titles,
  );

const current = (state: PanelState, request: number | null): boolean =>
  state.phase === "reading" && state.request === request;

/** Whether a save result is for the save in flight. */
const saving = (
  state: PanelState,
  request: number,
): state is Extract<PanelState, { phase: "saving" }> =>
  state.phase === "saving" && state.draft.request === request;

/** The draft the panel shows and saves from, if it has one. */
export const draftOf = (state: PanelState): Draft | null => ("draft" in state ? state.draft : null);

/** Whether closing would lose a read, unsaved file: the panel asks first. */
export const isDirty = (state: PanelState): boolean => draftOf(state) !== null;

/** The draft in its next form, kept in whichever phase the panel is in. */
function withDraft(state: PanelState, change: (draft: Draft) => Draft): PanelState {
  if (state.phase === "inspected") return { ...state, draft: change(state.draft) };
  if (state.phase === "failed" && state.stage === "save") {
    return { phase: "inspected", file: state.file, draft: change(state.draft) };
  }
  return state;
}

function saveFailed(state: PanelState, request: number, failure: WorkflowFailure): PanelState {
  if (!saving(state, request)) return state;
  const { file, draft } = state;
  const failed = (next: SaveFailure, kept = draft): PanelState => ({
    phase: "failed",
    stage: "save",
    file,
    draft: kept,
    failure: next,
  });
  switch (failure.reason) {
    case "name_taken":
      return { phase: "inspected", file, draft: { ...draft, takenName: draft.name.trim() } };
    case "blocked_nodes": {
      const known = new Set(draft.blocked.map((node) => node.classType));
      const more = failure.nodes
        .filter((classType) => !known.has(classType))
        .map((classType): BlockedNode => ({ classType, reason: "not_allowed" }));
      return {
        phase: "inspected",
        file,
        draft: { ...draft, blocked: [...draft.blocked, ...more], refusedClasses: failure.nodes },
      };
    }
    case "unreachable":
      return failed(
        { kind: "unreachable" },
        draft.target.mode === "create" ? { ...draft, unanswered: true } : draft,
      );
    case "full":
    case "not_found":
      return failed({ kind: failure.reason });
    case "conflict":
      return failed({ kind: "conflict", revision: failure.revision });
    case "invalid_workflow":
      return failed({ kind: "refused", code: failure.code, nodes: failure.nodes });
    case "too_large":
      return failed({ kind: "refused", code: "too_large", nodes: [] });
    default:
      return failed({ kind: "unreachable" });
  }
}

export function panelReducer(state: PanelState, action: PanelAction): PanelState {
  switch (action.type) {
    case "read":
      return {
        phase: "reading",
        request: action.request,
        controller: action.controller,
        fileName: action.fileName,
        file: null,
      };
    case "parsed":
      return state.phase === "reading" && current(state, action.request)
        ? { ...state, file: action.file }
        : state;
    case "refused":
      if (action.request !== null && !current(state, action.request)) return state;
      return { phase: "refused", fileName: action.fileName, refusal: action.refusal };
    case "inspected": {
      if (state.phase !== "reading" || !current(state, action.request) || state.file === null) {
        return state;
      }
      const { inspection, target } = action;
      const titles: NodeTitles = new Map(inspection.nodes.map((node) => [node.id, node.title]));
      const final = finalize(inspection, {}, titles);
      if (!final.ok && !isPlaceCode(final.refusal.error)) {
        return {
          phase: "refused",
          fileName: state.file.fileName,
          refusal: {
            kind: "invalid_workflow",
            code: final.refusal.error,
            nodes: final.refusal.nodes ?? [],
          },
        };
      }
      return {
        phase: "inspected",
        file: state.file,
        draft: {
          request: action.request,
          inspection,
          titles,
          choices: {},
          final,
          name: target.mode === "replace" ? target.workflow.name : inspection.nameSuggestion,
          family:
            target.mode === "replace" ? target.workflow.family : inspection.detection.familyGuess,
          target,
          takenName: null,
          blocked: inspection.blocked,
          refusedClasses: [],
          graphRevision: null,
          unanswered: false,
        },
      };
    }
    case "inspectFailed": {
      if (state.phase !== "reading" || !current(state, action.request)) return state;
      const { failure } = action;
      const fileName = state.fileName;
      if (failure.reason === "invalid_workflow") {
        return {
          phase: "refused",
          fileName,
          refusal: { kind: "invalid_workflow", code: failure.code, nodes: failure.nodes },
        };
      }
      if (failure.reason === "too_large") {
        return { phase: "refused", fileName, refusal: { kind: "too_large" } };
      }
      if (state.file === null) return state;
      return { phase: "failed", stage: "inspect", file: state.file, failure: failure.reason };
    }
    case "retry":
      if (state.phase !== "failed" || state.stage !== "inspect") return state;
      return {
        phase: "reading",
        request: action.request,
        controller: action.controller,
        fileName: state.file.fileName,
        file: state.file,
      };
    case "choose":
      return withDraft(state, (draft) => {
        const choices: WorkflowChoices =
          action.place === "prompt"
            ? { ...draft.choices, prompt: [action.node] }
            : { ...draft.choices, [action.place]: action.node };
        // Another graph runs now: it is sent again and judged afresh.
        return {
          ...draft,
          choices,
          final: finalize(draft.inspection, choices, draft.titles),
          refusedClasses: [],
          graphRevision: null,
        };
      });
    case "name":
      return withDraft(state, (draft) => ({ ...draft, name: action.name }));
    case "family":
      return withDraft(state, (draft) => ({ ...draft, family: action.family }));
    case "save":
      if (state.phase === "inspected" || (state.phase === "failed" && state.stage === "save")) {
        return { phase: "saving", file: state.file, draft: state.draft };
      }
      return state;
    case "graphSaved":
      return saving(state, action.request)
        ? { ...state, draft: { ...state.draft, graphRevision: action.revision } }
        : state;
    case "saveFailed":
      return saveFailed(state, action.request, action.failure);
    case "importAsNew":
      return withDraft(state, (draft) => ({
        ...draft,
        target: { mode: "create", id: action.id },
        graphRevision: null,
      }));
    case "landed": {
      // Kept in its phase: it lands while the retried save is in flight.
      if (!("draft" in state)) return state;
      const { target } = state.draft;
      if (target.mode !== "create" || target.id !== action.workflow.id) return state;
      const replace: SaveTarget = { mode: "replace", workflow: action.workflow };
      return {
        ...state,
        draft: { ...state.draft, target: replace, graphRevision: null, unanswered: false },
      };
    }
    case "saved":
      return draftOf(state)?.request === action.request ? INITIAL_PANEL : state;
    case "close":
      return INITIAL_PANEL;
  }
}

/** A node as the panel names it: "title (node id)", or "node id" when the file did not list it. */
export const nodeName = (titles: NodeTitles, id: string): string => {
  const title = titles.get(id);
  return title === undefined ? `node ${id}` : `${title} (node ${id})`;
};

/** The user's names a draft's must differ from, and the server's it may share with a note. */
export interface ListNames {
  yours: readonly WorkflowSummary[];
  server: readonly string[];
}

/** What the name field says: a refusal in ember, or a note in reed. */
export function nameCheck(
  draft: Draft,
  names: ListNames,
): { problem: string | null; note: string | null } {
  const name = draft.name.trim();
  const replaced = draft.target.mode === "replace" ? draft.target.workflow.id : null;
  const others = names.yours.filter((other) => other.id !== replaced).map((other) => other.name);
  const problem =
    renameProblem(name, others) ??
    (draft.takenName !== null && draft.takenName.toLowerCase() === name.toLowerCase()
      ? nameTakenLine(name)
      : null);
  const lower = name.toLowerCase();
  const shared = names.server.some((other) => other.toLowerCase() === lower);
  return { problem, note: problem === null && shared ? SERVER_NAME_NOTE : null };
}

/** Whether finalization refuses for want of a node in `place`. */
const refusedAt = (draft: Draft, place: ChoicePlace): boolean =>
  !draft.final.ok && draft.final.refusal.error === PLACE_CODES[place];

/**
 * The places still waiting for the user's choice, in the list's order: none
 * once finalization fills them all, else the one it refuses for, unless chosen.
 */
export function unchosen(draft: Draft): ChoicePlace[] {
  return (["prompt", "latent", "output"] as const).filter(
    (place) => draft.choices[place] === undefined && refusedAt(draft, place),
  );
}

/** Whether a place's row offers a choice: finalization could not fill it, or the user chose. */
export function choosable(draft: Draft, place: ChoicePlace): boolean {
  return draft.choices[place] !== undefined || refusedAt(draft, place);
}

/** Why the user's own choice for `place` leaves it unfilled, in words; null otherwise. */
export function placeProblem(draft: Draft, place: ChoicePlace): string | null {
  if (draft.choices[place] === undefined || draft.final.ok || !refusedAt(draft, place)) return null;
  const { error, nodes = [] } = draft.final.refusal;
  return refusalText(
    error,
    nodes.map((id) => nodeName(draft.titles, id)),
  );
}

/** A choice finalization refuses for another reason than a place left open, in words. */
export function choiceProblem(draft: Draft): string | null {
  if (draft.final.ok || isPlaceCode(draft.final.refusal.error)) return null;
  const { error, nodes = [] } = draft.final.refusal;
  const named =
    error === "unknown_node" || error === "dynamic_inputs"
      ? nodes
      : nodes.map((id) => nodeName(draft.titles, id));
  return refusalText(error, named);
}

/** The Changed and Left out lines as the choices stand: finalization's, else the file's own. */
export const reportOf = (draft: Draft): { changed: string[]; skipped: string[] } =>
  draft.final.ok
    ? { changed: draft.final.changed, skipped: draft.final.skipped }
    : draft.inspection.report;

/** The graph as it would be saved, or the inspected one until finalization succeeds. */
const keptGraph = (draft: Draft) =>
  draft.final.ok ? draft.final.template : draft.inspection.graph;

/**
 * The blocked nodes still in the graph, by reason, each named "title (node
 * id)". A class a save was refused for is listed even when the kept graph
 * lacks it: by its nodes in the file, else by its class alone (id null).
 */
export function blockedGroups(
  draft: Draft,
): { reason: BlockedReason; nodes: { id: string | null; title: string }[] }[] {
  const groups = new Map<BlockedReason, { id: string | null; title: string }[]>();
  const nodesIn = (graph: WorkflowGraph, classType: string) =>
    Object.keys(graph)
      .filter((id) => graph[id]?.class_type === classType)
      .map((id) => ({ id, title: draft.titles.get(id) ?? classType }));
  for (const { classType, reason } of draft.blocked) {
    let names: { id: string | null; title: string }[] = nodesIn(keptGraph(draft), classType);
    if (names.length === 0 && draft.refusedClasses.includes(classType)) {
      const inFile = nodesIn(draft.inspection.graph, classType);
      names = inFile.length > 0 ? inFile : [{ id: null, title: classType }];
    }
    if (names.length === 0) continue;
    groups.set(reason, [...(groups.get(reason) ?? []), ...names]);
  }
  return [...groups].map(([reason, nodes]) => ({ reason, nodes }));
}

/**
 * Whether Save may be pressed, and how many places still wait. Never while
 * reading, refused or saving; never with a place unchosen, a choice core
 * refuses, a name the field refuses or a blocked node; after a failed save,
 * only when Save is the way on (not reached, or the list was full).
 */
export function saveCheck(
  state: PanelState,
  names: ListNames,
): { enabled: boolean; unchosen: number } {
  const draft = draftOf(state);
  if (draft === null) return { enabled: false, unchosen: 0 };
  const waiting = unchosen(draft).length;
  // A conflict, a deleted replacement and a refused graph each offer their own way on.
  const answered =
    state.phase !== "failed" ||
    state.stage !== "save" ||
    state.failure.kind === "unreachable" ||
    state.failure.kind === "full";
  const enabled =
    state.phase !== "saving" &&
    answered &&
    waiting === 0 &&
    draft.final.ok &&
    nameCheck(draft, names).problem === null &&
    blockedGroups(draft).length === 0;
  return { enabled, unchosen: waiting };
}
