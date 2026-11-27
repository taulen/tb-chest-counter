"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.REPORTS_PER_RUN = void 0;
exports.fetchSharedReports = fetchSharedReports;
/**
 * Opens the battle reports and announcements shared in a clan's chats
 * (battle-report-repo.ts) on the game's journal service (journal.ts) and keeps
 * what they say. Runs with the between-scans chat poll (chat-capture.ts), on
 * the journal token of the clan's last scan login, a batch a minute, newest
 * share first. Read-only in the game; never fails anything around it.
 */
const journal_js_1 = require("../game-protocol/journal.js");
const journal_token_js_1 = require("../game-protocol/journal-token.js");
const battle_report_js_1 = require("../game-protocol/battle-report.js");
const battle_report_repo_js_1 = require("../data/repositories/battle-report-repo.js");
const logger_js_1 = require("../utils/logger.js");
const log_throttle_js_1 = require("../utils/log-throttle.js");
const log = (0, logger_js_1.childLogger)('battle-reports');
const warner = (0, log_throttle_js_1.createCoalescedWarner)((m) => log.warn({ noAlert: true }, m), 60 * 60_000);
/** Reports opened per clan per poll: a backlog (the v143 queue held ~2,500) drains in hours without a burst. */
exports.REPORTS_PER_RUN = 20;
const running = new Set();
/** Open what waits for this clan. Never throws. */
async function fetchSharedReports(clanId, token, opts = {}) {
    const now = opts.now ?? Date.now();
    if (!token)
        return { note: '', tokenBad: false };
    const exp = (0, journal_token_js_1.journalTokenExpiry)(token);
    if (exp !== null && exp * 1000 < now + 60_000)
        return { note: '', tokenBad: true };
    if (running.has(clanId))
        return { note: '', tokenBad: false };
    const pending = (0, battle_report_repo_js_1.pendingReportsForClan)(clanId, now, opts.limit ?? exports.REPORTS_PER_RUN);
    if (!pending.length)
        return { note: '', tokenBad: false };
    running.add(clanId);
    let session = null;
    try {
        try {
            session = await (opts.open ?? journal_js_1.JournalSession.open)(token);
        }
        catch (err) {
            const msg = String(err);
            const refused = /HTTP 40[13]/.test(msg);
            warner.warn(`open:${clanId}`, `Clan #${clanId}: could not reach the battle-report service: ${msg}`);
            return { note: '', tokenBad: refused };
        }
        let read = 0;
        let gone = 0;
        for (const p of pending) {
            try {
                const r = await (0, journal_js_1.fetchSharedEntry)(session, p.entryId);
                if (!r.ok) {
                    // The game answered and said no (expired, or not readable): asked once more later, then left.
                    if ((0, battle_report_repo_js_1.markReportFailed)(p.entryId, `status ${r.status}${r.error ? `: ${r.error}` : ''}`, { gone: r.status !== -1, nowMs: now }) === 'unavailable')
                        gone++;
                    continue;
                }
                const report = r.type === 'battle' ? (0, battle_report_js_1.parseBattleReport)(r.report) : null;
                let strikeLog = null;
                let strikes = null;
                if (report?.strikeLogId) {
                    strikeLog = await (0, journal_js_1.fetchJournalItem)(session, p.entryId, report.strikeLogId).catch(() => null);
                    strikes = strikeLog ? (0, battle_report_js_1.parseStrikeLog)(strikeLog) : null;
                }
                const announcement = r.type === 'clan_announcement' ? (0, battle_report_js_1.parseAnnouncement)(r.report)?.text ?? null : null;
                (0, battle_report_repo_js_1.saveFetchedReport)(p.entryId, { at: r.at, type: r.type, report, raw: r.report, strikeLog, strikes, announcement });
                read++;
            }
            catch (err) {
                // The connection went: the rest wait for the next poll.
                (0, battle_report_repo_js_1.markReportFailed)(p.entryId, String(err), { gone: false, nowMs: now });
                warner.warn(`fetch:${clanId}`, `Clan #${clanId}: reading a shared battle report failed: ${String(err)}`);
                break;
            }
        }
        const parts = [read ? `${read} read` : '', gone ? `${gone} no longer in the game` : ''].filter(Boolean);
        return { note: parts.length ? `battle reports: ${parts.join(', ')}` : '', tokenBad: false };
    }
    finally {
        session?.close();
        running.delete(clanId);
    }
}
//# sourceMappingURL=battle-reports.js.map