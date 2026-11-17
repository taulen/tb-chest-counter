"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FILTER_KINDS = void 0;
exports.buildRosterChanges = buildRosterChanges;
exports.searchKey = searchKey;
exports.filterRosterChanges = filterRosterChanges;
exports.countRosterChanges = countRosterChanges;
/**
 * Who joined the clan, who left, who came back — My Clan → Joins & leaves, and
 * the "joined" / "left" entries of a member's Timeline (member-timeline.ts),
 * which take theirs from here so the two views never disagree.
 *
 * Built from rows other features already keep (roster-changes-repo.ts);
 * nothing is invented, and every entry says whose record it is:
 *
 *   joined     game_players.joined_at — the game's own join time of the
 *              player's current (latest) stint, one per player ever seen in
 *              the clan (still there or gone). An earlier stint's join is
 *              overwritten by the game, so it is never shown.
 *   returned   a join that follows a recorded leave of the same member, or of
 *              a member the site already had on the clan's roster before the
 *              join (members.first_seen earlier than the game's join time):
 *              they were in the clan before, so this join is a return.
 *   restored   audit restore_member — an admin put a removed member back.
 *   left/game  audit member.left_clan of a member linked to a game player: the
 *              game's roster stopped listing them (dated by the scan that saw it).
 *   left/site  the site's own record, not the game's: member.left_clan of a row
 *              with no game link (the first game sync sweeping an OCR-era name),
 *              or members.left_at with no audit row beside it (the OCR-era
 *              7-day sweep, the off-roster retirement, an admin's Remove). Dated
 *              when the site marked them gone, which can be later than the day
 *              they really left.
 *
 * Never shown twice: members.left_at is the latest departure the member row
 * keeps (cleared on the way back in), so it is skipped when a member.left_clan
 * row for the same member sits within a minute of it. A site record about a row
 * the admins have since merged away or deleted is dropped: that row was a
 * duplicate spelling or a misread, not a person leaving.
 *
 * members.first_seen is never shown as a join: it is the first time the site
 * read the name (a gift, an OCR roster read, an import) — for most of the
 * OCR-era clan that is the day tracking started — so it only ever supports a
 * game join being a return. The "[Unknown]" placeholder is never a member.
 *
 * Pure: the repo gathers the rows, the route adds pictures and pages.
 */
