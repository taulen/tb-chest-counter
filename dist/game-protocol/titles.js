"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parsePlayerTitles = parsePlayerTitles;
exports.parseTitleCounts = parseTitleCounts;
exports.parseCityTitles = parseCityTitles;
exports.titleViews = titleViews;
const isInt = (v) => typeof v === 'number' && Number.isInteger(v);
/**
 * 402 field 19 → the titles held, or null when the field is not a list (an
 * unknown reply shape is not "holds nothing").
 */
function parsePlayerTitles(v) {
    if (!Array.isArray(v))
        return null;
    const out = [];
    for (const e of v) {
        if (!Array.isArray(e) || !isInt(e[0]) || !isInt(e[1]) || e[0] <= 0)
            continue;
        out.push({ titleId: e[0], assignedAt: e[1], eventId: null });
    }
    return out;
}
/** 402 field 20 → title id → how many times the player received it; null when not a list. */
function parseTitleCounts(v) {
    if (!Array.isArray(v))
        return null;
    const out = {};
    for (const e of v) {
        if (!Array.isArray(e) || !isInt(e[0]) || !isInt(e[1]) || e[0] <= 0 || e[1] <= 0)
            continue;
        out[String(e[0])] = e[1];
    }
    return out;
}
/**
 * City field 21 → the titles held, or null when the field is not a map. A map
 * with non-scalar keys arrives as `$pairs` (codec.ts); its values are read the
 * same way.
 */
function parseCityTitles(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v) || '$bin' in v)
        return null;
    const values = '$pairs' in v && Array.isArray(v.$pairs)
        ? v.$pairs.map(([, x]) => x)
        : Object.values(v);
    const out = [];
    for (const e of values) {
        if (!Array.isArray(e) || !isInt(e[0]) || !isInt(e[2]) || e[0] <= 0)
            continue;
        out.push({ titleId: e[0], assignedAt: e[2], eventId: isInt(e[1]) ? e[1] : null });
    }
    return out;
}
/**
 * The titles to show, from what is stored: only those still running at
 * `nowSec` (a title not read since it ran out — its player left the clan — is
 * over all the same), newest received first.
 */
function titleViews(names, held, nowSec, urls) {
    const out = [];
    for (const h of held) {
        const t = names?.titles?.[String(h.titleId)];
        const seconds = t?.seconds ?? 0;
        const end = seconds > 0 ? h.assignedAt + seconds : null;
        if (end !== null && end <= nowSec)
            continue;
        out.push({
            titleId: h.titleId,
            name: t?.name || `#${h.titleId}`,
            description: t?.description ?? '',
            source: t?.source ?? '',
            seconds,
            receivedAt: new Date(h.assignedAt * 1000).toISOString(),
            endsAt: end === null ? null : new Date(end * 1000).toISOString(),
            times: h.times ?? null,
            firstSeen: h.firstSeen,
            iconUrl: urls.icon(h.titleId),
            artUrl: urls.art(h.titleId),
        });
    }
    return out.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt) || a.titleId - b.titleId);
}
//# sourceMappingURL=titles.js.map