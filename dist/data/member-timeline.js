"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MIGHT_MOVE_RATIO = exports.TIMELINE_GROUPS = void 0;
exports.buildTimeline = buildTimeline;
exports.timelineCursor = timelineCursor;
exports.pageNewestFirst = pageNewestFirst;
exports.pageTimeline = pageTimeline;
/**
 * A member's history as one timeline (profile → Timeline): everything the
 * game and the site recorded about them, newest first, as entries a page can
 * draw without knowing where each came from.
 *
 * Built from rows other features already keep (see member-timeline-repo.ts);
 * nothing here is invented. The rule every source follows: the FIRST read of a
 * source is the baseline — when we started looking, not when the player got
 * there — so it is never shown as a change (the change readers already drop it
 * for research, captains, artifacts and equipment; player history, city
 * status and the dragon drop their first row here).
 *
 * A day's many small changes of one kind fold into one entry with items
 * (research, talents, captains, gear); everything else is one entry each.
 * Pure: the repo gathers the rows, the route adds the URLs it needs.
 */
const game_day_js_1 = require("../utils/game-day.js");
exports.TIMELINE_GROUPS = {
    joined: 'clan', left: 'clan', renamed: 'clan', merged: 'clan', rank: 'clan',
    hero_level: 'growth', city_level: 'growth', vip: 'growth', gold_pass: 'growth', hero: 'growth', might: 'growth', tier: 'growth',
    dragon: 'growth',
    research: 'research', talents: 'research',
    captains: 'captains', artifact: 'captains', gear: 'captains',
    shield: 'city', burning: 'city',
};
/** A day-over-day might move at least this big (either way) is news. */
exports.MIGHT_MOVE_RATIO = 0.1;
const ms = (iso) => Date.parse(iso);
/** Every entry for one member, newest first (ties: by key, so paging is stable). */
function buildTimeline(src, look, rolloverUtcHour) {
    const out = [];
    const dayOf = (iso) => (0, game_day_js_1.gameDateFor)(ms(iso), rolloverUtcHour);
    const add = (kind, at, id, fields = {}) => {
        out.push({ key: `${kind}:${id}`, kind, group: exports.TIMELINE_GROUPS[kind], at, day: dayOf(at), ...fields });
    };
    // ── The clan: joins and leaves the way My Clan → Joins & leaves has them ──
    for (const m of src.moves) {
        const fields = { asName: m.asName };
        if (m.kind === 'left')
            add('left', m.at, m.key, { ...fields, site: m.source === 'site' });
        else if (m.kind === 'restored')
            add('joined', m.at, m.key, { ...fields, restored: true });
        else
            add('joined', m.at, m.key, { ...fields, returned: m.kind === 'returned', prevLeftAt: m.prevLeftAt, seenSince: m.seenSince });
    }
    for (const a of src.audit) {
        const d = a.details;
        if (a.action === 'rename_member' && !d.source && typeof d.newName === 'string') {
            add('renamed', a.at, `admin:${a.at}`, { by: 'admin', from: typeof d.from === 'string' ? d.from : null, to: d.newName });
        }
        else if (a.action === 'merge_player' && typeof d.from === 'string') {
            add('merged', a.at, `${a.at}:${d.from}`, { from: d.from });
        }
    }
    // ── The player record (402), first row = baseline ──
    for (let i = 1; i < src.playerHistory.length; i++) {
        const p = src.playerHistory[i - 1];
        const n = src.playerHistory[i];
        const at = n.at;
        if (n.name !== p.name)
            add('renamed', at, `game:${at}`, { by: 'game', from: p.name, to: n.name });
        if (n.role !== null && p.role !== null && n.role !== p.role) {
            // 1 = leader … 5: a smaller number is a higher rank.
            add('rank', at, at, { from: p.role, to: n.role, promoted: n.role < p.role });
        }
        if (n.heroLevel !== null && p.heroLevel !== null && n.heroLevel !== p.heroLevel)
            add('hero_level', at, at, { from: p.heroLevel, to: n.heroLevel });
        if (n.cityLevel !== null && p.cityLevel !== null && n.cityLevel !== p.cityLevel)
            add('city_level', at, at, { from: p.cityLevel, to: n.cityLevel });
        if (n.vip !== null && p.vip !== null && n.vip !== p.vip)
            add('vip', at, at, { from: p.vip, to: n.vip });
        if (n.goldPass !== null && p.goldPass !== null && n.goldPass !== p.goldPass)
            add('gold_pass', at, at, { on: n.goldPass === 1 });
        if (n.heroAvatar !== null && p.heroAvatar !== null && n.heroAvatar !== p.heroAvatar) {
            add('hero', at, at, { name: look.heroName(n.heroAvatar), avatarUrl: look.heroAvatarUrl(n.heroAvatar) });
        }
    }
    // ── Might: only the big daily moves ──
    for (let i = 1; i < src.mightDays.length; i++) {
        const p = src.mightDays[i - 1];
        const n = src.mightDays[i];
        if (p.might > 0 && Math.abs(n.might - p.might) / p.might >= exports.MIGHT_MOVE_RATIO) {
            add('might', n.at, n.day, { from: p.might, to: n.might });
        }
    }
    // ── Troop tiers ──
    for (const t of src.tierChanges)
        add('tier', t.at, `${t.family}:${t.at}`, { family: t.family, from: t.from, to: t.to });
    // ── The dragon: a level or an evolution moved since the last day read ──
    // Compared with the last day that had a value: a day with no dragon read
    // ({} in the snapshot) is a gap, not a drop. A stage first seen (reads from
    // before it was parsed have none) is the stage's baseline.
    let lastLevel = null;
    let lastStage = null;
    for (const d of src.dragonDays) {
        if (d.level === null)
            continue;
        const levelMoved = lastLevel !== null && d.level !== lastLevel;
        const stageMoved = lastStage !== null && d.stage !== null && d.stage !== lastStage;
        if (levelMoved || stageMoved) {
            add('dragon', d.at, d.day, {
                ...(levelMoved ? { from: lastLevel, to: d.level } : {}),
                ...(stageMoved ? { stageFrom: lastStage, stageTo: d.stage } : {}),
                iconUrl: look.dragonIconUrl(d.stage ?? lastStage),
            });
        }
        lastLevel = d.level;
        if (d.stage !== null)
            lastStage = d.stage;
    }
    // ── Research and talents: one entry per game day and kind ──
    const fold = (kind, rows) => {
        const byDay = new Map();
        for (const r of rows) {
            const day = dayOf(r.at);
            const g = byDay.get(day);
            if (g) {
                g.items.push(r.item);
                if (r.at > g.at)
                    g.at = r.at;
            }
            else {
                byDay.set(day, { at: r.at, items: [r.item] });
            }
        }
        for (const [day, g] of byDay)
            add(kind, g.at, day, { items: g.items });
    };
    const techItem = (c) => ({
        techId: c.techId, name: look.techName(c.techId), iconUrl: look.techIconUrl(c.techId), level: c.level, prevLevel: c.prevLevel,
    });
    fold('research', src.techChanges.filter((c) => look.techKind(c.techId) === 'research').map((c) => ({ at: c.at, item: techItem(c) })));
    fold('talents', src.techChanges.filter((c) => look.techKind(c.techId) === 'talent').map((c) => ({ at: c.at, item: techItem(c) })));
    // ── Captains, artifacts, gear ──
    fold('captains', src.captainChanges.map((c) => ({
        at: c.changedAt,
        item: {
            captainId: c.captainId, name: look.captainName(c.captainId), iconUrl: look.captainIconUrl(c.captainId),
            level: c.level, prevLevel: c.prevLevel, stars: c.stars, prevStars: c.prevStars,
        },
    })));
    for (const a of src.artifactChanges) {
        add('artifact', a.changedAt, `${a.artifactType}:${a.changedAt}`, {
            artifactType: a.artifactType, name: look.artifactName(a.artifactType), iconUrl: look.artifactIconUrl(a.artifactType),
            level: a.level, prevLevel: a.prevLevel, star: a.star, prevStar: a.prevStar, rerolled: a.rerolled,
            // We only ever see the artifacts the three line-up captains wear: one seen
            // for the first time moved INTO the line-up, it is not new to the player.
            intoLineup: a.prevLevel === null,
        });
    }
    fold('gear', src.equipmentChanges.map((e) => ({
        at: e.changedAt,
        item: {
            captainId: e.captainId,
            captainName: e.captainId === 1 ? null : look.captainName(e.captainId),
            position: e.position,
            change: e.itemType === 0 ? 'taken_off' : e.reworked ? 'reworked' : 'put_on',
            name: e.itemType ? look.itemName(e.itemType) : null,
            iconUrl: e.itemType ? look.itemIconUrl(e.itemType) : null,
            prevName: e.prevType ? look.itemName(e.prevType) : null,
            prevIconUrl: e.prevType ? look.itemIconUrl(e.prevType) : null,
        },
    })));
    // ── The city on the map, first row = baseline ──
    for (let i = 1; i < src.cityStatus.length; i++) {
        const p = src.cityStatus[i - 1];
        const n = src.cityStatus[i];
        if (n.shielded !== p.shielded)
            add('shield', n.at, n.at, { on: n.shielded === 1 });
        if (n.burning !== p.burning)
            add('burning', n.at, n.at, { on: n.burning === 1 });
    }
    return out.sort(byNewest);
}
function byNewest(a, b) {
    if (a.at !== b.at)
        return a.at < b.at ? 1 : -1;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}
