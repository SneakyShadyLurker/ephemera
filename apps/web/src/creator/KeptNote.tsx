import { InlineStatus } from "@/app/NoticeCard.tsx";
import { ChatIcon, CheckIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { useStartChat } from "../chat/StartChat.tsx";
import { keptStore, useKept } from "./kept.ts";

/**
 * The gallery's line after Keep: "Kept Mara Voss" with Chat, so the meeting
 * leads straight into talking to them. Shown until dismissed or the next card is created.
 */
export function KeptNote() {
  const kept = useKept();
  const { start, dialog } = useStartChat();
  if (kept === null) return null;
  return (
    <InlineStatus
      as="div"
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 arrive"
    >
      {/* Text first; the actions wrap as one to the next line when the row is narrow. */}
      <div className="flex min-w-0 items-center gap-x-3">
        <CheckIcon size={16} className="shrink-0 text-reed" />
        <p className="min-w-0 break-words text-ink">Kept {kept.name}</p>
      </div>
      <div className="flex shrink-0 items-center gap-x-3">
        <Button size="text" variant="outline" onClick={() => start(kept.id, kept.name)}>
          <ChatIcon size={16} />
          Chat
        </Button>
        <Button size="text" onClick={() => keptStore.setState({ kept: null })}>
          Dismiss
        </Button>
      </div>
      {dialog}
    </InlineStatus>
  );
}
