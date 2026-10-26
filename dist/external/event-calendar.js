"use strict";
/**
 * Event calendar — per-occurrence timeframe windows, sourced from the public
 * tbclanportal iCal feed (feed.ics) or, for events the feed doesn't carry,
 * synthesised from a fixed rolling cycle (see `cycle` in the catalog).
 *
 * The Events page's fixed Weekly/Monthly selector double-counts events that run
 * more than once a week (a 1-day event that recurs every ~6 days shows twice in
 * one weekly bucket). Instead we treat ONE event run as ONE selectable window.
 * The feed is the authoritative schedule: individual dated VEVENTs (no RRULE),
 * every event running 17:00→17:00 UTC — the same game-day rollover the rest of
 * the site uses — so each occurrence drops straight into the existing
 * `[from, to]` aggregation (getEventBreakdown).
 *
 * Multi-day events are emitted as consecutive per-day VEVENTs (Olympus is five
 * "Day x/5" rows; Ancients pairs "Ancients' Treasure" day 1 with the
 * back-to-back "Rise of the Ancients" day 2). Grouping same-event VEVENTs that
 * touch in time (prev.DTEND == next.DTSTART) fuses each run into a single
 * occurrence, which handles multi-part events and the Ancients merge uniformly.
 *
 * That grouping alone trusts the feed to emit every day of a run, and it does
 * not: the 2026-09-03 Dark Omens carried only its "(Day 1/2)" row, so the
 * occurrence covered one game day of a two-day event and every chest earned on
 * day 2 fell outside the window — a short total that reads exactly like a quiet
 * event. So when a SUMMARY declares "(Day i/n)" we expand that VEVENT to the
 * whole run it belongs to before grouping (start back i-1 days, end n days
 * after that), and fusion collapses the overlaps. One surviving row of a run is
 * then enough to describe it, whichever day the feed kept. Days are always
 * 17:00→17:00 UTC, so the arithmetic is exact.
 *
 * The catalog (src/config/event-catalog.ts) declares which SUMMARY name(s) map
 * to each event via `calendarNames`. An event can instead declare a `cycle`
 * (Triumphal: a rolling 30 days that restarts at the reset the instant it
 * ends) — those windows are computed arithmetically from the cycle anchor, with
 * no feed involved, and are unbounded backwards, so the list is floored at the
 * cycle holding the clan's oldest chest for that event. An event with neither
 * (Citadels, which is 24/7 ongoing) has no occurrences and keeps the page's
 * fixed Weekly/Monthly selector.
 *
 * The feed is not the last word on a run's dates. It forgets runs after about
 * a month (so seen runs are archived), and it lags the game when the game moves
 * its rotation (so a superadmin can correct a run) — see `backfilledGroups` and
 * `applyCorrections`.
 *
 * Scan-time caveat: captured_at is the scan/claim time, not the in-game earn
 * time, so an occurrence's upper bound is extended to the first completed scan
 * after its reset (see getFirstCompletedAtOrAfter) to catch chests claimed just
 * after the event ended.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getEventSchedule = getEventSchedule;
exports.getEventOccurrences = getEventOccurrences;
exports.getScheduleCorrectionsView = getScheduleCorrectionsView;
exports.saveScheduleCorrection = saveScheduleCorrection;
const logger_js_1 = require("../utils/logger.js");
const log_buffer_js_1 = require("../utils/log-buffer.js");
const game_day_js_1 = require("../utils/game-day.js");
const index_js_1 = require("../config/index.js");
const event_catalog_js_1 = require("../config/event-catalog.js");
const session_repo_js_1 = require("../data/repositories/session-repo.js");
const event_repo_js_1 = require("../data/repositories/event-repo.js");
const event_schedule_repo_js_1 = require("../data/repositories/event-schedule-repo.js");
const log = (0, logger_js_1.childLogger)('event-calendar');
const FEED_URL = process.env.EVENT_CALENDAR_ICS_URL || 'https://tbclanportal.com/calendar/feed.ics';
const USER_AGENT = 'tb-chest-counter/1.0 (+self-hosted personal use)';
// The schedule changes at most once a day (17:00 UTC reset). A few hours keeps
// the feed fresh without hammering it — the parsed result is reused across
// every clan and every Events page hit in between.
const TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
const DAY_MS = 24 * 60 * 60 * 1000;
// Strip diacritics + the leading emoji/symbols so feed names compare cleanly:
// "🏛️ Trials of Olympus - Chimera (Day 1/5)" → "trials of olympus - chimera …".
function norm(s) {
    return s
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .replace(/^[^\p{L}]+/u, '')
        .trim()
        .toLowerCase();
}
// Catalog keys that declare calendar names, with those names pre-normalised.
const NAME_INDEX = event_catalog_js_1.EVENT_CATALOG.filter((e) => Array.isArray(e.calendarNames) && e.calendarNames.length).map((e) => ({ key: e.key, names: e.calendarNames.map(norm) }));
// Resolve a VEVENT SUMMARY to a catalog key by prefix match (so per-day and
// per-variant suffixes don't matter), or null when it's an event we don't track.
function keyForSummary(summary) {
    const s = norm(summary);
    for (const { key, names } of NAME_INDEX) {
        if (names.some((n) => n.length > 0 && s.startsWith(n)))
            return key;
    }
    return null;
}
// Trailing "(Day i/n)" on a SUMMARY. The feed writes it on every day of a
// multi-day run, so any one row names the run's length and this row's place in it.
const DAY_LABEL_RE = /\(\s*day\s+(\d+)\s*\/\s*(\d+)\s*\)\s*$/i;
// Nothing in the game runs longer than a week; a garbled label can't stretch a
// window past this. Olympus, the longest, is 5 days.
const MAX_DECLARED_RUN_DAYS = 10;
/**
 * Widen one VEVENT to the full run its "(Day i/n)" label declares, so a run the
 * feed emitted with days missing still spans its real length (see the header).
 * Unlabelled rows — and labels that don't make sense — pass through untouched.
 */
