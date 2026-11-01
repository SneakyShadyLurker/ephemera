import { useState } from "react";
import { Button } from "@/components/ui/button";
import { NoticeCard } from "../app/NoticeCard.tsx";
import { SHEET_GRID } from "./fields.ts";

/**
 * Another tab saved this entity after this sheet opened it, so this sheet's
 * save was refused (a stale revision) and saving waits for the owner's
 * choice: Reload takes the saved version and drops the edits made here;
 * Keep mine saves this tab's whole version over it. Neither is the safe default, so both are
 * outline buttons. On a sheet it is a sticky row at the foot of the form
 * column; on a screen with its own scrollers (the lorebook) it is a footer
 * below them, covering nothing; in a dialog (a memory) it sits inline in
 * the dialog's flow.
 */
export function ConflictNotice({
  noun,
  onReload,
  onKeepMine,
  placement = "row",
  reviewing = false,
}: {
  noun: string;
  onReload: () => Promise<unknown>;
  onKeepMine: () => void;
  placement?: "row" | "footer" | "inline";
  /** An AI Rework's proposal is under review: Reload drops it with the edits. */
  reviewing?: boolean;
}) {
  const [reloading, setReloading] = useState(false);
  const card = (
    <NoticeCard
      // The save state already announces "Not saved" assertively; this adds the choice politely.
      role="status"
      data-conflict=""
      placement={placement === "row" ? "float" : "dock"}
      // A dialog's column is too narrow for the actions beside the text.
      stacked={placement === "inline"}
      title="Changed in another tab"
      body={`Another tab saved this ${noun} after this tab opened it, so saving here waits for your choice. Reload takes that version and drops this tab's edits; Keep mine saves this tab's version over it.${reviewing ? " A proposal under review is dropped too." : ""}`}
      actions={
        <>
          <Button
            variant="outline"
            className="px-2.5"
            disabled={reloading}
            onClick={() => {
              setReloading(true);
              void onReload().finally(() => setReloading(false));
            }}
          >
            {reloading ? "Reloading" : "Reload"}
          </Button>
          <Button variant="outline" className="px-2.5" disabled={reloading} onClick={onKeepMine}>
            Keep mine
          </Button>
        </>
      }
    />
  );
  if (placement === "inline") return card;
  if (placement === "footer") {
    return (
      <div className="flex shrink-0 justify-center px-5 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] tablet:px-6 tablet:pb-6">
        <div className="w-full max-w-notice">{card}</div>
      </div>
    );
  }
  return (
    <div className={`${SHEET_GRID} sticky bottom-3 z-(--z-raised) tablet:bottom-6`}>
      <div className="hidden tablet:block" />
      {card}
    </div>
  );
}

/**
 * A sheet screen's Reload: fetch the entity again, then remount the editor
 * (its fields are seeded once) under a new key, calling `reloaded` first (a
 * sheet that created its entity leaves that mode for the fetched one). A
 * failed fetch changes nothing: the edits and the notice stay. Returns the
 * key suffix.
 */
export function useReload(
  refetch: () => Promise<{ isSuccess: boolean }>,
  reloaded?: () => void,
): [number, () => Promise<void>] {
  const [round, setRound] = useState(0);
  return [
    round,
    async () => {
      const { isSuccess } = await refetch();
      if (!isSuccess) return;
      reloaded?.();
      setRound((current) => current + 1);
    },
  ];
}
