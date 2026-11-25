/**
 * An event run's own scores — Tin Man per summon, Olympus / Ragnarök / Dark
 * Omens per day — in one place, for every reader: Events → Ancients and the
 * Scores tabs (routes/tinman.ts), Tools → Rewards (through that route), the
 * member profile's Events card (member-events.ts) and the Performance page's
 * Tin Man signal (performance.ts).
 *
 * The game is the source: ancients-game.ts, olympus-game.ts and
 * day-event-game.ts build each run's table from the standings every scan
 * reads. Standings were pasted by hand until Nov 2026; pasting is gone, and a
 * run the game never read (pasted before Nov 17 2026) shows its pasted table,
 * read-only (tinman-repo.ts). A run with both is the game's — except an Ancients
 * run read before reads were kept (v123), whose game table has totals only,
 * which keeps its pasted per-summon table; and Olympus runs from before its
 * game read (Nov 24 2026), whose pasted days stand.
 */
import { loadConfig } from '../config/index.js';
import { ANCIENTS_EVENT_TYPE } from '../game-protocol/ancients.js';
import { listRunsOfType } from './repositories/game-event-repo.js';
import * as tinmanRepo from './repositories/tinman-repo.js';
import { ancientsRunForDay, buildGameTinman, tinmanDayOfRun, type GameTinman } from './ancients-game.js';
import { buildGameOlympus, olympusGameRunDates, type GameOlympus } from './olympus-game.js';
import { buildGameDayEvent, dayEventGameRunDates, type GameDayEvent } from './day-event-game.js';

export type ScoreEventKey = tinmanRepo.ScoreEventKey;
export const SCORE_EVENT_KEYS: readonly ScoreEventKey[] = ['ancients', 'olympus', 'ragnarok', 'dark-omens'];

export function isScoreEventKey(key: string): key is ScoreEventKey {
  return (SCORE_EVENT_KEYS as readonly string[]).includes(key);
}

/** A player's line, the same shape from the game or a paste. */
export interface ScorePlayer {
  memberId: number | null;
  name: string;
  rawName: string;
  matchKind: string;
  cumulative: Record<number, number>;
  perSummon: Record<number, number>;
  total: number;
  played: number;
  rank: number;
}

type GameTable = GameTinman | GameOlympus | GameDayEvent;
export type GameMeta = Omit<GameTinman, 'players'> | Omit<GameOlympus, 'players'> | Omit<GameDayEvent, 'players'>;

export interface EventScores {
  date: string;
  /** The pasted uploads of a run the game never read; [] for a run from the game. */
  summons: tinmanRepo.TinmanUploadInfo[];
  players: ScorePlayer[];
  /** Where a run from the game stands (columns, live, read time…); null for a pasted run. */
  game: GameMeta | null;
}

const rollover = (): number => loadConfig().gameDayRolloverUtcHour;

/** Days of the runs the game has standings for, newest first (Ancients: Tinman days). */
function gameRunDates(clanId: number, key: ScoreEventKey): string[] {
  const r = rollover();
  if (key === 'ancients') {
    return [...new Set(listRunsOfType(clanId, ANCIENTS_EVENT_TYPE)
      .map((run) => tinmanDayOfRun(run, r))
      .filter((d): d is string => d !== null))];
  }
  if (key === 'olympus') return olympusGameRunDates(clanId, r);
  return dayEventGameRunDates(clanId, key, r);
}

/** Days of the runs with scores — from the game or pasted — newest first. */
export function eventScoreDates(clanId: number, key: ScoreEventKey, limit = 30): string[] {
  return [...new Set([...tinmanRepo.listTinmanDates(clanId, limit, key), ...gameRunDates(clanId, key)])]
    .sort().reverse().slice(0, limit);
}

/** The game's table for the run filed under `date`, or null. */
function gameTable(clanId: number, key: ScoreEventKey, date: string, pastedRounds: number, nowMs: number): GameTable | null {
  const r = rollover();
  if (key === 'ancients') {
    const run = ancientsRunForDay(clanId, date, r);
    const table = run ? buildGameTinman(clanId, run, nowMs) : null;
    // A run read before reads were kept has totals only: a pasted per-summon table beats it.
    return table && (table.reads > 0 || !pastedRounds) ? table : null;
  }
  if (pastedRounds) return null;
  return key === 'olympus' ? buildGameOlympus(clanId, date, r, nowMs) : buildGameDayEvent(clanId, key, date, r, nowMs);
}

/** One run's scores (see the file header for which source wins). */
export function getEventScores(clanId: number, key: ScoreEventKey, date: string, nowMs = Date.now()): EventScores {
  const pasted = tinmanRepo.getTinmanStandings(clanId, date, key);
  const game = gameTable(clanId, key, date, pasted.summons.length, nowMs);
  if (!game) return { date, summons: pasted.summons, players: pasted.players, game: null };
  const { players, ...meta } = game;
  return { date, summons: [], players, game: meta };
}
