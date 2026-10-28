import { addKeywords, type KeyProblem, splitKeywords } from "@ephemera/core";
import { type ReactNode, useId, useState } from "react";
import { cn } from "@/lib/cn";
import { TokenField } from "../sheet/TokenField.tsx";
import { KEY_PROBLEM_TEXT } from "./copy.ts";

/** A key still being written as `/pattern/`: a comma belongs to it. */
const openPattern = (draft: string) => /^\s*\//.test(draft) && !/^\s*\/.+\/[a-z]*\s*$/s.test(draft);

/**
 * Keywords as removable tokens (sheet/TokenField.tsx); a comma inside a
 * `/pattern/` belongs to it. A key that never matches is an ember token,
 * and the field says why (or what `notice` says). With `split`, the field holds
 * plain names (event pools): a comma always adds, and `suggestions` offers
 * names already in use. With `maxLength`, one token holds at most that many
 * characters as typed, and a count shows once the draft nears it.
 */
export function KeywordsField({
  label = "Keywords",
  labelEnd,
  item = "keyword",
  split = splitKeywords,
  maxLength,
  suggestions = [],
  keys,
  problems,
  dimmed,
  help,
  notice,
  focusOnMount = false,
  onChange,
}: {
  label?: string;
  /** Beside the label, at the end of its line. */
  labelEnd?: ReactNode;
  /** What one token is, in the placeholder and its remove button. */
  item?: string;
  /** How typed or pasted text becomes tokens; anything but the default holds no `/pattern/`. */
  split?: (text: string) => string[];
  /** The most characters one token holds as typed. */
  maxLength?: number;
  /** Values the field offers while typing (a native list). */
  suggestions?: readonly string[];
  keys: string[];
  problems: { key: string; problem: KeyProblem }[];
  dimmed: boolean;
  help: string;
  /** The problem line's text, when the field's consequence differs from the keywords'. */
  notice?: (problems: { key: string; problem: KeyProblem }[]) => string;
  /** Focus the field when it appears, as when a person's action reveals it. */
  focusOnMount?: boolean;
  onChange: (keys: string[]) => void;
}) {
  const inputId = useId();
  const helpId = useId();
  const countId = useId();
  const listId = useId();
  // The draft's length, for the count; the token field owns the draft itself.
  const [typed, setTyped] = useState(0);
  const patterns = split === splitKeywords;
  const shown = problems[0];
  // The count shows over the last fifth of the room, so it says how much is left before it runs out.
  const counted = maxLength !== undefined && typed >= Math.floor(maxLength * 0.8);

  return (
    // One column at the field's width: a token too long for it truncates instead of widening it.
    <div className="grid grid-cols-[minmax(0,1fr)] gap-1.5">
      <div className="flex min-h-5 flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <label htmlFor={inputId} className="font-medium text-ink text-ui">
          {label}
        </label>
        {labelEnd}
      </div>
      <TokenField
        tokens={keys}
        add={(tokens, text) => addKeywords(tokens, split(text))}
        item={item}
        holds={(draft) => patterns && openPattern(draft)}
        bad={(key) => problems.some((problem) => problem.key === key)}
        className={cn(
          "transition-opacity duration-(--duration-quick) ease-fade",
          dimmed && "opacity-60",
        )}
        input={{
          id: inputId,
          "aria-describedby": counted ? `${helpId} ${countId}` : helpId,
          ...(maxLength === undefined ? {} : { maxLength }),
          "aria-invalid": problems.length > 0 ? true : undefined,
          placeholder: keys.length === 0 ? `Add a ${item}` : "Add another",
          list: suggestions.length > 0 ? listId : undefined,
          // Only as a person's action reveals the field, never on a page's first load.
          autoFocus: focusOnMount,
        }}
        onDraft={(draft) => setTyped(draft.length)}
        onChange={onChange}
      >
        {counted && maxLength !== undefined && (
          <span
            id={countId}
            className={cn(
              "shrink-0 pr-1.5 text-meta tabular-nums transition-opacity duration-(--duration-quick) ease-fade starting:opacity-0",
              typed >= maxLength ? "text-ember" : "text-reed",
            )}
          >
            <span className="sr-only">Characters: </span>
            {typed}/{maxLength}
          </span>
        )}
        {suggestions.length > 0 && (
          <datalist id={listId}>
            {suggestions.map((suggestion) => (
              <option key={suggestion} value={suggestion} />
            ))}
          </datalist>
        )}
      </TokenField>
      <div id={helpId} className="grid gap-1.5">
        {shown !== undefined && (
          <p className="text-pretty break-words text-ember text-note arrive">
            {notice === undefined ? (
              <>
                {problems.length > 1 ? `${shown.key}: ` : ""}
                {KEY_PROBLEM_TEXT[shown.problem]}
                {problems.length < keys.length && " The other keywords still work."}
                {problems.length > 1 && ` ${problems.length - 1} more never match.`}
              </>
            ) : (
              notice(problems)
            )}
          </p>
        )}
        <p className="text-pretty text-note text-reed">{help}</p>
      </div>
    </div>
  );
}
