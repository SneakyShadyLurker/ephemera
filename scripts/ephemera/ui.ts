/** Shared pieces of `./ephemera`'s terminal interface. */
import { spawnSync } from "node:child_process";
import { styleText } from "node:util";
import { cancel, isCancel, log, spinner } from "@clack/prompts";
import { ROOT } from "./env.ts";

export const accent = (text: string) => styleText("yellow", text);
export const dim = (text: string) => styleText("dim", text);
export const bold = (text: string) => styleText("bold", text);
export const command = (text: string) => styleText("cyan", text);

/** The heading every command opens with: the crescent and its lamp. */
export const TITLE = `${accent("☾")} ${bold("Ephemera")}`;

/**
 * A spinner in a terminal; where there is none (an agent, a pipe), plain
 * lines instead of animation frames.
 */
export function activity(): Pick<ReturnType<typeof spinner>, "start" | "stop" | "error"> {
  if (process.stdout.isTTY) return spinner();
  return {
    start: (message) => log.step(message ?? ""),
    stop: (message) => log.success(message ?? ""),
    error: (message) => log.error(message ?? ""),
  };
}

/** "1 model", "12 models". */
export const models = (count: number) => `${count} ${count === 1 ? "model" : "models"}`;

/**
 * Whether to wait for Enter before an error closes the window: a Windows
 * shortcut's console disappears with the command, and the message with it.
 */
export const session = { pauseOnError: false };

/** Ends the command with an error message. */
export function fail(message: string): never {
  log.error(message);
  if (session.pauseOnError) prompt("Press Enter to close this window.");
  process.exit(1);
}

/** A prompt's answer, ending the command quietly when the user cancels. */
export function answered<T>(value: T): Exclude<T, symbol> {
  if (isCancel(value)) {
    cancel("Nothing was changed after that.");
    process.exit(0);
  }
  return value as Exclude<T, symbol>;
}

/**
 * Runs a step of the checkout's own tooling under a spinner. Its output is
 * shown only when it fails.
 */
export async function step(
  label: string,
  done: string,
  argv: string[],
  env: Record<string, string | undefined> = process.env,
  cwd = ROOT,
): Promise<boolean> {
  const shown = activity();
  shown.start(label);
  const child = Bun.spawn(argv, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [out, err, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exit === 0) {
    shown.stop(done);
    return true;
  }
  shown.error(`${label} failed`);
  const output = `${out}${err}`.trim().split("\n").slice(-20).join("\n");
  if (output !== "") log.message(dim(output));
  return false;
}

/** Opens a page in the default browser. */
export function openBrowser(url: string): boolean {
  const [opener, ...args] =
    process.platform === "win32"
      ? ["cmd.exe", "/c", "start", '""', url]
      : [process.platform === "darwin" ? "open" : "xdg-open", url];
  return (
    spawnSync(opener as string, args, {
      stdio: "ignore",
      windowsHide: true,
      windowsVerbatimArguments: true,
    }).status === 0
  );
}

/** "3 minutes ago" for a moment in the past. */
export function since(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
    ["second", 1],
  ];
  const [unit, size] = units.find(([, size]) => seconds >= size) ?? ["second", 1];
  return new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(
    -Math.floor(seconds / size),
    unit,
  );
}
