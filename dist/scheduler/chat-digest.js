"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.digestWarningKey = exports.COVERAGE_MAX_GAP_H = void 0;
exports.digestDayLabel = digestDayLabel;
exports.formatChatDigest = formatChatDigest;
exports.digestSchedule = digestSchedule;
exports.coverageOf = coverageOf;
exports.completedScanTimes = completedScanTimes;
exports.digestRows = digestRows;
exports.resolveTargetChannel = resolveTargetChannel;
exports.runChatDigest = runChatDigest;
exports.previewChatDigest = previewChatDigest;
const chat_js_1 = require("../game-protocol/chat.js");
const chat_send_js_1 = require("../game-protocol/chat-send.js");
const chest_repo_js_1 = require("../data/repositories/chest-repo.js");
const chat_digest_repo_js_1 = require("../data/repositories/chat-digest-repo.js");
const database_js_1 = require("../data/database.js");
const game_day_js_1 = require("../utils/game-day.js");
const log_buffer_js_1 = require("../utils/log-buffer.js");
const logger_js_1 = require("../utils/logger.js");
const chat_capture_js_1 = require("./chat-capture.js");
const log = (0, logger_js_1.childLogger)('chat-digest');
/** A scan gap longer than this inside the digest's day means the day may be incomplete: no post. */
exports.COVERAGE_MAX_GAP_H = 3;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** "2026-11-15" → "15 November" (the game day, as the hand-written digest dates it). */
function digestDayLabel(gameDate) {
    const [, m, d] = gameDate.split('-').map(Number);
    return `${d} ${MONTHS[(m ?? 1) - 1] ?? ''}`.trim();
}
/** A name on one line: no line breaks or control characters smuggled into the post. */
const cleanName = (s) => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim() || '?';
const fits = (text) => text.length <= chat_send_js_1.MAX_POST_CHARS && Buffer.byteLength(text, 'utf8') <= chat_send_js_1.MAX_POST_BYTES;
/**
 * The post, as CWB writes it by hand:
 *
 *   Daily Digest — 15 November
 *   Our top 20 crypters
 *    1) Princess of Chaos ··· 35 chests (5,815)
 *    2) jass ················ 13 chests (3,560)
 *
 * Names are padded with middle dots to 20 characters (at least two dots), so
 * the counts line up roughly in the game's proportional font. The whole post
 * never exceeds the hand-written one's size (MAX_POST_CHARS / MAX_POST_BYTES):
 * longer names shorten the dot leaders first, then the names themselves
 * ("…"), and only then are entries dropped from the bottom. Never split.
 */
function formatChatDigest(rows, gameDate, entries) {
    const list = rows.slice(0, Math.max(0, entries)).map((r) => ({ ...r, name: cleanName(r.name) }));
    const head = (n) => [`Daily Digest — ${digestDayLabel(gameDate)}`, `Our top ${n} crypters`];
    const render = (n, width, minDots, maxName) => {
        const lines = head(n);
        list.slice(0, n).forEach((r, i) => {
            const chars = [...r.name];
            const name = chars.length > maxName ? `${chars.slice(0, Math.max(1, maxName - 1)).join('')}…` : r.name;
            const dots = '·'.repeat(Math.max(minDots, width - [...name].length));
            const chests = `${r.chests.toLocaleString('en-US')} ${r.chests === 1 ? 'chest' : 'chests'}`;
            lines.push(`${String(i + 1).padStart(2)}) ${name} ${dots} ${chests} (${r.points.toLocaleString('en-US')})`);
        });
        return lines.join('\n');
    };
    if (!list.length)
        return { text: '', shown: 0 };
    for (let n = list.length; n >= 1; n--) {
        // 1. The hand-written layout.
        let text = render(n, 20, 2, Infinity);
        if (fits(text))
            return { text, shown: n };
        // 2. Shorter dot leaders.
        for (let width = 19; width >= 0; width--) {
            text = render(n, width, 1, Infinity);
            if (fits(text))
                return { text, shown: n };
        }
        // 3. Shorter names.
        for (let maxName = 20; maxName >= 8; maxName--) {
            text = render(n, 0, 1, maxName);
            if (fits(text))
                return { text, shown: n };
        }
        // 4. One entry fewer (the loop).
    }
    return { text: '', shown: 0 };
}
/** The digest day a moment belongs to: the game day that closed last. */
function digestSchedule(nowMs, rolloverUtcHour, postUtcMinute) {
    const sentGameDate = (0, game_day_js_1.gameDateFor)(nowMs, rolloverUtcHour);
    const dayEndMs = Date.parse(`${sentGameDate}T00:00:00Z`) + rolloverUtcHour * HOUR;
    const dayStartMs = dayEndMs - DAY;
    const offsetMin = (((postUtcMinute - rolloverUtcHour * 60) % 1440) + 1440) % 1440;
    return {
        gameDate: (0, game_day_js_1.gameDateFor)(dayStartMs, rolloverUtcHour),
        sentGameDate,
        dayStartMs,
        dayEndMs,
        postAtMs: dayEndMs + offsetMin * 60_000,
    };
}
/**
 * Whether the scans covered a day: the last scan before it began, every scan
 * inside it and the first after it closed, with no gap over the limit.
 * `waiting` = the day's closing scan hasn't finished yet.
 */
