import type { LorebookEntry } from "../card/schema.ts";
import type { LorebookReport } from "../prompt/inspect.ts";
import type { EntrySettings } from "./settings.ts";

/*
 * Event pools for one request: at most one
 * entry of a pool goes in. The result is chat content, like the rest of an
 * activation (activate.ts).
 */

/** Why an entry was dropped: the pool, and the combined index of the entry holding it, if any. */
type PoolLoss = NonNullable<LorebookReport["entries"][number]["pool"]>;

/**
 * The request's pools, settled once each. A pool is settled from the start
 * by a member held sticky, and otherwise by the first pass that activates one
 * of its members; from then on every member activating later is dropped, also
 * when its holder then misses its chance or does not fit the budget.
 */
export class EventPools {
  /** Each settled pool's holder; null when every member that took it was dropped in another pool. */
  private readonly settled = new Map<string, number | null>();
  /** What a pool's draw reads of each member: its settings, and its entry's insertion order. */
  private readonly members: readonly EntrySettings[];
  private readonly entries: readonly LorebookEntry[];
  private readonly random: () => number;
  /** Whether any entry names a pool: without one, nothing is resolved or drawn. */
  readonly used: boolean;

  constructor(
    settings: readonly EntrySettings[],
    entries: readonly LorebookEntry[],
    random: () => number,
  ) {
    this.members = settings;
    this.entries = entries;
    this.random = random;
    this.used = settings.some((member) => member.pools.length > 0);
  }

  /** Settles the pools of an entry held by a sticky effect; the first such entry holds them. */
  hold(index: number): void {
    for (const name of this.members[index]?.pools ?? []) {
      if (!this.settled.has(name)) this.settled.set(name, index);
    }
  }

  /**
   * Resolves one pass's newly activated entries (in any order) before their
   * chance rolls: returns the entries dropped, each with its loss. Members of
   * a pool already settled are dropped. The other pools are taken in the
   * order each first appears among the pass's entries in combined order; a
   * pool with more than one member still standing goes to its prioritized
   * member with the highest insertion order (ties: the earliest), else to one
   * drawn by weight with one draw. Losers drop out of every pool at once; the
   * winner competes in its other pools.
   */
  resolve(activated: readonly number[]): Map<number, PoolLoss> {
    const lost = new Map<number, PoolLoss>();
    if (!this.used) return lost;
    const ordered = activated.toSorted((a, b) => a - b);
    const drop = (index: number, name: string, holder: number | null) => {
      lost.set(index, holder === null ? { name } : { name, holder });
    };
    // Pools in first appearance, each with its members in combined order.
    const pools = new Map<string, number[]>();
    for (const index of ordered) {
      for (const name of this.members[index]?.pools ?? []) {
        const members = pools.get(name) ?? [];
        members.push(index);
        pools.set(name, members);
      }
    }
    for (const index of ordered) {
      const name = this.members[index]?.pools.find((pool) => this.settled.has(pool));
      if (name !== undefined) drop(index, name, this.settled.get(name) ?? null);
    }
    for (const [name, members] of pools) {
      if (this.settled.has(name)) continue;
      const standing = members.filter((index) => !lost.has(index));
      const winner = standing.length > 1 ? this.choose(standing) : standing[0];
      this.settled.set(name, winner ?? null);
      if (winner === undefined) continue;
      for (const index of standing) if (index !== winner) drop(index, name, winner);
    }
    return lost;
  }

  /** A contested pool's winner among `standing` (two or more, in combined order). */
  private choose(standing: readonly number[]): number {
    const member = (index: number) => this.members[index];
    const order = (index: number) => this.entries[index]?.insertionOrder ?? 0;
    const prioritized = standing.filter((index) => member(index)?.poolPrioritized === true);
    if (prioritized.length > 0) {
      // Highest order first; the earliest wins a tie, as the first one found is kept.
      return prioritized.reduce((best, index) => (order(index) > order(best) ? index : best));
    }
    const weights = standing.map((index) => member(index)?.poolWeight ?? 0);
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let draw = this.random() * total;
    for (const [at, index] of standing.entries()) {
      draw -= weights[at] ?? 0;
      if (draw < 0) return index;
    }
    // Rounding at the very top of the range: the last member.
    return standing[standing.length - 1] ?? 0;
  }
}
