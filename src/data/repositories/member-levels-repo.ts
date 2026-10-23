/**
 * Player levels reported in the in-game chat — G (guardsmen), M, S, E, C and
 * D, as people post them — imported by an admin from Admin → Levels from chat.
 *
 * Two writes per imported player:
 *  - a member_level_reports row: the full record of what was said, every
 *    letter, dated;
 *  - for G, an admin guards report (member_guards_reports), the same entry an
 *    admin makes by hand on a member's profile. The guards estimator weighs it
 *    as a pin for that date, so a G8 posted today makes the member G8 even with
 *    no donation that reveals it — and later donations can still carry them
 *    higher. Not written twice for the same member, day and level.
 *
 * Reading: each member's LATEST value per letter (a newer post that leaves a
 * letter out doesn't blank it), with the date it was reported.
 */
import { getDb } from '../database.js';
import { getAllMembers, getMemberById } from './member-repo.js';
import { addGuardsReport } from './guards-repo.js';
import { resolveNamesToMembers } from '../name-resolver.js';
import { GUARDS_MAX_LEVEL, GUARDS_MIN_LEVEL } from '../../config/guards-ladder.js';
import { LEVEL_KEYS, LEVEL_MAX, type LevelKey, type LevelReportLine, type Levels } from '../member-levels-parse.js';

export interface LevelPreviewRow {
  rawName: string;
  raw: string;
  levels: Levels;
  memberId: number | null;
  memberName: string | null;
  matchKind: 'exact' | 'fuzzy' | 'unmatched';
}

/** Match parsed chat lines to members, without saving anything. */
export function previewLevelReports(clanId: number, players: LevelReportLine[]): LevelPreviewRow[] {
  const resolved = resolveNamesToMembers(clanId, players.map((p) => p.name));
  return players.map((p, i) => ({
    rawName: p.name,
    raw: p.raw,
    levels: p.levels,
    memberId: resolved[i].member?.id ?? null,
    memberName: resolved[i].member?.name ?? null,
    matchKind: resolved[i].kind as LevelPreviewRow['matchKind'],
  }));
}

export interface LevelImportEntry {
  memberId: number;
  levels: Levels;
  raw?: string;
}

export interface LevelImportResult {
  saved: number;
  guardsReports: number;
  /** Entries dropped: member not in this clan, or no valid level. */
  rejected: number;
}

/** Keep only in-range whole-number levels. */
export function cleanLevels(raw: unknown): Levels {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: Levels = {};
  for (const k of LEVEL_KEYS) {
    const v = src[k];
    if (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= LEVEL_MAX[k]) out[k] = v;
  }
  return out;
}

export function importLevelReports(input: {
  clanId: number;
  date: string;
  entries: LevelImportEntry[];
  createdBy: string;
  createdByUserId: number | null;
}): LevelImportResult {
  const db = getDb();
  const result: LevelImportResult = { saved: 0, guardsReports: 0, rejected: 0 };
  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT INTO member_level_reports
      (clan_id, member_id, observed_date, g_level, m_level, s_level, e_level, c_level, d_level, raw_text, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const sameReport = db.prepare(
    'SELECT 1 AS hit FROM member_guards_reports WHERE clan_id = ? AND member_id = ? AND observed_date = ? AND level = ?',
  );

  const guardsToAdd: Array<{ memberId: number; level: number }> = [];
  db.transaction(() => {
    const seen = new Set<number>();
    for (const e of input.entries) {
      const levels = cleanLevels(e.levels);
      const member = Number.isInteger(e.memberId) ? getMemberById(e.memberId, input.clanId) : null;
      if (!member || seen.has(member.id) || Object.keys(levels).length === 0) {
        result.rejected++;
        continue;
      }
      seen.add(member.id);
      insert.run(
        input.clanId, member.id, input.date,
        levels.g ?? null, levels.m ?? null, levels.s ?? null, levels.e ?? null, levels.c ?? null, levels.d ?? null,
        String(e.raw ?? '').slice(0, 500), input.createdBy, now,
      );
      result.saved++;
      const g = levels.g;
      if (g !== undefined && g >= GUARDS_MIN_LEVEL && g <= GUARDS_MAX_LEVEL
        && !sameReport.get(input.clanId, member.id, input.date, g)) {
        guardsToAdd.push({ memberId: member.id, level: g });
      }
    }
  })();

  // Through the guards repo, so its cache is dropped like a hand entry's.
  for (const g of guardsToAdd) {
    addGuardsReport({
      clanId: input.clanId, memberId: g.memberId, level: g.level,
      observedDate: input.date, note: 'Posted in chat (levels import)', createdBy: input.createdByUserId,
    });
    result.guardsReports++;
  }
  return result;
}

export interface MemberLatestLevels {
  memberId: number;
  name: string;
  isActive: boolean;
  levels: Levels;
  /** When each letter was last reported. */
  asOf: Partial<Record<LevelKey, string>>;
  /** The newest report date of any letter. */
  lastReported: string;
}

/** One member's latest reported levels, or null when they never posted any. */
export function getLatestLevelsForMember(clanId: number, memberId: number): MemberLatestLevels | null {
  return getLatestLevels(clanId).find((r) => r.memberId === memberId) ?? null;
}

/** Each member's latest reported value per letter. Members never reported are absent. */
export function getLatestLevels(clanId: number): MemberLatestLevels[] {
  const rows = getDb().prepare(`
    SELECT member_id AS memberId, observed_date AS date,
           g_level AS g, m_level AS m, s_level AS s, e_level AS e, c_level AS c, d_level AS d
    FROM member_level_reports WHERE clan_id = ?
    ORDER BY observed_date ASC, id ASC
  `).all(clanId) as Array<{ memberId: number; date: string } & Record<LevelKey, number | null>>;

  const members = new Map(getAllMembers(false, clanId).map((m) => [m.id, m]));
  const out = new Map<number, MemberLatestLevels>();
  for (const r of rows) {
    const m = members.get(r.memberId);
    if (!m) continue;
    let entry = out.get(r.memberId);
    if (!entry) {
      entry = { memberId: m.id, name: m.name, isActive: m.isActive, levels: {}, asOf: {}, lastReported: r.date };
      out.set(r.memberId, entry);
    }
    for (const k of LEVEL_KEYS) {
      if (r[k] !== null && r[k] !== undefined) {
        entry.levels[k] = r[k] as number;
        entry.asOf[k] = r.date;
      }
    }
    entry.lastReported = r.date;
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}
