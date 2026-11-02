import { type DragEvent, useState } from "react";
import { useFormFactor } from "@/app/form-factor.ts";
import { ImportIcon } from "@/components/icons";

/*
 * A screen that takes dropped files: the drop handlers for its root and the
 * overlay it shows while files are dragged over it. Phones have no drag and
 * drop, so they get no handlers.
 */

const hasFiles = (event: DragEvent) => event.dataTransfer.types.includes("Files");

/** Whether files are dragged over the screen, and the handlers to spread on its root. */
export function useFileDrop(onFiles: (files: File[]) => void) {
  const phone = useFormFactor() === "phone";
  const [dragging, setDragging] = useState(false);
  const dropTarget = phone
    ? {}
    : {
        onDragEnter: (event: DragEvent) => {
          if (hasFiles(event)) setDragging(true);
        },
        onDragOver: (event: DragEvent) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        },
        onDragLeave: (event: DragEvent) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
        },
        onDrop: (event: DragEvent) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          setDragging(false);
          onFiles([...event.dataTransfer.files]);
        },
      };
  return { dragging, dropTarget };
}

/**
 * What a drop does, over the screen while files are dragged onto it
 * (`shown`). Kept mounted and hidden otherwise, so it fades in from its
 * starting style and fades out before it hides.
 */
export function DropOverlay({
  shown,
  title,
  hint,
}: {
  shown: boolean;
  title: string;
  hint: string;
}) {
  return (
    <div
      aria-hidden="true"
      hidden={!shown}
      className="pointer-events-none absolute inset-3 z-(--z-drop) grid place-items-center rounded-lg border border-control-edge bg-[color-mix(in_oklab,var(--canvas)_92%,transparent)] transition-[opacity,display] transition-discrete duration-(--duration-quick) ease-fade starting:opacity-0 [&[hidden]]:opacity-0"
    >
      <span className="grid justify-items-center gap-1 rounded-lg bg-canvas px-4 py-3 text-center">
        <span className="flex items-center gap-2 font-medium text-ink text-lead">
          <ImportIcon />
          {title}
        </span>
        <span className="text-note text-reed">{hint}</span>
      </span>
    </div>
  );
}
