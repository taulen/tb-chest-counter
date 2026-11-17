"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.previewLevelReports = previewLevelReports;
exports.cleanLevels = cleanLevels;
exports.importLevelReports = importLevelReports;
exports.getLatestLevelsForMember = getLatestLevelsForMember;
exports.getLatestLevels = getLatestLevels;
/**
 * Player levels reported in the in-game chat — G (guardsmen), M, S, E, C and
 * D, as people post them — imported by an admin from Admin → Levels from chat.
 *
 * One write per imported player: a member_level_reports row, the full record
 * of what was said, every letter, dated. It no longer sets anyone's guards
 * level — that is the Guardsmen tier from their research, as the game reports
 * it (guards-repo). Dragon (D) is the one letter only chat knows.
 *
 * Reading: each member's LATEST value per letter (a newer post that leaves a
 * letter out doesn't blank it), with the date it was reported.
 */
const database_js_1 = require("../database.js");
const member_repo_js_1 = require("./member-repo.js");
const name_resolver_js_1 = require("../name-resolver.js");
const member_levels_parse_js_1 = require("../member-levels-parse.js");
/** Match parsed chat lines to members, without saving anything. */
function previewLevelReports(clanId, players) {
    const resolved = (0, name_resolver_js_1.resolveNamesToMembers)(clanId, players.map((p) => p.name));
    return players.map((p, i) => ({
        rawName: p.name,
        raw: p.raw,
        levels: p.levels,
        memberId: resolved[i].member?.id ?? null,
        memberName: resolved[i].member?.name ?? null,
        matchKind: resolved[i].kind,
    }));
}
/** Keep only in-range whole-number levels. */
function cleanLevels(raw) {
    const src = (raw && typeof raw === 'object' ? raw : {});
    const out = {};
    for (const k of member_levels_parse_js_1.LEVEL_KEYS) {
        const v = src[k];
        if (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= member_levels_parse_js_1.LEVEL_MAX[k])
            out[k] = v;
    }
    return out;
}
function importLevelReports(input) {
    const db = (0, database_js_1.getDb)();
    const result = { saved: 0, rejected: 0 };
    const now = new Date().toISOString();
    const insert = db.prepare(`
    INSERT INTO member_level_reports
      (clan_id, member_id, observed_date, g_level, m_level, s_level, e_level, c_level, d_level, raw_text, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
    db.transaction(() => {
        const seen = new Set();
        for (const e of input.entries) {
            const levels = cleanLevels(e.levels);
            const member = Number.isInteger(e.memberId) ? (0, member_repo_js_1.getMemberById)(e.memberId, input.clanId) : null;
            if (!member || seen.has(member.id) || Object.keys(levels).length === 0) {
                result.rejected++;
                continue;
            }
            seen.add(member.id);
            insert.run(input.clanId, member.id, input.date, levels.g ?? null, levels.m ?? null, levels.s ?? null, levels.e ?? null, levels.c ?? null, levels.d ?? null, String(e.raw ?? '').slice(0, 500), input.createdBy, now);
            result.saved++;
        }
    })();
    return result;
}
/** One member's latest reported levels, or null when they never posted any. */
function getLatestLevelsForMember(clanId, memberId) {
    return getLatestLevels(clanId).find((r) => r.memberId === memberId) ?? null;
}
/** Each member's latest reported value per letter. Members never reported are absent. */
function getLatestLevels(clanId) {
    const rows = (0, database_js_1.getDb)().prepare(`
    SELECT id, member_id AS memberId, observed_date AS date, created_at AS createdAt,
           g_level AS g, m_level AS m, s_level AS s, e_level AS e, c_level AS c, d_level AS d
    FROM member_level_reports WHERE clan_id = ?
    ORDER BY observed_date ASC, id ASC
  `).all(clanId);
    const members = new Map((0, member_repo_js_1.getAllMembers)(false, clanId).map((m) => [m.id, m]));
    const out = new Map();
    for (const r of rows) {
        const m = members.get(r.memberId);
        if (!m)
            continue;
        let entry = out.get(r.memberId);
        if (!entry) {
            entry = {
                memberId: m.id, name: m.name, isActive: m.isActive, levels: {}, asOf: {},
                lastReported: r.date, lastReportedAt: r.createdAt, lastReportId: r.id,
            };
            out.set(r.memberId, entry);
        }
        for (const k of member_levels_parse_js_1.LEVEL_KEYS) {
            if (r[k] !== null && r[k] !== undefined) {
                entry.levels[k] = r[k];
                entry.asOf[k] = r.date;
            }
        }
        entry.lastReported = r.date;
        entry.lastReportedAt = r.createdAt;
        entry.lastReportId = r.id;
    }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}
//# sourceMappingURL=member-levels-repo.js.map