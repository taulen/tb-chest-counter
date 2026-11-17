"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchCounts = fetchCounts;
exports.parseCountsPayload = parseCountsPayload;
exports.computeCurrentWeekWindow = computeCurrentWeekWindow;
exports.computeWeekWindowContaining = computeWeekWindowContaining;
const logger_js_1 = require("../utils/logger.js");
const log = (0, logger_js_1.childLogger)('chesttracker-client');
const BASE_URL = 'https://api.chesttracker.com';
const USER_AGENT = 'tb-chest-counter/1.0 (+self-hosted personal use)';
/**
 * Fetch a public counts snapshot from chesttracker.com's API. The same
 * endpoint their SPA calls — see /counts/{code} network trace.
 *
 * Returns { status, etag, body }. body is null on 304.
 * Throws on non-200/304 HTTP status or network error.
 */
async function fetchCounts(opts) {
    const url = new URL(`${BASE_URL}/chests/public/${encodeURIComponent(opts.shareCode)}`);
    url.searchParams.set('start', opts.start);
    url.searchParams.set('end', opts.end);
    url.searchParams.set('duration', String(opts.durationDays));
    const headers = {
        accept: 'application/json',
        'user-agent': USER_AGENT,
        // Node's undici fetch auto-adds `Cache-Control: no-cache`, which makes
        // Express's req.fresh() return false and bypass the ETag check — the
        // server then 200s with a full body even when our If-None-Match matches.
        // Override with a value that doesn't contain "no-cache" so conditional
        // requests can short-circuit to 304.
        'cache-control': 'max-age=0',
    };
    if (opts.etag)
        headers['if-none-match'] = opts.etag;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
    let res;
    try {
        res = await fetch(url.toString(), { headers, signal: controller.signal });
    }
    finally {
        clearTimeout(timeout);
    }
    const etag = res.headers.get('etag');
    if (res.status === 304) {
        log.debug(`Fetch returned 304 (${opts.shareCode} ${opts.start} → ${opts.end})`);
        return { status: 304, etag, body: null, clan: null };
    }
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        const snippet = text.slice(0, 300);
        throw new Error(`Chesttracker fetch failed: HTTP ${res.status} ${res.statusText} — ${snippet}`);
    }
    const { counts, clan } = parseCountsPayload(await res.json());
    return { status: 200, etag, body: counts, clan };
}
function isCountsTuple(v) {
    return Array.isArray(v) && v.length >= 3 && Array.isArray(v[0]) && Array.isArray(v[1]);
}
/**
 * Read a counts response in either shape: the current `{ clan, window,
 * counts }` envelope or the legacy bare tuple. Throws when it is neither —
 * naming the keys that did arrive, so the next upstream change says what
 * it changed to instead of just "unexpected". Pure; unit-tested.
 */
function parseCountsPayload(json) {
    if (isCountsTuple(json))
        return { counts: json, clan: null };
    if (json && typeof json === 'object' && !Array.isArray(json)) {
        const env = json;
        if (isCountsTuple(env.counts)) {
            const clan = env.clan && typeof env.clan === 'object' && !Array.isArray(env.clan)
                ? env.clan
                : null;
            return { counts: env.counts, clan };
        }
        const keys = Object.keys(json).slice(0, 10).join(', ') || 'none';
        throw new Error(`Chesttracker returned an unrecognised payload: an object without a counts tuple (keys: ${keys})`);
    }
    const kind = Array.isArray(json) ? `an array of ${json.length}` : json === null ? 'null' : typeof json;
    throw new Error(`Chesttracker returned an unrecognised payload: ${kind}, expected { counts: [players[], definitions[], schema] }`);
}
/**
 * Compute the TB game-week window that CONTAINS `nowMs`. Total Battle's
 * weekly reset is Sunday at `rolloverUtcHour` UTC (17:00 by default — the
 * `end of peace time` on the game's clock), so every game week runs
 * Sunday HH:00 UTC → next Sunday HH:00 UTC.
 *
 * Every poll during the same week returns the same window → ETag 304s
 * when nothing has changed and fresh 200s when chests land. At the
 * weekly rollover, `start` and `end` both shift forward 7 days.
 */
function computeCurrentWeekWindow(rolloverUtcHour = 17, nowMs = Date.now()) {
    return computeWeekWindowContaining(nowMs, rolloverUtcHour);
}
/**
 * Given any timestamp, return the TB game-week window that contains it.
 * Used for backfill (step back in 7-day increments) and for the manual
 * "fetch the week containing date X" admin action.
 */
function computeWeekWindowContaining(anchorMs, rolloverUtcHour = 17) {
    // JS getUTCDay(): 0 = Sunday … 6 = Saturday.
    // We want `start` to be the most recent Sunday `rolloverUtcHour`:00 UTC
    // at or BEFORE the anchor. If anchor is e.g. Monday 10:00, that's
    // Sunday 17:00 of the previous calendar day.
    const anchor = new Date(anchorMs);
    const day = anchor.getUTCDay();
    const hour = anchor.getUTCHours();
    // Days to subtract to land on the most recent Sunday. If we're already
    // on a Sunday but *before* the rollover hour, we belong to the
    // PREVIOUS week — so step back 7 days, not 0.
    let daysBack;
    if (day === 0) {
        daysBack = hour < rolloverUtcHour ? 7 : 0;
    }
    else {
        daysBack = day; // 1..6 → step back to the prior Sunday
    }
    const start = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate() - daysBack, rolloverUtcHour, 0, 0, 0));
    const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
    return {
        start: start.toISOString(),
        end: end.toISOString(),
        durationDays: 7,
    };
}
//# sourceMappingURL=chesttracker-client.js.map