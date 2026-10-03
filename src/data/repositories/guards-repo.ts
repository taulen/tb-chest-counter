/**
 * Guards (guardsmen) levels per member — estimated, never stored.
 *
 * Every read rebuilds each member's evidence from resource_transactions (Omen
 * Essence and Scientific Tractates donations, see src/config/guards-ladder.ts)
 * plus any level an admin entered in member_guards_reports, and runs the
 * estimator over it (src/data/guards-estimator.ts). The result is cached briefly
 * per clan; the inputs change at most once a day.
 *
 * Two passes per clan: the first with no prior, then again with the clan's own
 * level make-up as a tie-breaker, so a member whose only donation fits two
 * levels equally lands on the one their clan is made of rather than the lower
 * by default.
 *
 * Deliberately unrelated to the ChestTracker `guardsLevel` the external ingest
 * carries: that is hand-maintained elsewhere, lags real level-ups, and uses G1
 * as "not set". Nothing here reads it.
 */
import { getDb } from '../database.js';
import { cached, invalidate } from '../../utils/ttl-cache.js';
import { childLogger } from '../../utils/logger.js';
import { daysBetweenGameDates } from '../../utils/game-day.js';
import {
  ESSENCE_RESOURCE_SLUG,
  GUARDS_STALE_DAYS,
  TRACTATE_RESOURCE_SLUG,
  TRACTATE_TIERS,
} from '../../config/guards-ladder.js';
import {
  buildLevelPrior,
  estimateGuardsLevel,
  type GuardsConfidence,
  type GuardsEstimate,
  type GuardsLevelUp,
  type GuardsObservation,
} from '../guards-estimator.js';

const log = childLogger('guards-repo');

const CACHE_TTL_MS = 60_000;
const CACHE_PREFIX = 'guards:';

/** Drop the cached estimates — one clan, or every clan. */
export function invalidateGuardsCache(clanId?: number): void {
  invalidate(clanId === undefined ? CACHE_PREFIX : `${CACHE_PREFIX}${clanId}:`);
}

export interface GuardsReport {
  id: number;
  memberId: number;
  level: number;
  observedDate: string;
  note: string;
  createdBy: number | null;
  createdByName: string | null;
  createdAt: string;
}

/** What a table cell needs: the level, how sure, and how old. */
export interface MemberGuardsSummary {
  level: number;
  asOf: string;
  confidence: GuardsConfidence;
  /** No new evidence for GUARDS_STALE_DAYS — the level may have moved on. */
  stale: boolean;
  /** The newest evidence is an admin's entry rather than a donation. */
  reported: boolean;
  lastLevelUp: GuardsLevelUp | null;
}

// One warning per missing slug per process: a renamed resource type would
// otherwise turn every member's level into a quiet "unknown".
const warnedSlugs = new Set<string>();

function warnIfSlugMissing(): void {
  const db = getDb();
  for (const slug of [ESSENCE_RESOURCE_SLUG, TRACTATE_RESOURCE_SLUG]) {
    if (warnedSlugs.has(slug)) continue;
    const hit = db.prepare('SELECT 1 AS ok FROM resource_types WHERE slug = ?').get(slug);
    if (!hit) {
      warnedSlugs.add(slug);
      log.warn(
        `Guards levels: no resource type with slug "${slug}" — every estimate that depends on it `
        + 'will read as unknown. Check ESSENCE_RESOURCE_SLUG / TRACTATE_RESOURCE_SLUG in '
        + 'src/config/guards-ladder.ts against resource_types.',
      );
    }
  }
}

/** Every member's raw evidence, keyed by member id. */
function loadObservations(clanId: number): Map<number, GuardsObservation[]> {
  const db = getDb();
  warnIfSlugMissing();

  // Tractates are filtered to the tier amounts in SQL: the table holds thousands
  // of other tractate lines (the 250k gold-pass line alone is most of them), none
  // of which says anything about a level.
  const tierAmounts = TRACTATE_TIERS.map((t) => t.amount);
  const rows = db.prepare(`
    SELECT rt.member_id AS memberId, t.slug AS slug, rt.transaction_date AS date, rt.amount AS amount
    FROM resource_transactions rt
    JOIN resource_types t ON t.id = rt.resource_type_id
    WHERE rt.clan_id = ? AND rt.direction = 1
      AND (t.slug = ? OR (t.slug = ? AND rt.amount IN (${tierAmounts.map(() => '?').join(',')})))
  `).all(clanId, ESSENCE_RESOURCE_SLUG, TRACTATE_RESOURCE_SLUG, ...tierAmounts) as Array<{
    memberId: number; slug: string; date: string; amount: number;
  }>;

  const reports = db.prepare(`
    SELECT member_id AS memberId, level, observed_date AS date
    FROM member_guards_reports WHERE clan_id = ?
  `).all(clanId) as Array<{ memberId: number; level: number; date: string }>;

  const out = new Map<number, GuardsObservation[]>();
  const push = (memberId: number, o: GuardsObservation): void => {
    const list = out.get(memberId);
    if (list) list.push(o);
    else out.set(memberId, [o]);
  };
  for (const r of rows) {
    push(r.memberId, {
      kind: r.slug === ESSENCE_RESOURCE_SLUG ? 'essence' : 'tractate',
      date: r.date,
      amount: r.amount,
    });
  }
  for (const r of reports) push(r.memberId, { kind: 'report', date: r.date, level: r.level });
  return out;
}

