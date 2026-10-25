"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PointsChangeError = exports.MAX_POINTS = void 0;
exports.getPointsBoard = getPointsBoard;
exports.previewPointChanges = previewPointChanges;
exports.applyPointChanges = applyPointChanges;
exports.previewCopyFrom = previewCopyFrom;
exports.applyCopyFrom = applyCopyFrom;
exports.previewRecalculate = previewRecalculate;
/**
 * The Chest Points admin board: one line per chest SOURCE with the value it
 * pays, instead of one line per (source, chest name) with a default and an
 * override each.
 *
 * Why a source is the unit. 90 of the ~100 sources seen in production pay every
 * chest they drop the same amount — a Level 25 epic crypt is 450 whichever of
 * its seventeen chests you get — so listing chests made a 369-row page whose
 * information was ~100 numbers. The few sources that genuinely pay chests
 * differently (the three omen chests, a citadel's cursed chest) show
 * their odd ones out as exceptions under the source line.
 *
 * What the board shows is the EFFECTIVE value, never the layer it came from.
 * The storage keeps its three layers (exact override → wildcard override →
 * seeded default, see resolvePointsForKey), but which layer holds a number is
 * an implementation detail an admin should not have to reason about — so a
 * save is expressed as a target state ("this source pays 50, except the Epic
 * Omen Chest at 150") and planChanges works out the override rows that produce it.
 *
 * Every write is previewed first: previewPointChanges / previewRecalculate
 * compute exactly which stored chest_records values would move, and by how
 * much, through the same resolver the write uses. Nothing is lost by a wrong
 * save, but a save nobody can check before making is how values drift.
 *
 * The board is one clan's: each clan has its own values (v86), so its record
 * counts, its previews and its saves all stay inside that clan. The sources it
 * lists are every clan's, so a value can be set before the first chest lands.
 */
const database_js_1 = require("./database.js");
const ttl_cache_js_1 = require("../utils/ttl-cache.js");
const clan_repo_js_1 = require("./repositories/clan-repo.js");
const source_points_repo_js_1 = require("./repositories/source-points-repo.js");
const source_names_js_1 = require("../vision/source-names.js");
const source_categories_js_1 = require("./source-categories.js");
/** Largest value a save accepts — the biggest real one is 10,000. */
exports.MAX_POINTS = 1_000_000;
// Under the summary's prefix on purpose: invalidateSourceKeySummary() drops by
// prefix, so every site that already invalidates the summary (scan completion,
// reassignment, override writes) refreshes the board too.
const BOARD_CACHE_KEY = 'sourceKeySummary:board';
const BOARD_TTL_MS = 300000;
/**
 * Heroic monsters are one source per level, but the game pays them by tier, so
 * thirty rows of mostly repeated numbers read better as six. The ranges are
 * the admins' own tiers. A level outside every range (the game adding level
 * 46) stays a row of its own rather than vanishing into a neighbour.
 */
const HEROIC_TIERS = [
    [16, 19], [20, 24], [25, 29], [30, 35], [36, 40], [41, 45],
];
function sourceGroup(key, category) {
    if (category !== 'heroic')
        return null;
    const level = Number(/(\d+)/.exec(key)?.[1]);
    const tier = HEROIC_TIERS.find(([from, to]) => level >= from && level <= to);
    if (!tier)
        return null;
    return { id: `heroic-${tier[0]}-${tier[1]}`, label: `Heroic Monster · Level ${tier[0]}–${tier[1]}`, category };
}
/** A change request the board can't place — surfaced as a 400. */
class PointsChangeError extends Error {
}
exports.PointsChangeError = PointsChangeError;
const IMPACT_LINE_LIMIT = 60;
/**
 * One clan's chest_records grouped down to (source, chest, stored value) — the
 * same rows recalculatePoints walks, so a preview counts exactly what a write
 * would touch.
 */
