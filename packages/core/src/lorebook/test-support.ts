import type { Lorebook } from "../card/schema.ts";
import type { LorebookReport } from "../prompt/inspect.ts";
import {
  activateLorebooks,
  type CombinedActivationInput,
  type LorebookActivation,
} from "./activate.ts";
import { clip } from "./rules.ts";
import type { LorebookState } from "./timed.ts";

/** One book alone, for tests: the card's own book as the single source, at `scanDepth`. */
export type ActivationInput = Omit<CombinedActivationInput, "books"> & {
  book: Lorebook;
  /** The book's scan depth; an entry's own `scanDepth` overrides it. */
  scanDepth: number;
};

/** An activation with its report and next state, as if every placed entry were delivered. */
export type SettledActivation = LorebookActivation & {
  state: LorebookState | null;
  report: LorebookReport;
};

/** Finalizes `activation` with every entry it placed delivered. */
export function settled(activation: LorebookActivation): SettledActivation {
  const placed = [
    ...activation.before,
    ...activation.after,
    ...activation.depth.flatMap((group) => group.entries),
    ...activation.authorsNote.top,
    ...activation.authorsNote.bottom,
    ...activation.examples.before,
    ...activation.examples.after,
  ];
  return {
    ...activation,
    ...activation.finalize(new Set(placed.map((entry) => entry.index))),
  };
}

/** Activates one book through `activateLorebooks`, its scan depth as given. */
export function activateLorebook(input: ActivationInput): SettledActivation {
  const { book, scanDepth, ...request } = input;
  const chains = book.recursiveScanning === true;
  return settled(
    activateLorebooks({
      ...request,
      books: {
        sources: [{ id: null, name: clip(book.name ?? ""), count: book.entries.length }],
        entries: book.entries.map((entry, index) => ({
          entry,
          book: null,
          index,
          scanDepth,
          chains,
        })),
        scanDepth,
      },
    }),
  );
}
