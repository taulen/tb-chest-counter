/**
 * The roster the Ancient planner (Tools page) prefills from: who is in the clan
 * right now, and each member's estimated guards level.
 *
 * Source, in order of preference:
 *  1. The newest might capture, when it is at most MIGHT_ROSTER_MAX_AGE_DAYS
 *     game days old. It reads the in-game member list, so it is the closest
 *     thing to "the clan as it is today" — and it is capped by the game at 100.
 *  2. Otherwise the members any scan has seen in the last RECENT_WINDOW_DAYS,
 *     most recently seen first, capped at MAX_ROSTER — a clan never holds more,
 *     so anything past 100 is a departure the inactivity sweep hasn't caught.
 *
 * Guards levels are the estimator's (guards-repo), never stored. A member with
 * no usable donation evidence comes back with a null level; the planner decides
 * how to count them.
 */
import { getLatestCaptureRoster } from './repositories/might-repo.js';
import { getRecentlySeenMembers } from './repositories/member-repo.js';
import { getGuardsSummaries } from './repositories/guards-repo.js';
import { daysBetweenGameDates } from '../utils/game-day.js';

/** A clan holds at most 100 members. */
export const MAX_ROSTER = 100;
/** Older than this, the newest might capture no longer stands for today's clan. */
export const MIGHT_ROSTER_MAX_AGE_DAYS = 2;
/** Fallback window for "seen recently". */
export const RECENT_WINDOW_DAYS = 7;

export interface AncientRosterMember {
  memberId: number;
  name: string;
  /** Estimated guards level 1–9, or null when there is no evidence. */
  guardsLevel: number | null;
  /** The estimate has had no new evidence for a while (it may have risen). */
  guardsStale: boolean;
}

export interface AncientRoster {
  source: 'might' | 'recent' | 'none';
  /** Game day of the newest might capture, used or not. */
  mightGameDate: string | null;
  mightAgeDays: number | null;
  maxAgeDays: number;
  windowDays: number;
  maxMembers: number;
  members: AncientRosterMember[];
}

export function getAncientRoster(clanId: number, today: string, nowMs = Date.now()): AncientRoster {
  const capture = getLatestCaptureRoster(clanId, MAX_ROSTER);
  const mightAgeDays = capture ? daysBetweenGameDates(capture.gameDate, today) : null;
  const captureFresh = capture !== null && capture.members.length > 0
    && mightAgeDays !== null && mightAgeDays <= MIGHT_ROSTER_MAX_AGE_DAYS;

  let source: AncientRoster['source'];
  let picked: Array<{ memberId: number; name: string }>;
  if (captureFresh) {
    source = 'might';
    picked = capture.members;
  } else {
    const since = new Date(nowMs - RECENT_WINDOW_DAYS * 86_400_000).toISOString();
    picked = getRecentlySeenMembers(clanId, since, MAX_ROSTER);
    source = picked.length > 0 ? 'recent' : 'none';
  }

  const guards = getGuardsSummaries(clanId, today);
  const members = picked.map((m) => {
    const g = guards.get(m.memberId);
    return {
      memberId: m.memberId,
      name: m.name,
      guardsLevel: g?.level ?? null,
      guardsStale: g?.stale ?? false,
    };
  });

  return {
    source,
    mightGameDate: capture?.gameDate ?? null,
    mightAgeDays,
    maxAgeDays: MIGHT_ROSTER_MAX_AGE_DAYS,
    windowDays: RECENT_WINDOW_DAYS,
    maxMembers: MAX_ROSTER,
    members,
  };
}