function loadRecordGroups(clanId) {
    const rows = (0, database_js_1.getDb)().prepare(`
    SELECT cr.clan_id, cs.source, ch.name AS chest_name, cr.point_value, COUNT(*) AS cnt
      FROM chest_records cr
      JOIN chest_sources cs ON cs.id = cr.chest_source_id
      JOIN chests ch ON ch.id = cr.chest_id
     WHERE cr.clan_id = ? AND cs.source != ''
     GROUP BY cr.clan_id, cr.chest_source_id, cr.chest_id, cr.point_value
  `).all(clanId);
    const keyOf = new Map();
    const groups = [];
    for (const r of rows) {
        let key = keyOf.get(r.source);
        if (key === undefined) {
            key = (0, source_names_js_1.getSourceKey)(r.source);
            keyOf.set(r.source, key);
        }
        if (!key)
            continue;
        groups.push({
            clanId: r.clan_id,
            source: r.source,
            key,
            canon: (0, source_names_js_1.canonicalSourceKey)(key),
            chestName: r.chest_name,
            stored: r.point_value,
            count: r.cnt,
        });
    }
    return groups;
}
/**
 * Every source and chest the app knows of, as zero-count groups: whatever any
 * live clan has recorded, plus the built-in default tables and every live
 * clan's saved values. A clan can only score what it has seen, but it needs to
 * value a source before its first chest arrives — a clan added mid-month would
 * otherwise see no event, tournament or Tartaros row until that chest had
 * already been scored. Counts, previews and saves stay the board clan's own.
 *
 * chestName '' = a source known with no chest name (a flat default, or a
 * source-wide value): it gets a row, but no chest under it.
 */
function loadKnownGroups(clanId) {
    const db = (0, database_js_1.getDb)();
    const recorded = db.prepare(`
    SELECT DISTINCT cs.source, ch.name AS chest_name
      FROM chest_records cr
      JOIN clans c ON c.id = cr.clan_id AND c.deleted_at = ''
      JOIN chest_sources cs ON cs.id = cr.chest_source_id
      JOIN chests ch ON ch.id = cr.chest_id
     WHERE cs.source != ''
  `).all();
    const saved = db.prepare(`
    SELECT DISTINCT o.source_key, o.chest_name
      FROM source_point_overrides o
      JOIN clans c ON c.id = o.clan_id AND c.deleted_at = ''
  `).all();
    const groups = [];
    const add = (source, key, chestName) => {
        groups.push({ clanId, source, key, canon: (0, source_names_js_1.canonicalSourceKey)(key), chestName, stored: 0, count: 0 });
    };
    for (const r of recorded) {
        const key = (0, source_names_js_1.getSourceKey)(r.source);
        if (key)
            add(r.source, key, r.chest_name);
    }
    for (const key of source_names_js_1.SOURCE_POINT_KEYS)
        add('', key, '');
    for (const [key, chests] of Object.entries(source_names_js_1.SOURCE_CHEST_POINTS)) {
        for (const name of Object.keys(chests))
            add('', key, name);
    }
    for (const o of saved)
        add('', o.source_key, o.chest_name);
    return groups;
}
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
function titleCase(s) {
    return s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}
/**
 * The structured families get a name built from the key, because the game's
 * own strings for them are inconsistent ("Level 25 Crypt", "Lvl 25-29 Vault of
 * the Ancients", "Level 45 Vault of the Ancients"). Everything else is shown as
 * the game spells it.
 */
