/** Unit test helpers; no app module imports them. */

/** Lets every queued task and its microtasks run, as one turn of the event loop. */
export const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Streams the test drives by hand; `push`/`finish` target the latest call. */
export function controlled<Event>() {
  const calls: {
    signal: AbortSignal;
    request: unknown;
    push: (event: Event) => void;
    finish: (error?: Error) => void;
  }[] = [];
  const open = async (request: unknown, signal: AbortSignal): Promise<AsyncIterable<Event>> => {
    const queue: Event[] = [];
    let done: { error?: Error } | undefined;
    let wake: () => void = () => {};
    calls.push({
      request,
      signal,
      push: (event) => {
        queue.push(event);
        wake();
      },
      finish: (error) => {
        done = error ? { error } : {};
        wake();
      },
    });
    return (async function* () {
      while (true) {
        const next = queue.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (done) {
          if (done.error) throw done.error;
          return;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    })();
  };
  return {
    open,
    calls,
    push: (event: Event) => calls.at(-1)?.push(event),
    finish: (error?: Error) => calls.at(-1)?.finish(error),
  };
}
