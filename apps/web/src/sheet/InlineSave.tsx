import { InlineStatus } from "@/app/NoticeCard.tsx";
import { cn } from "@/lib/cn";
import { isFailure, type SaveStatus, saveStatusText } from "./autosave.ts";

/** Local save feedback holds its place; fast saves never announce a pending word. */
export function InlineSave({ status, noun }: { status: SaveStatus; noun: string }) {
  return (
    <InlineStatus
      key={status.kind}
      as="span"
      data-inline-save=""
      tone={isFailure(status, false) ? "error" : "status"}
      className={cn("min-h-5 font-sans", status.kind === "saving" && "lamplight-late")}
    >
      {saveStatusText(status, false, noun)}
    </InlineStatus>
  );
}