function sourceLabel(key, category, sample) {
    let m = /^(common|rare|epic|tartaros) (\d+)$/.exec(key);
    if (m)
        return `${titleCase(m[1])} Crypt · Level ${m[2]}`;
    m = /^(elven|cursed) citadel (\d+)$/.exec(key);
    if (m)
        return `${m[1] === 'cursed' ? 'Cursed Citadel' : 'Citadel'} · Level ${m[2]}`;
    if (category === 'heroic') {
        const level = /(\d+)/.exec(key)?.[1];
        return level ? `Heroic Monster · Level ${level}` : 'Heroic Monster';
    }
    if (category === 'runic' || category === 'vault') {
        const name = category === 'runic' ? 'Raid Runic Squad' : 'Vault of the Ancients';
        // A key known only from the tables has no in-game text: "lvl 20 24 raid runic squad".
        const fromKey = /(\d+)(?: (\d+))?/.exec(key);
        const range = (0, source_names_js_1.parseSourceLevelRange)(sample)
            ?? (fromKey ? (fromKey[2] ? `${fromKey[1]}-${fromKey[2]}` : fromKey[1]) : undefined);
        return range ? `${name} · Level ${range.replace('-', '–')}` : name;
    }
    // Keys flatten an apostrophe to a space: "azada s shop" is Azada's Shop.
    return sample || titleCase(key).replace(/ S\b/g, '\'s');
}
/** Order within a category: crypt tier / citadel kind first, then the label. */
function sortRank(key) {
    if (/^tartaros \d+$/.test(key))
        return 3;
    if (/^rare \d+$/.test(key))
        return 1;
    if (/^epic \d+$/.test(key))
        return 2;
    if (/^cursed citadel \d+$/.test(key))
        return 1;
    return 0;
}
/** The value most records score; ties go to the value more chests share, then the lower. */
function majorityPoints(chests) {
    const byValue = new Map();
    for (const c of chests) {
        const v = byValue.get(c.points) ?? { records: 0, chests: 0 };
        v.records += c.records;
        v.chests += 1;
        byValue.set(c.points, v);
    }
    let best = null;
    for (const entry of byValue) {
        if (!best
            || entry[1].records > best[1].records
            || (entry[1].records === best[1].records && entry[1].chests > best[1].chests)
            || (entry[1].records === best[1].records && entry[1].chests === best[1].chests && entry[0] < best[0])) {
            best = entry;
        }
    }
    return best ? best[0] : 0;
}
/** What a source pays: its chests' majority, or — known only by key (a default
 *  or a saved value, no chest name yet) — its source-wide value. */
function sourcePoints(chests, overrides, key) {
    return chests.length > 0 ? majorityPoints(chests) : (0, source_points_repo_js_1.resolvePointsForKey)(overrides, key, '');
}
function buildBoard(clanId, groups, overrides) {
    const overridden = new Set((0, source_points_repo_js_1.getAllOverrides)(clanId).map((o) => (0, source_points_repo_js_1.makeCacheKey)(o.sourceKey, o.chestName)));
    // One bucket per CANONICAL key: a source read with and without spaces is
    // one source, scored by one set of overrides.
    const buckets = new Map();
    for (const g of [...groups, ...loadKnownGroups(clanId)]) {
        let b = buckets.get(g.canon);
        if (!b) {
            b = { keys: new Map(), sources: new Map(), chests: new Map() };
            buckets.set(g.canon, b);
        }
        b.keys.set(g.key, (b.keys.get(g.key) ?? 0) + g.count);
        if (g.source)
            b.sources.set(g.source, (b.sources.get(g.source) ?? 0) + g.count);
        if (!g.chestName)
            continue;
        const stored = b.chests.get(g.chestName) ?? new Map();
        // A chest only another clan has recorded: listed, with nothing stored.
        if (g.count > 0)
            stored.set(g.stored, (stored.get(g.stored) ?? 0) + g.count);
        b.chests.set(g.chestName, stored);
    }
    const mostCommon = (m) => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? '';
    const sources = [];
    let staleTotal = 0;
    for (const [canon, b] of buckets) {
        // The spaced spelling of a key is the readable one; prefer it.
        const key = [...b.keys.entries()]
            .sort((a, c) => c[0].split(' ').length - a[0].split(' ').length || c[1] - a[1])[0][0];
        const sample = mostCommon(b.sources);
        const wildcardSet = overridden.has(`${canon}\t`);
        let records = 0;
        let stale = 0;
        const chests = [];
        for (const [name, stored] of b.chests) {
            const points = (0, source_points_repo_js_1.resolvePointsForKey)(overrides, key, name);
            let n = 0;
            for (const [value, count] of stored) {
                n += count;
                if (value !== points)
                    stale += count;
            }
            records += n;
            chests.push({
                name,
                records: n,
                points,
                unset: points === 0 && !wildcardSet && !overridden.has(`${canon}\t${name}`) && !(0, source_names_js_1.hasDefaultPointsFor)(key, name),
            });
        }
        chests.sort((a, c) => collator.compare(a.name, c.name));
        const category = (0, source_categories_js_1.sourceCategory)(key);
        const label = sourceLabel(key, category, sample);
        const points = sourcePoints(chests, overrides, key);
        staleTotal += stale;
        sources.push({
            key,
            label,
            source: sample || label,
            category,
            records,
            points,
            chests,
            unset: chests.length > 0
                ? chests.some((c) => c.unset)
                : points === 0 && !wildcardSet && !(0, source_names_js_1.hasDefaultPointsFor)(key, ''),
            staleRecords: stale,
            group: sourceGroup(key, category)?.id ?? null,
            rank: sortRank(key),
        });
    }
    const order = new Map(source_categories_js_1.SOURCE_CATEGORIES.map((c, i) => [c.key, i]));
    sources.sort((a, b) => (order.get(a.category) ?? 99) - (order.get(b.category) ?? 99)
        || a.rank - b.rank
        || collator.compare(a.label, b.label));
    const categories = source_categories_js_1.SOURCE_CATEGORIES
        .map((c) => {
        const inCat = sources.filter((s) => s.category === c.key);
        return { key: c.key, title: c.title, sources: inCat.length, unset: inCat.filter((s) => s.unset).length };
    })
        .filter((c) => c.sources > 0);
    // In board order: a group sits where its first member would.
    const boardGroups = new Map();
    for (const s of sources) {
        const g = sourceGroup(s.key, s.category);
        if (g && !boardGroups.has(g.id))
            boardGroups.set(g.id, g);
    }
    return {
        clan: { id: clanId, name: (0, clan_repo_js_1.getClanById)(clanId)?.name ?? `Clan #${clanId}` },
        categories,
        sources: sources.map(({ rank: _rank, ...s }) => s),
        groups: [...boardGroups.values()],
        staleRecords: staleTotal,
    };
}
/** One clan's board as the admin page reads it. Cached; every write invalidates it. */
function getPointsBoard(clanId) {
    return (0, ttl_cache_js_1.cached)(`${BOARD_CACHE_KEY}:${clanId}`, BOARD_TTL_MS, () => buildBoard(clanId, loadRecordGroups(clanId), (0, source_points_repo_js_1.loadOverrides)(clanId)));
}
/**
 * What re-resolving every record under `overrides` would change: per clan, and
 * per (source, chest), largest point swing first.
 */