function declaredRunSpan(summary, start, end) {
    const m = DAY_LABEL_RE.exec(summary);
    if (!m)
        return { start, end, declared: null };
    const index = Number(m[1]);
    const total = Number(m[2]);
    if (!(index >= 1 && total >= index && total <= MAX_DECLARED_RUN_DAYS)) {
        return { start, end, declared: null };
    }
    const runStart = start - (index - 1) * DAY_MS;
    const runEnd = runStart + total * DAY_MS;
    return {
        start: Math.min(start, runStart),
        end: Math.max(end, runEnd),
        declared: { runStart, total, index },
    };
}
// "YYYYMMDDTHHMMSSZ" → epoch ms (UTC). Returns null on any other shape.
function parseIcsUtc(v) {
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(v.trim());
    if (!m)
        return null;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}
function parseVevents(text) {
    // Unfold RFC-5545 continuation lines (a CRLF/LF followed by space or tab).
    const unfolded = text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
    const lines = unfolded.split(/\r\n|\n|\r/);
    const out = [];
    let horizon = null;
    let edge = null;
    // Every "(Day i/n)" row seen, for the missing-day audit below.
    const declared = [];
    let inEvent = false;
    let summary = '';
    let dtstart = '';
    let dtend = '';
    for (const line of lines) {
        if (line === 'BEGIN:VEVENT') {
            inEvent = true;
            summary = dtstart = dtend = '';
            continue;
        }
        if (line === 'END:VEVENT') {
            if (inEvent) {
                const key = keyForSummary(summary);
                const start = parseIcsUtc(dtstart);
                const end = parseIcsUtc(dtend);
                if (start !== null && (horizon === null || start < horizon))
                    horizon = start;
                if (end !== null && (edge === null || end > edge))
                    edge = end;
                if (key && start !== null && end !== null && end > start) {
                    const span = declaredRunSpan(summary, start, end);
                    if (span.declared)
                        declared.push({ ...span.declared, key });
                    out.push({ key, start: span.start, end: span.end });
                }
            }
            inEvent = false;
            continue;
        }
        if (!inEvent)
            continue;
        const idx = line.indexOf(':');
        if (idx < 0)
            continue;
        // Property name may carry parameters after ';' (e.g. DTSTART;TZID=…) — drop them.
        const name = line.slice(0, idx).split(';')[0].toUpperCase();
        const value = line.slice(idx + 1);
        if (name === 'SUMMARY')
            summary = value;
        else if (name === 'DTSTART')
            dtstart = value;
        else if (name === 'DTEND')
            dtend = value;
    }
    warnOnMissingRunDays(declared);
    return { events: out, horizon, edge };
}
/**
 * The expansion above quietly covers for a feed that dropped days of a run, so
 * say when it did. Silence here would make an incomplete feed indistinguishable
 * from a complete one — the exact ambiguity that hid the 2026-09-03 Dark Omens
 * run reading as a single game day.
 */
