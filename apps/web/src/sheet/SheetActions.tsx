import { useState } from "react";
import { useFormFactor } from "@/app/form-factor.ts";
import { DeleteIcon, DuplicateIcon, ExportIcon, MoreIcon } from "@/components/icons";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuLinkItem,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import { cn } from "@/lib/cn";
import { ExportLink, type ExportTarget } from "../signin/ExportLink.tsx";
import { notReached } from "../signin/signin.ts";
import type { CreateOutcome } from "./saving.ts";

/** A phone action row in the bottom sheet. */
export const SHEET_ROW =
  "press flex h-13 w-full items-center gap-4 rounded-md px-4 text-left text-ink text-lead hover:bg-surface-hover [&_svg]:text-reed";

/** One export the actions offer: its label and the file it downloads. */
export interface SheetExport {
  label: string;
  file: ExportTarget;
}

/**
 * A sheet's More actions: Duplicate, its exports, and Delete behind a
 * confirmation. A menu on desktop and tablet, a bottom sheet on phones.
 * Duplicate and the exports work from what is saved, so pending edits are
 * flushed first; every failure is said through `onError`. `cannotDelete`
 * explains why Delete is unavailable; `locked` turns Duplicate and Delete
 * off while an AI Rework holds the sheet, leaving the exports on.
 */
export function SheetActions({
  name,
  label,
  flush = async () => true,
  onError,
  duplicate,
  exports = [],
  deleteLabel = "Delete",
  deleteTitle,
  deleteDescription,
  onDelete,
  cannotDelete,
  locked = false,
}: {
  /** The entity's name, which names the actions and the exported files. */
  name: string;
  label: string;
  /** Saves pending edits; false when they could not be saved. */
  flush?: () => Promise<boolean>;
  onError: (message: string) => void;
  /** Duplicate, when the entity offers it: `copy` makes the copy, `open` refreshes and opens it. */
  duplicate?: {
    copy: () => Promise<CreateOutcome>;
    open: (id: string) => Promise<void> | void;
  };
  exports?: SheetExport[];
  /** What Delete is called, here and on the confirmation. */
  deleteLabel?: string;
  deleteTitle: string;
  deleteDescription: string;
  /** Deletes the entity and leaves its sheet; false when Ephemera was not reached. */
  onDelete: () => Promise<boolean>;
  cannotDelete?: string;
  locked?: boolean;
}) {
  const phone = useFormFactor() === "phone";
  const [sheetOpen, setSheetOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const onDuplicate = async () => {
    if (duplicate === undefined) return;
    if (!(await flush())) return onError("Not duplicated: the latest edits are not saved yet.");
    const copy = await duplicate.copy();
    if (!copy.ok) return onError(`Not duplicated: ${copy.reason}.`);
    await duplicate.open(copy.id);
  };

  // The file holds what is saved, so pending edits are saved first, as for Duplicate.
  const exportReady = async () => {
    if (await flush()) return true;
    onError("Not exported: the latest edits are not saved yet.");
    return false;
  };
  const exportLink = (file: ExportTarget) => (
    <ExportLink file={file} name={name} ready={exportReady} onError={onError} />
  );

  const remove = async () => {
    if (!(await onDelete())) onError(`Not deleted: ${notReached()}.`);
  };

  const dialog = (
    <ConfirmDialog
      open={deleting}
      onOpenChange={setDeleting}
      title={deleteTitle}
      description={deleteDescription}
      confirm={deleteLabel}
      onConfirm={() => void remove()}
    />
  );

  if (phone) {
    return (
      <>
        <Button size="icon" aria-label="More actions" onClick={() => setSheetOpen(true)}>
          <MoreIcon />
        </Button>
        <Drawer open={sheetOpen} onOpenChange={setSheetOpen} showSwipeHandle>
          <DrawerContent>
            <DrawerTitle className="sr-only">Actions for {name}</DrawerTitle>
            <ul className="grid gap-0.5 px-3 pt-2 pb-[calc(1rem+env(safe-area-inset-bottom))]">
              {duplicate && (
                <li>
                  <button
                    type="button"
                    disabled={locked}
                    className={cn(SHEET_ROW, "disabled:text-text-disabled")}
                    onClick={() => {
                      setSheetOpen(false);
                      void onDuplicate();
                    }}
                  >
                    <DuplicateIcon size={24} />
                    Duplicate
                  </button>
                </li>
              )}
              {exports.map(({ label: text, file }) => (
                <li key={text}>
                  <ExportLink
                    file={file}
                    name={name}
                    ready={exportReady}
                    onError={onError}
                    className={SHEET_ROW}
                    onClick={() => setSheetOpen(false)}
                  >
                    <ExportIcon size={24} />
                    {text}
                  </ExportLink>
                </li>
              ))}
              <li>
                <button
                  type="button"
                  disabled={cannotDelete !== undefined || locked}
                  className={cn(
                    SHEET_ROW,
                    "text-ember disabled:text-text-disabled [&_svg]:text-current",
                  )}
                  onClick={() => {
                    setSheetOpen(false);
                    setDeleting(true);
                  }}
                >
                  <DeleteIcon size={24} />
                  {deleteLabel}
                </button>
                {cannotDelete && <p className="px-4 pb-2 text-note text-reed">{cannotDelete}</p>}
              </li>
            </ul>
          </DrawerContent>
        </Drawer>
        {dialog}
      </>
    );
  }

  return (
    <>
      <Menu>
        <MenuTrigger render={<Button size="icon" aria-label="More actions" />}>
          <MoreIcon />
        </MenuTrigger>
        <MenuContent label={label}>
          {duplicate && (
            <MenuItem disabled={locked} onClick={() => void onDuplicate()}>
              <DuplicateIcon size={16} />
              Duplicate
            </MenuItem>
          )}
          {exports.map(({ label: text, file }) => (
            <MenuLinkItem key={text} closeOnClick render={exportLink(file)}>
              <ExportIcon size={16} />
              {text}
            </MenuLinkItem>
          ))}
          {(duplicate !== undefined || exports.length > 0) && <MenuSeparator />}
          <MenuItem
            danger
            disabled={cannotDelete !== undefined || locked}
            onClick={() => setDeleting(true)}
          >
            <DeleteIcon size={16} />
            {deleteLabel}
          </MenuItem>
          {cannotDelete && (
            <p className="max-w-60 px-2.5 py-1.5 text-meta text-reed">{cannotDelete}</p>
          )}
        </MenuContent>
      </Menu>
      {dialog}
    </>
  );
}
