import { createContext, type ReactNode, use, useLayoutEffect, useRef } from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";
import { useConversationReading } from "@/components/ai-elements/conversation";
import { useSetting } from "../settings/settings.ts";
import { chatStore, useChat } from "./session.ts";
import type { Deleted } from "./store.ts";

const DeletionContext = createContext<{
  remove: (id: string, mutate: () => void) => void;
  undo: (deleted: Deleted, control: HTMLButtonElement) => void;
} | null>(null);

export const useDeletionView = () => use(DeletionContext);

const targetId = (deleted: Deleted) =>
  deleted.kind === "alternate" ? deleted.messageId : deleted.messages[0]?.id;

/** The displayed More, excluding the hidden nameplate/footer duplicate and folded turns. */
function moreFor(content: HTMLElement, id: string) {
  return [...content.querySelectorAll<HTMLButtonElement>("button[data-edit-for]")].find(
    (button) =>
      button.dataset.editFor === id &&
      button.isConnected &&
      !button.disabled &&
      !button.closest('[inert], [hidden], [aria-hidden="true"], [data-folded]') &&
      button.getClientRects().length > 0 &&
      getComputedStyle(button).visibility === "visible",
  );
}

interface Bookmark {
  deleted: Deleted;
  offset: number | undefined;
  following: boolean;
  movement: number;
  rejoin: number;
  epoch: number;
  characterId: string | null;
}

/** Private, tab-only presentation state for one successful deletion in this mounted Thread. */
export function DeletionView({ children }: { children: ReactNode }) {
  const { scrollRef, contentRef, stopScroll } = useStickToBottomContext();
  const reading = useConversationReading();
  const deleted = useChat((chat) => chat.deleted);
  const epoch = useChat((chat) => chat.epoch);
  const characterId = useSetting((settings) => settings.characterId);
  const bookmark = useRef<Bookmark | null>(null);
  const restoring = useRef<{
    id: string;
    focus: HTMLButtonElement | null;
    bookmark: Bookmark | null;
    top: number;
    anchor: Element | undefined;
    offset: number;
  } | null>(null);
  const previous = useRef(deleted);

  useLayoutEffect(() => {
    const saved = bookmark.current;
    if (saved && (saved.epoch !== epoch || saved.characterId !== characterId)) {
      bookmark.current = null;
      restoring.current = null;
    }
    const pending = restoring.current;
    const scroll = scrollRef.current;
    const content = contentRef.current;
    const changed = previous.current !== deleted;
    previous.current = deleted;
    if (!scroll || !content) return;
    if (pending) {
      restoring.current = null;
      bookmark.current = null;
      if (deleted !== null) return;
      const more = moreFor(content, pending.id);
      const kept = pending.bookmark;
      const untouched =
        kept?.movement === reading.movement.current &&
        kept.rejoin === reading.rejoin.current.version;
      const rejoined =
        kept !== null &&
        kept.rejoin !== reading.rejoin.current.version &&
        reading.rejoin.current.movement === reading.movement.current;
      if ((untouched && kept.following) || rejoined || (kept === null && reading.following())) {
        reading.restoreTail();
      } else {
        stopScroll();
        const turn = more?.closest("[data-message]");
        const anchor = untouched ? turn : pending.anchor;
        const offset = anchor === turn ? kept?.offset : pending.offset;
        reading.restoreScrollTop(
          anchor?.isConnected && offset !== undefined
            ? scroll.scrollTop +
                anchor.getBoundingClientRect().top -
                scroll.getBoundingClientRect().top -
                offset
            : pending.top,
        );
      }
      // The old Undo must still own focus. A successful restore never takes it
      // from a control the owner chose meanwhile, nor reveals an obscured More.
      if (
        pending.focus &&
        more &&
        (document.activeElement === pending.focus || document.activeElement === document.body)
      )
        reading.focusRestored(more);
    } else if (changed && saved?.deleted === deleted) {
      if (
        saved.following &&
        saved.movement === reading.movement.current &&
        saved.rejoin === reading.rejoin.current.version
      ) {
        reading.restoreTail();
      }
    } else if (changed) bookmark.current = null;
  });

  return (
    <DeletionContext
      value={{
        remove: (id, mutate) => {
          bookmark.current = null;
          restoring.current = null;
          const scroll = scrollRef.current;
          const content = contentRef.current;
          const turn = content && moreFor(content, id)?.closest("[data-message]");
          const offset =
            scroll && turn
              ? turn.getBoundingClientRect().top - scroll.getBoundingClientRect().top
              : undefined;
          const following = reading.following();
          const movement = reading.movement.current;
          const rejoin = reading.rejoin.current.version;
          const before = chatStore.getState().deleted;
          mutate();
          const after = chatStore.getState().deleted;
          if (after && after !== before)
            bookmark.current = {
              deleted: after,
              offset,
              following,
              movement,
              rejoin,
              epoch,
              characterId,
            };
        },
        undo: (result, control) => {
          const scroll = scrollRef.current;
          const content = contentRef.current;
          const id = targetId(result);
          const saved = bookmark.current;
          if (!scroll || !content || id === undefined || chatStore.getState().deleted !== result) {
            chatStore.getState().undoDelete();
            return;
          }
          const anchor = [...content.querySelectorAll("[data-prose] p, .prose-turn p")].find(
            (node) => node.getBoundingClientRect().bottom > scroll.getBoundingClientRect().top,
          );
          const pending = {
            id,
            focus: document.activeElement === control ? control : null,
            bookmark: saved?.deleted === result ? saved : null,
            top: scroll.scrollTop,
            anchor,
            offset: (anchor?.getBoundingClientRect().top ?? 0) - scroll.getBoundingClientRect().top,
          };
          chatStore.getState().undoDelete();
          const after = chatStore.getState();
          // The store may refuse while generating or remembering. Only its real
          // restoration can schedule a layout/focus handoff.
          if (after.deleted === result) return;
          bookmark.current = null;
          if (after.deleted !== null || !after.messages.some((message) => message.id === id))
            return;
          restoring.current = pending;
        },
      }}
    >
      {children}
    </DeletionContext>
  );
}