function coverageOf(completedMs, dayStartMs, dayEndMs, maxGapH = exports.COVERAGE_MAX_GAP_H) {
    const times = [...completedMs].sort((a, b) => a - b);
    const before = times.filter((t) => t < dayStartMs).pop();
    const after = times.find((t) => t >= dayEndMs);
    if (after === undefined)
        return { ok: false, waiting: true, maxGapMs: 0, reason: "the day's closing scan has not run yet", code: 'waiting' };
    if (before === undefined)
        return { ok: false, waiting: false, maxGapMs: 0, reason: 'no scan before the day began', code: 'no-scan-before' };
    const points = [before, ...times.filter((t) => t >= dayStartMs && t < dayEndMs), after];
    let maxGapMs = 0;
    for (let i = 1; i < points.length; i++)
        maxGapMs = Math.max(maxGapMs, points[i] - points[i - 1]);
    if (maxGapMs > maxGapH * HOUR) {
        return { ok: false, waiting: false, maxGapMs, reason: `a ${(maxGapMs / HOUR).toFixed(1)} h gap between scans (more than ${maxGapH} h)`, code: 'gap' };
    }
    return { ok: true, waiting: false, maxGapMs, reason: null, code: 'ok' };
}
/** Completed (non-import) scans of a clan around a day, as epoch ms. */
function completedScanTimes(clanId, fromMs, toMs) {
    return (0, database_js_1.getDb)().prepare(`SELECT completed_at FROM scan_sessions
      WHERE clan_id = ? AND status = 'completed' AND trigger_source <> 'import' AND completed_at IS NOT NULL
        AND completed_at >= ? AND completed_at <= ?`).all(clanId, new Date(fromMs).toISOString(), new Date(toMs).toISOString())
        .map((r) => Date.parse(r.completed_at))
        .filter((t) => Number.isFinite(t));
}
/** The day's ranking: every member's chests and points (the Discord digest's numbers). */
function digestRows(clanId, dayStartMs, dayEndMs) {
    return (0, chest_repo_js_1.getDailyDigestData)(new Date(dayStartMs).toISOString(), new Date(dayEndMs).toISOString(), clanId)
        .topContributors.map((r) => ({ name: r.memberName, chests: r.chests, points: r.points }));
}
/** The group chat a clan's settings point at, among the chats its scanner account is in. */
function resolveTargetChannel(settings, channels) {
    if (settings.channelUrl)
        return channels.find((c) => c.url === settings.channelUrl) ?? null;
    const name = settings.channelName.trim();
    return name ? channels.find((c) => c.name.trim() === name) ?? null : null;
}
/** The warning key a resolved post clears (System → Needs attention). */
const digestWarningKey = (clanId) => `chat-digest:clan:${clanId}`;
exports.digestWarningKey = digestWarningKey;
// One warning per clan per digest day for a condition that repeats every scan.
const warnedDays = new Set();
function warnOncePerDay(clanId, gameDate, message) {
    const k = `${clanId}:${gameDate}:${message}`;
    if (warnedDays.has(k))
        return;
    warnedDays.add(k);
    log.warn({ resolveKey: (0, exports.digestWarningKey)(clanId) }, `Clan #${clanId} chat digest (${gameDate}): ${message}`);
}
/**
 * After a scan: refresh which group chats the scanner account is in, then post
 * the closed day's digest if it is due (or an admin asked for a test post) and
 * every rule allows it. Returns a short note for the scan log ('' = nothing to
 * say). Never throws.
 */