const game_day_js_1 = require("../utils/game-day.js");
const fuzzy_js_1 = require("../utils/fuzzy.js");
/** A leave within this of members.left_at is the same departure. */
const SAME_LEAVE_MS = 60_000;
/** first_seen must precede the game's join by more than this to make it a return. */
const SEEN_BEFORE_MS = 60 * 60 * 1000;
const UNKNOWN_MEMBER_NAME = '[Unknown]';
const isPerson = (name) => name.trim() !== '' && name !== UNKNOWN_MEMBER_NAME;
/** Every join, return, restore and leave of the clan, newest first (ties: by key). */
function buildRosterChanges(src, rolloverUtcHour) {
    const byId = new Map(src.members.map((m) => [m.id, m]));
    const dayOf = (iso) => (0, game_day_js_1.gameDateFor)(Date.parse(iso), rolloverUtcHour);
    const out = [];
    const entry = (kind, at, key, member, recordedName, fields = {}) => {
        const name = member?.name ?? recordedName;
        const e = {
            key, kind, at, day: dayOf(at), memberId: member?.id ?? null, playerId: null, name,
            asName: recordedName && recordedName !== name ? recordedName : null,
            source: 'site', prevLeftAt: null, seenSince: null, ...fields,
        };
        out.push(e);
        return e;
    };
    // ── Leaves the sync recorded (member.left_clan) ──
    const leaves = [];
    for (const a of src.audit) {
        const d = a.details;
        const recorded = typeof d.name === 'string' ? d.name : '';
        if (a.action === 'member.left_clan') {
            const game = d.linked !== false;
            let member = byId.get(Number(d.id)) ?? null;
            if (!member) {
                // The row is gone: merged into another member, or deleted. A linked
                // player's departure is still that person's (the survivor of the
                // merge); an unlinked row's was a duplicate or a misread.
                if (!game)
                    continue;
                member = (recorded ? (0, fuzzy_js_1.exactMatchMember)(recorded, src.members) : null);
            }
            if (!isPerson(member?.name ?? recorded))
                continue;
            leaves.push(entry('left', a.at, `left:${a.at}:${String(d.id ?? recorded)}`, member, recorded, { source: game ? 'game' : 'site' }));
        }
        else if (a.action === 'restore_member') {
            const member = recorded ? (0, fuzzy_js_1.exactMatchMember)(recorded, src.members) : null;
            if (!member || !isPerson(member.name))
                continue;
            entry('restored', a.at, `restored:${a.at}:${member.id}`, member, recorded);
        }
    }
    // ── Leaves only the member row remembers (members.left_at) ──
    for (const m of src.members) {
        if (m.isActive || !m.leftAt || !isPerson(m.name))
            continue;
        const t = Date.parse(m.leftAt);
        if (!Number.isFinite(t))
            continue;
        if (leaves.some((l) => l.memberId === m.id && Math.abs(Date.parse(l.at) - t) <= SAME_LEAVE_MS))
            continue;
        leaves.push(entry('left', m.leftAt, `left:${m.leftAt}:${m.id}`, m, m.name));
    }
    // ── Joins: the game's own join time, a return when they were here before ──
    for (const p of src.players) {
        if (!p.joinedAt)
            continue;
        const member = p.memberId !== null ? byId.get(p.memberId) ?? null : null;
        if (!isPerson(member?.name ?? p.name))
            continue;
        const joinMs = p.joinedAt * 1000;
        const at = new Date(joinMs).toISOString();
        let prevLeftAt = null;
        for (const l of leaves) {
            if (member && l.memberId === member.id && Date.parse(l.at) < joinMs && (!prevLeftAt || l.at > prevLeftAt))
                prevLeftAt = l.at;
        }
        const firstSeenMs = member ? Date.parse(member.firstSeen) : NaN;
        const seenSince = !prevLeftAt && Number.isFinite(firstSeenMs) && firstSeenMs < joinMs - SEEN_BEFORE_MS ? member.firstSeen : null;
        // An alt folded into a main by a rule shows under the main, as the alt's game name.
        const recorded = member && !p.linked ? p.name : member?.name ?? p.name;
        entry(prevLeftAt || seenSince ? 'returned' : 'joined', at, `joined:${p.playerId}:${p.joinedAt}`, member, recorded, {
            playerId: p.playerId, source: 'game', prevLeftAt, seenSince,
        });
    }
    return out.sort(byNewest);
}
function byNewest(a, b) {
    if (a.at !== b.at)
        return a.at < b.at ? 1 : -1;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}
/** The kinds a filter chip shows. */
exports.FILTER_KINDS = {
    joined: new Set(['joined', 'returned', 'restored']),
    left: new Set(['left']),
};
/** Lowercase, accents and spacing folded: "Ébène  SK" finds "ebene sk". */
function searchKey(s) {
    return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}
/** Only the entries a chip and a name search keep. */
function filterRosterChanges(entries, opts) {
    const kinds = opts.filter ? exports.FILTER_KINDS[opts.filter] : null;
    const q = opts.query ? searchKey(opts.query) : '';
    return entries.filter((e) => (!kinds || kinds.has(e.kind))
        && (!q || searchKey(e.name).includes(q) || (e.asName !== null && searchKey(e.asName).includes(q))));
}
/**
 * Joins (returns and restores among them) and leaves at or after `sinceIso`,
 * for the header's "in the last 30 days".
 */
function countRosterChanges(entries, sinceIso) {
    const c = { joined: 0, returned: 0, left: 0 };
    for (const e of entries) {
        if (e.at < sinceIso)
            continue;
        if (e.kind === 'left')
            c.left++;
        else {
            c.joined++;
            if (e.kind !== 'joined')
                c.returned++;
        }
    }
    return c;
}
//# sourceMappingURL=roster-changes.js.map