import { USER_DATASET_KEY } from "@ephemera/server/identity";

/*
 * The user this tab serves (PRINCIPLES.md 2). The server writes the
 * username on the page's `<html>` as `data-user`; the tab reads it once and
 * binds every API request to it. When the browser's session turns out to
 * belong to someone else, the tab drops everything it holds and reloads, so
 * nothing of one user is ever shown or sent as another's. Tab memory only.
 * In development Vite serves the page without the attribute: the tab is
 * unbound and its requests carry no binding.
 */

/** Thrown for an API request refused, or never sent, because the tab's user changed. */
export class IdentityChanged extends Error {
  override name = "IdentityChanged";
  constructor() {
    super("Identity changed");
  }
}

/** The username on the page, when served by Ephemera; tests have no document. */
const readPage = (): string | undefined =>
  typeof document === "undefined" ? undefined : document.documentElement.dataset[USER_DATASET_KEY];

/**
 * `read` learns the username, once; `leave` ends the tab's life as this
 * user (it hides the page and reloads).
 */
export function createIdentity(read: () => string | undefined, leave: () => void) {
  let user: { value: string | undefined } | undefined;
  let changed = false;
  const listeners = new Set<() => void>();

  const hasChanged = () => changed;

  return {
    /** The username the tab is bound to, or undefined when the page carried none. */
    bound(): string | undefined {
      user ??= { value: read() };
      return user.value;
    },
    /**
     * The session now belongs to another user. Terminal and synchronous: from
     * here no request goes out, every `onChanged` owner drops its state, and no
     * unload guard holds up the reload that follows.
     */
    changed(): void {
      if (changed) return;
      changed = true;
      for (const listener of listeners) listener();
      leave();
    },
    hasChanged,
    /** Drops the tab's state when the identity changes; returns the unsubscribe. */
    onChanged(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /**
     * An unload guard's condition: `hasWork`, but never once the identity
     * changed, so the reload that discards the other user's state goes unasked.
     */
    guard(hasWork: () => boolean): () => boolean {
      return () => !changed && hasWork();
    },
    /** Reads the username again and clears the change (tests). */
    reset(): void {
      user = undefined;
      changed = false;
    },
  };
}

export type Identity = ReturnType<typeof createIdentity>;

/**
 * The tab's one identity. Leaving hides the page through its `hidden`
 * attribute (not a style, which the CSP would refuse inline) until the
 * reload replaces it.
 */
export const identity = createIdentity(readPage, () => {
  document.body.hidden = true;
  window.location.reload();
});
