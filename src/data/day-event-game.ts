/**
 * Ragnarök and Dark Omens per-day tables built from the game (Events →
 * Ragnarok / Dark Omens, Tools → Rewards): points per day, total and rank,
 * read every scan the way every event is (game_event_runs / _standings /
 * _standing_history) instead of pasted.
 *
 * A run's ranking is cumulative, so a day's points are the step between a
 * member's points at the day's 17:00 UTC end and at the previous day's — a
 * member's points at a moment are their newest standing-history row at or
 * before it, as Olympus' are (olympus-game.ts). The last day keeps every read
 * until the run closes, so its cumulative points are the final ones. A
 * one-day run (Seasonal Kingdom Ragnarök, Nov 2026) is one column; a two-day
 * run two.
 *
 * Runs are found by title (event-mapping's catalogKeyForEventTitle) and keyed
 * like the pasted ones and the Events page's runs, by the game day they start
 * on. Dark Omens had no run read when this was written (Nov 25 2026): which
 * of its rankings the game answers for the event — Spoils of Dread damage,
 * shown on its tab and split by in Rewards — is to be checked on its first run.
 */
import { gameDateFor } from '../utils/game-day.js';
import { catalogKeyForEventTitle } from '../game-protocol/event-mapping.js';
import {
  getEventStandings, listEventRuns, listStandingHistory, type StoredEventRun,
} from './repositories/game-event-repo.js';
import { gamePlayerNames } from './game-player-names.js';

export type DayEventKey = 'ragnarok' | 'dark-omens';

const DAY_MS = 86_400_000;

/** When game day `date` starts (its rollover), epoch ms. */
function dayStartMs(date: string, rolloverUtcHour: number): number {
  return Date.parse(`${date}T00:00:00Z`) + rolloverUtcHour * 3_600_000;
}

/** The game day a run starts on (or, with no start, the day holding its last moment). */
function runStartDay(run: Pick<StoredEventRun, 'startsAt' | 'endsAt'>, rolloverUtcHour: number): string | null {
  if (run.startsAt !== null) return gameDateFor(run.startsAt * 1000, rolloverUtcHour);
  if (run.endsAt !== null) return gameDateFor(run.endsAt * 1000 - 1, rolloverUtcHour);
  return null;
}

/** The clan's runs of the event that have standings, newest first, each with its start day. */
function eventRuns(clanId: number, key: DayEventKey, rolloverUtcHour: number): Array<{ date: string; run: StoredEventRun }> {
  const out: Array<{ date: string; run: StoredEventRun }> = [];
  for (const run of listEventRuns(clanId)) {
    if (catalogKeyForEventTitle(run.title) !== key) continue;
    const date = runStartDay(run, rolloverUtcHour);
    if (date) out.push({ date, run });
  }
  return out;
}

/** Start days of the runs the game has standings for, newest first. */
export function dayEventGameRunDates(clanId: number, key: DayEventKey, rolloverUtcHour: number): string[] {
  return [...new Set(eventRuns(clanId, key, rolloverUtcHour).map((r) => r.date))].sort().reverse();
}

export interface GameDayColumn {
  /** The day; `first` = `last`, the shape the Ancients columns share. */
  first: number;
  last: number;
  /** The day is on now. */
  live: boolean;
}

export interface GameDayPlayer {
  memberId: number | null;
  name: string;
  rawName: string;
  matchKind: 'game';
  /** Points as they stood after each day (the last one: so far) — what Tools → Rewards splits by. */
  cumulative: Record<number, number>;
  /** Points scored on each day. */
  perSummon: Record<number, number>;
  total: number;
  /** Days with points in them. */
  played: number;
  /** The game's rank. */
  rank: number;
}

export interface GameDayEvent {
  /** The run is on now. */
  live: boolean;
  /** The newest read of the run. */
  readAt: string;
  columns: GameDayColumn[];
  /** Days `cumulative` holds, for Tools → Rewards. */
  days: number[];
  players: GameDayPlayer[];
}

/**
 * The run that started on game day `date`, or null when the game has no
 * standings for one. Two runs on one start day (can't happen with one run per
 * day) keep the one read last.
 */
export function buildGameDayEvent(
  clanId: number, key: DayEventKey, date: string, rolloverUtcHour: number, nowMs = Date.now(),
): GameDayEvent | null {
  let run: StoredEventRun | null = null;
  for (const r of eventRuns(clanId, key, rolloverUtcHour)) {
    if (r.date === date && (!run || r.run.lastRead > run.lastRead)) run = r.run;
  }
  if (!run) return null;
  const standings = getEventStandings(clanId, run);
  if (!standings.length) return null;

  const start = dayStartMs(date, rolloverUtcHour);
  const endMs = run.endsAt !== null ? run.endsAt * 1000 : null;
  // Days the run spans (by its own end), else days begun by now; at least one.
  const span = endMs !== null ? Math.ceil((endMs - start) / DAY_MS) : Math.floor((nowMs - start) / DAY_MS) + 1;
  const runDays = Math.max(1, span);
  const begun = Math.min(runDays, Math.max(1, Math.floor((nowMs - start) / DAY_MS) + 1));
  const days = Array.from({ length: begun }, (_, i) => i + 1);
  const nowSec = nowMs / 1000;
  const live = (run.startsAt ?? 0) <= nowSec && (run.endsAt === null || run.endsAt > nowSec);
  const dayLive = (d: number) => live && nowMs >= start + (d - 1) * DAY_MS && nowMs < start + d * DAY_MS;

  const history = listStandingHistory(clanId, run);
  const names = gamePlayerNames(clanId, standings.map((s) => s.playerId));

  const players: GameDayPlayer[] = standings.map((s) => {
    const h = history.get(s.playerId) ?? [];
    const pointsAt = (ms: number): number => {
      const iso = new Date(ms).toISOString();
      let v = 0;
      for (const x of h) {
        if (x.at > iso) break;
        v = x.points;
      }
      return v;
    };
    const cumulative: Record<number, number> = {};
    const perSummon: Record<number, number> = {};
    let prev = 0;
    for (const d of days) {
      // The run's last day has no next day: it keeps every read until the run
      // closes, so its total is the final standing.
      const cum = d === runDays ? s.points : Math.min(pointsAt(Math.min(start + d * DAY_MS, nowMs)), s.points);
      cumulative[d] = cum;
      perSummon[d] = cum - prev;
      prev = cum;
    }
    const n = names.get(s.playerId);
    const name = n?.name || `#${s.playerId}`;
    return {
      memberId: n?.memberId ?? null, name, rawName: name, matchKind: 'game' as const,
      cumulative, perSummon, total: s.points,
      played: Object.values(perSummon).filter((v) => v > 0).length,
      rank: s.rank,
    };
  });
  players.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));

  return {
    live,
    readAt: run.lastRead,
    columns: days.map((d) => ({ first: d, last: d, live: dayLive(d) })),
    days,
    players,
  };
}
