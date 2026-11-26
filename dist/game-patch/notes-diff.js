"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_TEXTS = exports.MAX_CHANGES = exports.NOTE_LANGS = exports.PATCH_NOTES_FORMAT = void 0;
exports.looksLikeKey = looksLikeKey;
exports.flattenLines = flattenLines;
exports.normalizeValue = normalizeValue;
exports.valueChanges = valueChanges;
exports.diffSections = diffSections;
exports.diffTrees = diffTrees;
exports.techsShownByTrees = techsShownByTrees;
exports.textGroupKey = textGroupKey;
exports.normalizeText = normalizeText;
exports.planTexts = planTexts;
exports.planKeys = planKeys;
exports.textsOf = textsOf;
exports.assembleTexts = assembleTexts;
exports.artStem = artStem;
exports.diffArtNames = diffArtNames;
exports.claimedArt = claimedArt;
exports.artTextKeys = artTextKeys;
exports.artNamesByStem = artNamesByStem;
exports.summarizeNotes = summarizeNotes;
/**
 * The patch notes' diffs — pure: two versions of the game's files in, what
 * changed out. game-patch/notes.ts reads the files and stores the result;
 * Tools → What's new shows it. Four parts:
 *
 *   sections  every kind of game data (notes-sections.ts): added, revealed
 *             (a placeholder given its real name), renamed, changed, removed
 *   trees     research trees: new ones whole (drawn as the game draws them),
 *             grown ones with their new nodes
 *   texts     every text of the game's translation catalogue, grouped by
 *             feature, and its help windows as readable guides — UI text
 *             ships before the feature does, so this is where a coming
 *             feature shows first
 *   images    what the art catalogue added, grouped by picture
 */
