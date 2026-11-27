"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_REPORT_ATTEMPTS = exports.KEPT_ENTRY_TYPES = exports.TINMAN_STACK_CHOICES = exports.MAX_REPORT_CHATS = void 0;
exports.recordReportShares = recordReportShares;
exports.pendingReportsForClan = pendingReportsForClan;
exports.saveFetchedReport = saveFetchedReport;
exports.markReportFailed = markReportFailed;
exports.reportCounts = reportCounts;
exports.getReportChats = getReportChats;
exports.setReportChats = setReportChats;
exports.getTinmanRequiredStacks = getTinmanRequiredStacks;
exports.setTinmanRequiredStacks = setTinmanRequiredStacks;
exports.listAnnouncements = listAnnouncements;
exports.listTinmanHits = listTinmanHits;
/**
 * Battle reports shared in chat (v143, docs/battle-reports.md).
 *
 * A report link in any chat the scanner reads — the clan chat, a private
 * message to the scanner account, or a group chat the clan picked — is a
 * share. Every attack report shared is queued once (battle_reports, one row
 * per report however many clans saw it), opened on the game's journal service
 * (scheduler/battle-reports.ts) and kept: the parsed summary for the site, the
 * raw bytes for a later, better reading.
 */
const zlib_1 = __importDefault(require("zlib"));
const database_js_1 = require("../database.js");
const chat_text_js_1 = require("../../game-protocol/chat-text.js");
const battle_report_js_1 = require("../../game-protocol/battle-report.js");
const game_player_names_js_1 = require("../game-player-names.js");
const announcement_headline_js_1 = require("../announcement-headline.js");
/** Group chats a clan can read reports from besides its clan chat and private messages. */
exports.MAX_REPORT_CHATS = 5;
/** The Tin Man rule's choices: hit it while it still has this many stacks. */
exports.TINMAN_STACK_CHOICES = [4, 3, 2];
/**
 * Shared journal entries that are kept: battles (Tin Man hits, citadels,
 * epics…) and clan announcements (their text, for My Clan). Scout and crypt
 * reports are left alone.
 */
exports.KEPT_ENTRY_TYPES = ['attack', 'clan_announcement'];
/** Tries before a report that keeps failing is given up on. */
exports.MAX_REPORT_ATTEMPTS = 6;
/**
 * Record the battle reports and announcements linked in these messages (any channel the clan's
 * chat sync keeps). A report already shared in the clan keeps its first share.
 * Returns how many shares were new.
 */
function recordReportShares(clanId, messages) {
    const found = messages.flatMap((m) => (0, chat_text_js_1.chatReportLinks)(m.data).filter((l) => exports.KEPT_ENTRY_TYPES.includes(l.entryType)).map((l) => ({ m, l })));
    if (!found.length)
        return 0;
    const db = (0, database_js_1.getDb)();
    const report = db.prepare(`INSERT INTO battle_reports (entry_id, entry_type, target_static_id, first_shared_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (entry_id) DO UPDATE SET first_shared_at = MIN(first_shared_at, excluded.first_shared_at)`);
    const share = db.prepare(`INSERT INTO battle_report_shares (clan_id, entry_id, channel_url, message_id, sender_player_id, sender_name, shared_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (clan_id, entry_id) DO NOTHING`);
    let added = 0;
    db.transaction(() => {
        for (const { m, l } of found) {
            report.run(l.entryId, l.entryType, l.staticId || null, m.createdAt);
            added += share.run(clanId, l.entryId, m.channelUrl, m.messageId, (0, chat_text_js_1.chatSenderPlayerId)(m.senderInfo), m.senderName ?? '', m.createdAt).changes;
        }
    })();
    return added;
}
/**
 * Reports shared in this clan that wait to be opened, newest share first (an
 * old one may already be gone from the game; a fresh one is what members look
 * for). Failed ones come back once their retry time has passed.
 */
function pendingReportsForClan(clanId, nowMs, limit) {
    return (0, database_js_1.getDb)().prepare(`SELECT r.entry_id, r.attempts FROM battle_reports r
     WHERE r.status IN ('pending', 'failed') AND (r.next_try_at IS NULL OR r.next_try_at <= ?)
       AND EXISTS (SELECT 1 FROM battle_report_shares s WHERE s.clan_id = ? AND s.entry_id = r.entry_id)
     ORDER BY r.first_shared_at DESC LIMIT ?`).all(nowMs, clanId, limit)
        .map((r) => ({ entryId: r.entry_id, attempts: r.attempts }));
}
const gz = (b) => (b ? zlib_1.default.gzipSync(b) : null);
function summaryOf(report, strikes) {
    const side = (s) => ({
        p: s.playerId, army: s.armyId, units: s.units.map((u) => [u.unit, u.count]), killed: s.killed,
    });
    return {
        v: 1, rounds: report.rounds, attackers: report.attackers.map(side), defenders: report.defenders.map(side),
        ...(strikes && strikes.length ? { strikes } : {}),
    };
}
/**
 * A report opened: what it says, and its bytes kept. `report` null = not a
 * battle: an announcement keeps its text, anything else is kept unread.
 */
