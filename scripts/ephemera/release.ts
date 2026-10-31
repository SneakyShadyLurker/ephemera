/**
 * Installed copies, as the Windows installer makes them: each version of the
 * code in its own folder under `EPHEMERA_HOME` (`app-<commit>`), `current`
 * naming the one in use, and `.env`, the data and the run state beside them.
 * An update downloads the next version beside the running one, so no folder
 * a running program holds is ever renamed or replaced (Windows forbids it).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { HOME_DIR, ROOT } from "./env.ts";
import { REVISION_FILE } from "./service.ts";

export const REPOSITORY = "SneakyShadyLurker/ephemera";
export const CURRENT_FILE = join(HOME_DIR, "current");
const COMMIT = /^[0-9a-f]{40}$/;
/** A folder the installer or an update made, and nothing else in the home. */
const VERSION_FOLDER = /^app-[0-9a-f]{40}(\.partial(\.tar\.gz)?)?$/;

export const isVersionFolder = (name: string) => VERSION_FOLDER.test(name);

/** Whether this code is a version of an installed copy rather than a Git checkout. */
export function installedCopy(): boolean {
  return existsSync(CURRENT_FILE) && existsSync(REVISION_FILE);
}

/** The newest commit of the branch installs follow: `main`, or `EPHEMERA_REF` for testing. */
export async function latestRevision(): Promise<string> {
  const ref = process.env.EPHEMERA_REF || "main";
  const response = await fetch(
    `https://api.github.com/repos/${REPOSITORY}/commits/${encodeURIComponent(ref)}`,
    {
      headers: { Accept: "application/vnd.github.sha" },
      signal: AbortSignal.timeout(20_000),
    },
  );
  const revision = (await response.text()).trim();
  if (!response.ok || !COMMIT.test(revision)) {
    throw new Error(`GitHub did not name the latest version (HTTP ${response.status})`);
  }
  return revision;
}

/** The system's own tar, which unpacks the archive on every platform (Git's tar misreads C:\ paths). */
function tar(): string {
  return process.platform === "win32"
    ? join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
    : "tar";
}

/** Downloads and unpacks a version beside the others; returns its folder. */
export async function downloadVersion(revision: string): Promise<string> {
  const dir = join(HOME_DIR, `app-${revision}`);
  // The running version is never replaced in place.
  if (resolve(dir) === resolve(ROOT)) throw new Error("That version is the one running");
  const partial = `${dir}.partial`;
  const archive = `${partial}.tar.gz`;
  rmSync(partial, { recursive: true, force: true });
  const response = await fetch(`https://codeload.github.com/${REPOSITORY}/tar.gz/${revision}`, {
    signal: AbortSignal.timeout(300_000),
  });
  if (!response.ok) throw new Error(`The download failed (HTTP ${response.status})`);
  await Bun.write(archive, response);
  mkdirSync(partial, { recursive: true });
  const unpacked = spawnSync(tar(), ["-xzf", archive, "-C", partial, "--strip-components=1"], {
    stdio: "ignore",
    windowsHide: true,
  });
  rmSync(archive, { force: true });
  if (unpacked.status !== 0) {
    rmSync(partial, { recursive: true, force: true });
    throw new Error("The download could not be unpacked");
  }
  writeFileSync(join(partial, "REVISION"), `${revision}\n`);
  rmSync(dir, { recursive: true, force: true });
  renameSync(partial, dir);
  return dir;
}

/** Makes `dir` the version the launcher runs. */
export function switchTo(dir: string): void {
  const next = `${CURRENT_FILE}.next`;
  writeFileSync(next, basename(dir));
  renameSync(next, CURRENT_FILE);
}

/** Removes every version but the current one and the one just replaced (kept to go back to). */
export function removeOldVersions(current: string): void {
  const keep = new Set([basename(current), basename(ROOT)]);
  for (const name of readdirSync(HOME_DIR)) {
    if (!isVersionFolder(name) || keep.has(name)) continue;
    try {
      rmSync(join(HOME_DIR, name), { recursive: true, force: true, maxRetries: 2 });
    } catch {
      // A version some program still holds stays until a later update.
    }
  }
}
