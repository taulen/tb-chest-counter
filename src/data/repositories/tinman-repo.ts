/**
 * Rise of the Ancients (Tinman) standings, pasted in after each summon.
 *
 * The in-game ranking is CUMULATIVE over the run: it never resets between
 * summons, it only grows as players hit the Tin Man. So each upload is a full
 * snapshot, keyed by (clan, Tinman game day, summon), and what a player scored
 * IN a summon is the difference from their previous snapshot. Some play every
 * summon, some only one; a player missing from a later snapshot carries their
 * last total forward rather than dropping to zero.
 *
 * ── Matching pasted names to members ─────────────────────────────────────────
 *
 * Same order as the might capture's resolveMember, for the same reasons:
 *   1. a player merge rule outranks everything, and matches EXACTLY;
 *   2. every exact pass (name, alias, despaced key) across active AND inactive
 *      members before any distance pass;
 *   3. then the fuzzy tier (utils/fuzzy.ts), active members first.
 * A member can be claimed once per upload: exact matches go first, and a fuzzy
 * hit on a member someone else already holds is left unmatched for review
 * rather than handing one player two rows.
 *
 * An admin's correction sticks: assigning a name sets it on every summon of
 * that run, adds the pasted spelling as the member's alias (so the next run
 * matches it exactly), and a later upload of the same run reuses the decision —
 * including "this is nobody" on a fuzzy match.
 *
 * Nothing here ever creates a member. A pasted list is not evidence that a new
 * player exists the way a scan is; an unknown name stays unknown until an admin
 * says who it is.
 */
import { getDb } from '../database.js';
import { getAllMembers, addAlias, getMemberById } from './member-repo.js';
import { loadPlayerNameCanonicaliser } from './merge-repo.js';
import { exactMatchMember, fuzzyMatchMember } from '../../utils/fuzzy.js';
import { despace } from '../../vision/ocr-normalize.js';
import type { TinmanRow } from '../tinman-parse.js';
import type { ClanMember } from '../../models/types.js';

export const TINMAN_MAX_SUMMONS = 8;

export type TinmanMatchKind = 'exact' | 'fuzzy' | 'manual' | 'unmatched' | 'rejected';

interface Resolved {
  member: ClanMember | null;
  kind: TinmanMatchKind;
}

/** Normalised identity of a pasted name, for carrying decisions between uploads. */
function nameKey(raw: string): string {
  return despace(raw) || raw.trim().toLowerCase();
}

/**
 * Decisions an admin already made for this run, by pasted name: a manual
 * assignment, or a rejected fuzzy match. Taken from the run's other summons.
 */
function priorDecisions(clanId: number, date: string, exceptSummon: number): Map<string, Resolved> {
  const rows = getDb().prepare(`
    SELECT s.raw_name AS rawName, s.member_id AS memberId, s.match_kind AS kind
    FROM tinman_scores s JOIN tinman_uploads u ON u.id = s.upload_id
    WHERE u.clan_id = ? AND u.tinman_date = ? AND u.summon != ?
      AND s.match_kind IN ('manual', 'rejected')
    ORDER BY u.summon DESC
  `).all(clanId, date, exceptSummon) as Array<{ rawName: string; memberId: number | null; kind: TinmanMatchKind }>;
  const out = new Map<string, Resolved>();
  for (const r of rows) {
    const key = nameKey(r.rawName);
    if (out.has(key)) continue; // newest summon's decision wins
    const member = r.memberId ? getMemberById(r.memberId, clanId) : null;
    if (r.kind === 'manual' && !member) continue; // member since deleted
    out.set(key, { member, kind: r.kind });
  }
  return out;
}

/** Match every pasted row to a member, in the documented order. */
export function matchTinmanRows(
  clanId: number,
  rows: TinmanRow[],
  prior: Map<string, Resolved> = new Map(),
): Resolved[] {
  const all = getAllMembers(false, clanId);
  const active = all.filter((m) => m.isActive);
  const inactive = all.filter((m) => !m.isActive);
  const canonicalise = loadPlayerNameCanonicaliser(clanId);

  const out: Resolved[] = rows.map(() => ({ member: null, kind: 'unmatched' as TinmanMatchKind }));
  const claimed = new Set<number>();

  // Pass 0: an admin's own decision for this run.
  rows.forEach((r, i) => {
    const d = prior.get(nameKey(r.name));
    if (!d) return;
    if (d.member && claimed.has(d.member.id)) return;
    out[i] = d;
    if (d.member) claimed.add(d.member.id);
  });

  const undecided = (i: number) => out[i].kind === 'unmatched' && !prior.has(nameKey(rows[i].name));

  // Pass 1: merge rules and exact matches, across both pools.
  rows.forEach((r, i) => {
    if (!undecided(i)) return;
    const canonical = canonicalise(r.name);
    const viaRule = canonical !== r.name;
    const member = exactMatchMember(canonical, active) ?? exactMatchMember(canonical, inactive);
    if (member && !claimed.has(member.id)) {
      out[i] = { member, kind: 'exact' };
      claimed.add(member.id);
    } else if (viaRule) {
      // A rule fired but its destination isn't (or is no longer) a member — the
      // rule is the admin's word, so don't let distance guess past it.
      out[i] = { member: null, kind: 'unmatched' };
    }
  });

  // Pass 2: distance, active members first, never onto a claimed member.
  rows.forEach((r, i) => {
    if (!undecided(i) || out[i].member) return;
    if (canonicalise(r.name) !== r.name) return;
    for (const pool of [active, inactive]) {
      const member = fuzzyMatchMember(r.name, pool.filter((m) => !claimed.has(m.id)));
      if (member) {
        out[i] = { member, kind: 'fuzzy' };
        claimed.add(member.id);
        return;
      }
    }
  });

  return out;
}