/** The cursor of an entry: the next page starts after it. */
function timelineCursor(e) {
    return `${e.at}|${e.key}`;
}
/**
 * One page of a newest-first list (by time, then key): entries after `before`
 * (a cursor from the previous page), at most `limit`. `next` is the cursor to
 * ask with for the page after, or null at the start. Entries arriving at the
 * top never shift what the next page returns. Also pages My Clan → Joins &
 * leaves (roster-changes.ts).
 */
function pageNewestFirst(list, opts) {
    let rest = list;
    if (opts.before) {
        const sep = opts.before.indexOf('|');
        const at = sep < 0 ? opts.before : opts.before.slice(0, sep);
        const key = sep < 0 ? '' : opts.before.slice(sep + 1);
        rest = list.filter((e) => e.at < at || (e.at === at && e.key > key));
    }
    const page = rest.slice(0, Math.max(1, opts.limit));
    const next = rest.length > page.length ? timelineCursor(page[page.length - 1]) : null;
    return { entries: page, next };
}
/**
 * One page of a built timeline: entries after `before` (a cursor from the
 * previous page), only the given groups, at most `limit`. `next` is the
 * cursor to ask with for the page after, or null at the start.
 */
function pageTimeline(entries, opts) {
    const list = opts.groups?.size ? entries.filter((e) => opts.groups.has(e.group)) : entries;
    return { ...pageNewestFirst(list, opts), total: list.length };
}
//# sourceMappingURL=member-timeline.js.map