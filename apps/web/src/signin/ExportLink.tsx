import { exportFileName } from "@ephemera/core";
import type { ComponentProps } from "react";
import { exportUrl } from "../characters/queries.ts";
import { lorebookExportUrl } from "../lorebooks/queries.ts";
import { type PresetKind, presetExportUrl } from "../presets/queries.ts";
import { downloadWhenSignedIn } from "./download.ts";

/** What an export link downloads: a card file, a library lorebook or one preset. */
export type ExportTarget =
  | { kind: "character"; id: string; format: "png" | "json" }
  | { kind: "lorebook"; id: string }
  | { kind: PresetKind; id: string };

const hrefOf = (target: ExportTarget): string =>
  target.kind === "character"
    ? exportUrl(target.id, target.format)
    : target.kind === "lorebook"
      ? lorebookExportUrl(target.id)
      : presetExportUrl(target.kind, target.id);

/**
 * An export download: a same-origin link to the export route with
 * `download`, so the page does not navigate (no leave prompt) and no object
 * URL is made. The persistence audit exempts exactly this file for the
 * `download` attribute: it builds its address from an export target, so it
 * can only ever point at a card, lorebook or preset export, never at chat
 * content.
 */
export function ExportLink({
  file,
  name,
  ready,
  onClick,
  onError,
  ...props
}: {
  file: ExportTarget;
  /** The exported item's name, which names the file. */
  name: string;
  /** Saves pending edits first; false keeps the file from downloading without them. */
  ready?: () => Promise<boolean>;
  onError?: (message: string) => void;
} & Omit<ComponentProps<"a">, "href" | "download" | "onError">) {
  // Chromium names the file after the attribute, so it carries the same name as the header.
  return (
    <a
      href={hrefOf(file)}
      download={exportFileName(name, file.kind === "character" ? file.format : "json")}
      onClick={(event) => {
        onClick?.(event);
        downloadWhenSignedIn(event, ready, onError);
      }}
      {...props}
    />
  );
}
