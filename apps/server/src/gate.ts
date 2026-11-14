/**
 * Lets `limit` holders in at once; the rest wait their turn in arrival order.
 * A waiter whose `signal` aborts leaves the line without taking a turn.
 */
export function createGate(limit: number) {
  let free = limit;
  const waiting: (() => void)[] = [];
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else free += 1;
  };
  return {
    /**
     * Resolves with the turn's release, to call exactly once, or with
     * undefined once `signal` aborts first.
     */
    enter(signal: AbortSignal): Promise<(() => void) | undefined> {
      if (signal.aborted) return Promise.resolve(undefined);
      if (free > 0) {
        free -= 1;
        return Promise.resolve(release);
      }
      const { promise, resolve } = Promise.withResolvers<(() => void) | undefined>();
      const admit = () => {
        signal.removeEventListener("abort", leave);
        resolve(release);
      };
      const leave = () => {
        waiting.splice(waiting.indexOf(admit), 1);
        resolve(undefined);
      };
      signal.addEventListener("abort", leave, { once: true });
      waiting.push(admit);
      return promise;
    },
  };
}
