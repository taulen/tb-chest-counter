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
 * Scan-time caveat: captured_at is the scan/claim time, not the in-game earn
 * time, so an occurrence's upper bound is extended to the first completed scan
 * after its reset (see getFirstCompletedAtOrAfter) to catch chests claimed just
 * after the event ended.
 */

import { childLogger } from '../utils/logger.js';
import { EVENT_CATALOG, getEventDef } from '../config/event-catalog.js';
import { getFirstCompletedAtOrAfter } from '../data/repositories/session-repo.js';
import { getEventDataStart } from '../data/repositories/event-repo.js';

const log = childLogger('event-calendar');

const FEED_URL =
  process.env.EVENT_CALENDAR_ICS_URL || 'https://tbclanportal.com/calendar/feed.ics';
const USER_AGENT = 'tb-chest-counter/1.0 (+self-hosted personal use)';
// The schedule changes at most once a day (17:00 UTC reset). A few hours keeps
// the feed fresh without hammering it — the parsed result is reused across
// every clan and every Events page hit in between.
const TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface EventOccurrence {
  /** ISO UTC, inclusive start (first VEVENT DTSTART = the event's opening reset). */
  from: string;
  /**
   * ISO UTC upper bound for the aggregation. Normally the event's closing reset
   * (last VEVENT DTEND), but extended to the first completed scan after that
   * reset so trailing chests (claimed post-reset) are counted.
   */
  to: string;
  /**
   * ISO UTC of the event's closing reset (last VEVENT DTEND) — `to` without the
   * scan-tail extension. Chest aggregation wants the extended bound; anything
   * *describing* the occurrence (its label, the game-days it covers) wants this
   * one, or a run reads as a day longer than it was.
   */
  resetAt: string;
  /** Compact human label over the event's game-days, e.g. "Jul 2–6" or "Jul 19". */
  label: string;
  /** True when the event is currently in progress (now is before its reset). */
  isCurrent: boolean;
  /**
   * True when the window was reconstructed from the event's cadence because it
   * predates the feed's rolling history (see `backfilledGroups`), rather than
   * read from a VEVENT. The dates are then a projection, not a record.
   */
  estimated: boolean;
}

interface VEvent {
  key: string; // catalog event key this VEVENT resolves to
  start: number; // epoch ms (DTSTART)
  end: number; // epoch ms (DTEND)
}

// Strip diacritics + the leading emoji/symbols so feed names compare cleanly:
// "🏛️ Trials of Olympus - Chimera (Day 1/5)" → "trials of olympus - chimera …".
function norm(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/^[^\p{L}]+/u, '')
    .trim()
    .toLowerCase();
}

// Catalog keys that declare calendar names, with those names pre-normalised.
const NAME_INDEX = EVENT_CATALOG.filter(
  (e) => Array.isArray(e.calendarNames) && e.calendarNames.length,
).map((e) => ({ key: e.key, names: (e.calendarNames as string[]).map(norm) }));

// Resolve a VEVENT SUMMARY to a catalog key by prefix match (so per-day and
// per-variant suffixes don't matter), or null when it's an event we don't track.
function keyForSummary(summary: string): string | null {
  const s = norm(summary);
  for (const { key, names } of NAME_INDEX) {
    if (names.some((n) => n.length > 0 && s.startsWith(n))) return key;
  }
  return null;
}

// Trailing "(Day i/n)" on a SUMMARY. The feed writes it on every day of a
// multi-day run, so any one row names the run's length and this row's place in it.
const DAY_LABEL_RE = /\(\s*day\s+(\d+)\s*\/\s*(\d+)\s*\)\s*$/i;
// Nothing in the game runs longer than a week; a garbled label can't stretch a
// window past this. Olympus, the longest, is 5 days.
const MAX_DECLARED_RUN_DAYS = 10;

/** One parsed "(Day i/n)" row: which run it belongs to, and its place in it. */
interface DeclaredDay {
  key: string;
  runStart: number;
  total: number;
  index: number;
}

/**
 * Widen one VEVENT to the full run its "(Day i/n)" label declares, so a run the
 * feed emitted with days missing still spans its real length (see the header).
 * Unlabelled rows — and labels that don't make sense — pass through untouched.
 */
function declaredRunSpan(
  summary: string,
  start: number,
  end: number,
): { start: number; end: number; declared: Omit<DeclaredDay, 'key'> | null } {
  const m = DAY_LABEL_RE.exec(summary);
  if (!m) return { start, end, declared: null };
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
function parseIcsUtc(v: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(v.trim());
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

function parseVevents(text: string): VEvent[] {
  // Unfold RFC-5545 continuation lines (a CRLF/LF followed by space or tab).
  const unfolded = text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
  const lines = unfolded.split(/\r\n|\n|\r/);
  const out: VEvent[] = [];
  // Every "(Day i/n)" row seen, for the missing-day audit below.
  const declared: DeclaredDay[] = [];
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
        if (key && start !== null && end !== null && end > start) {
          const span = declaredRunSpan(summary, start, end);
          if (span.declared) declared.push({ ...span.declared, key });
          out.push({ key, start: span.start, end: span.end });
        }
      }
      inEvent = false;
      continue;
    }
    if (!inEvent) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    // Property name may carry parameters after ';' (e.g. DTSTART;TZID=…) — drop them.
    const name = line.slice(0, idx).split(';')[0].toUpperCase();
    const value = line.slice(idx + 1);
    if (name === 'SUMMARY') summary = value;
    else if (name === 'DTSTART') dtstart = value;
    else if (name === 'DTEND') dtend = value;
  }
  warnOnMissingRunDays(declared);
  return out;
}