function computeImpact(groups, overrides, board, onlyCanon) {
    const labels = new Map(board.sources.map((s) => [(0, source_names_js_1.canonicalSourceKey)(s.key), s]));
    const clanNames = new Map([[board.clan.id, board.clan.name]]);
    const clans = new Map();
    const lines = new Map();
    let records = 0;
    let delta = 0;
    for (const g of groups) {
        if (onlyCanon && !onlyCanon.has(g.canon))
            continue;
        const to = (0, source_points_repo_js_1.resolvePointsForKey)(overrides, g.key, g.chestName);
        if (to === g.stored)
            continue;
        const d = (to - g.stored) * g.count;
        records += g.count;
        delta += d;
        const clan = clans.get(g.clanId) ?? { records: 0, delta: 0 };
        clan.records += g.count;
        clan.delta += d;
        clans.set(g.clanId, clan);
        const id = `${g.canon}\t${to}`;
        let line = lines.get(id);
        if (!line) {
            const src = labels.get(g.canon);
            line = {
                key: src?.key ?? g.key,
                label: src?.label ?? g.source,
                chests: [],
                records: 0,
                from: [],
                to,
                delta: 0,
                fromSet: new Set(),
                chestRecords: new Map(),
            };
            lines.set(id, line);
        }
        line.records += g.count;
        line.delta += d;
        line.fromSet.add(g.stored);
        line.chestRecords.set(g.chestName, (line.chestRecords.get(g.chestName) ?? 0) + g.count);
    }
    const sorted = [...lines.values()]
        .map(({ fromSet, chestRecords, ...l }) => ({
        ...l,
        from: [...fromSet].sort((a, b) => a - b),
        chests: [...chestRecords.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name),
    }))
        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || b.records - a.records || collator.compare(a.label, b.label));
    return {
        records,
        delta,
        clans: [...clans.entries()]
            .map(([id, c]) => ({ id, name: clanNames.get(id) ?? `Clan #${id}`, ...c }))
            .sort((a, b) => a.id - b.id),
        lines: sorted.slice(0, IMPACT_LINE_LIMIT),
        moreLines: Math.max(0, sorted.length - IMPACT_LINE_LIMIT),
    };
}
function validPoints(n) {
    return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= exports.MAX_POINTS;
}
/**
 * Turn the board-level target state into override rows.
 *
 * A source-level change means "every chest paying the source's value now pays
 * v, and so does any chest this source drops in future": it sets the wildcard
 * and lets those chests fall through to it. The source's exceptions keep their
 * values — pinned with an exact row where the new wildcard would otherwise
 * swallow them (a value that came from the old wildcard or from a per-chest
 * seed, which the wildcard outranks). A chest-level change pins that chest.
 * Any exact row that would only restate what the chest resolves to anyway is
 * removed, so the table converges on the fewest rows that say the same thing.
 */
