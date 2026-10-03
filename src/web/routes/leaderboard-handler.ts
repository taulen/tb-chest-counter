// Shared leaderboard query logic. Used by both the authenticated
// /api/leaderboard and the public-share /api/public/:token/leaderboard
// route — keeping the query/filter/re-rank semantics in one place so
// the two endpoints can never disagree about what the leaderboard
// looks like for a given window.

import type { Request } from 'express';
import { getLeaderboard } from '../../data/repositories/chest-repo.js';
import { getLatestMightByMember } from '../../data/repositories/might-repo.js';
import { getGuardsSummaries } from '../../data/repositories/guards-repo.js';
import { getGoldPassStatuses } from '../../data/repositories/gold-pass-repo.js';
import { listSiteContacts, type SiteContacts } from '../../data/repositories/user-repo.js';
import { buildPointsGuide, type PointsGuide } from '../../data/points-guide.js';
import { getClanById, type Clan } from '../../data/repositories/clan-repo.js';
import type { LeaderboardEntry } from '../../models/types.js';
import { loadConfig } from '../../config/index.js';
import { currentGameDate } from '../../utils/game-day.js';

function isValidIso(s: string | undefined): s is string {
  return !!s && !Number.isNaN(new Date(s).getTime());
}

/**
 * Parse the standard leaderboard query params out of a Request:
 *  - includeAll=1|true  → return one row per active member (otherwise
 *    only those with chests, capped at 25)
 *  - from=ISO, to=ISO   → half-open [from, to) UTC window
 *
 * Anything else is ignored. Invalid ISO strings fall back to the
 * unfiltered view so a typo in a shared link still loads.
 */
export function parseLeaderboardQuery(req: Request): {
  from: string | undefined;
  to: string | undefined;
  includeAllMembers: boolean;
} {
  const includeAllMembers = req.query.includeAll === '1' || req.query.includeAll === 'true';
  const fromParam = typeof req.query.from === 'string' ? req.query.from : undefined;
  const toParam = typeof req.query.to === 'string' ? req.query.to : undefined;
  return {
    from: isValidIso(fromParam) ? fromParam : undefined,
    to: isValidIso(toParam) ? toParam : undefined,
    includeAllMembers,
  };
}

/**
 * Run the leaderboard query for `clanId` with the parsed params.
 * Always includes all active members (zero-point members appear at the
 * bottom) and re-ranks 1..N so displayed ranks are gap-free.
 *
 * Each row is then decorated with the member's latest might + hero level. That
 * happens HERE rather than inside getLeaderboard() on purpose: the chest query is
 * about chests, its result is cached under a chest-shaped key, and might data
 * changes on a completely different schedule (once a day, from the OCR snapshot).
 * Joining them in SQL would tie one cache's lifetime to the other's and put a
 * might read on the Discord digest and CSV export paths that never asked for it.
 *
 * The estimated guards level and Gold Pass status ride along the same way and
 * for the same reasons — both are derived from resource and chest data on their
 * own schedule. They describe the member NOW, whatever window the board shows.
 *
 * getLatestMightByMember returns a SHARED, cached Map — never mutate it here.
 * Rows are rebuilt rather than assigned into, because getLeaderboard's own array
 * is cached too and writing to those objects would poison every later reader.
 */
export function queryLeaderboard(
  clanId: number,
  params: { from: string | undefined; to: string | undefined; includeAllMembers: boolean },
): LeaderboardEntry[] {
  const { from, to } = params;
  const rows = getLeaderboard(clanId, from, to, {
    includeAllMembers: true,
  });
  const rolloverHr = loadConfig().gameDayRolloverUtcHour;
  const might = getLatestMightByMember(clanId);
  const guards = getGuardsSummaries(clanId, currentGameDate(rolloverHr));
  const goldPass = getGoldPassStatuses(clanId, Date.now(), rolloverHr);
  if (might.size === 0 && guards.size === 0 && goldPass.size === 0) return rows;
  return rows.map((row) => {
    const hit = might.get(row.memberId);
    const g = guards.get(row.memberId);
    return {
      ...row,
      might: hit ? hit.might : null,
      heroLevel: hit ? hit.heroLevel : null,
      guardsLevel: g ? g.level : null,
      guardsConfidence: g ? g.confidence : null,
      guardsAsOf: g ? g.asOf : null,
      guardsStale: g ? g.stale : false,
      goldPass: goldPass.get(row.memberId) ?? null,
    };
  });
}

/**
 * What this clan's leaderboard shows beyond rank / chests / points — the
 * columns and colouring the FAQ has answers for.
 */
export interface LeaderboardFeatures {
  goalWeeklyPoints: number | null;
  guards: boolean;
  might: boolean;
  goldPass: boolean;
}

export interface LeaderboardFaq {
  pointsGuide: PointsGuide;
  contacts: SiteContacts;
  board: LeaderboardFeatures;
}

/**
 * Decided here, from the same rows the board renders, rather than handed over
 * by whichever page opened the FAQ. It used to be the latter, which tied the
 * FAQ's text to render timing: the share page's top-nav link and #faq / #join
 * deep links could open the FAQ before the board had loaded, and the Guards,
 * GP and Might answers silently went missing.
 *
 * The all-time query is enough because these columns don't depend on the
 * window: every window lists every active member, decorated with their latest
 * might / guards / pass whatever period is on screen. It is the cached query
 * the All tab already runs.
 */
function leaderboardFeatures(clan: Clan | null, clanId: number): LeaderboardFeatures {
  const rows = queryLeaderboard(clanId, { from: undefined, to: undefined, includeAllMembers: true });
  return {
    goalWeeklyPoints: resolveWeeklyGoalPoints(clan),
    // Same predicates the two pages use to decide their columns.
    guards: rows.some((e) => e.guardsLevel != null),
    might: rows.some((e) => e.might != null || e.heroLevel != null),
    goldPass: rows.some((e) => e.goldPass === 'current' || e.goldPass === 'previous'),
  };
}

/**
 * Everything the leaderboard FAQ modal needs from the server: the points-per-
 * chest table (global — the scoring table has no clan), who to contact (this
 * clan's admins plus the site's superadmins), and which of the board's extras
 * to explain. Shared by /api/leaderboard/faq and the public
 * /api/public/:token/faq so the two modals can't disagree.
 */
export function buildLeaderboardFaq(clanId: number): LeaderboardFaq {
  return {
    pointsGuide: buildPointsGuide(),
    contacts: listSiteContacts(clanId),
    board: leaderboardFeatures(getClanById(clanId), clanId),
  };
}

/**
 * The clan's WEEKLY points goal, or null when there isn't one.
 *
 * A goal exists only when the admin both switched the colouring on and left a
 * positive number in the field — the two are stored separately so toggling the
 * feature off for a week doesn't discard the target, and a blank number with the
 * flag on is "not configured yet", not "goal of zero" (which would paint the
 * whole board green).
 *
 * Every other timeframe is derived from this one number on the client, by
 * scaleGoalForPeriod() in lib/leaderboard-render.js — shared by the authenticated
 * page and the public share page so the two can't disagree about what a daily
 * goal is.
 */
export function resolveWeeklyGoalPoints(clan: Pick<Clan, 'leaderboardGoalEnabled' | 'leaderboardWeeklyGoalPoints'> | null | undefined): number | null {
  if (!clan || !clan.leaderboardGoalEnabled) return null;
  const n = clan.leaderboardWeeklyGoalPoints;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
}