/**
 * Every member's estimate for one clan, members with no usable evidence absent.
 *
 * Returns a SHARED cached Map — read it, never mutate it.
 */
export function getGuardsEstimates(clanId: number): Map<number, GuardsEstimate> {
  return cached(`${CACHE_PREFIX}${clanId}:estimates`, CACHE_TTL_MS, () => {
    const observations = loadObservations(clanId);

    const firstPass: number[] = [];
    for (const obs of observations.values()) {
      const e = estimateGuardsLevel(obs);
      // Only levels the evidence actually settled feed the prior; a coin-flip
      // member would otherwise vote for whichever level wins ties by default.
      if (e && e.confidence !== 'low') firstPass.push(e.level);
    }
    const prior = buildLevelPrior(firstPass);

    const out = new Map<number, GuardsEstimate>();
    for (const [memberId, obs] of observations) {
      const e = estimateGuardsLevel(obs, prior);
      if (e) out.set(memberId, e);
    }
    return out;
  });
}

/** Cut an estimate down to what a table cell shows. `today` is a game day. */
export function summarizeEstimate(e: GuardsEstimate, today: string): MemberGuardsSummary {
  const age = daysBetweenGameDates(e.asOf, today);
  const newest = e.evidence[e.evidence.length - 1];
  return {
    level: e.level,
    asOf: e.asOf,
    confidence: e.confidence,
    stale: age !== null && age > GUARDS_STALE_DAYS,
    reported: newest?.kind === 'report' && newest.agrees,
    lastLevelUp: e.levelUps.length > 0 ? e.levelUps[e.levelUps.length - 1] : null,
  };
}

/** memberId → summary for every member with an estimate. */
export function getGuardsSummaries(clanId: number, today: string): Map<number, MemberGuardsSummary> {
  const out = new Map<number, MemberGuardsSummary>();
  for (const [memberId, e] of getGuardsEstimates(clanId)) out.set(memberId, summarizeEstimate(e, today));
  return out;
}

export interface ClanGuardsOverview {
  /** Active members per estimated level. */
  distribution: Array<{ level: number; members: number }>;
  /** Active members with an estimate, and without one. */
  estimated: number;
  unknown: number;
  stale: number;
  lowConfidence: number;
  /** Level-ups first seen within `recentDays`, newest first. */
  recentLevelUps: Array<GuardsLevelUp & { memberId: number; name: string }>;
}

/** The clan's make-up for the Analytics overview — active members only. */
export function getClanGuardsOverview(clanId: number, today: string, recentDays = 30): ClanGuardsOverview {
  const db = getDb();
  const active = db.prepare(
    'SELECT id, name FROM members WHERE clan_id = ? AND is_active = 1',
  ).all(clanId) as Array<{ id: number; name: string }>;
  const estimates = getGuardsEstimates(clanId);

  const counts = new Map<number, number>();
  let estimated = 0;
  let stale = 0;
  let lowConfidence = 0;
  const recentLevelUps: ClanGuardsOverview['recentLevelUps'] = [];

  for (const m of active) {
    const e = estimates.get(m.id);
    if (!e) continue;
    estimated++;
    counts.set(e.level, (counts.get(e.level) ?? 0) + 1);
    const s = summarizeEstimate(e, today);
    if (s.stale) stale++;
    if (e.confidence === 'low') lowConfidence++;
    for (const up of e.levelUps) {
      const age = daysBetweenGameDates(up.by, today);
      if (age !== null && age <= recentDays) recentLevelUps.push({ ...up, memberId: m.id, name: m.name });
    }
  }
  recentLevelUps.sort((a, b) => (a.by < b.by ? 1 : a.by > b.by ? -1 : a.name.localeCompare(b.name)));

  const distribution = [...counts.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([level, members]) => ({ level, members }));

  return {
    distribution,
    estimated,
    unknown: active.length - estimated,
    stale,
    lowConfidence,
    recentLevelUps,
  };
}

// ─── Admin-entered levels ─────────────────────────────────────

export function listGuardsReports(memberId: number, clanId: number): GuardsReport[] {
  const db = getDb();
  return db.prepare(`
    SELECT r.id, r.member_id AS memberId, r.level, r.observed_date AS observedDate, r.note,
           r.created_by AS createdBy, u.username AS createdByName, r.created_at AS createdAt
    FROM member_guards_reports r
    LEFT JOIN users u ON u.id = r.created_by
    WHERE r.member_id = ? AND r.clan_id = ?
    ORDER BY r.observed_date DESC, r.id DESC
  `).all(memberId, clanId) as GuardsReport[];
}

export function addGuardsReport(input: {
  clanId: number;
  memberId: number;
  level: number;
  observedDate: string;
  note: string;
  createdBy: number | null;
}): number {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO member_guards_reports (clan_id, member_id, level, observed_date, note, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.clanId, input.memberId, input.level, input.observedDate,
    input.note, input.createdBy, new Date().toISOString(),
  );
  invalidateGuardsCache(input.clanId);
  return Number(result.lastInsertRowid);
}

/** The deleted report's member, or null when the id isn't this clan's. */
export function deleteGuardsReport(id: number, clanId: number): { memberId: number; level: number } | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT member_id AS memberId, level FROM member_guards_reports WHERE id = ? AND clan_id = ?',
  ).get(id, clanId) as { memberId: number; level: number } | undefined;
  if (!row) return null;
  db.prepare('DELETE FROM member_guards_reports WHERE id = ? AND clan_id = ?').run(id, clanId);
  invalidateGuardsCache(clanId);
  return row;
}