function warnOnMissingRunDays(declared) {
    // One run == one (event key, run start) pair, since the label pins both.
    const runs = new Map();
    for (const d of declared) {
        const id = `${d.key}@${d.runStart}`;
        const run = runs.get(id) ?? { key: d.key, runStart: d.runStart, total: d.total, days: new Set() };
        run.days.add(d.index);
        runs.set(id, run);
    }
    const gaps = [];
    for (const run of runs.values()) {
        if (run.days.size >= run.total)
            continue;
        const missing = [];
        for (let i = 1; i <= run.total; i++)
            if (!run.days.has(i))
                missing.push(i);
        const day = new Date(run.runStart).toISOString().slice(0, 10);
        gaps.push(`${run.key} ${day} missing day ${missing.join('+')} of ${run.total}`);
    }
    if (gaps.length) {
        log.warn({ noAlert: true }, `Event calendar feed omitted run days (windows widened from the "Day i/n" label): ${gaps.join('; ')}`);
    }
}
async function fetchFeed() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let text;
    try {
        const res = await fetch(FEED_URL, {
            headers: { accept: 'text/calendar', 'user-agent': USER_AGENT },
            signal: controller.signal,
        });
        if (!res.ok)
            throw new Error(`HTTP ${res.status} ${res.statusText}`);
        text = await res.text();
    }
    finally {
        clearTimeout(timer);
    }
    return parseVevents(text);
}
// In-process cache of the parsed feed (shared across clans). `inflight`
// coalesces concurrent misses into one fetch; a fetch failure serves the last
// good result when we have one, so a transient feed outage is invisible.
let cache = null;
let inflight = null;
async function getFeed() {
    const now = Date.now();
    if (cache && cache.expires > now)
        return cache.feed;
    if (inflight)
        return inflight;
    inflight = fetchFeed()
        .then((feed) => {
        cache = { feed, expires: Date.now() + TTL_MS };
        log.info(`Loaded ${feed.events.length} tracked calendar VEVENTs from ${FEED_URL}`);
        archiveFeed(feed);
        checkTinmanCadence(feed);
        return feed;
    })
        .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`Event calendar fetch failed: ${msg}`);
        if (cache)
            return cache.feed; // serve stale rather than break the page
        throw err;
    })
        .finally(() => {
        inflight = null;
    });
    return inflight;
}
/**
 * Fuse spans that touch or overlap into single runs, ascending. Shared by the
 * feed's per-day VEVENTs, the archive merge and the corrections pass.
 */
function fuse(spans) {
    const sorted = [...spans].sort((a, b) => a.start - b.start);
    const groups = [];
    for (const s of sorted) {
        const last = groups[groups.length - 1];
        if (last && s.start <= last.end) {
            if (s.end > last.end)
                last.end = s.end;
        }
        else {
            groups.push({ start: s.start, end: s.end });
        }
    }
    return groups;
}
/**
 * Record every started run in this fetch (see `syncArchivedRuns`). Once per
 * fetch, so at most every TTL. A failure costs nothing the feed doesn't still
 * hold, so it is logged and swallowed rather than allowed to break the page.
 */