function saveFetchedReport(entryId, r) {
    const rep = r.report;
    const summary = rep
        ? JSON.stringify(summaryOf(rep, r.strikes))
        : typeof r.announcement === 'string' ? JSON.stringify({ v: 1, announcement: r.announcement }) : null;
    (0, database_js_1.getDb)().prepare(`UPDATE battle_reports SET status = 'ok', attempts = attempts + 1, next_try_at = NULL, last_error = NULL, fetched_at = ?,
       report_at = ?, kind = ?, won = ?, attacker_player_id = ?, target_static_id = COALESCE(?, target_static_id),
       tinman_level = ?, tinman_stacks = ?, summary = ?, raw = ?, strike_log = ?
     WHERE entry_id = ?`).run(r.now ?? new Date().toISOString(), r.at, rep ? rep.kind : r.type, rep ? (rep.won ? 1 : 0) : null, rep?.attackers[0]?.playerId ?? null, rep?.targetStaticId ?? null, rep ? (0, battle_report_js_1.tinmanLevel)(rep.targetStaticId) : null, rep ? (0, battle_report_js_1.tinmanStacks)(rep) : null, summary, gz(r.raw), gz(r.strikeLog), entryId);
}
/**
 * A try that didn't work. `gone`: the game answered and refused it (expired,
 * or never readable) — after a second refusal it is given up on. Anything else
 * (no connection, a timeout) is tried again later, backing off, up to
 * MAX_REPORT_ATTEMPTS.
 */
function markReportFailed(entryId, error, opts) {
    const db = (0, database_js_1.getDb)();
    const row = db.prepare('SELECT attempts FROM battle_reports WHERE entry_id = ?').get(entryId);
    const attempts = (row?.attempts ?? 0) + 1;
    const giveUp = opts.gone ? attempts >= 2 : attempts >= exports.MAX_REPORT_ATTEMPTS;
    const status = giveUp ? 'unavailable' : 'failed';
    const backoff = Math.min(6 * 3_600_000, 5 * 60_000 * 2 ** (attempts - 1));
    db.prepare('UPDATE battle_reports SET status = ?, attempts = ?, last_error = ?, next_try_at = ? WHERE entry_id = ?')
        .run(status, attempts, error.slice(0, 300), giveUp ? null : opts.nowMs + backoff, entryId);
    return status;
}
/** How the clan's shared reports stand. */
function reportCounts(clanId) {
    const row = (0, database_js_1.getDb)().prepare(`SELECT COUNT(*) AS shared,
       SUM(CASE WHEN r.status = 'ok' THEN 1 ELSE 0 END) AS read,
       SUM(CASE WHEN r.status IN ('pending', 'failed') THEN 1 ELSE 0 END) AS waiting,
       SUM(CASE WHEN r.status = 'unavailable' THEN 1 ELSE 0 END) AS unavailable,
       MAX(r.fetched_at) AS last_read_at
     FROM battle_report_shares s JOIN battle_reports r ON r.entry_id = s.entry_id WHERE s.clan_id = ?`).get(clanId);
    return { shared: row.shared, read: row.read ?? 0, waiting: row.waiting ?? 0, unavailable: row.unavailable ?? 0, lastReadAt: row.last_read_at };
}
function getReportChats(clanId) {
    return (0, database_js_1.getDb)().prepare('SELECT channel_url, name, added_at FROM clan_report_chats WHERE clan_id = ? ORDER BY name COLLATE NOCASE')
        .all(clanId)
        .map((r) => ({ url: r.channel_url, name: r.name, addedAt: r.added_at }));
}
/** Replace the clan's report chats (a chat kept keeps the day it was added). */
function setReportChats(clanId, chats, now = new Date().toISOString()) {
    const db = (0, database_js_1.getDb)();
    db.transaction(() => {
        const keep = new Set(chats.map((c) => c.url));
        for (const old of getReportChats(clanId)) {
            if (!keep.has(old.url))
                db.prepare('DELETE FROM clan_report_chats WHERE clan_id = ? AND channel_url = ?').run(clanId, old.url);
        }
        const ins = db.prepare(`INSERT INTO clan_report_chats (clan_id, channel_url, name, added_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (clan_id, channel_url) DO UPDATE SET name = excluded.name`);
        for (const c of chats.slice(0, exports.MAX_REPORT_CHATS))
            ins.run(clanId, c.url, c.name, now);
    })();
    return getReportChats(clanId);
}
// ── The Tin Man rule ───────────────────────────────────────────────────────
function getTinmanRequiredStacks(clanId) {
    const row = (0, database_js_1.getDb)().prepare('SELECT tinman_required_stacks AS n FROM clans WHERE id = ?').get(clanId);
    const n = row?.n ?? null;
    return n !== null && exports.TINMAN_STACK_CHOICES.includes(n) ? n : null;
}
function setTinmanRequiredStacks(clanId, n) {
    const value = n !== null && exports.TINMAN_STACK_CHOICES.includes(n) ? n : null;
    (0, database_js_1.getDb)().prepare('UPDATE clans SET tinman_required_stacks = ? WHERE id = ?').run(value, clanId);
}
/**
 * Clan announcements shared in the clan's chats and read (docs/battle-reports.md),
 * newest first, each with its one-line headline (announcement-headline.ts).
 * `sinceIso` keeps only those announced since then.
 */