async function runChatDigest(clanId, opts) {
    try {
        return await runChatDigestInner(clanId, opts);
    }
    catch (err) {
        log.warn({ noAlert: true }, `Clan #${clanId} chat digest failed (the scan is unaffected): ${String(err)}`);
        return 'chat digest failed';
    }
}
async function runChatDigestInner(clanId, opts) {
    const now = opts.now ?? Date.now();
    let settings = (0, chat_digest_repo_js_1.getChatDigestSettings)(clanId);
    const test = settings.testRequestedAt !== null;
    if (!settings.enabled && !test)
        return '';
    const done = (note) => {
        if (test)
            (0, chat_digest_repo_js_1.clearTestRequest)(clanId);
        return note;
    };
    if ((0, chat_send_js_1.chatSendingDisabled)())
        return done('chat digest: sending is disabled (CHAT_SEND_DISABLED)');
    // Which group chats the scanner account is in — the only ones it may post into.
    const list = opts.listGroupChats ?? (async () => {
        const session = (0, chat_capture_js_1.chatSessionFor)(clanId);
        return session ? (0, chat_js_1.listChannels)(session, [...chat_send_js_1.POSTABLE_TYPES]) : null;
    });
    try {
        const channels = await list();
        if (channels)
            (0, chat_digest_repo_js_1.setPostableChannels)(clanId, channels, { userId: opts.client.suid, name: opts.client.nickname }, new Date(now).toISOString());
    }
    catch (err) {
        log.warn({ noAlert: true }, `Clan #${clanId} chat digest: could not list the account's group chats: ${String(err)}`);
    }
    const sch = digestSchedule(now, opts.rolloverUtcHour, settings.postUtcMinute);
    if (!test && now < sch.postAtMs)
        return '';
    const blocked = (0, chat_digest_repo_js_1.attemptBlocker)(clanId, sch.gameDate, sch.sentGameDate);
    if (blocked)
        return test ? done(`chat digest test not sent: ${blocked.message}`) : '';
    const coverage = coverageOf(completedScanTimes(clanId, sch.dayStartMs - DAY, now), sch.dayStartMs, sch.dayEndMs);
    if (coverage.waiting)
        return test ? done(`chat digest test not sent: ${coverage.reason}`) : '';
    if (!coverage.ok) {
        warnOncePerDay(clanId, sch.gameDate, `not posted — the day may be incomplete: ${coverage.reason}`);
        return done(`chat digest skipped: ${coverage.reason}`);
    }
    const target = resolveTargetChannel(settings, (0, chat_digest_repo_js_1.getPostableChannels)(clanId));
    if (!target) {
        const who = opts.client.nickname || 'the scanner account';
        warnOncePerDay(clanId, sch.gameDate, `${who} is not a member of the group chat "${settings.channelName || settings.channelUrl}" — add the account to it, or pick another chat`);
        return done('chat digest: the account is not in the chosen chat');
    }
    try {
        (0, chat_send_js_1.assertPostableChannel)(target);
    }
    catch (err) {
        warnOncePerDay(clanId, sch.gameDate, `refused: ${err.message}`);
        return done(`chat digest refused: ${err.message}`);
    }
    if (!settings.channelUrl) {
        // Seeded by name: pin the resolved chat, so a renamed chat can't redirect the post.
        settings = (0, chat_digest_repo_js_1.saveChatDigestSettings)(clanId, { ...settings, channelUrl: target.url, channelName: target.name });
    }
    const rows = opts.rows ? opts.rows(sch.dayStartMs, sch.dayEndMs) : digestRows(clanId, sch.dayStartMs, sch.dayEndMs);
    const { text, shown } = formatChatDigest(rows, sch.gameDate, settings.entries);
    if (!shown)
        return test ? done('chat digest test not sent: nothing collected that day') : '';
    const reserved = (0, chat_digest_repo_js_1.reserveDigestPost)({
        clanId, gameDate: sch.gameDate, sentGameDate: sch.sentGameDate, channelUrl: target.url, channelName: target.name,
        text, trigger: test ? 'test' : 'scheduled',
    }, new Date(now).toISOString());
    if ('blocked' in reserved)
        return done(`chat digest not sent: ${reserved.blocked}`);
    let token;
    try {
        token = await opts.client.chatToken();
    }
    catch (err) {
        // Nothing went out: a verified failure (one retry on a later scan).
        (0, chat_digest_repo_js_1.finishDigestPost)(reserved.id, { status: 'failed', error: `no chat token: ${String(err)}` });
        warnOncePerDay(clanId, sch.gameDate, `not posted: no chat token (${String(err)})`);
        return done('chat digest failed: no chat token');
    }
    const outcome = await (0, chat_send_js_1.postToGroupChat)({ userId: opts.client.suid, token, channel: target, text }, opts.send);
    if (outcome.status === 'sent') {
        (0, chat_digest_repo_js_1.finishDigestPost)(reserved.id, outcome);
        (0, log_buffer_js_1.resolveEntries)((0, exports.digestWarningKey)(clanId));
        log.info(`Clan #${clanId} chat digest for ${sch.gameDate} posted to "${target.name}" (${shown} entries, message ${outcome.messageId})`);
        return done(`chat digest posted to "${target.name}"`);
    }
    if (outcome.status === 'refused') {
        (0, chat_digest_repo_js_1.finishDigestPost)(reserved.id, { status: 'failed', error: outcome.error });
        warnOncePerDay(clanId, sch.gameDate, `not posted: ${outcome.error}`);
        return done(`chat digest refused: ${outcome.error}`);
    }
    (0, chat_digest_repo_js_1.finishDigestPost)(reserved.id, { status: 'unknown', error: outcome.error });
    warnOncePerDay(clanId, sch.gameDate, `may or may not have been posted (${outcome.error}) — it will not be resent`);
    return done(`chat digest outcome unknown: ${outcome.error}`);
}
/** What the next post would say, for the settings page (never sends). */
function previewChatDigest(clanId, rolloverUtcHour, now = Date.now()) {
    const settings = (0, chat_digest_repo_js_1.getChatDigestSettings)(clanId);
    const sch = digestSchedule(now, rolloverUtcHour, settings.postUtcMinute);
    const { text, shown } = formatChatDigest(digestRows(clanId, sch.dayStartMs, sch.dayEndMs), sch.gameDate, settings.entries);
    return {
        gameDate: sch.gameDate,
        postAt: new Date(sch.postAtMs).toISOString(),
        text,
        shown,
        chars: text.length,
        bytes: Buffer.byteLength(text, 'utf8'),
        maxChars: chat_send_js_1.MAX_POST_CHARS,
        maxBytes: chat_send_js_1.MAX_POST_BYTES,
        blocked: (0, chat_digest_repo_js_1.attemptBlocker)(clanId, sch.gameDate, sch.sentGameDate),
        coverage: coverageOf(completedScanTimes(clanId, sch.dayStartMs - DAY, now), sch.dayStartMs, sch.dayEndMs),
    };
}
//# sourceMappingURL=chat-digest.js.map