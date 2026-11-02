import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A workflow file that stops the start. `file` is the file's base name, an
 * operational field the start log carries; the file's content is never kept.
 */
export class WorkflowFileError extends Error {
  override readonly name = "WorkflowFileError";
  readonly file: string;
  constructor(message: string, file: string, options?: ErrorOptions) {
    super(message, options);
    this.file = file;
  }
}

/**
 * Reads the ComfyUI workflow files of one directory once at startup, in file
 * name order, for the workflow registry: the bundled one, or the one
 * `EPHEMERA_WORKFLOWS_DIR` names. Lives here because this module is the only
 * server code allowed to touch the file system (scripts/persistence-audit.ts);
 * it only reads, and only graph files, never chat content.
 */
export function readWorkflowFiles(directory: string): { file: string; source: unknown }[] {
  return readdirSync(directory)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => {
      try {
        return { file, source: JSON.parse(readFileSync(join(directory, file), "utf8")) as unknown };
      } catch (error) {
        throw new WorkflowFileError(`workflow file is not readable JSON: ${file}`, file, {
          cause: error,
        });
      }
    });
}
