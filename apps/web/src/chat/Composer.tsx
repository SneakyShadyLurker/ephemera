import { type KeyboardEvent, type RefObject, useEffect, useRef, useState } from "react";
import { useUi } from "@/app/ui.ts";
import { InspectIcon, StopIcon, WriteForMeIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { isComposing } from "@/lib/keys.ts";
import { MODEL_BUSY } from "@/lib/text";
import { useContextWindow } from "../api.ts";
import { useSettings } from "../settings/settings.ts";
import { FOCUS_WITHIN } from "../sheet/fields.ts";
import { useSignedIn } from "../signin/hooks.ts";
import { useChatCharacter, useChatPersona } from "./character.ts";
import { SCRIPT_FRAME } from "./frame.ts";
import { retryGreeting } from "./greetings.ts";
import { focusModelNotice, MODEL_NOTICE_BODY, useModelBlocker } from "./ModelNotice.tsx";
import { IMPERSONATION_REFUSAL, REFUSAL_NOTE } from "./refusal.ts";
import { chatStore, useChat } from "./session.ts";
import { awaitsGreeting, type ImpersonationNote, type MacroNotice } from "./store.ts";

/** Send and Stop crossfade in place. */
const SWAP = "grid transition-opacity duration-(--duration-quick) ease-fade starting:opacity-0";

/** Stop stays inert this long after it replaces Send, so a double-click on Send cannot stop the reply. */
const STOP_GUARD_MS = 400;

/** The composer's field, for the chat keys and focus return; its label stays free to change. */
export const COMPOSER = "textarea[data-composer]";

const IMPERSONATION_NOTE: Record<NonNullable<ImpersonationNote>["status"], string> = {
  stopped: "Write for me stopped; the draft keeps what it wrote.",
  failed: "Write for me failed; nothing more was written.",
};

/** Why nothing went out, or a reply's macros were not filled; the draft is always kept. Never the message itself. */
const MACRO_NOTICE: Record<MacroNotice, string> = {
  limit: "Not sent: its macros go past their limits. Your draft is kept.",
  empty: "Not sent: its macros leave nothing to send. Your draft is kept.",
  unavailable:
    "Not sent: the chosen character, persona, presets or model settings didn't load. Try again.",
  changed:
    "Not sent: the chat, or the chosen character, persona, presets or model settings, changed meanwhile. Try again.",
  window: `${REFUSAL_NOTE.context_window_unknown} Your draft is kept.`,
  output: "The reply's macros go past their limits: it is kept as the model wrote it, unfilled.",
};

export function Composer({ field }: { field: RefObject<HTMLTextAreaElement | null> }) {
  const draft = useChat((state) => state.draft);
  const generating = useChat((state) => state.generating);
  const impersonating = useChat((state) => state.generationMode === "impersonate");
  const impersonation = useChat((state) => state.impersonation);
  const macroNotice = useChat((state) => state.macroNotice);
  // Only while the chat still waits for the greeting: once it is under way the greeting is past.
  const greetingFailed = useChat((state) => state.greetingFailed && awaitsGreeting(state));
  const inspectorUnavailable = useUi((state) => state.inspectorUnavailable);
  const settings = useSettings();
  const { model } = settings;
  // Without a model or a known window nothing can be sent; ModelNotice says why and offers the way out.
  const window = useContextWindow(model, settings);
  // Signed out, nothing can be generated until the session is back; the draft stays editable.
  const signedIn = useSignedIn();
  const sendable = model !== null && window !== null && signedIn;
  // While the notice above says why Send cannot work, the field and Send are described by it.
  const blocked = useModelBlocker().blocker !== null;
  const describedBy = blocked ? MODEL_NOTICE_BODY : undefined;
  // An empty draft goes too when the prompt preset sends its Send If Empty text instead.
  const canSend = useChat((state) => state.draft.trim() !== "") && sendable;
  const persona = useChatPersona();
  const character = useChatCharacter();
  const empty = useChat((state) => state.messages.length === 0);
  const { setDraft, send, stop, impersonate, startEdit } = chatStore.getState();
  // When Stop leaves the slot while it has focus, focus goes back to the field, not the page.
  const slotHadFocus = useRef(false);
  useEffect(() => {
    if (!generating && slotHadFocus.current && document.activeElement === document.body) {
      field.current?.focus();
    }
  }, [generating, field]);
  // When Write for me finishes, the draft is the user's to edit: focus lands at its end.
  const wasImpersonating = useRef(false);
  useEffect(() => {
    if (wasImpersonating.current && !impersonating) {
      const node = field.current;
      node?.focus();
      node?.setSelectionRange(node.value.length, node.value.length);
    }
    wasImpersonating.current = impersonating;
  }, [impersonating, field]);
  const trackFocus = {
    onFocus: () => {
      slotHadFocus.current = true;
    },
    onBlur: () => {
      slotHadFocus.current = false;
    },
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const composing = isComposing(event);
    // Ctrl, Cmd and Alt with Enter are the chat's shortcuts (regenerate, continue), not Send.
    const modified = event.ctrlKey || event.metaKey || event.altKey;
    if (event.key === "Enter" && !event.shiftKey && !modified && !composing) {
      event.preventDefault();
      // Nothing can go out yet: Enter goes to the notice's way out instead of doing nothing.
      if (blocked && focusModelNotice()) return;
      void send();
    } else if (event.key === "Escape" && generating) {
      event.preventDefault();
      stop();
    } else if (
      event.key === "ArrowUp" &&
      draft === "" &&
      !generating &&
      !event.shiftKey &&
      !event.altKey &&
      !composing
    ) {
      // Chat keys: Up edits the last message, Ctrl+Up (Cmd+Up) your last one.
      const { messages } = chatStore.getState();
      const mine = event.ctrlKey || event.metaKey;
      const message = mine ? messages.findLast((other) => other.role === "user") : messages.at(-1);
      if (message === undefined) return;
      event.preventDefault();
      startEdit(message.id, "text", true);
    }
  };

  const placeholder = character
    ? persona
      ? `Write to ${character.name} as ${persona.name}`
      : `Write to ${character.name}`
    : persona
      ? `Write as ${persona.name}`
      : empty
        ? "Write the first line"
        : "Write your reply";
  const status = impersonating
    ? `Writing ${persona ? `${persona.name}'s` : "your"} next message…`
    : impersonation === null
      ? null
      : impersonation.refusal !== undefined
        ? IMPERSONATION_REFUSAL[impersonation.refusal]
        : impersonation.busy && impersonation.status === "failed"
          ? `Write for me failed. ${MODEL_BUSY}`
          : IMPERSONATION_NOTE[impersonation.status];
  const notSent = macroNotice === null || generating ? null : MACRO_NOTICE[macroNotice];

  return (
    <form
      className={cn(
        SCRIPT_FRAME,
        "shrink-0 pb-[calc(0.75rem+env(safe-area-inset-bottom))] tablet:pb-[calc(1.25rem+env(safe-area-inset-bottom))]",
      )}
      onSubmit={(event) => {
        event.preventDefault();
        void send();
        field.current?.focus();
      }}
    >
      <div className="grid gap-1.5">
        {status && (
          <p
            key={status}
            role="status"
            className="flex items-center gap-2 pl-1 text-note text-reed transition-opacity duration-(--duration-quick) ease-fade starting:opacity-0"
          >
            <WriteForMeIcon size={16} className="shrink-0" />
            {status}
          </p>
        )}
        {notSent && (
          <p
            key={notSent}
            role="status"
            className="pl-1 text-note text-reed transition-opacity duration-(--duration-quick) ease-fade starting:opacity-0"
          >
            {notSent}
          </p>
        )}
        {greetingFailed && !generating && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-1 transition-opacity duration-(--duration-quick) ease-fade starting:opacity-0">
            <p role="status" className="min-w-0 flex-1 text-note text-reed">
              The greeting didn't load: the chosen character, persona or presets didn't load.
            </p>
            <Button variant="outline" onClick={retryGreeting}>
              Try again
            </Button>
          </div>
        )}
        {inspectorUnavailable && (
          <p
            role="status"
            className="flex items-center gap-2 pl-1 text-note text-reed transition-opacity duration-(--duration-quick) ease-fade starting:opacity-0"
          >
            <InspectIcon size={16} className="shrink-0" />
            The prompt inspector didn't load; a reload brings it back and ends the chat.
          </p>
        )}
        <div
          className={cn(
            "flex min-w-0 items-end gap-1 rounded-xl border border-control-edge bg-surface py-1.5 pr-1.5 pl-1.5",
            FOCUS_WITHIN,
          )}
        >
          {impersonating ? (
            // Read-only while the model writes it, with the caret every stream carries.
            <div
              aria-live="off"
              className="caret-after max-h-[min(12rem,28dvh)] min-h-9 flex-1 self-center overflow-y-auto py-1.5 pl-2.5 text-ink text-turn whitespace-pre-wrap break-words touch:py-2.5"
            >
              <p>{draft}</p>
            </div>
          ) : (
            <textarea
              data-composer=""
              data-skip-target=""
              ref={field}
              aria-label="Message"
              aria-describedby={describedBy}
              placeholder={placeholder}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onKeyDown}
              autoComplete="off"
              rows={1}
              className={cn(
                "max-h-[min(12rem,28dvh)] min-h-9 min-w-0 flex-1 resize-none self-center bg-transparent py-1.5 pl-2.5 text-ink text-turn placeholder:text-reed focus-visible:outline-none touch:min-h-11 touch:py-2.5",
                // Empty, one line: long names in the placeholder never grow the composer.
                draft === ""
                  ? "[field-sizing:fixed] placeholder:truncate"
                  : "[field-sizing:content]",
              )}
            />
          )}
          {!generating && (
            <Tooltip
              label={draft === "" ? "Write for me" : "Write for me works on an empty draft"}
              side="top"
            >
              <Button
                size="icon"
                aria-label="Write for me"
                disabled={!sendable || draft !== ""}
                onClick={() => void impersonate()}
              >
                <WriteForMeIcon />
              </Button>
            </Tooltip>
          )}
          {/* One slot: Send, or Stop while anything is written. */}
          <div className="grid w-20 shrink-0 *:col-start-1 *:row-start-1 *:*:w-full tablet:w-24">
            {generating ? (
              <span key="stop" className={SWAP}>
                <StopButton onStop={stop} {...trackFocus} />
              </span>
            ) : (
              <span key="send" className={SWAP}>
                <Button
                  type="submit"
                  variant="primary"
                  disabled={!canSend}
                  aria-describedby={describedBy}
                  {...trackFocus}
                >
                  Send
                </Button>
              </span>
            )}
          </div>
        </div>
      </div>
    </form>
  );
}

function StopButton({
  onStop,
  ...focusHandlers
}: {
  onStop: () => void;
  onFocus: () => void;
  onBlur: () => void;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setArmed(true), STOP_GUARD_MS);
    return () => clearTimeout(timer);
  }, []);
  return (
    <Button
      type="button"
      variant="outline"
      disabled={!armed}
      // Looks ready at once; only the first 400ms of clicks are ignored.
      className="disabled:border-control-edge disabled:text-ink"
      onClick={onStop}
      {...focusHandlers}
    >
      <StopIcon size={16} />
      Stop
    </Button>
  );
}
