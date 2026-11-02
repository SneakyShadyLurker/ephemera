import {
  type ClipboardEvent,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  useRef,
  useState,
} from "react";
import { CloseIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { FOCUS_WITHIN } from "./fields.ts";

/**
 * Values as removable tokens, the one control behind tags, keywords, cues
 * and pool names. Enter or a comma adds (unless `holds` keeps the comma in
 * the draft); pasting a list splits it; Backspace in an empty field removes
 * the last; leaving the field adds what it holds. Removing a token with its
 * button leaves focus in the field. Tokens and their remove buttons take
 * 44px on touch, like every target. A `locked` field is read-only.
 */
export function TokenField({
  tokens,
  add,
  item,
  holds = () => false,
  bad = () => false,
  locked = false,
  settle,
  className,
  input: inputProps,
  children,
  onDraft,
  onChange,
}: {
  tokens: string[];
  /** The tokens after the text (typed or pasted, maybe a list) is added. */
  add: (tokens: string[], text: string) => string[];
  /** What one token is, in its remove button's name. */
  item: string;
  /** Whether a comma belongs to the draft instead of ending it. */
  holds?: (draft: string) => boolean;
  /** Whether a token is shown as one that does not work. */
  bad?: (token: string) => boolean;
  locked?: boolean;
  /** Marks the box for the settle glow of what an AI Rework just wrote. */
  settle?: boolean;
  /** Classes for the bordered box. */
  className?: string;
  /** The text input's naming, description and limits. */
  input: Omit<
    InputHTMLAttributes<HTMLInputElement>,
    "value" | "onChange" | "onKeyDown" | "onPaste" | "onBlur" | "readOnly"
  >;
  /** After the input, inside the box (a count, a datalist). */
  children?: ReactNode;
  /** Told of each change to the text being typed. */
  onDraft?: (draft: string) => void;
  onChange: (tokens: string[]) => void;
}) {
  const [draft, setDraftState] = useState("");
  const setDraft = (next: string) => {
    setDraftState(next);
    onDraft?.(next);
  };
  const field = useRef<HTMLInputElement>(null);

  const commit = (text: string) => {
    const next = add(tokens, text);
    if (next.length !== tokens.length) onChange(next);
    setDraft("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || (event.key === "," && !holds(draft))) {
      event.preventDefault();
      if (!locked) commit(draft);
    } else if (event.key === "Backspace" && draft === "" && tokens.length > 0 && !locked) {
      onChange(tokens.slice(0, -1));
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData("text/plain");
    if (locked || !text.includes(",")) return;
    event.preventDefault();
    commit(`${draft}${text}`);
  };

  return (
    <div
      data-settle={settle ? "" : undefined}
      className={cn(
        "flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border border-control-edge bg-surface px-1.5 py-1 touch:min-h-11",
        className,
        FOCUS_WITHIN,
        locked && "border-rush bg-canvas",
      )}
    >
      {tokens.map((token, at) => {
        // Keyed by the text and its occurrence (an imported card may repeat one), so
        // removing one token leaves the others mounted instead of replaying their entrance.
        const occurrence = tokens.slice(0, at).filter((other) => other === token).length;
        return (
          <span
            key={`${occurrence}:${token}`}
            className={cn(
              "flex h-7 min-w-0 max-w-full items-center gap-0.5 rounded-md pr-0.5 pl-2.5 text-note arrive touch:h-11",
              bad(token) ? "bg-error-surface text-ember" : "bg-surface-selected text-ink",
            )}
          >
            <span className="truncate">{token}</span>
            <Button
              size="icon"
              aria-label={`Remove ${item} ${token}`}
              disabled={locked}
              onClick={() => {
                onChange(tokens.filter((_, other) => other !== at));
                // The button goes with its token; focus stays in the field.
                field.current?.focus();
              }}
              className="size-6 rounded-sm hover:bg-surface-pressed touch:size-11"
            >
              <CloseIcon size={16} />
            </Button>
          </span>
        );
      })}
      <input
        {...inputProps}
        ref={field}
        value={draft}
        autoComplete="off"
        readOnly={locked}
        aria-readonly={locked || undefined}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onBlur={() => {
          if (!holds(draft) && !locked) commit(draft);
        }}
        className="h-7 min-w-24 flex-1 bg-transparent px-1.5 text-ink text-ui outline-none placeholder:text-reed touch:h-11"
      />
      {children}
    </div>
  );
}
