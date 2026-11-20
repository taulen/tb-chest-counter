/**
 * Which map tiles a scan's map pass reads, in which order — and which it can
 * skip as it goes (scheduler/game-protocol-phase.ts reads them, TILE_BATCH at
 * a time, and reports back what each batch held).
 *
 * In priority order:
 *   1. own    every member's city tile, every scan — their shield and burning
 *             state come from it, and most vaults stand on it too;
 *   2. track  the tile of each member's vault still standing at the last
 *             pass, so its "last seen" stays true (usually already in 1);
 *   3. reach  while vaults are being raised (Ancients' Treasure, the run's
 *             first day): the ≤ 4 tiles within a vault's reach of the city of
 *             each member who has no vault yet. A member's tiles drop out the
 *             moment their vault is found — in an earlier batch of the same
 *             pass, or on an earlier scan that day — since a player raises
 *             one vault a run.
 *
 * Pure: no requests, no database. Tested in tests/scheduler/map-plan.test.ts.
 */

export interface TilePlanInput {
  /** Members' own city tiles. */
  own: Iterable<number>;
  /** Tiles of member vaults to follow. */
  track: Iterable<number>;
  /** Member (game player id) → the tiles within vault reach of their city. */
  reach: Map<number, number[]>;
  /** Members whose vault was already found this run. */
  found: Iterable<number>;
  /** Search members' reach for vaults (the treasure day, or a new vault just seen). */
  search: boolean;
}

export class TilePlan {
  private readonly own: number[];
  private readonly track: number[];
  private readonly reach: Map<number, number[]>;
  private readonly found: Set<number>;
  private readonly done = new Set<number>();
  private searching: boolean;

  constructor(input: TilePlanInput) {
    this.own = [...input.own];
    this.track = [...input.track];
    this.reach = input.reach;
    this.found = new Set(input.found);
    this.searching = input.search;
  }

  /** Start searching members' reach (a vault nobody had seen turned up). */
  startSearch(): void {
    this.searching = true;
  }

  get isSearching(): boolean {
    return this.searching;
  }

  /** A member's vault was seen: their reach is no longer needed. */
  markFound(playerId: number): void {
    this.found.add(playerId);
  }

  /** Members still without a vault, while searching (0 when not). */
  get stillSearching(): number {
    if (!this.searching) return 0;
    let n = 0;
    for (const p of this.reach.keys()) if (!this.found.has(p)) n++;
    return n;
  }

  /** Tiles read so far. */
  get readCount(): number {
    return this.done.size;
  }

  /** The next batch: up to `size` unread tiles still needed, highest priority first. */
  next(size: number): number[] {
    const out: number[] = [];
    const seen = new Set<number>();
    const add = (t: number): boolean => {
      if (t < 0 || this.done.has(t) || seen.has(t)) return out.length < size;
      seen.add(t);
      out.push(t);
      return out.length < size;
    };
    for (const t of this.own) if (!add(t)) return out;
    for (const t of this.track) if (!add(t)) return out;
    if (this.searching) {
      for (const [player, tiles] of this.reach) {
        if (this.found.has(player)) continue;
        for (const t of tiles) if (!add(t)) return out;
      }
    }
    return out;
  }

  /** These tiles were read. */
  markRead(tiles: Iterable<number>): void {
    for (const t of tiles) this.done.add(t);
  }
}