function archiveFeed(feed) {
    if (feed.horizon == null || !feed.events.length)
        return;
    try {
        const runs = [];
        for (const key of new Set(feed.events.map((e) => e.key))) {
            for (const g of fuse(feed.events.filter((e) => e.key === key))) {
                runs.push({ eventKey: key, start: g.start, end: g.end });
            }
        }
        (0, event_schedule_repo_js_1.syncArchivedRuns)(feed.horizon, Date.now(), runs);
    }
    catch (err) {
        log.warn(`Event calendar archive failed: ${err instanceof Error ? err.message : String(err)}`);
    }
}
const TINMAN_CADENCE_KEY = 'event-calendar:tinman-cadence';
/**
 * Tinman-to-Tinman weeks are computed from a fixed anchor and a 6-day cadence
 * (ANCIENTS_TINMAN_ANCHOR in utils/game-day.ts), not from this feed — they
 * have to be pure arithmetic on both server and client. So if the game ever
 * moves Ancients, those clans' weeks would silently straddle the event. Every
 * fetch checks the last day of each Ancients run in the feed (Rise of the
 * Ancients, the Tinman day) against the cadence and warns on a mismatch; the
 * fix is moving the anchor constant in both places. Clears itself once the
 * feed agrees again (e.g. after a corrected feed or a moved anchor).
 *
 * A run that reaches the feed's forward edge is skipped: the window often stops
 * between its two days, so it "ends" on the Treasure day, a day before Tinman.
 * That false alarm fired on 2026-10-26 for the 2027-01-26 run.
 */
function checkTinmanCadence(feed) {
    const edge = feed.edge ?? Infinity;
    const runs = fuse(feed.events.filter((e) => e.key === 'ancients')).filter((r) => r.end < edge);
    if (!runs.length)
        return;
    const off = runs
        .map((r) => (0, game_day_js_1.gameDateFor)(r.end - DAY_MS, (0, index_js_1.loadConfig)().gameDayRolloverUtcHour))
        .filter((day) => !(0, game_day_js_1.isTinmanDay)(day));
    if (off.length) {
        log.warn({ resolveKey: TINMAN_CADENCE_KEY }, `Ancients has moved off the Tinman-to-Tinman week cadence: ${off.length} of ${runs.length} `
            + `runs in the calendar end on a day that isn't a Tinman day (first: ${off[0]}). Clans using `
            + 'Tinman weeks are now cut at the wrong day — update ANCIENTS_TINMAN_ANCHOR in '
            + 'utils/game-day.ts and lib/period.js.');
    }
    else {
        (0, log_buffer_js_1.resolveEntries)(TINMAN_CADENCE_KEY);
    }
}
/**
 * An event's runs as the feed has given them: what it carries now, plus the
 * archived runs from before its rolling window began. Corrections NOT applied.
 */
async function feedRunsFor(eventKey) {
    const feed = await getFeed();
    const current = feed.events.filter((e) => e.key === eventKey);
    const horizon = feed.horizon ?? Infinity;
    const archived = (0, event_schedule_repo_js_1.listArchivedRuns)(eventKey).filter((r) => r.start < horizon);
    return fuse([...archived, ...current]);
}
/**
 * Move each feed run an admin corrected (see `event_schedule_corrections`).
 * A correction matches a run by its exact feed start, so once the portal fixes
 * its own feed there is no run left at that start and the correction just stops
 * applying — it never fights a feed that has caught up.
 */
