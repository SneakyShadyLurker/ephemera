import type { MouseEvent } from "react";
import { api, apiFetch } from "../api.ts";

/**
 * True only when Ephemera itself answered: a download link answered by the
 * sign-in redirect would take the whole tab to the portal (Chromium follows
 * it as a navigation), and the chat with it. The confirming request also
 * renews Authelia's inactivity window, so the download that follows at once
 * meets a live session.
 */
async function sessionAlive(): Promise<boolean> {
  try {
    return (await api.settings.$get()).ok;
  } catch {
    return false;
  }
}

/**
 * An export link's click: the file downloads once `ready` (pending edits
 * saved first) and the session is confirmed; signed out, the sign-in notice
 * shows and the tab stays. A modified or middle click keeps the browser's
 * own behavior (a new tab can take the redirect). The link it downloads
 * through is same-origin and short-lived.
 */
export function downloadWhenSignedIn(
  event: MouseEvent<HTMLAnchorElement>,
  ready: () => Promise<boolean> = async () => true,
  onError?: (message: string) => void,
): void {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey) return;
  if (event.shiftKey || event.altKey) return;
  event.preventDefault();
  const { href, download } = event.currentTarget;
  void (async () => {
    if (!(await ready()) || !(await sessionAlive())) return false;
    // Preflight the same native file so a refusal stays inline, without navigating.
    try {
      const response = await apiFetch(href, { signal: AbortSignal.timeout(30_000) });
      await response.body?.cancel();
      if (response.ok) return true;
      onError?.(
        response.status === 413
          ? "Not exported: this saved item exceeds the file limits. Shorten its text, then try again."
          : "Not exported: the file could not be prepared. Try again.",
      );
    } catch {
      onError?.("Not exported: the file could not be prepared. Try again.");
    }
    return false;
  })().then((alive) => {
    if (!alive) return;
    const link = document.createElement("a");
    link.href = href;
    link.download = download;
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
  });
}