/**
 * The expansion above quietly covers for a feed that dropped days of a run, so
 * say when it did. Silence here would make an incomplete feed indistinguishable
 * from a complete one — the exact ambiguity that hid the 2026-09-03 Dark Omens
 * run reading as a single game day.
 */
function warnOnMissingRunDays(declared: DeclaredDay[]): void {
  // One run == one (event key, run start) pair, since the label pins both.
  const runs = new Map<string, { key: string; runStart: number; total: number; days: Set<number> }>();
  for (const d of declared) {
    const id = `${d.key}@${d.runStart}`;
    const run = runs.get(id) ?? { key: d.key, runStart: d.runStart, total: d.total, days: new Set<number>() };
    run.days.add(d.index);
    runs.set(id, run);
  }
  const gaps: string[] = [];
  for (const run of runs.values()) {
    if (run.days.size >= run.total) continue;
    const missing: number[] = [];
    for (let i = 1; i <= run.total; i++) if (!run.days.has(i)) missing.push(i);
    const day = new Date(run.runStart).toISOString().slice(0, 10);
    gaps.push(`${run.key} ${day} missing day ${missing.join('+')} of ${run.total}`);
  }
  if (gaps.length) {
    log.warn(
      { noAlert: true },
      `Event calendar feed omitted run days (windows widened from the "Day i/n" label): ${gaps.join('; ')}`,
    );
  }
}

