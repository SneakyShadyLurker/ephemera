import type { ArtFamily, WorkflowFormat } from "@ephemera/core";
import type { FinishReason } from "ai";

/**
 * The only fields a log line may carry. Chat content, request bodies, URLs
 * with queries and raw error objects are never logged (PRINCIPLES.md 1).
 */
export interface LogFields {
  event: string;
  route?: string;
  method?: string;
  status?: number;
  durationMs?: number;
  model?: string;
  errorClass?: string;
  /** How a model call ended: the AI SDK's finish reason, a fixed set of words. */
  finishReason?: FinishReason;
  /** Which call of a request this is: a card's automatic retry is its second. */
  attempt?: number;
  /** Whether a stored portrait went to the model as a reference. */
  reference?: boolean;
  /** Whether a workflow's reference graph painted with the portrait as its image input. */
  referenceGraph?: boolean;
  /** How many items an operational event concerns, such as orphaned portrait files deleted. */
  count?: number;
  /** A configuration file's base name, such as the workflow file that stopped the start; never its content. */
  file?: string;
  /** The image-model family a workflow file runs, such as the General family a file's name fell back to. */
  family?: ArtFamily;
  /** How many nodes a workflow graph has; never which. */
  nodes?: number;
  /** Whether a live ComfyUI checked a saved workflow. */
  checked?: boolean;
  /** The format of an imported workflow file, `ui` or `api`. */
  format?: WorkflowFormat;
}

const ALLOWED_KEYS = [
  "event",
  "route",
  "method",
  "status",
  "durationMs",
  "model",
  "errorClass",
  "finishReason",
  "attempt",
  "reference",
  "referenceGraph",
  "count",
  "file",
  "family",
  "nodes",
  "checked",
  "format",
] as const satisfies readonly (keyof LogFields)[];

type Level = "info" | "warn" | "error";

export type Logger = Record<Level, (fields: LogFields) => void>;

export function createLogger(sink: (line: string) => void = (line) => console.log(line)): Logger {
  const write = (level: Level, fields: LogFields) => {
    const line: Record<string, string | number | boolean> = {
      time: new Date().toISOString(),
      level,
    };
    for (const key of ALLOWED_KEYS) {
      const value = fields[key];
      if (value !== undefined) line[key] = value;
    }
    sink(JSON.stringify(line));
  };
  return {
    info: (fields) => write("info", fields),
    warn: (fields) => write("warn", fields),
    error: (fields) => write("error", fields),
  };
}

/** The error's class name; never its message, which can carry the prompt. */
export function errorClass(error: unknown): string {
  if (error instanceof Error) return error.name;
  return typeof error;
}
