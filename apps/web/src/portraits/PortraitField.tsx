import { type ReactNode, useId, useRef, useState } from "react";
import { DeleteIcon, ImportIcon, MoreIcon, PlusIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { Tooltip } from "@/components/ui/tooltip";
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
    <div className="grid content-start gap-1">
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
      {version === null ? (
        <button
          type="button"
          disabled={id === null || busy || locked}
          aria-describedby={id === null ? `${errorId}-hint` : undefined}
          onClick={() => picker.current?.click()}
          className="grid aspect-[2/3] w-full place-items-center content-center gap-1 rounded-lg border border-control-edge border-dashed text-reed hover:bg-surface-hover hover:text-ink disabled:cursor-default disabled:border-rush disabled:text-text-disabled disabled:hover:bg-transparent"
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
      {/*
       * One row, its primary action first in one place whether or not a
       * portrait is stored, so a first portrait keeps what it holds mounted.
       */}
      <div className="flex flex-wrap items-center gap-1 pt-1 empty:hidden">
        {primary?.({ busy })}
        {version !== null &&
          (primary ? (
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="icon"
                    className="size-8 touch:size-11"
                    aria-label="Portrait actions"
                    disabled={busy || locked}
                  />
                }
              >
                <MoreIcon size={16} />
              </MenuTrigger>
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
              <Button
                className="h-8 px-2 text-note touch:h-11"
                disabled={busy || locked}
                onClick={() => picker.current?.click()}
              >
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
      {busy && version !== null && (
        <p role="status" className="px-2 text-meta text-reed">
          Saving the portrait
        </p>
      )}
      {id === null && (
        <p id={`${errorId}-hint`} className="sr-only">
          Add a name first; the portrait can be added once the {noun} is saved.
        </p>
      )}
      {error && (
        <p role="alert" className="text-pretty text-ember text-meta">
          {error}
        </p>
      )}
    </div>
  );
}