function planChanges(board, overrides, changes) {
    const byCanon = new Map(board.sources.map((s) => [(0, source_names_js_1.canonicalSourceKey)(s.key), s]));
    const perSource = new Map();
    for (const c of changes) {
        if (!c || typeof c.sourceKey !== 'string' || typeof c.chestName !== 'string') {
            throw new PointsChangeError('Each change needs a sourceKey and a chestName');
        }
        if (!validPoints(c.points)) {
            throw new PointsChangeError(`Points must be a whole number from 0 to ${exports.MAX_POINTS.toLocaleString('en')}`);
        }
        const canon = (0, source_names_js_1.canonicalSourceKey)(c.sourceKey);
        if (!byCanon.has(canon))
            throw new PointsChangeError(`Unknown source "${c.sourceKey}"`);
        const list = perSource.get(canon) ?? [];
        list.push(c);
        perSource.set(canon, list);
    }
    const writes = [];
    const edits = [];
    const canonKeys = new Set();
    for (const [canon, list] of perSource) {
        const src = byCanon.get(canon);
        const current = new Map(src.chests.map((c) => [c.name, c.points]));
        const whole = list.find((c) => c.chestName === '');
        const wholeChanged = whole !== undefined && whole.points !== src.points;
        const target = new Map(current);
        if (wholeChanged) {
            for (const c of src.chests)
                if (c.points === src.points)
                    target.set(c.name, whole.points);
        }
        for (const c of list) {
            if (c.chestName === '')
                continue;
            if (!current.has(c.chestName)) {
                throw new PointsChangeError(`"${c.chestName}" has never dropped from ${src.label}`);
            }
            target.set(c.chestName, c.points);
        }
        const changedChests = src.chests.filter((c) => target.get(c.name) !== c.points);
        if (!wholeChanged && changedChests.length === 0)
            continue;
        canonKeys.add(canon);
        const wildcard = wholeChanged ? whole.points : overrides.get((0, source_points_repo_js_1.makeCacheKey)(src.key, ''));
        if (wholeChanged) {
            writes.push({ sourceKey: src.key, chestName: '', points: whole.points });
            edits.push({ key: src.key, label: src.label, chestName: '', from: src.points, to: whole.points });
        }
        // With a new wildcard every chest's fallback moves, so every chest is
        // re-checked; otherwise only the ones asked about.
        for (const c of wholeChanged ? src.chests : changedChests) {
            const to = target.get(c.name);
            const fallback = wildcard ?? (0, source_names_js_1.getDefaultPointsFor)(src.key, c.name);
            const hasExact = overrides.has((0, source_points_repo_js_1.makeCacheKey)(src.key, c.name));
            if (to === fallback) {
                if (hasExact)
                    writes.push({ sourceKey: src.key, chestName: c.name, points: null });
            }
            else if (!hasExact || overrides.get((0, source_points_repo_js_1.makeCacheKey)(src.key, c.name)) !== to) {
                writes.push({ sourceKey: src.key, chestName: c.name, points: to });
            }
            // A chest swept along by the source's new value is covered by the
            // source line; only a chest moved on its own gets a line of its own.
            const sweptByWhole = wholeChanged && c.points === src.points && to === whole.points;
            if (to !== c.points && !sweptByWhole) {
                edits.push({ key: src.key, label: src.label, chestName: c.name, from: c.points, to });
            }
        }
    }
    return { writes, edits, canonKeys };
}
function withWrites(overrides, writes) {
    const next = new Map(overrides);
    for (const w of writes) {
        const k = (0, source_points_repo_js_1.makeCacheKey)(w.sourceKey, w.chestName);
        if (w.points === null)
            next.delete(k);
        else
            next.set(k, w.points);
    }
    return next;
}
/** Dry run of a save: the edits it amounts to and what they do to the clan's stored records. */
function previewPointChanges(clanId, changes) {
    const groups = loadRecordGroups(clanId);
    const overrides = (0, source_points_repo_js_1.loadOverrides)(clanId);
    const board = buildBoard(clanId, groups, overrides);
    const plan = planChanges(board, overrides, changes);
    return { edits: plan.edits, impact: computeImpact(groups, withWrites(overrides, plan.writes), board, plan.canonKeys) };
}
/**
 * Save: write the clan's override rows, then recalculate every one of its
 * records from the sources touched — which also settles any of them that were
 * already stale, exactly as the preview reported.
 */
