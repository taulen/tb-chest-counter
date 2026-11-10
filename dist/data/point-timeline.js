"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeCacheKey = makeCacheKey;
exports.resolvePointsForKey = resolvePointsForKey;
exports.isGameDay = isGameDay;
exports.dayStartMs = dayStartMs;
exports.valuesOn = valuesOn;
exports.buildSchedule = buildSchedule;
exports.segmentAt = segmentAt;
exports.valuesAt = valuesAt;
exports.currentValues = currentValues;
exports.pointsAt = pointsAt;
exports.valueRuns = valueRuns;
exports.changedRuns = changedRuns;
exports.collapseRepeats = collapseRepeats;
exports.applyWrites = applyWrites;
/**
 * Chest point values over time (v99) — the pure half: no database here.
 * See docs/chest-points-history.md for the rules this implements.
 *
 * A clan's values are a list of entries. Each says "for this (source key,
 * chest name), from game day `from` on, the value is `value`". `from` '' means
 * all history, and `value` null means "from that day on, no value of its own"
 * (the chest falls back to the source value, then the built-in default). The
 * value in force on a day is the latest entry dated on or before it.
 *
 * A chest record is scored with the values of the game day it was EARNED on
 * (`effective_at`, the clock every ranking buckets by), so changing a value
 * from a date never moves a record from before that date.
 */
const source_names_js_1 = require("../vision/source-names.js");
/**
 * Build a cache-map key for (source_key, chest_name). Using a tab separator
 * keeps the composite unambiguous without colliding with either column's
 * value space (source keys and chest names never contain tabs).
 */
function makeCacheKey(sourceKey, chestName) {
    // Canonicalize the source part (space-insensitive) so overrides match
    // regardless of whether the source was OCR'd with spaces (Tesseract /
    // historical) or without (PaddleOCR). The chest name is already canonical
    // via correctChestName, so it's compared verbatim. See canonicalSourceKey.
    return `${(0, source_names_js_1.canonicalSourceKey)(sourceKey)}\t${chestName}`;
}
/**
 * The lookup stack for an already-derived source key: exact override, then the
 * source's wildcard override, then the seeded default. The one place the order
 * is written down — scans, recalculation and the admin board's previews all
 * resolve through it, so a preview can never disagree with what a save does.
 */
function resolvePointsForKey(overrides, key, chestName) {
    const exact = overrides.get(makeCacheKey(key, chestName));
    if (exact !== undefined)
        return exact;
    const wildcard = overrides.get(makeCacheKey(key, ''));
    if (wildcard !== undefined)
        return wildcard;
    return (0, source_names_js_1.getDefaultPointsFor)(key, chestName);
}
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** A real calendar date in YYYY-MM-DD form. */
function isGameDay(day) {
    if (typeof day !== 'string' || !DAY_RE.test(day))
        return false;
    const ms = Date.parse(`${day}T00:00:00Z`);
    return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === day;
}
/** First instant (epoch ms) of game day `day`; 0 for '' (all history). */
function dayStartMs(day, rolloverUtcHour) {
    if (day === '')
        return 0;
    return Date.parse(`${day}T00:00:00Z`) + rolloverUtcHour * 3_600_000;
}
/**
 * The values in force on game day `day`: per key, the latest entry dated on or
 * before it (strictly before it with `before`). A null entry removes the key.
 */
function valuesOn(entries, day, { before = false } = {}) {
    const latest = new Map();
    for (const e of entries) {
        if (before ? e.from >= day : e.from > day)
            continue;
        const k = makeCacheKey(e.sourceKey, e.chestName);
        const cur = latest.get(k);
        if (!cur || e.from > cur.from)
            latest.set(k, e);
    }
    const map = new Map();
    for (const [k, e] of latest)
        if (e.value !== null)
            map.set(k, e.value);
    return map;
}
function buildSchedule(entries, rolloverUtcHour) {
    const dated = [...new Set(entries.map((e) => e.from).filter((d) => d !== ''))].sort();
    const days = ['', ...dated];
    return {
        days,
        starts: days.map((d) => dayStartMs(d, rolloverUtcHour)),
        values: days.map((d) => valuesOn(entries, d)),
    };
}
/** Index of the segment holding instant `ms`. */
function segmentAt(schedule, ms) {
    let lo = 0;
    let hi = schedule.starts.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (schedule.starts[mid] <= ms)
            lo = mid;
        else
            hi = mid - 1;
    }
    return lo;
}
/** The values in force at instant `ms`. */
function valuesAt(schedule, ms) {
    return schedule.values[segmentAt(schedule, ms)];
}
/** The values in force now — what the board shows. No entry is dated after today. */
function currentValues(schedule) {
    return schedule.values[schedule.values.length - 1];
}
/** What a chest from `source` earned at `ms` scores. */
function pointsAt(schedule, source, chestName, ms) {
    const key = (0, source_names_js_1.getSourceKey)(source);
    if (!key)
        return 0;
    return resolvePointsForKey(valuesAt(schedule, ms), key, chestName);
}
/**
 * The value a (key, chest) scores in each stretch of time, adjacent equal
 * stretches merged: [{ from, to, value }] with `to` exclusive (Infinity for the
 * last). Most keys have one run; a dated change splits it.
 */
