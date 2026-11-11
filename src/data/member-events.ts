/**
 * One member's event record, for the Events card on their profile: their
 * Tin Man standings over the last few Rise of the Ancients runs, and for every
 * event in the catalog their points and clan rank in each recent run.
 *
 * A run here is exactly the window the Events page shows for it — a calendar
 * occurrence, a Triumphal 30-day cycle, or a plain game week for the
 * schedule-less events (Citadels, Heroics) — and the rank is the Events page's
 * canonical one (countable points, then countable chests, then name). So a
 * number on the profile always matches the table its link opens.
 *
 * Recent runs only, never all-time: an all-time breakdown is ~0.5 s for the
 * biggest event on a 160k-row clan, against ~10 ms for one run. Each run's
 * ranking is cached per clan, not per member, so paging through profiles pays
 * for it once; a chest write drops the cache (notifyChestDataChanged).
 *
 * Olympus, Ragnarok and Dark Omens also have the event's own ranking pasted in
 * day by day (Events → Scores). A run that has one is ranked by it — that is
 * the event's result; chests are only what it paid out — and a run nobody
 * pasted falls back to the chest ranking. Ancients' pasted scores have their
 * own card (Tin Man scores), so its row stays on chests.
 */
import { getEventCatalogSummary, getEventDef } from '../config/event-catalog.js';
import * as eventRepo from './repositories/event-repo.js';
import * as tinmanRepo from './repositories/tinman-repo.js';
import { getGuardsSummaries } from './repositories/guards-repo.js';
import { getClanWeekStart } from './repositories/clan-repo.js';
import { getEventOccurrences } from '../external/event-calendar.js';
import { cached } from '../utils/ttl-cache.js';
import { gameDateFor, gameWindow } from '../utils/game-day.js';

const RUNS_PER_EVENT = 5;
const WEEKS_PER_FIXED_EVENT = 4;
const TINMAN_RUNS = 5;
/** Unknown guards level is held against the G7 target, as on the Tin Man table. */
const ASSUMED_TIER = 'g7';
const RUN_CACHE_TTL_MS = 10 * 60 * 1000;
/** Dropped by notifyChestDataChanged (chest-summary-repo.ts) under this same literal. */
const MEMBER_EVENTS_CACHE_PREFIX = 'memberEvents:';

export interface MemberEventRun {
  /** The occurrence's label ("Oct 19–23"); null for a plain game week, which the page labels. */
  label: string | null;
  from: string;
  to: string;
  /** First game day of the run — the Events page's `?run=` anchor. */
  runDay: string;
  isCurrent: boolean;
  /** Dates projected from the event's cadence, not read from the feed. */
  estimated: boolean;
  points: number;
  chests: number;
  /**
   * What ranks the run: the event's pasted standings when the run has them,
   * else the member's countable chests from it.
   */
  source: 'scores' | 'chests';
  /** Null when the member has no chest in the run — or, for 'scores', isn't on the pasted ranking. */
  rank: number | null;
  participants: number;
  /** The member's countable chest points from the run, whatever ranks it. */
  chestPoints: number;
}

export interface MemberEventSummary {
  key: string;
  name: string;
  mode: 'occurrences' | 'cycle' | 'weekly';
  /** Newest first. */
  runs: MemberEventRun[];
}

export interface MemberTinmanRun {
  /** The Tinman game day the standings are filed under. */
  date: string;
  points: number;
  /** Null when the member isn't on the pasted ranking. */
  rank: number | null;
  players: number;
  /** Summons they scored in, out of `summons` uploaded. */
  played: number;
  summons: number;
  /** Their tier's target for the run, or null when none was pasted. */
  target: number | null;
}

export interface MemberEventsOverview {
  tinman: {
    tier: string;
    tierAssumed: boolean;
    /** Newest first. */
    runs: MemberTinmanRun[];
  } | null;
  events: MemberEventSummary[];
}

export interface RankedRun {
  byMember: Map<number, { rank: number; points: number; chests: number }>;
  participants: number;
}

/**
 * One event run ranked the Events page's way, cached per clan and run. Also
 * read by the Performance page (data/performance.ts), so both share the cache.
 */
export function rankedRun(key: string, clanId: number, from: string, to: string): RankedRun {
  return cached(`${MEMBER_EVENTS_CACHE_PREFIX}${clanId}:${key}:${from}:${to}`, RUN_CACHE_TTL_MS, () => {
    const players = [...(eventRepo.getEventBreakdown(key, clanId, from, to)?.players ?? [])];
    players.sort((a, b) =>
      (b.countablePoints - a.countablePoints)
      || (b.countableChests - a.countableChests)
      || a.memberName.localeCompare(b.memberName));
    const byMember = new Map<number, { rank: number; points: number; chests: number }>();
    players.forEach((p, i) => {
      if (p.memberId !== null) {
        byMember.set(p.memberId, { rank: i + 1, points: p.countablePoints, chests: p.countableChests });
      }
    });
    return { byMember, participants: players.length };
  });
}

type RunWindow = Omit<MemberEventRun, 'points' | 'chests' | 'source' | 'rank' | 'participants' | 'chestPoints'>;

