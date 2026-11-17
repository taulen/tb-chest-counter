/**
 * The rows a member's timeline is built from (data/member-timeline.ts), all
 * already kept by other features: the player record's history, the site's
 * audit log, research / captain / artifact / equipment history, troop tier
 * changes, the city's shield / burning history, the daily might, the
 * dragon of each daily city snapshot, the player's title grants (v125) — and the clan's joins & leaves
 * (roster-changes-repo.ts), this member's part of them. Every read is
 * clan-scoped; a member without a linked game player gets only the site's own
 * entries (renames, merges, left / restored) and the might.
 */
import { getDb } from '../database.js';
import { getMemberById } from './member-repo.js';
import { getPlayerArtifactChanges, getPlayerCaptainChanges, getPlayerEquipmentChanges } from './game-profile-repo.js';
import { getMemberTiers } from '../member-tiers.js';
import { buildRosterChanges } from '../roster-changes.js';
import { loadRosterSources } from './roster-changes-repo.js';
import { loadConfig } from '../../config/index.js';
import { isScreenshotSpelling, type KnownNames, type TimelineSources, type PlayerHistoryRow } from '../member-timeline.js';

const ALL_TIME = '0000';
const NO_LIMIT = 1_000_000;

/** Everything the timeline needs for one member, or null when the member isn't in this clan. */
export function loadTimelineSources(clanId: number, memberId: number, playerId: number | null): TimelineSources | null {
  const member = getMemberById(memberId, clanId);
  if (!member) return null;
  const db = getDb();

  // Joined / came back / left / restored: the clan's Joins & leaves list,
  // this member's part of it (roster-changes.ts) — so the two never disagree.
  const moves = buildRosterChanges(loadRosterSources(clanId), loadConfig().gameDayRolloverUtcHour)
    .filter((m) => m.memberId === memberId);

  // The site's actions about this member: a manual rename (the sync's own
  // carry source "game" and show as the player renaming in the game) and a
  // merge of another name INTO this member (by the member's name or an alias).
  const names = [member.name, ...member.aliases];
  const auditRows = db.prepare(
    `SELECT created_at AS at, action, details FROM audit_log
      WHERE action IN ('rename_member', 'merge_player')
        AND (clan_id = ? OR clan_id IS NULL)
      ORDER BY created_at`,
  ).all(clanId) as Array<{ at: string; action: string; details: string | null }>;
  const audit: TimelineSources['audit'] = [];
  for (const r of auditRows) {
    let d: Record<string, unknown> = {};
    try { d = r.details ? JSON.parse(r.details) as Record<string, unknown> : {}; } catch { continue; }
    const forMember =
      (r.action === 'rename_member' && Number(d.id) === memberId) ||
      (r.action === 'merge_player' && typeof d.to === 'string' && names.includes(d.to) && (d.clanId === undefined || Number(d.clanId) === clanId));
    if (forMember) audit.push({ at: r.at, action: r.action, details: d });
  }
  // Which merged-in names are screenshot-era spellings (isScreenshotSpelling).
  const mergedFrom = [...new Set(audit.flatMap((a) => (a.action === 'merge_player' && typeof a.details.from === 'string' ? [a.details.from] : [])))];
  if (mergedFrom.length) {
    const known = knownNames(mergedFrom);
    for (const a of audit) {
      if (a.action === 'merge_player' && typeof a.details.from === 'string') a.screenshotSpelling = isScreenshotSpelling(a.details.from, known);
    }
  }

  const mightDays = db.prepare(
    `SELECT game_date AS day, captured_at AS at, power AS might FROM member_snapshots
      WHERE member_id = ? AND clan_id = ? AND game_date != '' AND power > 0 ORDER BY game_date`,
  ).all(memberId, clanId) as TimelineSources['mightDays'];

  if (playerId === null) {
    return {
      moves, playerHistory: [], audit, titles: [], techChanges: [], tierChanges: [], captainChanges: [],
      artifactChanges: [], equipmentChanges: [], cityStatus: [], mightDays, dragonDays: [],
    };
  }

  // Every grant of every title (a title received again is a row of its own).
  const titles = db.prepare(
    `SELECT title_id AS titleId, assigned_at AS assignedAt, first_seen AS firstSeen, gone_at AS goneAt
       FROM game_player_titles WHERE clan_id = ? AND player_id = ? ORDER BY assigned_at, title_id`,
  ).all(clanId, playerId) as TimelineSources['titles'];

  const playerHistory = db.prepare(
    `SELECT captured_at AS at, name, hero_level AS heroLevel, city_level AS cityLevel, vip, gold_pass AS goldPass,
            hero_avatar AS heroAvatar, role
       FROM game_player_history WHERE clan_id = ? AND player_id = ? ORDER BY captured_at`,
  ).all(clanId, playerId) as PlayerHistoryRow[];

  // Research and talent changes with the level each moved from; the player's
  // first read is the baseline and left out.
  const techChanges = db.prepare(
    `WITH h AS (
       SELECT tech_id, level, changed_at, LAG(level) OVER (PARTITION BY tech_id ORDER BY changed_at) AS prev_level
         FROM game_player_tech_history WHERE clan_id = ? AND player_id = ?
     )
     SELECT tech_id AS techId, level, prev_level AS prevLevel, changed_at AS at FROM h
      WHERE changed_at > (SELECT MIN(changed_at) FROM game_player_tech_history WHERE clan_id = ? AND player_id = ?)
        AND NOT (prev_level IS level)
      ORDER BY changed_at`,
  ).all(clanId, playerId, clanId, playerId) as TimelineSources['techChanges'];

  const tiers = getMemberTiers(clanId).get(memberId);
  const tierChanges: TimelineSources['tierChanges'] = [];
  for (const [family, list] of Object.entries(tiers?.changes ?? {})) {
    for (const c of list) tierChanges.push({ at: c.at, family, from: c.from, to: c.to });
  }

  const cityStatus = db.prepare(
    `SELECT changed_at AS at, shielded, burning FROM game_city_status_history
      WHERE clan_id = ? AND player_id = ? ORDER BY changed_at`,
  ).all(clanId, playerId) as TimelineSources['cityStatus'];

  // The dragon: city field 26 as each game day's city snapshot kept it
  // (column `hero`, named before field 26 was known to be the dragon).
  const dragonDays: TimelineSources['dragonDays'] = [];
  const cityDays = db.prepare(
    `SELECT game_date AS day, captured_at AS at, hero FROM game_city_snapshots
      WHERE clan_id = ? AND player_id = ? ORDER BY game_date`,
  ).all(clanId, playerId) as Array<{ day: string; at: string; hero: string | null }>;
  for (const r of cityDays) {
    let d: { level?: unknown; stage?: unknown } = {};
    try { d = JSON.parse(r.hero || '{}') as typeof d; } catch { /* unreadable: a gap */ }
    const level = typeof d.level === 'number' ? d.level : null;
    const stage = typeof d.stage === 'number' ? d.stage : null;
    dragonDays.push({ day: r.day, at: r.at, level, stage });
  }

  return {
    moves,
    playerHistory,
    audit,
    titles,
    techChanges,
    tierChanges,
    captainChanges: getPlayerCaptainChanges(clanId, playerId, ALL_TIME, NO_LIMIT),
    artifactChanges: getPlayerArtifactChanges(clanId, playerId, ALL_TIME, NO_LIMIT),
    equipmentChanges: getPlayerEquipmentChanges(clanId, playerId, ALL_TIME, NO_LIMIT),
    cityStatus,
    mightDays,
    dragonDays,
  };
}