function valueRuns(schedule, key, chestName) {
    const runs = [];
    schedule.values.forEach((values, i) => {
        const value = resolvePointsForKey(values, key, chestName);
        const last = runs[runs.length - 1];
        if (last && last.value === value)
            return;
        if (last)
            last.to = schedule.starts[i];
        runs.push({ from: schedule.starts[i], to: Infinity, value });
    });
    return runs;
}
/** Sources whose built-in defaults pay some chests their own rate. */
const SEEDED_PER_CHEST = new Set(Object.keys(source_names_js_1.SOURCE_CHEST_POINTS).map(source_names_js_1.canonicalSourceKey));
/**
 * What "no entry" means for a key, as a number when that is exact: a
 * source-wide value with no per-chest defaults under it falls back to the one
 * source default. Anything else falls through to layers that can change on
 * their own, so "no entry" is only equal to itself (null).
 */
function implicitValue(sourceKey, chestName) {
    if (chestName !== '' || SEEDED_PER_CHEST.has((0, source_names_js_1.canonicalSourceKey)(sourceKey)))
        return null;
    return (0, source_names_js_1.getDefaultPointsForKey)(sourceKey);
}
/**
 * The stretches of time in which a (key, chest) scores differently under
 * `next` than under `prev`, with the `next` value: [{ from, to, value }], `to`
 * exclusive. What a dated change moves — and nothing else, so a record it
 * doesn't cover keeps whatever it holds, even a value already out of line.
 */
function changedRuns(prev, next, key, chestName) {
    const starts = [...new Set([...prev.starts, ...next.starts])].sort((a, b) => a - b);
    const runs = [];
    starts.forEach((start, i) => {
        const end = i + 1 < starts.length ? starts[i + 1] : Infinity;
        const before = resolvePointsForKey(valuesAt(prev, start), key, chestName);
        const after = resolvePointsForKey(valuesAt(next, start), key, chestName);
        if (before === after)
            return;
        const last = runs[runs.length - 1];
        if (last && last.to === start && last.value === after) {
            last.to = end;
            return;
        }
        runs.push({ from: start, to: end, value: after });
    });
    return runs;
}
const sameKey = (a, canon, chestName) => a.chestName === chestName && (0, source_names_js_1.canonicalSourceKey)(a.sourceKey) === canon;
/**
 * Drop dated entries that only repeat the value in force the day before (null
 * and "no entry" are the same thing, and so is a source-wide value equal to a
 * default nothing else overrides). All-history entries always stay: an
 * explicit value outranks a per-chest default even when the numbers match.
 */
function collapseRepeats(entries) {
    const byKey = new Map();
    for (const e of entries) {
        const k = makeCacheKey(e.sourceKey, e.chestName);
        const list = byKey.get(k) ?? [];
        list.push(e);
        byKey.set(k, list);
    }
    const keep = new Set();
    for (const list of byKey.values()) {
        list.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
        const implicit = implicitValue(list[0].sourceKey, list[0].chestName);
        const effective = (v) => v ?? implicit;
        let prev = null;
        for (const e of list) {
            if (e.from === '' || effective(e.value) !== effective(prev))
                keep.add(e);
            prev = e.value;
        }
    }
    return entries.filter((e) => keep.has(e));
}
/**
 * The entries after `writes` are saved on `day`.
 *
 * - '' (all history): each key's whole timeline is replaced — every dated
 *   value for it goes, and the new value (if any) holds for all history.
 * - A date: the key's value from that day on. A value already saved for that
 *   day is replaced; one that only repeats the value in force the day before
 *   is dropped, so setting a value back leaves nothing behind.
 */
function applyWrites(entries, day, writes, changeId, now) {
    let next = [...entries];
    for (const w of writes) {
        const canon = (0, source_names_js_1.canonicalSourceKey)(w.sourceKey);
        if (day === '') {
            next = next.filter((e) => !sameKey(e, canon, w.chestName));
            if (w.points !== null) {
                next.push({ sourceKey: w.sourceKey, chestName: w.chestName, from: '', value: w.points, changeId: null, updatedAt: now });
            }
            continue;
        }
        next = next.filter((e) => !(sameKey(e, canon, w.chestName) && e.from === day));
        next.push({ sourceKey: w.sourceKey, chestName: w.chestName, from: day, value: w.points, changeId, updatedAt: now });
    }
    return collapseRepeats(next);
}
//# sourceMappingURL=point-timeline.js.map