export interface TinmanSaveResult {
  rows: number;
  matched: number;
  fuzzy: number;
  unmatched: number;
  replaced: boolean;
}

/** Store one summon's standings, replacing any earlier upload of the same summon. */
export function saveTinmanSummon(input: {
  clanId: number;
  date: string;
  summon: number;
  rows: TinmanRow[];
  uploadedBy: string;
}): TinmanSaveResult {
  const { clanId, date, summon, rows } = input;
  const db = getDb();
  const resolved = matchTinmanRows(clanId, rows, priorDecisions(clanId, date, summon));

  const tx = db.transaction(() => {
    const old = db.prepare(
      'SELECT id FROM tinman_uploads WHERE clan_id = ? AND tinman_date = ? AND summon = ?',
    ).get(clanId, date, summon) as { id: number } | undefined;
    if (old) {
      db.prepare('DELETE FROM tinman_scores WHERE upload_id = ?').run(old.id);
      db.prepare('DELETE FROM tinman_uploads WHERE id = ?').run(old.id);
    }
    const upload = db.prepare(`
      INSERT INTO tinman_uploads (clan_id, tinman_date, summon, uploaded_by, uploaded_at)
      VALUES (?, ?, ?, ?, ?) RETURNING id
    `).get(clanId, date, summon, input.uploadedBy, new Date().toISOString()) as { id: number };
    const insert = db.prepare(`
      INSERT INTO tinman_scores (upload_id, clan_id, rank, raw_name, member_id, match_kind, points)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    rows.forEach((r, i) => {
      insert.run(upload.id, clanId, r.rank, r.name, resolved[i].member?.id ?? null, resolved[i].kind, r.points);
    });
    return Boolean(old);
  });
  const replaced = tx() as boolean;

  return {
    rows: rows.length,
    matched: resolved.filter((r) => r.member).length,
    fuzzy: resolved.filter((r) => r.kind === 'fuzzy').length,
    unmatched: resolved.filter((r) => !r.member).length,
    replaced,
  };
}

/** Remove one summon's upload. False when there was none. */
export function deleteTinmanSummon(clanId: number, date: string, summon: number): boolean {
  const db = getDb();
  const row = db.prepare(
    'SELECT id FROM tinman_uploads WHERE clan_id = ? AND tinman_date = ? AND summon = ?',
  ).get(clanId, date, summon) as { id: number } | undefined;
  if (!row) return false;
  db.transaction(() => {
    db.prepare('DELETE FROM tinman_scores WHERE upload_id = ?').run(row.id);
    db.prepare('DELETE FROM tinman_uploads WHERE id = ?').run(row.id);
  })();
  return true;
}

/**
 * Settle who a pasted name is, for every summon of this run. A member id
 * assigns it (and records the spelling as that member's alias, so it matches
 * exactly from now on); null marks it as nobody in the clan. Returns the
 * number of rows changed — 0 when the name isn't in this run.
 */
export function assignTinmanName(clanId: number, date: string, rawName: string, memberId: number | null): number {
  const db = getDb();
  const member = memberId === null ? null : getMemberById(memberId, clanId);
  if (memberId !== null && !member) return -1;

  const ids = db.prepare(`
    SELECT s.id AS id, s.raw_name AS rawName FROM tinman_scores s JOIN tinman_uploads u ON u.id = s.upload_id
    WHERE u.clan_id = ? AND u.tinman_date = ?
  `).all(clanId, date) as Array<{ id: number; rawName: string }>;
  const key = nameKey(rawName);
  const targets = ids.filter((r) => nameKey(r.rawName) === key).map((r) => r.id);
  if (targets.length === 0) return 0;

  db.transaction(() => {
    const upd = db.prepare('UPDATE tinman_scores SET member_id = ?, match_kind = ? WHERE id = ?');
    for (const id of targets) upd.run(member?.id ?? null, member ? 'manual' : 'rejected', id);
    if (member) {
      // One player, one row per summon: whoever else this run had on that
      // member (a fuzzy guess) goes back to the review list.
      db.prepare(`
        UPDATE tinman_scores SET member_id = NULL, match_kind = 'unmatched'
        WHERE member_id = ? AND match_kind != 'manual'
          AND upload_id IN (SELECT id FROM tinman_uploads WHERE clan_id = ? AND tinman_date = ?)
      `).run(member.id, clanId, date);
    }
  })();

  if (member && nameKey(member.name) !== key && !member.aliases.some((a) => nameKey(a) === key)) {
    addAlias(member.id, rawName.trim(), clanId);
  }
  return targets.length;
}

// ─── Reading ─────────────────────────────────────────────────────

export interface TinmanUploadInfo {
  summon: number;
  uploadedAt: string;
  uploadedBy: string;
  rows: number;
  unmatched: number;
}

export interface TinmanPlayer {
  /** Matched member, or null for a name nobody has been assigned to. */
  memberId: number | null;
  name: string;
  /** The name as last pasted. */
  rawName: string;
  matchKind: TinmanMatchKind;
  /** Cumulative points after each uploaded summon (summon → points). */
  cumulative: Record<number, number>;
  /** Points scored IN each uploaded summon: the step from the previous upload. */
  perSummon: Record<number, number>;
  total: number;
  /** Summons with points scored in them. */
  played: number;
  /** Latest pasted rank. */
  rank: number;
}

export interface TinmanReviewItem {
  rawName: string;
  matchKind: TinmanMatchKind;
  memberId: number | null;
  memberName: string | null;
  points: number;
}

export interface TinmanStandings {
  date: string;
  summons: TinmanUploadInfo[];
  players: TinmanPlayer[];
  /** Pasted names nobody is assigned to, and fuzzy guesses worth a second look. */
  review: TinmanReviewItem[];
}

export function getTinmanStandings(clanId: number, date: string): TinmanStandings {
  const db = getDb();
  const uploads = db.prepare(`
    SELECT u.id, u.summon, u.uploaded_at AS uploadedAt, u.uploaded_by AS uploadedBy,
           COUNT(s.id) AS rows,
           SUM(CASE WHEN s.member_id IS NULL THEN 1 ELSE 0 END) AS unmatched
    FROM tinman_uploads u LEFT JOIN tinman_scores s ON s.upload_id = u.id
    WHERE u.clan_id = ? AND u.tinman_date = ?
    GROUP BY u.id ORDER BY u.summon ASC
  `).all(clanId, date) as Array<TinmanUploadInfo & { id: number }>;

  const scores = db.prepare(`
    SELECT u.summon AS summon, s.rank, s.raw_name AS rawName, s.member_id AS memberId,
           s.match_kind AS matchKind, s.points, m.name AS memberName
    FROM tinman_scores s
    JOIN tinman_uploads u ON u.id = s.upload_id
    LEFT JOIN members m ON m.id = s.member_id
    WHERE u.clan_id = ? AND u.tinman_date = ?
    ORDER BY u.summon ASC, s.rank ASC
  `).all(clanId, date) as Array<{
    summon: number; rank: number; rawName: string; memberId: number | null;
    matchKind: TinmanMatchKind; points: number; memberName: string | null;
  }>;

  const byKey = new Map<string, TinmanPlayer>();
  for (const s of scores) {
    const key = s.memberId ? `m:${s.memberId}` : `n:${nameKey(s.rawName)}`;
    let p = byKey.get(key);
    if (!p) {
      p = {
        memberId: s.memberId, name: s.memberName ?? s.rawName, rawName: s.rawName, matchKind: s.matchKind,
        cumulative: {}, perSummon: {}, total: 0, played: 0, rank: s.rank,
      };
      byKey.set(key, p);
    }
    // Two pasted rows on one member in one upload can't happen (claims are
    // exclusive) — but if a hand edit ever did it, keep the larger total.
    p.cumulative[s.summon] = Math.max(p.cumulative[s.summon] ?? 0, s.points);
    p.rawName = s.rawName;
    p.matchKind = s.matchKind;
    p.rank = s.rank;
  }

  const summonNumbers = uploads.map((u) => u.summon);
  for (const p of byKey.values()) {
    let prev = 0;
    for (const n of summonNumbers) {
      const cum = p.cumulative[n];
      if (cum === undefined) continue; // not in this snapshot — total carries forward
      p.perSummon[n] = cum - prev;
      if (cum - prev > 0) p.played++;
      prev = cum;
    }
    p.total = prev;
  }

  const players = [...byKey.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  const review = players
    .filter((p) => !p.memberId || p.matchKind === 'fuzzy')
    .map((p) => ({
      rawName: p.rawName, matchKind: p.matchKind, memberId: p.memberId,
      memberName: p.memberId ? p.name : null, points: p.total,
    }));

  return {
    date,
    summons: uploads.map(({ id: _id, ...u }) => ({ ...u, unmatched: u.unmatched ?? 0 })),
    players,
    review,
  };
}

/** Tinman days this clan has standings for, newest first. */
export function listTinmanDates(clanId: number, limit = 30): string[] {
  const rows = getDb().prepare(`
    SELECT DISTINCT tinman_date AS d FROM tinman_uploads WHERE clan_id = ? ORDER BY d DESC LIMIT ?
  `).all(clanId, limit) as Array<{ d: string }>;
  return rows.map((r) => r.d);
}
