/*
 * One logical creation under a client-chosen id, for the creates the server
 * answers alike for an id it already stored (a retry makes nothing new). The
 * id and what is created are taken by the first attempt and sent again by
 * every retry until the server acknowledges one, so an answer lost after the
 * server stored it never makes a second; and while an attempt is on its way,
 * another for the same intent sends nothing. A creation the server answered
 * it refused (stored nothing) is released too, so a retry reads what it sends
 * afresh. Held in memory only, by the screen that owns the intent.
 */

/** What one creation sends, every attempt alike. */
export interface Creation<Payload> {
  readonly id: string;
  readonly payload: Payload;
}

/** What an attempt may read and take: the creation held from before, or a new one. */
export interface Attempt<Payload> {
  /** The creation an earlier attempt left unacknowledged, if any. */
  readonly held: Creation<Payload> | undefined;
  /** The held creation, else a new one under a fresh id for `payload`, held until acknowledged. */
  take: (payload: Payload) => Creation<Payload>;
  /** Lets the held creation go, so `take` makes a new one: for an intent completed another way. */
  release: () => void;
}

/** One screen's creations, one per intent `key` (New, a copy of one book). */
export function creations<Payload>() {
  const held = new Map<string, Creation<Payload>>();
  const running = new Set<string>();
  return {
    /**
     * Runs one attempt for `key`; undefined, sending nothing, while another
     * is on its way. An outcome that is `ok`, or `refused` by an answer that
     * stored nothing, releases the creation, so the next attempt for `key` is
     * a new one; any other failure keeps it for the retry.
     */
    run: async <Outcome extends { ok: boolean; refused?: boolean }>(
      key: string,
      send: (attempt: Attempt<Payload>) => Promise<Outcome>,
    ): Promise<Outcome | undefined> => {
      if (running.has(key)) return undefined;
      running.add(key);
      try {
        const outcome = await send({
          held: held.get(key),
          take: (payload) => {
            const creation = held.get(key) ?? { id: crypto.randomUUID(), payload };
            held.set(key, creation);
            return creation;
          },
          release: () => {
            held.delete(key);
          },
        });
        if (outcome.ok || outcome.refused === true) held.delete(key);
        return outcome;
      } finally {
        running.delete(key);
      }
    },
  };
}
