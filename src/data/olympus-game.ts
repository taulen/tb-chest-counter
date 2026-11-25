/**
 * The Olympus per-day table built from the game (Events → Olympus): the same
 * rows the hand-pasted view shows (routes/tinman.ts, `olympus`) — points per
 * day, total, rank — read every scan instead of pasted
 * (game-protocol/olympus.ts). Two measures, both per day:
 *
 *   - Olympus points: the umbrella event's Ranking → Clan members (82003),
 *     the ranking admins used to paste and the clan's score is the sum of.
 *     Cumulative over the run, so a day's points are the step between the
 *     reads either side of the day's 17:00 UTC end: a member's points at a
 *     moment are their newest standing-history row at or before it. Points
 *     scored between a day's last read and its end land on the next day —
 *     except on day 5, which keeps every read until the event closes.
 *   - Stage points: the day's stage's own Clan members ranking (day 1 Trial
 *     of the Chimera … day 5 Trial of Briareus), which starts from zero.
 *
 * Runs are keyed like the pasted ones, by their first game day: stage n read
 * on game day d belongs to the run that started on d − (n − 1); the umbrella
 * run is the one running on that first day.
 *
 * Side events: a run ranked across the whole matchup (Sealed in Flame, on
 * Lava Fountain day) sits between the days as "day n.5" — n the day it ran
 * on. Its own ranking, with the game's places; never part of a total.
 */
import { gameDateFor } from '../utils/game-day.js';
import { isMatchupRankedRun, OLYMPUS_EVENT_TYPE, OLYMPUS_STAGES } from '../game-protocol/olympus.js';
import { olympusStageDay } from '../game-protocol/event-mapping.js';
import {
  getEventStandings, getMatchup, listEventRuns, listRunsOfType, listStandingHistory, type Matchup, type StoredEventRun,
} from './repositories/game-event-repo.js';
import { gamePlayerNames } from './game-player-names.js';
import { getClanInfo } from './repositories/game-clan-repo.js';

const DAY_MS = 86_400_000;
const RUN_DAYS = OLYMPUS_STAGES.length;

function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** When game day `date` starts (its rollover), epoch ms. */
function dayStartMs(date: string, rolloverUtcHour: number): number {
  return Date.parse(`${date}T00:00:00Z`) + rolloverUtcHour * 3_600_000;
}

/** The game day a run was on: the day it started (or, with no start, the day holding its last moment). */
function runGameDay(run: Pick<StoredEventRun, 'startsAt' | 'endsAt'>, rolloverUtcHour: number): string | null {
  if (run.startsAt !== null) return gameDateFor(run.startsAt * 1000, rolloverUtcHour);
  if (run.endsAt !== null) return gameDateFor(run.endsAt * 1000 - 1, rolloverUtcHour);
  return null;
}

interface StageRun {
  day: number;
  /** The Olympus run it belongs to: its first game day. */
  runDate: string;
  run: StoredEventRun;
}

/** Every Olympus stage the clan has standings for, newest first. */
function stageRuns(clanId: number, rolloverUtcHour: number): StageRun[] {
  const out: StageRun[] = [];
  for (const run of listEventRuns(clanId)) {
    const day = olympusStageDay(run.title);
    const gameDay = day === null ? null : runGameDay(run, rolloverUtcHour);
    if (day === null || gameDay === null) continue;
    out.push({ day, runDate: addDays(gameDay, -(day - 1)), run });
  }
  return out;
}

/**
 * The run's side events (isMatchupRankedRun), keyed by "day n.5": n is the day
 * of the run it started on. Two of one day keep the one read last.
 */
