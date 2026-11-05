import { type ReactNode, useId, useRef, useState } from "react";
import { InlineStatus, NoticeSlot } from "@/app/NoticeCard.tsx";
import { DeleteIcon, ImportIcon, PlusIcon } from "@/components/icons";
import { MoreButton } from "@/components/more-button";
import { Button } from "@/components/ui/button";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { Portrait } from "./Portrait.tsx";
import { type PortraitOwner, removePortrait, setPortrait } from "./queries.ts";

/**
 * A sheet's portrait in the margin with one row of actions under it: the
 * sheet's `primary` action (a character's New art, told whether the picker
 * is busy) with Replace and Remove in a menu beside it, or without one
 * Replace and Remove themselves. A new sheet offers Add portrait once it is
 * saved with a name. A fresh upload surfaces out of blur once, and so does a
 * version that `arrived` through another path.
 */
export function PortraitField({
  owner,
  id,
  version,
  noun,
  locked = false,
  arrived: arrivedVersion = null,
  primary,
  onBusyChange,
  onChange,
  compactOnPhone = false,
  identity,
  tags,
  details,
}: {
  owner: PortraitOwner;
  id: string | null;
  version: number | null;
  /** What the sheet edits, for the hint on a new sheet ("character", "persona"). */
  noun: string;
  /**
   * Add, Replace and Remove are off while an AI Rework works or is under
   * review: a changed portrait would make changes made to match it stale.
   */
  locked?: boolean;
  /** A version that just arrived through another path (New art's Use as portrait). */
  arrived?: number | null;
  primary?: ((state: { busy: boolean }) => ReactNode) | undefined;
  /** An upload or removal starts or ends: the sheet holds an AI Rework meanwhile. */
  onBusyChange?: (busy: boolean) => void;
  onChange: (version: number | null) => void;
  /** Phones set the portrait small with its actions beside it, so the sheet's text starts sooner. */
  compactOnPhone?: boolean;
  identity?: ReactNode;
  tags?: ReactNode;
  details?: ReactNode;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusyState] = useState(false);
  const [arrived, setArrived] = useState(false);
  const errorId = useId();

  const setBusy = (next: boolean) => {
    setBusyState(next);
    onBusyChange?.(next);
  };

  const upload = async (file: File | undefined) => {
    // A file chosen in a picker opened before a rework or another change began changes nothing.
    if (file === undefined || id === null || busy || locked) return;
    setBusy(true);
    setError(null);
    const result = await setPortrait(owner, id, file);
    setBusy(false);
    if (result.ok) {
      setArrived(true);
      onChange(result.version);
    } else setError(result.reason);
  };

  const remove = async () => {
    if (id === null || busy || locked) return;
    setBusy(true);
    setError(null);
    const removed = await removePortrait(owner, id);
    setBusy(false);
    if (removed) onChange(null);
    else setError("The portrait could not be removed.");
  };

  return (
    <div
      className={cn(
        "grid content-start gap-1",
        // Phones: the portrait small at the row's start, its actions beside its foot.
        compactOnPhone &&
          "grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-4 tablet:grid-cols-[7rem_minmax(0,1fr)] tablet:grid-rows-[auto_auto_1fr_auto] tablet:gap-x-6",
      )}
    >
      <input
        ref={picker}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => {
          void upload(event.currentTarget.files?.[0]);
          event.currentTarget.value = "";
        }}
      />
      <div className={cn(compactOnPhone && "row-span-2 tablet:row-span-3")}>
        {version === null ? (
          <button
            type="button"
            disabled={id === null || busy || locked}
            aria-describedby={id === null ? `${errorId}-hint` : undefined}
            onClick={() => picker.current?.click()}
            className="press grid aspect-[2/3] w-full place-items-center content-center gap-1 rounded-lg border border-control-edge border-dashed text-reed hover:bg-surface-hover hover:text-ink disabled:cursor-default disabled:border-rush disabled:text-text-disabled disabled:hover:bg-transparent"
          >
            <PlusIcon size={20} />
            <span className="text-note">{busy ? "Adding" : "Add portrait"}</span>
          </button>
        ) : (
          <Portrait
            owner={owner}
            id={id ?? ""}
            version={version}
            size="full"
            arriving={arrived || (arrivedVersion !== null && arrivedVersion === version)}
            transition
          />
        )}
      </div>
      {identity && (
        <div data-sheet-heading="" className="col-start-2 row-start-1 min-w-0 self-start">
          {identity}
        </div>
      )}
      {/*
       * One row, its primary action first in one place whether or not a
       * portrait is stored, so a first portrait keeps what it holds mounted.
       */}
      <div
        className={cn(
          "flex flex-wrap items-center gap-1 pt-1 empty:hidden max-tablet:flex-nowrap",
          compactOnPhone &&
            "col-start-2 row-start-2 self-end tablet:col-start-1 tablet:row-start-4",
        )}
      >
        {primary?.({ busy })}
        {version !== null &&
          (primary ? (
            <Menu>
              <MenuTrigger
                render={<MoreButton aria-label="Portrait actions" disabled={busy || locked} />}
              />
              <MenuContent label="Portrait actions" align="start">
                <MenuItem onClick={() => picker.current?.click()}>
                  <ImportIcon size={16} />
                  Replace
                </MenuItem>
                <MenuItem onClick={() => void remove()}>
                  <DeleteIcon size={16} />
                  Remove
                </MenuItem>
              </MenuContent>
            </Menu>
          ) : (
            <>
              <Button size="text" disabled={busy || locked} onClick={() => picker.current?.click()}>
                Replace
              </Button>
              <Tooltip label="Remove portrait">
                <Button
                  size="icon"
                  className="size-8 touch:size-11"
                  aria-label="Remove portrait"
                  disabled={busy || locked}
                  onClick={() => void remove()}
                >
                  <DeleteIcon size={16} />
                </Button>
              </Tooltip>
            </>
          ))}
      </div>
      {tags && (
        <div className="col-span-full min-w-0 tablet:col-start-2 tablet:col-span-1 tablet:row-start-2 tablet:self-start">
          {tags}
        </div>
      )}
      {details && (
        <div className="col-span-full min-w-0 self-start tablet:col-start-2 tablet:col-span-1 tablet:row-start-3">
          {details}
        </div>
      )}
      <NoticeSlot
        {...(compactOnPhone && { className: "max-tablet:col-span-full" })}
        value={
          busy && version !== null
            ? { kind: "status" as const, text: "Saving the portrait" }
            : error
              ? { kind: "alert" as const, text: error }
              : null
        }
      >
        {(notice) =>
          notice.kind === "status" ? (
            <InlineStatus as="p" role="status" className="px-2 text-meta">
              {notice.text}
            </InlineStatus>
          ) : (
            <InlineStatus as="p" role="alert" className="text-ember text-meta">
              {notice.text}
            </InlineStatus>
          )
        }
      </NoticeSlot>
      {id === null && (
        <p id={`${errorId}-hint`} className="sr-only">
          Add a name first; the portrait can be added once the {noun} is saved.
        </p>
      )}
    </div>
  );
}
