/**
 * The Tin Man per-summon table built from the game (Events → Ancients): the
 * same rows the hand-pasted view shows (routes/tinman.ts, v80) — points per
 * summon, total, rank — from every read of the run's standings.
 *
 * Summons are windows found by data/summon-windows.ts; a member's points in a
 * summon (or in a "Summons 2–3" group the reads can't split) = their points at
 * its end read − at its start read, each the member's newest standing-history
 * row at or before that read. Total and rank are the game's own.
 */
import { gameDateFor } from '../utils/game-day.js';
import { ANCIENTS_EVENT_TYPE } from '../game-protocol/ancients.js';
import {
  getEventStandings, listEventReads, listRunsOfType, listStandingHistory,
  type EventRead, type EventRunKey, type StoredEventRun,
} from './repositories/game-event-repo.js';
import { pointsPerGroup, splitSummons, type SummonRead } from './summon-windows.js';
import { gamePlayerNames } from './game-player-names.js';

/** The read rows a split works on. */
export function toSummonReads(reads: readonly EventRead[]): SummonRead[] {
  return reads.map((r) => ({
    at: Date.parse(r.readAt), left: r.summonsLeft, max: r.summonsMax, changed: r.changed, total: r.totalPoints,
  }));
}

/** A game run's Tinman day: the game day holding its last moment, as the site keys its runs (api.ts `tinmanDate`). */
export function tinmanDayOfRun(run: Pick<StoredEventRun, 'startsAt' | 'endsAt'>, rolloverUtcHour: number): string | null {
  if (run.endsAt !== null) return gameDateFor(run.endsAt * 1000 - 1, rolloverUtcHour);
  if (run.startsAt !== null) return gameDateFor(run.startsAt * 1000, rolloverUtcHour);
  return null;
}

/** The clan's Rise of the Ancients run of one Tinman day, or null. */
export function ancientsRunForDay(clanId: number, date: string, rolloverUtcHour: number): StoredEventRun | null {
  return listRunsOfType(clanId, ANCIENTS_EVENT_TYPE).find((r) => tinmanDayOfRun(r, rolloverUtcHour) === date) ?? null;
}

export interface GameSummonColumn {
  /** Summon numbers in the column: equal unless back-to-back summons couldn't be split. */
  first: number;
  last: number;
  /** Still scoring (or about to): the newest read can't call it over yet. */
  live: boolean;
}

export interface GameTinmanPlayer {
  memberId: number | null;
  name: string;
  rawName: string;
  matchKind: 'game';
  cumulative: Record<number, number>;
  /** Points per column, keyed by the column's first summon. */
  perSummon: Record<number, number>;
  total: number;
  /** Columns with points in them. */
  played: number;
  rank: number;
}

export interface GameTinman {
  run: EventRunKey & { title: string };
  /** The run is on now. */
  live: boolean;
  startsAt: string | null;
  endsAt: string | null;
  /** The newest read (or the standings' last update, for a run read before reads were kept). */
  readAt: string;
  /** Reads with a summon tag; 0 = a run read before v124 (totals only). */
  reads: number;
  summonsLeft: number | null;
  summonsMax: number | null;
  summonsUsed: number;
  columns: GameSummonColumn[];
  players: GameTinmanPlayer[];
}

const iso = (sec: number | null): string | null => (sec === null ? null : new Date(sec * 1000).toISOString());

export function buildGameTinman(clanId: number, run: StoredEventRun, nowMs = Date.now()): GameTinman | null {
  const key: EventRunKey = { eventType: run.eventType, run: run.run, occurrence: run.occurrence };
  const standings = getEventStandings(clanId, key);
  if (!standings.length) return null;
  const reads = listEventReads(clanId, key);
  const nowSec = nowMs / 1000;
  const live = (run.startsAt ?? 0) <= nowSec && (run.endsAt === null || run.endsAt > nowSec);
  const split = splitSummons(toSummonReads(reads), { now: nowMs, running: live });
  const history = listStandingHistory(clanId, key);
  const readTimes = reads.map((r) => r.readAt);
  const names = gamePlayerNames(clanId, standings.map((s) => s.playerId));

  const players: GameTinmanPlayer[] = standings.map((s) => {
    const h = history.get(s.playerId) ?? [];
    const pointsAt = (i: number): number => {
      let v = 0;
      for (const x of h) {
        if (x.at > readTimes[i]) break;
        v = x.points;
      }
      return v;
    };
    const per = pointsPerGroup(split.groups, pointsAt);
    const perSummon: Record<number, number> = {};
    let played = 0;
    split.groups.forEach((g, i) => {
      perSummon[g.first] = per[i];
      if (per[i] > 0) played++;
    });
    const n = names.get(s.playerId);
    const name = n?.name || `#${s.playerId}`;
    return {
      memberId: n?.memberId ?? null, name, rawName: name, matchKind: 'game' as const,
      cumulative: {}, perSummon, total: s.points, played, rank: s.rank,
    };
  });
  players.sort((a, b) => b.total - a.total || a.rank - b.rank || a.name.localeCompare(b.name));

  const newest = reads.length ? reads[reads.length - 1].readAt
    : standings.reduce((m, s) => (s.updatedAt > m ? s.updatedAt : m), standings[0].updatedAt);
  return {
    run: { ...key, title: run.title },
    live,
    startsAt: iso(run.startsAt),
    endsAt: iso(run.endsAt),
    readAt: newest,
    reads: reads.filter((r) => r.summonsLeft !== null).length,
    summonsLeft: split.left,
    summonsMax: split.max,
    summonsUsed: split.used,
    columns: split.groups.map((g) => ({ first: g.first, last: g.last, live: g.live })),
    players,
  };
}