async function fetchVevents(): Promise<VEvent[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let text: string;
  try {
    const res = await fetch(FEED_URL, {
      headers: { accept: 'text/calendar', 'user-agent': USER_AGENT },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    text = await res.text();
  } finally {
    clearTimeout(timer);
  }
  return parseVevents(text);
}

// In-process cache of the parsed feed (shared across clans). `inflight`
// coalesces concurrent misses into one fetch; a fetch failure serves the last
// good result when we have one, so a transient feed outage is invisible.
let cache: { expires: number; events: VEvent[] } | null = null;
let inflight: Promise<VEvent[]> | null = null;

async function getVevents(): Promise<VEvent[]> {
  const now = Date.now();
  if (cache && cache.expires > now) return cache.events;
  if (inflight) return inflight;
  inflight = fetchVevents()
    .then((events) => {
      cache = { events, expires: Date.now() + TTL_MS };
      log.info(`Loaded ${events.length} tracked calendar VEVENTs from ${FEED_URL}`);
      return events;
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`Event calendar fetch failed: ${msg}`);
      if (cache) return cache.events; // serve stale rather than break the page
      throw err;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Label an occurrence by its game-days. `endMs` is the exclusive closing reset,
// so the last game-day is the day before it: a Jul-2→Jul-7 run reads "Jul 2–6".
function labelFor(startMs: number, endMs: number): string {
  const a = new Date(startMs);
  const b = new Date(endMs - DAY_MS);
  const am = a.getUTCMonth();
  const ad = a.getUTCDate();
  const bm = b.getUTCMonth();
  const bd = b.getUTCDate();
  if (am === bm && ad === bd) return `${MONTHS[am]} ${ad}`;
  if (am === bm) return `${MONTHS[am]} ${ad}–${bd}`;
  return `${MONTHS[am]} ${ad} – ${MONTHS[bm]} ${bd}`;
}

// Fuse an event's consecutive VEVENTs (touching/overlapping in time) into
// occurrence spans, ascending. Shared by the occurrence list and the schedule.
async function groupsFor(eventKey: string): Promise<Array<{ start: number; end: number }>> {
  const events = (await getVevents()).filter((e) => e.key === eventKey);
  if (!events.length) return [];
  events.sort((a, b) => a.start - b.start);
  const groups: Array<{ start: number; end: number }> = [];
  for (const ev of events) {
    const last = groups[groups.length - 1];
    if (last && ev.start <= last.end) {
      if (ev.end > last.end) last.end = ev.end;
    } else {
      groups.push({ start: ev.start, end: ev.end });
    }
  }
  return groups;
}

// A rolling cycle is infinite backwards, so the list is floored at the clan's
// oldest chest for the event. This caps it regardless — a bad anchor, or a very
// long-lived clan, can't turn the "older" arrow into an endless walk.
const MAX_CYCLE_WINDOWS = 60;

/** One occurrence span, and whether it came from the feed or was reconstructed. */
interface Span {
  start: number;
  end: number;
  estimated: boolean;
}

/**
 * The feed is a ROLLING window, not an archive: measured 2026-09-18 it carried
 * 2026-08-18 → 2026-12-18, i.e. about a month back. A 6-day event therefore
 * still has five past runs in it, but a 24-day one (Ragnarök, Dark Omens,
 * Olympus, Armageddon, Hell Forge) has ONE or TWO — which is exactly what made
 * the Events page's "older" arrow stop dead after a step or two while "All
 * time" kept showing the clan's full history.
 *
 * Every tracked event in the feed is strictly periodic — 6, 12 or 24 days, with
 * zero exceptions across 374 VEVENTs spanning four months — so runs that have
 * aged out are reconstructed by stepping that period back from the feed's
 * earliest run. Two guards keep that from inventing history:
 *
 *  - the period must be PROVEN by the feed (three runs, identical gaps); an
 *    event with an irregular or unknown cadence is left exactly as it was, and
 *  - the walk stops at the clan's oldest chest for the event, so an event the
 *    game introduced last month can't grow runs from before it existed.
 *
 * Reconstructed windows are flagged `estimated` and the page marks them, since
 * their dates are a projection of the schedule rather than a record of it.
 */
const MAX_BACKFILL_WINDOWS = 60;

/**
 * The event's run-to-run period, in ms — but only when the feed proves it:
 * three runs whose gaps are all identical. Anything less regular returns null
 * and gets no backfill.
 */
function inferPeriodMs(groups: Array<{ start: number; end: number }>): number | null {
  if (groups.length < 3) return null;
  const period = groups[1].start - groups[0].start;
  if (!(period > 0)) return null;
  for (let i = 1; i < groups.length - 1; i++) {
    if (groups[i + 1].start - groups[i].start !== period) return null;
  }
  return period;
}

/** Feed runs, preceded by the reconstructed ones the feed no longer carries. */
function backfilledGroups(
  groups: Array<{ start: number; end: number }>,
  eventKey: string,
  clanId?: number,
): Span[] {
  const feed: Span[] = groups.map((g) => ({ start: g.start, end: g.end, estimated: false }));
  if (clanId == null || !groups.length) return feed;
  const period = inferPeriodMs(groups);
  if (period == null) return feed;
  const floorMs = dataFloorMs(eventKey, clanId);
  const earliest = groups[0].start;
  if (floorMs >= earliest) return feed;
  // A run the feed emitted with days missing is SHORT (the 2026-09-03 Dark
  // Omens arrived as its "(Day 1/2)" row alone), so size reconstructed windows
  // by the longest run seen rather than by the first one — and never longer
  // than the period, which would run one window into the next.
  const lenMs = Math.min(Math.max(...groups.map((g) => g.end - g.start)), period);
  const older: Span[] = [];
  for (
    let start = earliest - period;
    start + period > floorMs && older.length < MAX_BACKFILL_WINDOWS;
    start -= period
  ) {
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
function cycleGroups(
  cycle: { anchor: string; days: number },
  floorMs: number,
): Array<{ start: number; end: number }> {
  const anchorMs = Date.parse(cycle.anchor);
  const lenMs = cycle.days * DAY_MS;
  if (!Number.isFinite(anchorMs) || lenMs <= 0) return [];
  // Cycle index relative to the anchor — negative for cycles that ran before
  // it, so an anchor read off today's in-game timer still describes the past.
  const indexAt = (ms: number) => Math.floor((ms - anchorMs) / lenMs);
  const last = indexAt(Date.now());
  const first = Math.max(Math.min(indexAt(floorMs), last), last - (MAX_CYCLE_WINDOWS - 1));
  const groups: Array<{ start: number; end: number }> = [];
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
function dataFloorMs(eventKey: string, clanId?: number): number {
  if (clanId == null) return Date.now();
  const first = getEventDataStart(eventKey, clanId);
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
export async function getEventSchedule(
  eventKey: string,
): Promise<{ next: EventOccurrence | null; live: boolean; cycleEndsAt: string | null }> {
  const cycle = getEventDef(eventKey)?.cycle;
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
export async function getEventOccurrences(
  eventKey: string,
  clanId?: number,
): Promise<EventOccurrence[]> {
  const cycle = getEventDef(eventKey)?.cycle;
  const base: Span[] = cycle
    ? cycleGroups(cycle, dataFloorMs(eventKey, clanId)).map((g) => ({ ...g, estimated: false }))
    : backfilledGroups(await groupsFor(eventKey), eventKey, clanId);
  if (!base.length) return [];
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
      const ext = getFirstCompletedAtOrAfter(clanId, new Date(g.end).toISOString());
      if (ext) {
        const extMs = Date.parse(ext);
        if (Number.isFinite(extMs) && extMs > toMs) toMs = extMs;
      }
    }
    // Never let the scan-tail extension bleed into this event's next occurrence.
    const nextStart = i + 1 < groups.length ? groups[i + 1].start : Infinity;
    if (toMs > nextStart) toMs = nextStart;
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
