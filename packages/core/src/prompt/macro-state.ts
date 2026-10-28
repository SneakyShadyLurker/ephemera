import { z } from "zod";

/** Both namespaces are chat content: keep them in tab/request memory only. */
export interface MacroState {
  local: Record<string, string>;
  global: Record<string, string>;
}

export const MACRO_STATE_LIMITS = {
  name: 256,
  value: 64 * 1024,
  variables: 512,
  total: 256 * 1024,
  /** Sparse arrays must be bounded before assignment/serialization. */
  indexedArray: 10_000,
  jsonDepth: 64,
} as const;

/**
 * The one variable name never stored: setting it does nothing. The AI SDK's
 * stream parser refuses any object with an own `__proto__` key, so a state
 * holding one would fail the reply that carries it.
 */
export const RESERVED_MACRO_NAME = "__proto__";

/** Within `max` UTF-16 units, the unit the evaluator's writes and the aggregate count. */
const units = (max: number) => z.string().refine((text) => text.length <= max);

// Refused rather than left to `z.record`, which drops the key without a word.
const namespaceSchema = z
  .custom<Record<string, string>>(
    (value) =>
      typeof value !== "object" || value === null || !Object.hasOwn(value, RESERVED_MACRO_NAME),
    "Reserved macro variable name",
  )
  .pipe(z.record(units(MACRO_STATE_LIMITS.name).min(1), units(MACRO_STATE_LIMITS.value)));

/** Validates the complete memory-only DTO, including the aggregate size. */
export const macroStateSchema = z
  .strictObject({ local: namespaceSchema, global: namespaceSchema })
  .superRefine((state, context) => {
    let variables = 0;
    let total = 0;
    for (const namespace of [state.local, state.global]) {
      for (const [name, value] of Object.entries(namespace)) {
        variables += 1;
        total += name.length + value.length;
      }
    }
    if (variables > MACRO_STATE_LIMITS.variables || total > MACRO_STATE_LIMITS.total) {
      context.addIssue({ code: "custom", message: "Macro state limit exceeded" });
    }
  });

/** Null-prototype dictionaries: inherited names such as `constructor` are never read as variables. */
export function emptyMacroState(): MacroState {
  return {
    local: Object.create(null) as Record<string, string>,
    global: Object.create(null) as Record<string, string>,
  };
}

/** Make a validated working copy before evaluating a preview or generation. */
export function cloneMacroState(state: MacroState): MacroState {
  if (!macroStateSchema.safeParse(state).success) throw new Error("Invalid macro state");
  const copy = emptyMacroState();
  for (const namespace of ["local", "global"] as const) {
    for (const [name, value] of Object.entries(state[namespace])) {
      Object.defineProperty(copy[namespace], name, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  return copy;
}