/** Events ranked by their pasted standings on the profile (see the file header). */
const PASTED_RANKING_EVENTS: ReadonlySet<string> = new Set<tinmanRepo.ScoreEventKey>(['olympus', 'ragnarok', 'dark-omens']);
/** Pasted runs looked up per event: far more than the recent runs shown. */
const PASTED_DATES_LOOKUP = 30;

function isPastedRankingEvent(key: string): key is tinmanRepo.ScoreEventKey {
  return PASTED_RANKING_EVENTS.has(key);
}

/**
 * The member's line in a run's pasted standings, filed under the run's first
 * game day (its runDay) as the Events page files them. The standings come in
 * ranking order, with names nobody is assigned to counted as the players they are.
 */
function pastedRun(
  key: tinmanRepo.ScoreEventKey, clanId: number, runDay: string, memberId: number,
): Pick<MemberEventRun, 'points' | 'rank' | 'participants'> {
  const players = tinmanRepo.getTinmanStandings(clanId, runDay, key).players;
  const i = players.findIndex((p) => p.memberId === memberId);
  return {
    points: i >= 0 ? players[i].total : 0,
    rank: i >= 0 ? i + 1 : null,
    participants: players.length,
  };
}

async function runWindows(
  key: string,
  clanId: number,
  rollover: number,
): Promise<{ mode: MemberEventSummary['mode']; windows: RunWindow[] }> {
  const def = getEventDef(key);
  if (def?.cycle || def?.calendarNames?.length) {
    const occurrences = await getEventOccurrences(key, clanId).catch(() => []);
    if (occurrences.length) {
      return {
        mode: def.cycle ? 'cycle' : 'occurrences',
        windows: occurrences.slice(0, RUNS_PER_EVENT).map((o) => ({
          label: o.label,
          from: o.from,
          to: o.to,
          runDay: gameDateFor(Date.parse(o.from), rollover),
          isCurrent: o.isCurrent,
          estimated: o.estimated,
        })),
      };
    }
  }
  // No schedule (or the feed is down): the Events page falls back to game
  // weeks, so this does too.
  const weekStart = getClanWeekStart(clanId);
  const windows: RunWindow[] = [];
  for (let i = 0; i < WEEKS_PER_FIXED_EVENT; i++) {
    const w = gameWindow('weekly', i, rollover, weekStart)!;
    windows.push({
      label: null,
      from: w.from,
      to: w.to,
      runDay: gameDateFor(Date.parse(w.from), rollover),
      isCurrent: i === 0,
      estimated: false,
    });
  }
  return { mode: 'weekly', windows };
}

function tinmanOverview(clanId: number, memberId: number, today: string): MemberEventsOverview['tinman'] {
  const dates = tinmanRepo.listTinmanDates(clanId, TINMAN_RUNS);
  if (!dates.length) return null;
  const level = getGuardsSummaries(clanId, today).get(memberId)?.level ?? null;
  const tier = level ? `g${level}` : ASSUMED_TIER;
  const runs = dates.map((date) => {
    const standings = tinmanRepo.getTinmanStandings(clanId, date);
    const i = standings.players.findIndex((p) => p.memberId === memberId);
    const p = i >= 0 ? standings.players[i] : null;
    const target = tinmanRepo.getTinmanTargets(clanId, date)?.tiers[tier as keyof tinmanRepo.TinmanTargets['tiers']];
    return {
      date,
      points: p?.total ?? 0,
      rank: p ? i + 1 : null,
      players: standings.players.length,
      played: p?.played ?? 0,
      summons: standings.summons.length,
      target: target ?? null,
    };
  });
  return { tier, tierAssumed: level === null, runs };
}

export async function getMemberEventsOverview(
  clanId: number,
  memberId: number,
  rollover: number,
): Promise<MemberEventsOverview> {
  const today = gameDateFor(Date.now(), rollover);
  const events = await Promise.all(getEventCatalogSummary().map(async (e) => {
    const { mode, windows } = await runWindows(e.key, clanId, rollover);
    const scoreKey = isPastedRankingEvent(e.key) ? e.key : null;
    const pasted = scoreKey ? new Set(tinmanRepo.listTinmanDates(clanId, PASTED_DATES_LOOKUP, scoreKey)) : null;
    const runs = windows.map((w): MemberEventRun => {
      const ranked = rankedRun(e.key, clanId, w.from, w.to);
      const mine = ranked.byMember.get(memberId);
      const chestPoints = mine?.points ?? 0;
      const chests = mine?.chests ?? 0;
      if (scoreKey && pasted?.has(w.runDay)) {
        return { ...w, ...pastedRun(scoreKey, clanId, w.runDay, memberId), chests, source: 'scores', chestPoints };
      }
      return {
        ...w,
        points: chestPoints,
        chests,
        source: 'chests',
        rank: mine?.rank ?? null,
        participants: ranked.participants,
        chestPoints,
      };
    });
    return { key: e.key, name: e.name, mode, runs };
  }));
  return { tinman: tinmanOverview(clanId, memberId, today), events };
}