function applyCorrections(eventKey, runs) {
    const moves = new Map();
    for (const c of (0, event_schedule_repo_js_1.listCorrections)()) {
        if (c.eventKey === eventKey)
            moves.set(Date.parse(c.feedStartAt), Date.parse(c.actualStartAt));
    }
    if (!moves.size)
        return runs;
    return fuse(runs.map((r) => {
        const to = moves.get(r.start);
        return to === undefined ? r : { start: to, end: to + (r.end - r.start) };
    }));
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Label an occurrence by its game-days. `endMs` is the exclusive closing reset,
// so the last game-day is the day before it: a Jul-2→Jul-7 run reads "Jul 2–6".
function labelFor(startMs, endMs) {
    const a = new Date(startMs);
    const b = new Date(endMs - DAY_MS);
    const am = a.getUTCMonth();
    const ad = a.getUTCDate();
    const bm = b.getUTCMonth();
    const bd = b.getUTCDate();
    if (am === bm && ad === bd)
        return `${MONTHS[am]} ${ad}`;
    if (am === bm)
        return `${MONTHS[am]} ${ad}–${bd}`;
    return `${MONTHS[am]} ${ad} – ${MONTHS[bm]} ${bd}`;
}
// An event's occurrence spans, ascending: feed + archive, with admin
// corrections applied. Shared by the occurrence list and the schedule.
async function groupsFor(eventKey) {
    return applyCorrections(eventKey, await feedRunsFor(eventKey));
}
// A rolling cycle is infinite backwards, so the list is floored at the clan's
// oldest chest for the event. This caps it regardless — a bad anchor, or a very
// long-lived clan, can't turn the "older" arrow into an endless walk.
const MAX_CYCLE_WINDOWS = 60;
/**
 * The feed is a ROLLING window, not an archive: measured 2026-09-18 it carried
 * 2026-08-18 → 2026-12-18, i.e. about a month back. A 6-day event therefore
 * still has five past runs in it, but a 24-day one (Ragnarök, Dark Omens,
 * Olympus, Armageddon, Hell Forge) has ONE or TWO — which is exactly what made
 * the Events page's "older" arrow stop dead after a step or two while "All
 * time" kept showing the clan's full history.
 *
 * Two things now stand in front of that reconstruction:
 *
 *  - the ARCHIVE (event_calendar_runs, v76) keeps every run the feed has shown,
 *    so from v76 onwards an aged-out run keeps the dates it really had, and
 *  - admin CORRECTIONS (event_schedule_corrections) move a run the feed has
 *    wrong — the feed lags the game when the game moves its rotation, as it did
 *    in Oct 2026.
 *
 * Only runs older than both are reconstructed. Every tracked event was strictly
 * periodic through Sep 2026 — 6, 12 or 24 days, zero exceptions across 374
 * VEVENTs spanning four months — so those are stepped back by that period from
 * the earliest run on the cadence. Two guards keep that from inventing history:
 *
 *  - the period must be PROVEN by the runs (the most common gap, seen at least
 *    twice and outnumbering every other); an event with an irregular or unknown
 *    cadence is left exactly as it was, and
 *  - the walk stops at the clan's oldest chest for the event, so an event the
 *    game introduced last month can't grow runs from before it existed.
 *
 * Reconstructed windows are flagged `estimated` and the page marks them, since
 * their dates are a projection of the schedule rather than a record of it.
 */
const MAX_BACKFILL_WINDOWS = 60;
/**
 * The event's run-to-run period, in ms — but only when the runs prove it: the
 * most common gap, seen at least twice and strictly more often than any other.
 * Anything less regular returns null and gets no backfill.
 *
 * Not "every gap identical": the game does move single runs (Dark Omens'
 * Oct 2026 run came 6 days early, turning its gaps into 18, 30, 24, 24), and
 * the all-identical rule answered one moved run by dropping every
 * reconstructed run of the event's history from the page.
 */
function inferPeriodMs(groups) {
    const counts = new Map();
    for (let i = 0; i < groups.length - 1; i++) {
        const gap = groups[i + 1].start - groups[i].start;
        if (gap > 0)
            counts.set(gap, (counts.get(gap) ?? 0) + 1);
    }
    const ranked = [...counts].sort((a, b) => b[1] - a[1]);
    if (!ranked.length || ranked[0][1] < 2)
        return null;
    if (ranked.length > 1 && ranked[1][1] === ranked[0][1])
        return null;
    return ranked[0][0];
}
/** Known runs, preceded by the reconstructed ones nothing records any more. */
function backfilledGroups(groups, eventKey, clanId) {
    const feed = groups.map((g) => ({ start: g.start, end: g.end, estimated: false }));
    if (clanId == null || !groups.length)
        return feed;
    const period = inferPeriodMs(groups);
    if (period == null)
        return feed;
    const floorMs = dataFloorMs(eventKey, clanId);
    const earliest = groups[0].start;
    if (floorMs >= earliest)
        return feed;
    // Step back from the first run that sits ON the cadence (followed by a gap of
    // exactly one period), not blindly from the earliest: when the earliest run
    // is a moved one, stepping from it would shift every reconstructed run by the
    // same few days. Projections that land on or after the earliest known run
    // are skipped — the runs there are records, not guesses.
    let anchor = earliest;
    for (let i = 0; i < groups.length - 1; i++) {
        if (groups[i + 1].start - groups[i].start === period) {
            anchor = groups[i].start;
            break;
        }
    }
    // A run the feed emitted with days missing is SHORT (the 2026-09-03 Dark
    // Omens arrived as its "(Day 1/2)" row alone), so size reconstructed windows
    // by the longest run seen rather than by the first one — and never longer
    // than the period, which would run one window into the next.
    const lenMs = Math.min(Math.max(...groups.map((g) => g.end - g.start)), period);
    const older = [];
    for (let start = anchor - period; start + period > floorMs && older.length < MAX_BACKFILL_WINDOWS; start -= period) {
        if (start + lenMs > earliest)
            continue;
        older.push({ start, end: start + lenMs, estimated: true });
    }
    older.reverse();
    return [...older, ...feed];
}
/**
 * Occurrence spans for a rolling-cycle event (see `cycle` in the catalog),
 * ascending: the cycle containing now, plus every earlier cycle back to the one
 * holding `floorMs`. Boundaries are exact multiples of the cycle length from the
 * anchor, so they all land on the same 17:00 reset the anchor was taken at.
 */
function cycleGroups(cycle, floorMs) {
    const anchorMs = Date.parse(cycle.anchor);
    const lenMs = cycle.days * DAY_MS;
    if (!Number.isFinite(anchorMs) || lenMs <= 0)
        return [];
    // Cycle index relative to the anchor — negative for cycles that ran before
    // it, so an anchor read off today's in-game timer still describes the past.
    const indexAt = (ms) => Math.floor((ms - anchorMs) / lenMs);
    const last = indexAt(Date.now());
    const first = Math.max(Math.min(indexAt(floorMs), last), last - (MAX_CYCLE_WINDOWS - 1));
    const groups = [];
    for (let i = first; i <= last; i++) {
        const start = anchorMs + i * lenMs;
        groups.push({ start, end: start + lenMs });
    }
    return groups;
}
// Oldest window worth listing: the one holding this event's first chest for the
// clan. Without a clan (or with no chests yet) nothing older than now is listed
// — a rolling cycle then shows only the current one, and a feed event gets no
// reconstructed runs.
function dataFloorMs(eventKey, clanId) {
    if (clanId == null)
        return Date.now();
    const first = (0, event_repo_js_1.getEventDataStart)(eventKey, clanId);
    const ms = first ? Date.parse(first) : NaN;
    return Number.isFinite(ms) ? ms : Date.now();
}
/**
 * Schedule tag for an event: its next UPCOMING occurrence (earliest run that
 * hasn't started yet) and whether one is running right now. Feed-driven and
 * clan-agnostic — for the "next event" hint on the Events tabs.
 *
 * A rolling-cycle event (Triumphal) has neither: it never starts and never
 * stops, so `live` stays false (a permanent "Live now" badge is noise) and
 * `cycleEndsAt` carries the only useful timing — when the current cycle resets.
 * Events with no schedule at all (Citadels) return all three empty.
 */
async function getEventSchedule(eventKey) {
    const cycle = (0, event_catalog_js_1.getEventDef)(eventKey)?.cycle;
    if (cycle) {
        const current = cycleGroups(cycle, Date.now()).pop();
        return {
            next: null,
            live: false,
            cycleEndsAt: current ? new Date(current.end).toISOString() : null,
        };
    }
    const groups = await groupsFor(eventKey);
    const now = Date.now();
    const live = groups.some((g) => g.start <= now && now < g.end);
    const upcoming = groups
        .filter((g) => g.start > now)
        .sort((a, b) => a.start - b.start)[0];
    const next = upcoming
        ? {
            from: new Date(upcoming.start).toISOString(),
            // A run that hasn't started has no trailing scan to extend to, so the
            // aggregation bound and the closing reset are the same instant.
            to: new Date(upcoming.end).toISOString(),
            resetAt: new Date(upcoming.end).toISOString(),
            label: labelFor(upcoming.start, upcoming.end),
            isCurrent: false,
            estimated: false,
        }
        : null;
    return { next, live, cycleEndsAt: null };
}
/**
 * Occurrence windows for one event, newest first. Only occurrences that have
 * already started are returned (future scheduled runs have no data yet).
 *
 * For a feed-driven event, when `clanId` is given each window's upper bound is
 * extended to the first completed scan after the event's reset (scan-time
 * capture — see the module header) but never past the next occurrence of the
 * same event. For a rolling-cycle event `clanId` instead decides how far back
 * the cycles go (the clan's oldest chest for the event).
 *
 * The feed only reaches about a month back, so a feed-driven event's older runs
 * are reconstructed from its proven cadence and flagged `estimated` — see
 * `backfilledGroups`.
 *
 * Returns [] for events with neither a calendar mapping nor a cycle, and when
 * the feed is empty.
 */
async function getEventOccurrences(eventKey, clanId) {
    const cycle = (0, event_catalog_js_1.getEventDef)(eventKey)?.cycle;
    const base = cycle
        ? cycleGroups(cycle, dataFloorMs(eventKey, clanId)).map((g) => ({ ...g, estimated: false }))
        : backfilledGroups(await groupsFor(eventKey), eventKey, clanId);
    if (!base.length)
        return [];
    const groups = base.map((g) => ({
        start: g.start,
        end: g.end,
        to: g.end,
        estimated: g.estimated,
    }));
    const now = Date.now();
    for (let i = 0; i < groups.length; i++) {
        const g = groups[i];
        let toMs = g.end;
        // No scan-tail extension for a rolling cycle: its windows are back-to-back,
        // so extending past a reset would only steal from the next cycle. Chests
        // earned before the reset but claimed after it are already placed correctly
        // by effective_at (the in-game earn time) where we have it.
        if (clanId != null && !cycle) {
            const ext = (0, session_repo_js_1.getFirstCompletedAtOrAfter)(clanId, new Date(g.end).toISOString());
            if (ext) {
                const extMs = Date.parse(ext);
                if (Number.isFinite(extMs) && extMs > toMs)
                    toMs = extMs;
            }
        }
        // Never let the scan-tail extension bleed into this event's next occurrence.
        const nextStart = i + 1 < groups.length ? groups[i + 1].start : Infinity;
        if (toMs > nextStart)
            toMs = nextStart;
        g.to = toMs;
    }
    return groups
        .filter((g) => g.start <= now)
        .sort((a, b) => b.start - a.start)
        .map((g) => ({
        from: new Date(g.start).toISOString(),
        to: new Date(g.to).toISOString(),
        resetAt: new Date(g.end).toISOString(),
        label: labelFor(g.start, g.end),
        isCurrent: g.start <= now && now < g.end,
        estimated: g.estimated,
    }));
}
// ── Schedule corrections (superadmin) ───────────────────────────────
/** How far back a correctable run may lie — enough to fix a run just missed. */
const CORRECTABLE_PAST_MS = 30 * DAY_MS;
/** A correction moves a run within its own cycle, never into another one. */
const MAX_CORRECTION_SHIFT_MS = 30 * DAY_MS;
/** Feed-scheduled events (the only ones a correction applies to). */
function calendarEvents() {
    return event_catalog_js_1.EVENT_CATALOG.filter((e) => !e.cycle && e.calendarNames?.length).sort((a, b) => a.order - b.order);
}
/**
 * The System page's view: every feed-scheduled event's recent and upcoming runs
 * as the feed lists them, and every stored correction with whether it still
 * applies.
 */
async function getScheduleCorrectionsView() {
    const now = Date.now();
    const corrections = (0, event_schedule_repo_js_1.listCorrections)();
    const events = [];
    const runsByKey = new Map();
    for (const def of calendarEvents()) {
        const runs = await feedRunsFor(def.key);
        runsByKey.set(def.key, runs);
        events.push({
            key: def.key,
            name: def.name,
            runs: runs
                .filter((r) => r.end > now - CORRECTABLE_PAST_MS)
                .map((r) => {
                const c = corrections.find((x) => x.eventKey === def.key && Date.parse(x.feedStartAt) === r.start);
                const to = c ? Date.parse(c.actualStartAt) : null;
                return {
                    feedStart: new Date(r.start).toISOString(),
                    feedLabel: labelFor(r.start, r.end),
                    correctedStart: to == null ? null : new Date(to).toISOString(),
                    correctedLabel: to == null ? null : labelFor(to, to + (r.end - r.start)),
                    correctionId: c?.id ?? null,
                };
            }),
        });
    }
    return {
        events,
        corrections: corrections.map((c) => {
            const feedStart = Date.parse(c.feedStartAt);
            const actualStart = Date.parse(c.actualStartAt);
            const run = runsByKey.get(c.eventKey)?.find((r) => r.start === feedStart);
            // An inert correction no longer has a run to take a length from; label
            // its start day alone.
            const len = run ? run.end - run.start : DAY_MS;
            return {
                id: c.id,
                eventKey: c.eventKey,
                eventName: (0, event_catalog_js_1.getEventDef)(c.eventKey)?.name ?? c.eventKey,
                feedStart: c.feedStartAt,
                feedLabel: labelFor(feedStart, feedStart + len),
                actualStart: c.actualStartAt,
                actualLabel: labelFor(actualStart, actualStart + len),
                active: !!run,
            };
        }),
    };
}
/**
 * Validate and store a correction. `actualDate` is the game day the run really
 * opens on (YYYY-MM-DD); runs always open at the 17:00 UTC reset, so that is
 * the only instant a correction may name. Returns an error string for bad
 * input instead of throwing, so the route can answer 400.
 */
async function saveScheduleCorrection(eventKey, feedStart, actualDate, userId) {
    const def = (0, event_catalog_js_1.getEventDef)(eventKey);
    if (!def || def.cycle || !def.calendarNames?.length) {
        return { error: 'Not a calendar-scheduled event' };
    }
    const feedMs = Date.parse(feedStart);
    const run = (await feedRunsFor(eventKey)).find((r) => r.start === feedMs);
    if (!run)
        return { error: 'The feed has no run of this event starting then' };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(actualDate))
        return { error: 'Date must be YYYY-MM-DD' };
    const actualMs = Date.parse(`${actualDate}T17:00:00.000Z`);
    if (!Number.isFinite(actualMs))
        return { error: 'Invalid date' };
    if (actualMs === feedMs)
        return { error: 'That is already the feed’s date' };
    if (Math.abs(actualMs - feedMs) > MAX_CORRECTION_SHIFT_MS) {
        return { error: 'A correction can move a run by at most 30 days' };
    }
    (0, event_schedule_repo_js_1.setCorrection)(eventKey, feedMs, actualMs, userId);
    return { ok: true };
}
//# sourceMappingURL=event-calendar.js.map