/** Unit test helpers; no app module imports them. */

/** Lets every queued task and its microtasks run, as one turn of the event loop. */
export const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
