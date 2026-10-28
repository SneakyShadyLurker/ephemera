import { type ReactNode, useId, useRef, useState } from "react";
import { PlusIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { Portrait } from "./Portrait.tsx";
import { type PortraitOwner, removePortrait, setPortrait } from "./queries.ts";

/**
 * A sheet's portrait in the margin with Replace and Remove; a new sheet offers
 * Add portrait once it is saved with a name. A fresh upload surfaces out of
 * blur once, and so does a version that `arrived` through another path.
 * `extra`: the sheet's own actions under the field's (a character's New
 * art), told whether the picker is busy.
 */
export function PortraitField({
  owner,
  id,
  name,
  version,
  noun,
  locked = false,
  arrived: arrivedVersion = null,
  extra,
  onBusyChange,
  onChange,
}: {
  owner: PortraitOwner;
  id: string | null;
  name: string;
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
  extra?: ((state: { busy: boolean }) => ReactNode) | undefined;
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
        <>
          <Portrait
            owner={owner}
            id={id ?? ""}
            name={name}
            version={version}
            size="full"
            arriving={arrived || (arrivedVersion !== null && arrivedVersion === version)}
            transition
          />
          <div className="grid">
            <Button
              className="h-8 px-2 text-note touch:h-11"
              disabled={busy || locked}
              onClick={() => picker.current?.click()}
            >
              {busy ? "Replacing" : "Replace"}
            </Button>
            <Button
              className="h-8 px-2 text-note touch:h-11"
              disabled={busy || locked}
              onClick={async () => {
                if (id === null || busy || locked) return;
                setBusy(true);
                setError(null);
                const removed = await removePortrait(owner, id);
                setBusy(false);
                if (removed) onChange(null);
                else setError("The portrait could not be removed.");
              }}
            >
              Remove
            </Button>
          </div>
        </>
      )}
      {/* One place whether or not a portrait is stored, so a first portrait keeps what it holds mounted. */}
      {extra && <div className={cn("grid", version !== null && "-mt-1")}>{extra({ busy })}</div>}
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