/**
 * Of `names`, the ones the game reported for any player (any clan, now or in
 * the player history), plus every name a person typed in a manual rename —
 * what isScreenshotSpelling checks a merged-in name against.
 */
export function knownNames(names: string[]): KnownNames {
  const db = getDb();
  const gameNames = new Set<string>();
  // Chunked: a bound list stays far below SQLite's variable limit.
  for (let i = 0; i < names.length; i += 400) {
    const part = names.slice(i, i + 400);
    const ph = part.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT name FROM game_players WHERE name IN (${ph})
       UNION SELECT name FROM game_player_history WHERE name IN (${ph})`,
    ).all(...part, ...part) as Array<{ name: string }>;
    for (const r of rows) gameNames.add(r.name);
  }
  const typedNames = new Set<string>();
  const renames = db.prepare(`SELECT details FROM audit_log WHERE action = 'rename_member'`).all() as Array<{ details: string | null }>;
  for (const r of renames) {
    try {
      const d = r.details ? JSON.parse(r.details) as Record<string, unknown> : {};
      // The sync's own renames carry source "game": those are the game's names.
      if (!d.source && typeof d.newName === 'string') typedNames.add(d.newName);
    } catch { /* unreadable row: not a typed name */ }
  }
  return { gameNames, typedNames };
}