function listAnnouncements(clanId, limit = 50, sinceIso = null) {
    const sinceS = sinceIso ? Math.floor(Date.parse(sinceIso) / 1000) : null;
    const rows = (0, database_js_1.getDb)().prepare(`SELECT r.entry_id, r.report_at, r.summary, m.data
     FROM battle_report_shares s
     JOIN battle_reports r ON r.entry_id = s.entry_id
     LEFT JOIN chat_messages m ON m.clan_id = s.clan_id AND m.channel_url = s.channel_url AND m.message_id = s.message_id
     WHERE s.clan_id = ? AND r.status = 'ok' AND r.kind = 'clan_announcement' AND r.report_at IS NOT NULL
       AND (? IS NULL OR r.report_at >= ?)
     ORDER BY r.report_at DESC LIMIT ?`).all(clanId, sinceS, sinceS, limit);
    const out = [];
    for (const r of rows) {
        let text = '';
        try {
            text = String(JSON.parse(r.summary ?? '{}').announcement ?? '');
        }
        catch { /* unreadable: skipped */ }
        if (!text.trim())
            continue;
        const author = (0, chat_text_js_1.chatReportLinks)(r.data ?? '').find((l) => l.entryId === r.entry_id)?.name ?? '';
        out.push({ entryId: r.entry_id, at: new Date(r.report_at * 1000).toISOString(), author, headline: (0, announcement_headline_js_1.announcementHeadline)(text), text });
    }
    return out;
}
/** Hits on a Tin Man the clan's chats shared, fought in [fromIso, toIso), newest first. */
function listTinmanHits(clanId, fromIso, toIso) {
    const fromS = fromIso ? Math.floor(Date.parse(fromIso) / 1000) : null;
    const toS = toIso ? Math.floor(Date.parse(toIso) / 1000) : null;
    const rows = (0, database_js_1.getDb)().prepare(`SELECT r.entry_id, r.report_at, r.attacker_player_id, r.tinman_level, r.tinman_stacks, r.summary,
            s.sender_name, s.sender_player_id, s.channel_url, c.custom_type, c.name AS chat_name
     FROM battle_report_shares s
     JOIN battle_reports r ON r.entry_id = s.entry_id
     LEFT JOIN chat_channels c ON c.clan_id = s.clan_id AND c.channel_url = s.channel_url
     WHERE s.clan_id = ? AND r.status = 'ok' AND r.tinman_stacks IS NOT NULL AND r.report_at IS NOT NULL
       AND (? IS NULL OR r.report_at >= ?) AND (? IS NULL OR r.report_at < ?)
     ORDER BY r.report_at DESC`).all(clanId, fromS, fromS, toS, toS);
    const ids = [...new Set(rows.map((r) => r.attacker_player_id).filter((p) => p !== null))];
    const names = (0, game_player_names_js_1.gamePlayerNames)(clanId, ids);
    return rows.map((r) => {
        let killed = 0;
        try {
            const s = r.summary ? JSON.parse(r.summary) : null;
            for (const n of Object.values(s?.defenders[0]?.killed ?? {}))
                killed += Number(n) || 0;
        }
        catch { /* an unreadable summary counts nothing */ }
        const who = r.attacker_player_id !== null ? names.get(r.attacker_player_id) : undefined;
        // Outside the clan's roster: the sharer's name when they shared their own hit.
        const name = who?.name || (r.sender_player_id !== null && r.sender_player_id === r.attacker_player_id ? r.sender_name : '');
        const sharedIn = r.custom_type === 'clanGroup' || r.channel_url.startsWith('triumph_clan_channel_')
            ? 'clan' : r.custom_type === 'whisper' ? 'private' : 'group';
        return {
            entryId: r.entry_id,
            at: new Date(r.report_at * 1000).toISOString(),
            playerId: r.attacker_player_id,
            memberId: who?.memberId ?? null,
            name,
            level: r.tinman_level,
            stacks: r.tinman_stacks,
            killed,
            sharedIn,
            chatName: sharedIn === 'group' ? (r.chat_name ?? '') : '',
            sharedBy: r.sender_name,
        };
    });
}
//# sourceMappingURL=battle-report-repo.js.map