function sideRuns(clanId: number, date: string, rolloverUtcHour: number): Map<number, StoredEventRun> {
  const out = new Map<number, StoredEventRun>();
  for (const run of listEventRuns(clanId)) {
    if (!isMatchupRankedRun(run)) continue;
    const gameDay = runGameDay(run, rolloverUtcHour);
    if (gameDay === null) continue;
    const n = Math.round((Date.parse(`${gameDay}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / DAY_MS) + 1;
    if (n < 1 || n > RUN_DAYS) continue;
    const day = n + 0.5;
    const had = out.get(day);
    if (!had || run.lastRead > had.lastRead) out.set(day, run);
  }
  return out;
}

/** The umbrella run (TRIALS OF OLYMPUS) on during the run's first game day — it opens an hour or so before day 1. */
function umbrellaRun(clanId: number, date: string, rolloverUtcHour: number): StoredEventRun | null {
  const from = dayStartMs(date, rolloverUtcHour) / 1000;
  const to = from + DAY_MS / 1000;
  return listRunsOfType(clanId, OLYMPUS_EVENT_TYPE)
    .find((r) => (r.startsAt ?? 0) < to && (r.endsAt === null || r.endsAt > from)) ?? null;
}

/** The run's matchup with the clan itself marked. */
function matchupWithOwn(clanId: number, umbrella: StoredEventRun | null): GameOlympus['matchup'] {
  const m = umbrella ? getMatchup(clanId, umbrella) : null;
  if (!m) return null;
  const ownId = getClanInfo(clanId)?.gameClanId ?? null;
  return { ...m, clans: m.clans.map((c) => ({ ...c, own: c.gameClanId === ownId })) };
}

/** First game days of the Olympus runs the game has stages for, newest first. */
export function olympusGameRunDates(clanId: number, rolloverUtcHour: number): string[] {
  return [...new Set(stageRuns(clanId, rolloverUtcHour).map((s) => s.runDate))].sort().reverse();
}

export interface GameOlympusColumn {
  /** The day (= stage number); `first` = `last`, the shape the Ancients columns share. */
  first: number;
  last: number;
  /** The day is on now. */
  live: boolean;
  /** The day's stage, as the game names it (tGame at display). */
  title: string;
}

export interface GameOlympusStage {
  day: number;
  title: string;
  /** read: its ranking is stored; upcoming: its day is still ahead; unread: its day passed with no ranking read. */
  state: 'read' | 'upcoming' | 'unread';
  live: boolean;
}

/** A side event of the run (Sealed in Flame): its own matchup-wide ranking. */
export interface GameOlympusSide {
  /** Where it sits: the day it ran on + 0.5 (Sealed in Flame on day 3: 3.5). */
  day: number;
  /** As the game names it (tGame at display). */
  title: string;
  live: boolean;
}

export interface GameOlympusPlayer {
  memberId: number | null;
  name: string;
  rawName: string;
  matchKind: 'game';
  /** Olympus points as they stood after each day (the last one: so far) — what Tools → Rewards splits by. */
  cumulative: Record<number, number>;
  /** Olympus points scored on each day (stage points when the run has no Olympus points). */
  perSummon: Record<number, number>;
  /** Olympus points now (the stage points' sum when there are none). */
  total: number;
  /** Each day's stage points. Absent: not in that stage's ranking. */
  stagePoints: Record<number, number>;
  stageTotal: number;
  /** Days with points in them. */
  played: number;
  /** Each side event's points and official place (rank 0: outside its top 100), by its day (3.5). Absent: not read. */
  side: Record<number, { points: number; rank: number }>;
  /** The game's rank in the Olympus ranking (by stage points when there is none). */
  rank: number;
}

export interface GameOlympus {
  /** A day of the run is on now. */
  live: boolean;
  /** The newest read of the run. */
  readAt: string;
  /** Days started or read, in order. */
  columns: GameOlympusColumn[];
  /** All five days. */
  stages: GameOlympusStage[];
  /** Side events read for the run (Sealed in Flame as day 3.5), in day order. */
  side: GameOlympusSide[];
  /** The run has Olympus points (82003); false: stage points only (read before Nov 24 2026). */
  olympusPoints: boolean;
  /** Days `cumulative` holds, for Tools → Rewards; empty without Olympus points. */
  days: number[];
  /** The clan-vs-clan matchup, when read; `own` marks the clan itself. */
  matchup: (Omit<Matchup, 'clans'> & { clans: Array<Matchup['clans'][number] & { own: boolean }> }) | null;
  players: GameOlympusPlayer[];
}

/**
 * The run that started on game day `date`; null when the game gave neither a
 * stage nor Olympus points of it. Two reads of one day's stage (can't happen
 * with one variant per kingdom) keep the one read last.
 */
export function buildGameOlympus(clanId: number, date: string, rolloverUtcHour: number, nowMs = Date.now()): GameOlympus | null {
  const byDay = new Map<number, StoredEventRun>();
  for (const s of stageRuns(clanId, rolloverUtcHour)) {
    if (s.runDate !== date) continue;
    const had = byDay.get(s.day);
    if (!had || s.run.lastRead > had.lastRead) byDay.set(s.day, s.run);
  }
  const umbrella = umbrellaRun(clanId, date, rolloverUtcHour);
  const olympus = umbrella ? getEventStandings(clanId, umbrella) : [];
  const sides = [...sideRuns(clanId, date, rolloverUtcHour)].sort((a, b) => a[0] - b[0]);
  const olympusPoints = olympus.some((s) => s.points > 0);
  if (!byDay.size && !olympusPoints) return null;

  const nowSec = nowMs / 1000;
  const isLive = (r: StoredEventRun) => (r.startsAt ?? 0) <= nowSec && (r.endsAt === null || r.endsAt > nowSec);
  const start = dayStartMs(date, rolloverUtcHour);
  // Days begun by now (the run's own clock), plus any stage read.
  const begun = Math.min(RUN_DAYS, Math.max(0, Math.floor((nowMs - start) / DAY_MS) + 1));
  const days = [...new Set([...Array.from({ length: begun }, (_, i) => i + 1), ...byDay.keys()])].sort((a, b) => a - b);
  const dayLive = (d: number) => nowMs >= start + (d - 1) * DAY_MS && nowMs < start + d * DAY_MS;

  const stageRows = new Map([...byDay].map(([d, r]) => [d, new Map(getEventStandings(clanId, r).map((s) => [s.playerId, s]))]));
  const olympusRows = new Map(olympus.map((s) => [s.playerId, s]));
  const sideRows = sides.map(([d, r]) => [d, new Map(getEventStandings(clanId, r).map((s) => [s.playerId, s]))] as const);
  const history = umbrella && olympusPoints ? listStandingHistory(clanId, umbrella) : new Map<number, Array<{ points: number; at: string }>>();

  const ids = new Set<number>(olympusRows.keys());
  for (const rows of stageRows.values()) for (const id of rows.keys()) ids.add(id);
  for (const [, rows] of sideRows) for (const s of rows.values()) if (s.rank > 0) ids.add(s.playerId);
  const names = gamePlayerNames(clanId, [...ids]);

  const players: GameOlympusPlayer[] = [...ids].map((playerId) => {
    const stagePoints: Record<number, number> = {};
    let stageTotal = 0;
    for (const [d, rows] of stageRows) {
      const row = rows.get(playerId);
      if (!row) continue;
      stagePoints[d] = row.points;
      stageTotal += row.points;
    }
    const cumulative: Record<number, number> = {};
    const perDay: Record<number, number> = {};
    if (olympusPoints) {
      const h = history.get(playerId) ?? [];
      const pointsAt = (ms: number): number => {
        const iso = new Date(ms).toISOString();
        let v = 0;
        for (const x of h) {
          if (x.at > iso) break;
          v = x.points;
        }
        return v;
      };
      let prev = 0;
      for (const d of days) {
        // The last day has no next day: it keeps every read until the event
        // closes (an hour after its 17:00 end), so its total is the final one.
        const cum = d === RUN_DAYS ? (h.length ? h[h.length - 1].points : 0) : pointsAt(Math.min(start + d * DAY_MS, nowMs));
        cumulative[d] = cum;
        perDay[d] = cum - prev;
        prev = cum;
      }
    }
    const per = olympusPoints ? perDay : stagePoints;
    const side: Record<number, { points: number; rank: number }> = {};
    for (const [d, rows] of sideRows) {
      const row = rows.get(playerId);
      if (row) side[d] = { points: row.points, rank: row.rank };
    }
    const n = names.get(playerId);
    const name = n?.name || `#${playerId}`;
    return {
      memberId: n?.memberId ?? null, name, rawName: name, matchKind: 'game' as const,
      cumulative, perSummon: per,
      total: olympusPoints ? olympusRows.get(playerId)?.points ?? 0 : stageTotal,
      stagePoints, stageTotal,
      played: Object.values(per).filter((v) => v > 0).length,
      rank: olympusRows.get(playerId)?.rank ?? 0,
      side,
    };
  });
  players.sort((a, b) => b.total - a.total || b.stageTotal - a.stageTotal || a.name.localeCompare(b.name));
  if (!olympusPoints) players.forEach((p, i) => { p.rank = i + 1; });

  const today = gameDateFor(nowMs, rolloverUtcHour);
  const runs = [...byDay.values(), ...sides.map(([, r]) => r), ...(umbrella ? [umbrella] : [])];
  return {
    live: days.some(dayLive) && (umbrella ? isLive(umbrella) : [...byDay.values()].some(isLive)),
    readAt: runs.reduce((m, r) => (r.lastRead > m ? r.lastRead : m), runs[0].lastRead),
    columns: days.map((d) => ({ first: d, last: d, live: dayLive(d), title: OLYMPUS_STAGES[d - 1].title })),
    stages: OLYMPUS_STAGES.map((s) => {
      const r = byDay.get(s.day);
      return {
        day: s.day,
        title: s.title,
        state: r ? 'read' as const : addDays(date, s.day - 1) > today ? 'upcoming' as const : 'unread' as const,
        live: dayLive(s.day),
      };
    }),
    side: sides.map(([d, r]) => ({ day: d, title: r.title, live: isLive(r) })),
    olympusPoints,
    days: olympusPoints ? days : [],
    matchup: matchupWithOwn(clanId, umbrella),
    players,
  };
}