const notes_sections_js_1 = require("./notes-sections.js");
/** Bump when what a note holds changes: an index of an older format is noted afresh (the newest patch against the one before it). */
exports.PATCH_NOTES_FORMAT = 3;
exports.NOTE_LANGS = ['en', 'de', 'es', 'fr', 'ru'];
const KIND_ORDER = { added: 0, revealed: 1, renamed: 2, changed: 3, removed: 4 };
// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------
/** Changes kept per entry; the rest are counted. */
exports.MAX_CHANGES = 12;
const MAX_LINES = 20_000;
/** An id map's keys are ids: "17146", "1037,4". Anything else is one object (the Dragon, the Hall of Fame). */
function isIdMap(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v))
        return false;
    const keys = Object.keys(v);
    return keys.length > 0 && keys.every((k) => /^-?\d+(?:,-?\d+)*$/.test(k));
}
/** An untranslated text key standing in for a name ("item.name.mod_roulette_4_progress"). */
function looksLikeKey(name) {
    return /^[a-z0-9_]+(?:\.[a-z0-9_%]+)+$/i.test(name) && !/\s/.test(name);
}
/** Every leaf of a value, by path; a [text, value] pair is one line named by its text. */
function flattenLines(v, at = '', out = []) {
    if (out.length >= MAX_LINES)
        return out;
    if (v === null || v === undefined)
        return out;
    if (typeof v !== 'object') {
        out.push({ at: at || undefined, text: '', value: String(v) });
        return out;
    }
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && (v[1] === null || typeof v[1] !== 'object')) {
        out.push({ at: at || undefined, text: v[0], value: String(v[1] ?? '') });
        return out;
    }
    const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x]) : Object.entries(v);
    for (const [k, x] of entries)
        flattenLines(x, at ? `${at} › ${k}` : k, out);
    return out;
}
/** A value as compared: "+30,0%" and "+30%" are the same number, a formatting change is no change. */
function normalizeValue(s) {
    return s
        .replace(/(\d),(\d)/g, '$1.$2')
        .replace(/\d+(?:\.\d+)?/g, (m) => String(Number(m)))
        .replace(/\s+/g, ' ')
        .trim();
}
function lineKey(l, seen) {
    const base = `${l.at ?? ''}\u0000${l.text}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n ? `${base}\u0000${n}` : base;
}
/** What moved between two values of one entry, formatting aside. */
function valueChanges(def, a, b) {
    const linesOf = (v) => {
        const seen = new Map();
        const lines = def.lines ? def.lines(v) : flattenLines(v);
        return new Map(lines.map((l) => [lineKey(l, seen), l]));
    };
    const la = linesOf(a);
    const lb = linesOf(b);
    const all = [];
    for (const k of new Set([...la.keys(), ...lb.keys()])) {
        const x = la.get(k);
        const y = lb.get(k);
        if (x && y && normalizeValue(x.value) === normalizeValue(y.value))
            continue;
        if (!x && y && !y.value)
            continue;
        if (x && !y && !x.value)
            continue;
        const l = (y ?? x);
        all.push({ at: l.at, text: l.text, was: x ? x.value : null, now: y ? y.value : null });
    }
    // A value that moved says the most, then a line the entry gained, then one it lost.
    const rank = (c) => (c.was !== null && c.now !== null ? 0 : c.now !== null ? 1 : 2);
    const sorted = all.map((c, i) => ({ c, i })).sort((p, q) => rank(p.c) - rank(q.c) || p.i - q.i).map((p) => p.c);
    return { changes: sorted.slice(0, exports.MAX_CHANGES), more: Math.max(0, sorted.length - exports.MAX_CHANGES) };
}
const pictures = (list) => {
    const out = [...new Set((list ?? []).filter((x) => typeof x === 'string' && x.length > 0))];
    return out.length ? out : undefined;
};
function entryOf(def, kind, id, v, ctx) {
    const name = def.name(v, id).trim();
    const e = { id, kind, name };
    if (looksLikeKey(name))
        e.unnamed = true;
    const sub = def.sub?.(v, id);
    if (sub)
        e.sub = sub;
    const icon = pictures(def.icon?.(v, id, ctx));
    if (icon)
        e.icon = icon;
    const art = pictures(def.art?.(v, id, ctx));
    if (art)
        e.art = art;
    const layers = def.layers?.(v, id, ctx);
    if (layers && (layers.back || layers.frame))
        e.layers = layers;
    const detail = def.detail?.(v, id);
    if (detail)
        e.detail = Object.fromEntries(Object.entries(detail).filter(([, x]) => x !== undefined && x !== null && x !== ''));
    return e;
}
/** Entries of one kind and name fold into one when the section groups by name. */
function groupByName(entries) {
    const out = [];
    const byKey = new Map();
    for (const e of entries) {
        // A renamed group shares its old name too; revealed placeholders differ in theirs ("item.name.x_4", "_5").
        const key = `${e.kind}\u0000${e.name}\u0000${e.kind === 'renamed' ? e.was ?? '' : ''}`;
        const first = byKey.get(key);
        if (!first || !e.name) {
            byKey.set(key, e);
            out.push(e);
            continue;
        }
        first.ids = [...(first.ids ?? [first.id]), e.id];
        if (!first.icon && e.icon)
            first.icon = e.icon;
        if (e.changes?.length && (first.changes?.length ?? 0) < exports.MAX_CHANGES) {
            const room = exports.MAX_CHANGES - (first.changes?.length ?? 0);
            first.changes = [...(first.changes ?? []), ...e.changes.slice(0, room)];
            first.moreChanges = (first.moreChanges ?? 0) + Math.max(0, e.changes.length - room) + (e.moreChanges ?? 0);
        }
    }
    return out;
}
function diffIdMap(def, a, b, ctx, skip) {
    const before = a ?? {};
    const after = b ?? {};
    const prevNames = new Map();
    for (const [id, v] of Object.entries(before)) {
        const n = def.name(v, id).trim();
        prevNames.set(n, (prevNames.get(n) ?? 0) + 1);
    }
    const entries = [];
    for (const [id, v] of Object.entries(after)) {
        if (skip?.has(id))
            continue;
        if (def.keep && !def.keep(v, id))
            continue;
        if (!(id in before)) {
            const e = entryOf(def, 'added', id, v, ctx);
            // Nothing to show for a row with neither a name nor a picture.
            if (e.name || e.icon)
                entries.push(e);
            continue;
        }
        const old = before[id];
        if (JSON.stringify(old) === JSON.stringify(v))
            continue;
        const name = def.name(v, id).trim();
        const was = def.name(old, id).trim();
        const { changes, more } = valueChanges(def, old, v);
        if (was !== name) {
            // A placeholder given its real name: blank, an untranslated key, or a
            // name the game had stamped on several ids at once ("Artemisia" ×5).
            const revealed = !was || looksLikeKey(was) || (prevNames.get(was) ?? 0) > 1;
            const e = entryOf(def, revealed ? 'revealed' : 'renamed', id, v, ctx);
            e.was = was;
            if (changes.length && !revealed) {
                e.changes = changes;
                if (more)
                    e.moreChanges = more;
            }
            if (e.name || e.icon)
                entries.push(e);
            continue;
        }
        if (!changes.length)
            continue;
        const e = entryOf(def, 'changed', id, v, ctx);
        e.changes = changes;
        if (more)
            e.moreChanges = more;
        entries.push(e);
    }
    for (const [id, v] of Object.entries(before)) {
        if (id in after || skip?.has(id))
            continue;
        if (def.keep && !def.keep(v, id))
            continue;
        const e = entryOf(def, 'removed', id, v, ctx);
        if (e.name)
            entries.push(e);
    }
    const grouped = def.groupByName ? groupByName(entries) : entries;
    return grouped.sort((x, y) => KIND_ORDER[x.kind] - KIND_ORDER[y.kind] || x.name.localeCompare(y.name) || x.id.localeCompare(y.id, undefined, { numeric: true }));
}
/**
 * Every section of one source that changed. `skip` leaves ids out per key
 * (techs the research trees already show).
 */
function diffSections(prev, next, source, ctx, skip = new Map()) {
    if (!prev)
        return [];
    const keys = new Set([...Object.keys(prev), ...Object.keys(next)].filter((k) => !notes_sections_js_1.IGNORED_KEYS[source].has(k)));
    const out = [];
    for (const key of keys) {
        const def = (0, notes_sections_js_1.sectionDef)(source, key);
        const a = (def.values ? def.values(prev) : prev[key]);
        const b = (def.values ? def.values(next) : next[key]);
        if (a === undefined || b === undefined)
            continue; // a kind this side doesn't carry: not a change
        let entries;
        if (isIdMap(a) || isIdMap(b)) {
            entries = diffIdMap(def, isIdMap(a) ? a : {}, isIdMap(b) ? b : {}, ctx, skip.get(key));
        }
        else {
            // One object (the Dragon's levels): one "changed" entry when it moved.
            if (JSON.stringify(a) === JSON.stringify(b))
                continue;
            const { changes, more } = valueChanges(def, a, b);
            if (!changes.length)
                continue;
            entries = [{ id: key, kind: 'changed', name: '', changes, ...(more ? { moreChanges: more } : {}) }];
        }
        if (entries.length)
            out.push({ key, source, entries });
    }
    return out.sort((x, y) => (0, notes_sections_js_1.sectionOrder)(x.source, x.key) - (0, notes_sections_js_1.sectionOrder)(y.source, y.key) || x.key.localeCompare(y.key));
}
// ---------------------------------------------------------------------------
// Research trees
// ---------------------------------------------------------------------------
/**
 * `known`: every tech id the previous patch had (its names.json techs). A
 * tree's research the old file didn't list as the tree's — an older
 * tech-trees.json kept no unplaced research — is new only if the old data
 * lacked the tech altogether.
 */
function diffTrees(prev, next, known) {
    if (!prev || !next)
        return [];
    const before = new Map(prev.trees.map((t) => [t.id, t]));
    const after = new Set(next.trees.map((t) => t.id));
    const all = (t) => [...t.nodes, ...(t.unplaced ?? [])];
    const out = [];
    for (const tree of next.trees) {
        const old = before.get(tree.id);
        if (!old) {
            if (all(tree).length)
                out.push({ kind: 'added', tree, newNodes: all(tree).map((n) => n.techId), raised: [] });
            continue;
        }
        const oldNodes = new Map(all(old).map((n) => [n.techId, n]));
        const newNodes = all(tree)
            .filter((n) => !oldNodes.has(n.techId) && !known?.has(String(n.techId)))
            .map((n) => n.techId);
        const raised = all(tree)
            .filter((n) => oldNodes.has(n.techId) && oldNodes.get(n.techId).maxLevel !== n.maxLevel)
            .map((n) => ({ techId: n.techId, was: oldNodes.get(n.techId).maxLevel, now: n.maxLevel }));
        const renamed = old.name !== tree.name;
        if (newNodes.length || raised.length || renamed) {
            out.push({ kind: 'grown', tree, newNodes, raised, ...(renamed ? { was: old.name } : {}) });
        }
    }
    for (const old of prev.trees) {
        if (!after.has(old.id) && all(old).length)
            out.push({ kind: 'removed', tree: old, newNodes: [], raised: [] });
    }
    const order = { added: 0, grown: 1, removed: 2 };
    return out.sort((x, y) => order[x.kind] - order[y.kind] || x.tree.id - y.tree.id);
}
/** Techs the tree notes show, so the Research section doesn't list them twice. */
function techsShownByTrees(trees) {
    const out = new Set();
    for (const t of trees)
        for (const id of t.newNodes)
            out.add(String(id));
    return out;
}
// ---------------------------------------------------------------------------
// Texts
// ---------------------------------------------------------------------------
/** Texts kept per patch (all languages of one key count once). */
exports.MAX_TEXTS = 3000;
const HELP_PREFIX = 'client_config.value.help.windows.';
/** Key segments that only say where a text lives, not what it is about. */
const NAMESPACES = new Set(['client', 'client_config', 'value', 'global_tournament', 'client_info', 'help', 'windows']);
/** Groups of names of many features at once: no single title fits them. */
const MIXED_GROUPS = new Set(['', 'help', 'tech', 'item', 'customization', 'titles', 'equipment', 'artifact', 'captain']);
/** The feature a text is about: its first segment past the namespaces ('' for a one-word key). */
function textGroupKey(key) {
    const segs = key.split('.');
    if (segs.length === 1)
        return '';
    let i = 0;
    while (i < segs.length - 1 && NAMESPACES.has(segs[i]))
        i++;
    return segs[i];
}
/** The key's segments up to and including its group's (where the feature's other texts live). */
function groupPrefix(key) {
    const segs = key.split('.');
    let i = 0;
    while (i < segs.length - 1 && NAMESPACES.has(segs[i]))
        i++;
    return segs.slice(0, i + 1).join('.');
}
/** A title the group's own window shows: short, no placeholders, no markup. */
const usableTitle = (text) => !!text && text.length <= 48 && !/[%<]/.test(text) && text.trim().length > 1;
/**
 * The group's own title: only its window's (`<feature>.title`,
 * `.header.title`, `.window.title`, `.info.title`, `.name`). A title deeper
 * down names one part of it — booster_categories' "Shield of Peace" is one
 * category among many (Nov 26 2026) — so none is better than that.
 */
function findGroupTitle(prefixes, en) {
    for (const suffix of ['header.title', 'window.title', 'info.title', 'title', 'name']) {
        for (const p of prefixes) {
            const k = `${p}.${suffix}`;
            if (usableTitle(en.get(k)))
                return k;
        }
    }
    return undefined;
}
/**
 * A text as compared: its words, not its punctuation, spacing or case — a
 * full stop added ("5 times" → "5 times."), "Lv.%level%" → "Lv. %level%" is
 * no change worth listing.
 */
function normalizeText(s) {
    return s.toLowerCase().replace(/<[^>]*>/g, '').replace(/\\n/g, ' ').replace(/[^\p{L}\p{N}%]+/gu, '');
}
/** What changed between two English catalogues, and which keys each part needs in every language. */
function planTexts(prevEn, nextEn) {
    let added = [...nextEn.keys()].filter((k) => !prevEn.has(k));
    let changed = [...nextEn.keys()].filter((k) => prevEn.has(k) && normalizeText(prevEn.get(k)) !== normalizeText(nextEn.get(k)));
    let removed = [...prevEn.keys()].filter((k) => !nextEn.has(k));
    const total = added.length + changed.length + removed.length;
    let truncated = 0;
    if (total > exports.MAX_TEXTS) {
        // Keep new texts first: they are what a coming feature looks like.
        const keepAdded = Math.min(added.length, exports.MAX_TEXTS);
        const keepChanged = Math.min(changed.length, exports.MAX_TEXTS - keepAdded);
        const keepRemoved = Math.min(removed.length, exports.MAX_TEXTS - keepAdded - keepChanged);
        added = added.sort().slice(0, keepAdded);
        changed = changed.sort().slice(0, keepChanged);
        removed = removed.sort().slice(0, keepRemoved);
        truncated = total - exports.MAX_TEXTS;
    }
    // Help windows with new texts become guides; a window that only gained its
    // title (a Battle Pass captain's name) stays a plain text.
    const byWindow = new Map();
    for (const k of added) {
        if (!k.startsWith(HELP_PREFIX))
            continue;
        const win = k.slice(HELP_PREFIX.length).split('.')[0];
        if (!win)
            continue;
        if (!byWindow.has(win))
            byWindow.set(win, []);
        byWindow.get(win).push(k);
    }
    const guides = new Map();
    const guideTitles = new Map();
    for (const [win, keys] of byWindow) {
        if (!keys.some((k) => !/\.title$/.test(k)))
            continue;
        guides.set(win, keys.sort());
        const titleKey = `${HELP_PREFIX}${win}.title`;
        if (nextEn.has(titleKey))
            guideTitles.set(win, titleKey);
        for (const k of keys) {
            const part = k.slice(HELP_PREFIX.length + win.length + 1).split('.').slice(0, -1).join('.');
            if (!part)
                continue;
            const partTitle = `${HELP_PREFIX}${win}.${part}.title`;
            if (nextEn.has(partTitle))
                guideTitles.set(`${win}.${part}`, partTitle);
        }
    }
    const inGuide = new Set([...guides.values()].flat());
    const groups = new Map();
    const prefixes = new Map();
    const put = (k, list) => {
        // A help window that isn't a guide (it only gained its title): the help windows' group.
        const g = k.startsWith(HELP_PREFIX) ? 'help' : textGroupKey(k);
        if (!groups.has(g))
            groups.set(g, { added: [], changed: [], removed: [] });
        groups.get(g)[list].push(k);
        if (!prefixes.has(g))
            prefixes.set(g, new Set());
        prefixes.get(g).add(groupPrefix(k));
    };
    for (const k of added)
        if (!inGuide.has(k))
            put(k, 'added');
    for (const k of changed)
        put(k, 'changed');
    for (const k of removed)
        put(k, 'removed');
    for (const [g, entry] of groups) {
        if (MIXED_GROUPS.has(g))
            continue;
        const titleKey = findGroupTitle(prefixes.get(g) ?? new Set(), nextEn);
        if (titleKey)
            entry.titleKey = titleKey;
    }
    return { added, changed, removed, truncated, guides, guideTitles, groups };
}
/** The keys to read in every language: from the new catalogue, and from the old (for what a changed text said). */
function planKeys(plan) {
    const next = new Set([...plan.added, ...plan.changed, ...plan.guideTitles.values()]);
    for (const g of plan.groups.values())
        if (g.titleKey)
            next.add(g.titleKey);
    return { next, prev: new Set(plan.changed) };
}
function textsOf(key, maps) {
    const out = {};
    for (const lang of exports.NOTE_LANGS) {
        const v = maps.get(lang)?.get(key);
        if (v !== undefined && v !== '')
            out[lang] = v;
    }
    return out;
}
/** The plan's keys as texts in every language read. `next`/`prev` hold 'en' (whole) and the others (planKeys). */
function assembleTexts(plan, next, prev) {
    const guides = [];
    for (const [win, keys] of plan.guides) {
        const parts = new Map();
        for (const k of keys) {
            const rest = k.slice(HELP_PREFIX.length + win.length + 1).split('.');
            const last = rest[rest.length - 1];
            const part = rest.slice(0, -1).join('.');
            if (!part && last === 'title')
                continue; // the guide's own title
            if (!parts.has(part)) {
                const titleKey = plan.guideTitles.get(`${win}.${part}`);
                parts.set(part, { ...(titleKey ? { title: textsOf(titleKey, next) } : {}), texts: [] });
            }
            if (last === 'title')
                continue;
            parts.get(part).texts.push(textsOf(k, next));
        }
        const titleKey = plan.guideTitles.get(win);
        const list = [...parts.entries()]
            .sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b, undefined, { numeric: true })))
            .map(([, p]) => p)
            .filter((p) => p.texts.length);
        if (list.length)
            guides.push({ key: win, ...(titleKey ? { title: textsOf(titleKey, next) } : {}), parts: list });
    }
    guides.sort((a, b) => b.parts.reduce((n, p) => n + p.texts.length, 0) - a.parts.reduce((n, p) => n + p.texts.length, 0) || a.key.localeCompare(b.key));
    const texts = [];
    for (const [key, g] of plan.groups) {
        texts.push({
            key,
            ...(g.titleKey ? { title: textsOf(g.titleKey, next) } : {}),
            added: g.added.sort().map((k) => ({ key: k, text: textsOf(k, next) })),
            changed: g.changed.sort().map((k) => ({ key: k, text: textsOf(k, next), was: textsOf(k, prev) })),
            removed: g.removed.sort().map((k) => ({ key: k, text: textsOf(k, prev) })),
        });
    }
    // Groups with the most new texts first: that's where a feature is arriving.
    texts.sort((a, b) => b.added.length - a.added.length || (b.changed.length + b.removed.length) - (a.changed.length + a.removed.length) || a.key.localeCompare(b.key));
    return { guides, texts };
}
// ---------------------------------------------------------------------------
// Art
// ---------------------------------------------------------------------------
/** The picture an address is a variant of: sizes, icon/shard/animation suffixes and the walk cycle stripped. */
function artStem(name) {
    let s = name.toLowerCase();
    for (let i = 0; i < 4; i++) {
        const before = s;
        s = s
            .replace(/^anim_/, '')
            .replace(/^icon_/, '')
            .replace(/_spine$/, '')
            .replace(/_\d{2,4}x\d{2,4}(?:_[a-z])?$/, '')
            .replace(/_(?:22|28|32|36|42|44|48|50|56|62|64|72|80|96|128|144)$/, '')
            .replace(/_(?:hero|unit)(?:_(?:attack|down|left|left_down|left_up|up|right))?$/, '')
            .replace(/_shard_icon(?:_\d)?$/, '')
            .replace(/_icon(?:_\d)?$/, '')
            .replace(/_shard$/, '')
            .replace(/_anim$/, '');
        if (s === before)
            break;
    }
    return s || name.toLowerCase();
}
/**
 * Pictures the catalogue added, grouped by stem. Pictures a section entry
 * already shows (`claimed`, and anything sharing a stem with one) are left
 * out: the gallery is for what no entry explains.
 */
function diffArtNames(prev, next, claimed) {
    if (!prev)
        return [];
    const before = new Set(prev);
    const claimedStems = new Set([...claimed].map(artStem));
    const groups = new Map();
    for (const n of next) {
        if (!n || before.has(n) || claimed.has(n))
            continue;
        const stem = artStem(n);
        if (claimedStems.has(stem))
            continue;
        if (!groups.has(stem))
            groups.set(stem, []);
        groups.get(stem).push(n);
    }
    return [...groups.entries()]
        .map(([stem, names]) => ({ stem, names: names.sort() }))
        .sort((a, b) => a.stem.localeCompare(b.stem));
}
/** Every picture name the sections and trees use (for diffArtNames' `claimed`). */
function claimedArt(sections, trees, safe) {
    const out = new Set();
    for (const s of sections) {
        for (const e of s.entries) {
            for (const n of [...(e.icon ?? []), ...(e.art ?? [])])
                out.add(n);
        }
    }
    for (const t of trees) {
        if (t.tree.icon)
            out.add(safe(t.tree.icon));
        for (const n of [...t.tree.nodes, ...(t.tree.unplaced ?? [])])
            if (n.icon)
                out.add(safe(n.icon));
    }
    return out;
}
/** Name parts too common to tie a picture to a text. */
const ART_TOKEN_STOP = new Set(['icon', 'icons', 'the', 'of', 'and', 'big', 'small', 'new', 'old', 'back', 'bg']);
const tokensOf = (s) => s.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length > 1 && !ART_TOKEN_STOP.has(x));
/** Texts kept per picture, and past how many matches a stem is too generic to say anything. */
const MAX_ART_TEXTS = 4;
const TOO_MANY_ART_TEXTS = 12;
/**
 * The game's texts about a picture: catalogue keys holding every part of its
 * stem ("clan_city_customization_union_57" → customization.name.union_clan_city_57,
 * customization.description.union_clan_city_57). Names and descriptions first.
 * A stem of fewer than two parts, or one that matches too much, gets nothing.
 */
function artTextKeys(groups, en) {
    const wanted = groups.map((g) => ({ stem: g.stem, tokens: tokensOf(g.stem) })).filter((g) => g.tokens.length >= 2);
    const hits = new Map(wanted.map((g) => [g.stem, []]));
    for (const key of en.keys()) {
        const keyTokens = new Set(tokensOf(key));
        for (const g of wanted) {
            if (g.tokens.every((tk) => keyTokens.has(tk)))
                hits.get(g.stem).push(key);
        }
    }
    const rank = (k) => (/\.(?:full_)?name\b/.test(k) ? 0 : /\.description\b/.test(k) ? 1 : /tooltip/.test(k) ? 2 : 3);
    const out = new Map();
    for (const [stem, keys] of hits) {
        if (!keys.length || keys.length > TOO_MANY_ART_TEXTS)
            continue;
        out.set(stem, keys.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).slice(0, MAX_ART_TEXTS));
    }
    return out;
}
/**
 * The game's names for a picture: any entry of the art static slice (items,
 * captains, units, frames, city looks…) drawn with a picture of the same stem.
 */
function artNamesByStem(slice, safe) {
    const out = new Map();
    const add = (pic, name) => {
        if (typeof pic !== 'string' || !pic || typeof name !== 'string' || !name.trim())
            return;
        const stem = artStem(safe(pic));
        if (!out.has(stem))
            out.set(stem, new Set());
        out.get(stem).add(name.trim());
    };
    for (const section of Object.values(slice ?? {})) {
        const rows = Array.isArray(section) ? section : section && typeof section === 'object' ? Object.values(section) : [];
        for (const row of rows) {
            if (!row || typeof row !== 'object')
                continue;
            const r = row;
            for (const k of ['icon', 'visual', 'art'])
                add(r[k], r.name);
            if (r.icons && typeof r.icons === 'object')
                for (const pic of Object.values(r.icons))
                    add(pic, r.name);
        }
    }
    return new Map([...out].map(([k, v]) => [k, [...v]]));
}
const HIGHLIGHT_SECTIONS = ['events', 'captains', 'artifacts', 'heroes'];
function summarizeNotes(n) {
    const counts = {};
    const trees = n.trees.filter((t) => t.kind !== 'removed').length;
    if (trees)
        counts.trees = trees;
    for (const s of n.sections) {
        const c = s.entries.filter((e) => e.kind !== 'removed').length;
        if (c)
            counts[s.key] = c;
    }
    if (n.guides.length)
        counts.guides = n.guides.length;
    const added = n.texts.reduce((sum, g) => sum + g.added.length, 0) + n.guides.reduce((sum, g) => sum + g.parts.reduce((x, p) => x + p.texts.length, 0), 0);
    if (added)
        counts.texts = added;
    if (n.images.length)
        counts.images = n.images.length;
    const highlights = [];
    for (const t of n.trees)
        if (t.kind === 'added')
            highlights.push({ section: 'trees', name: t.tree.name });
    for (const key of HIGHLIGHT_SECTIONS) {
        const s = n.sections.find((x) => x.key === key);
        for (const e of s?.entries ?? []) {
            if ((e.kind === 'added' || e.kind === 'revealed') && e.name && !e.unnamed)
                highlights.push({ section: key, name: e.name });
        }
    }
    return { id: n.id, date: n.date, counts, highlights: highlights.slice(0, 8) };
}
//# sourceMappingURL=notes-diff.js.map