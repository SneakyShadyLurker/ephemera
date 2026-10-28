/*
 * What a sheet does on arrival from the screen that opened it (say what
 * brought it there, select its name for typing), meant for one entity id.
 * Kept in memory for one navigation, never in the URL or history state.
 */

/** One kind of sheet's arrivals: set before navigating, taken once by the sheet of that id. */
export function arrivals<Arrival extends object>() {
  let held: ({ id: string } & Arrival) | null = null;
  return {
    /** Asks the next sheet of `arrival.id` to act on the rest of it. */
    arriveAt: (arrival: { id: string } & Arrival) => {
      held = arrival;
    },
    /** The arrival meant for `id`, taken once; any other is dropped. */
    take: (id: string): Partial<Arrival> => {
      const arrival = held;
      held = null;
      if (arrival === null || arrival.id !== id) return {};
      const { id: _id, ...rest } = arrival;
      return rest as Partial<Arrival>;
    },
  };
}
