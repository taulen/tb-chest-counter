/**
 * Clan Capital ledger entries (15031) → resource_transactions rows.
 *
 * The ledger is the same history the OCR resource capture read off the screen,
 * one entry per line, so each entry becomes exactly one row keyed by its
 * entry id (resource_transactions.game_entry_id, unique per clan).
 *
 * Mapping, verified against the OCR rows on prod (Nov 2026):
 *   - kind 1 = clan → member payout (Dragon Coins, clan fragments): direction −1;
 *     kinds 2, 3, 4, 7 = member → clan donation: direction +1;
 *     kinds 5 and 8 = leader-side treasury entries (only ever the clan leader,
 *     at the reset; the in-game history never showed them and OCR has none) —
 *     kept in game_ledger, not imported.
 *   - the item id resolves to its resource type BY NAME (static data names ==
 *     resource_types.name), so a new resource needs no code;
 *   - Clan Speedup items are counted in hours, like the OCR rows
 *     ({2051: 2, 2054: 2} = 2×3 h + 2×24 h = 54);
 *   - the date is the 17:00-UTC game day of the entry.
 */
import type { LedgerEntry } from './messages.js';
import type { GameNames } from './static-data.js';
import { gameDateFor } from '../utils/game-day.js';

/** Clan Speedup item → hours per item. */
export const SPEEDUP_HOURS: Readonly<Record<string, number>> = { 2050: 1, 2051: 3, 2052: 8, 2053: 15, 2054: 24, 2055: 72 };
const SPEEDUP_SLUG = 'clan-speedup';

const DIRECTION_BY_KIND: Readonly<Record<number, 1 | -1>> = { 1: -1, 2: 1, 3: 1, 4: 1, 7: 1 };
/** Kinds known and deliberately not imported (leader-side treasury entries). */
export const LEADER_KINDS: ReadonlySet<number> = new Set([5, 8]);

export interface LedgerRow {
  entryId: number;
  playerId: number;
  resourceTypeId: number;
  direction: 1 | -1;
  amount: number;
  transactionDate: string;
}

export interface LedgerMapping {
  rows: LedgerRow[];
  /** Entries left out, by reason — logged so a new kind or item is noticed. */
  skipped: Record<string, number>;
}

export function ledgerToRows(
  entries: LedgerEntry[],
  names: Pick<GameNames, 'gifts'>,
  types: Array<{ id: number; name: string; slug: string }>,
  opts: {
    /** Entries on or before this game date are already covered by OCR rows ('' = none). */
    afterDate: string;
    rolloverUtcHour: number;
    untrackedSlugs: ReadonlySet<string>;
  },
): LedgerMapping {
  const byName = new Map(types.map((t) => [t.name.toLowerCase(), t]));
  const speedup = types.find((t) => t.slug === SPEEDUP_SLUG);
  const rows: LedgerRow[] = [];
  const skipped: Record<string, number> = {};
  const skip = (why: string) => { skipped[why] = (skipped[why] ?? 0) + 1; };

  for (const e of entries) {
    const direction = DIRECTION_BY_KIND[e.kind];
    if (!direction) { skip(LEADER_KINDS.has(e.kind) ? 'leader entry' : `kind ${e.kind}`); continue; }
    const transactionDate = gameDateFor(e.occurredAt * 1000, opts.rolloverUtcHour);
    if (opts.afterDate && transactionDate <= opts.afterDate) { skip('covered by OCR rows'); continue; }

    let type: { id: number; slug: string } | undefined;
    let amount = 0;
    let mixed = false;
    for (const [item, count] of Object.entries(e.amounts)) {
      const hours = SPEEDUP_HOURS[item];
      const t = hours !== undefined ? speedup : byName.get((names.gifts[item]?.chest ?? '').toLowerCase());
      if (!t) { type = undefined; mixed = false; amount = 0; skip(`unmapped item ${item}`); break; }
      if (type && type.id !== t.id) { mixed = true; break; }
      type = t;
      amount += hours !== undefined ? count * hours : count;
    }
    if (mixed) { skip('several resource types in one entry'); continue; }
    if (!type) {
      if (!Object.keys(e.amounts).length) skip('no amounts');
      continue;
    }
    if (opts.untrackedSlugs.has(type.slug)) { skip(`untracked ${type.slug}`); continue; }
    if (amount <= 0) { skip('zero amount'); continue; }
    rows.push({ entryId: e.entryId, playerId: e.playerId, resourceTypeId: type.id, direction, amount, transactionDate });
  }
  return { rows, skipped };
}