function applyPointChanges(clanId, changes) {
    const groups = loadRecordGroups(clanId);
    const overrides = (0, source_points_repo_js_1.loadOverrides)(clanId);
    const board = buildBoard(clanId, groups, overrides);
    const plan = planChanges(board, overrides, changes);
    const impact = computeImpact(groups, withWrites(overrides, plan.writes), board, plan.canonKeys);
    (0, source_points_repo_js_1.writeOverrides)(clanId, plan.writes);
    const updated = plan.canonKeys.size > 0 ? (0, source_points_repo_js_1.recalculatePoints)(clanId, plan.canonKeys) : 0;
    return { edits: plan.edits, impact, updated };
}
/**
 * The board's lines that move when `next` replaces the clan's overrides: a
 * source whose own value changes gets one line, and a chest only when it moves
 * apart from its source — the same shape a hand-made save previews as.
 */
function boardEdits(board, next) {
    const edits = [];
    for (const src of board.sources) {
        const after = src.chests.map((c) => ({ ...c, points: (0, source_points_repo_js_1.resolvePointsForKey)(next, src.key, c.name) }));
        const to = sourcePoints(after, next, src.key);
        if (to !== src.points)
            edits.push({ key: src.key, label: src.label, chestName: '', from: src.points, to });
        after.forEach((c, i) => {
            const from = src.chests[i].points;
            const swept = from === src.points && c.points === to;
            if (c.points !== from && !swept) {
                edits.push({ key: src.key, label: src.label, chestName: c.name, from, to: c.points });
            }
        });
    }
    return edits;
}
function copySource(clanId, fromClanId) {
    if (!Number.isInteger(fromClanId) || fromClanId === clanId) {
        throw new PointsChangeError('Pick a different clan to copy the values from');
    }
    const from = (0, clan_repo_js_1.getClanById)(fromClanId);
    if (!from)
        throw new PointsChangeError(`No clan #${fromClanId}`);
    return { id: from.id, name: from.name };
}
/** Dry run of copying every value of `fromClanId` onto `clanId`. */
function previewCopyFrom(clanId, fromClanId) {
    const from = copySource(clanId, fromClanId);
    const groups = loadRecordGroups(clanId);
    const board = buildBoard(clanId, groups, (0, source_points_repo_js_1.loadOverrides)(clanId));
    const next = (0, source_points_repo_js_1.loadOverrides)(fromClanId);
    return {
        from,
        values: (0, source_points_repo_js_1.getAllOverrides)(fromClanId).length,
        edits: boardEdits(board, next),
        impact: computeImpact(groups, next, board),
    };
}
/**
 * Copy: the clan's values become an exact copy of `fromClanId`'s, then every
 * one of its records is recalculated — which also settles any that were
 * already stale, exactly as the preview reported. The source clan is untouched.
 */
function applyCopyFrom(clanId, fromClanId) {
    const preview = previewCopyFrom(clanId, fromClanId);
    (0, source_points_repo_js_1.copyOverrides)(fromClanId, clanId);
    const updated = (0, source_points_repo_js_1.recalculatePoints)(clanId);
    return { ...preview, updated };
}
/** Dry run of Recalculate: every record of the clan whose stored value is out of date. */
function previewRecalculate(clanId) {
    const groups = loadRecordGroups(clanId);
    const overrides = (0, source_points_repo_js_1.loadOverrides)(clanId);
    return computeImpact(groups, overrides, buildBoard(clanId, groups, overrides));
}
//# sourceMappingURL=points-board.js.map