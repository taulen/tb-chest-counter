"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.NOTES_WARNING_KEY = exports.MAX_PATCHES = void 0;
exports.notesDir = notesDir;
exports.readNotesIndex = readNotesIndex;
exports.readPatchNotes = readPatchNotes;
exports.buildPatchNotes = buildPatchNotes;
exports.notePatch = notePatch;
exports.notePatchSafely = notePatchSafely;
exports.resetPatchNotesMemo = resetPatchNotesMemo;
exports.patchList = patchList;
exports.patchNotesView = patchNotesView;
/**
 * Patch notes: what each game patch added, revealed, renamed and changed, for
 * Tools → What's new (every member) — read from the game's own files the
 * moment the patch is read (watch.ts runs `notePatchSafely` after the readers).
 *
 * A patch is a move of the names version (static data + translations: the
 * data, the trees, the texts) and/or the art catalogue (the pictures) since
 * the last one noted. The diffs are notes-diff.ts; what a kind of data is
 * called and pictured is notes-sections.ts. An art move within
 * AMEND_WINDOW_MS of a noted patch amends it (the art reader often lands a
 * few minutes after the data); later it is a patch of its own.
 *
 * Kept in data/game-patch-notes/ (GAME_PATCH_NOTES_DIR overrides it):
 * index.json (what was noted last, a summary per patch) and <id>.json per
 * patch — history, the newest MAX_PATCHES. The first run on a volume notes
 * the newest patch against the one before it on disk, if any.
 *
 * The texts are read from the CDN for both catalogues (it keeps old ones), in
 * English whole and the four other site languages for the keys that changed.
 * When it no longer has the old one, the notes go without texts (textsError).
 * See docs/game-patches.md → "What's new".
 */
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const logger_js_1 = require("../utils/logger.js");
const log_buffer_js_1 = require("../utils/log-buffer.js");
const selection_js_1 = require("../game-art/selection.js");
const status_js_1 = require("./status.js");
const notes_diff_js_1 = require("./notes-diff.js");
const notes_sections_js_1 = require("./notes-sections.js");
const log = (0, logger_js_1.childLogger)('game-patch');
exports.MAX_PATCHES = 60;
const AMEND_WINDOW_MS = 48 * 3600_000;
const RETRY_MS = 30 * 60_000;
const ID_RE = /^[a-z0-9-]{1,64}$/;
const VERSION_DIR_RE = /^[0-9a-z-]{8,80}$/i;
exports.NOTES_WARNING_KEY = 'game-patch:notes';
function notesDir() {
    return process.env.GAME_PATCH_NOTES_DIR ? path_1.default.resolve(process.env.GAME_PATCH_NOTES_DIR) : path_1.default.resolve('data', 'game-patch-notes');
}
function defaultStaticDir() {
    return process.env.GAME_STATIC_DIR ? path_1.default.resolve(process.env.GAME_STATIC_DIR) : path_1.default.resolve('data', 'game-static');
}
function defaultArtDir() {
    return process.env.GAME_ART_DIR ? path_1.default.resolve(process.env.GAME_ART_DIR) : path_1.default.resolve('data', 'game-art');
}
function readJson(file) {
    try {
        return JSON.parse(fs_1.default.readFileSync(file, 'utf8'));
    }
    catch {
        return null;
    }
}
function writeJsonAtomic(file, value) {
    fs_1.default.mkdirSync(path_1.default.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs_1.default.writeFileSync(tmp, JSON.stringify(value));
    fs_1.default.renameSync(tmp, file);
}
function readNotesIndex(dir = notesDir()) {
    const idx = readJson(path_1.default.join(dir, 'index.json'));
    return idx && Array.isArray(idx.patches) ? idx : null;
}
function readPatchNotes(id, dir = notesDir()) {
    if (!ID_RE.test(id))
        return null;
    const notes = readJson(path_1.default.join(dir, `${id}.json`));
    return notes && notes.id === id ? notes : null;
}
/** The versions the readers read their live patch from; null where one serves an older patch or none. */
function currentVersions() {
    const s = (0, status_js_1.readPatchStatus)();
    const read = (r) => {
        const st = s.readers[r];
        return st?.ok && st.served && st.served === st.live ? st.served : null;
    };
    return { names: read('names'), art: read('art') };
}
/** names.json's builtAt without parsing its 2 MB. */
function builtAtOf(file) {
    try {
        const fd = fs_1.default.openSync(file, 'r');
        try {
            const buf = Buffer.alloc(300);
            const n = fs_1.default.readSync(fd, buf, 0, buf.length, 0);
            return /"builtAt":"([^"]+)"/.exec(buf.subarray(0, n).toString('utf8'))?.[1] ?? null;
        }
        finally {
            fs_1.default.closeSync(fd);
        }
    }
    catch {
        return null;
    }
}
/** The names version on disk read just before `current` (the first run's "from"). */
function previousNamesOnDisk(dir, current) {
    const mine = builtAtOf(path_1.default.join(dir, current, 'names.json'));
    let best = null;
    let entries = [];
    try {
        entries = fs_1.default.readdirSync(dir);
    }
    catch {
        return null;
    }
    for (const key of entries) {
        if (key === current || !VERSION_DIR_RE.test(key))
            continue;
        const at = builtAtOf(path_1.default.join(dir, key, 'names.json'));
        if (!at || (mine && at >= mine))
            continue;
        if (!best || at > best.at)
            best = { key, at };
    }
    return best?.key ?? null;
}
/** The art catalogue served before `current` (the art store's state). */
function previousArtOnDisk(dir, current) {
    const st = readJson(path_1.default.join(dir, 'state.json'));
    if (!st)
        return null;
    if (st.current === current)
        return st.previous ?? null;
    return st.current ?? null;
}
function readLines(file) {
    try {
        const lines = fs_1.default.readFileSync(file, 'utf8').split('\n').filter(Boolean);
        return lines.length > 1 ? lines : null;
    }
    catch {
        return null;
    }
}
async function defaultFetchTexts(catalog, lang, keep) {
    const { fetchCatalogTexts } = await import('../game-protocol/static-data.js');
    return fetchCatalogTexts(catalog, lang, keep);
}
async function defaultCatalogOf(key) {
    const { catalogOfNamesKey } = await import('../game-protocol/static-data.js');
    return catalogOfNamesKey(key);
}
/** The art index's mappings and the static slice's icons, for picture names. */
function sectionCtx(artDir, artVersion, artStatic) {
    const index = artVersion ? readJson(path_1.default.join(artDir, artVersion, 'index.json')) : null;
    const itemIcons = new Map();
    for (const it of artStatic?.items ?? []) {
        if (it?.icon && !itemIcons.has(String(it.id)))
            itemIcons.set(String(it.id), (0, selection_js_1.safeArtName)(it.icon));
    }
    const techIcons = new Map();
    for (const [id, t] of Object.entries(artStatic?.techs ?? {})) {
        if (t?.icon)
            techIcons.set(id, (0, selection_js_1.safeArtName)(t.icon));
    }
    return { mappings: index?.mappings ?? {}, itemIcons, techIcons };
}
/**
 * The texts part: what changed between two catalogues (when they differ), and
 * the game's texts about each new picture (`images`, filled in place) from
 * the newer one — an art-only patch passes the current names key twice.
 */
async function readTexts(from, to, deps, images) {
    const [a, b] = await Promise.all([deps.catalogOf(from), deps.catalogOf(to)]);
    if (!b)
        return { guides: [], texts: [] };
    const compare = !!a && a !== b;
    if (!compare && !images.length)
        return { guides: [], texts: [] };
    try {
        const [prevEn, nextEn] = await Promise.all([compare ? deps.fetchTexts(a, 'en') : null, deps.fetchTexts(b, 'en')]);
        const plan = prevEn ? (0, notes_diff_js_1.planTexts)(prevEn, nextEn) : null;
        const keys = plan ? (0, notes_diff_js_1.planKeys)(plan) : { next: new Set(), prev: new Set() };
        const about = (0, notes_diff_js_1.artTextKeys)(images, nextEn);
        for (const list of about.values())
            for (const k of list)
                keys.next.add(k);
        const next = new Map([['en', nextEn]]);
        const prev = new Map(prevEn ? [['en', prevEn]] : []);
        for (const lang of notes_diff_js_1.NOTE_LANGS) {
            if (lang === 'en')
                continue;
            // A language that can't be read shows English: never the whole note lost.
            const [n, p] = await Promise.all([
                keys.next.size ? deps.fetchTexts(b, lang, keys.next).catch(() => null) : null,
                compare && keys.prev.size ? deps.fetchTexts(a, lang, keys.prev).catch(() => null) : null,
            ]);
            if (n)
                next.set(lang, n);
            if (p)
                prev.set(lang, p);
        }
        for (const g of images) {
            const list = about.get(g.stem);
            if (list)
                g.about = { ...g.about, texts: list.map((k) => (0, notes_diff_js_1.textsOf)(k, next)) };
        }
        if (!plan)
            return { guides: [], texts: [] };
        const { guides, texts } = (0, notes_diff_js_1.assembleTexts)(plan, next, prev);
        return { guides, texts, ...(plan.truncated ? { textsTruncated: plan.truncated } : {}) };
    }
    catch (err) {
        return compare ? { guides: [], texts: [], textsError: err instanceof Error ? err.message : String(err) } : { guides: [], texts: [] };
    }
}
async function buildPatchNotes(input, deps = {}) {
    const staticDir = deps.staticDir ?? defaultStaticDir();
    const artDir = deps.artDir ?? defaultArtDir();
    const n = input.names;
    const json = (dir, ...p) => readJson(path_1.default.join(dir, ...p));
    const prevNames = n ? json(staticDir, n.from, 'names.json') : null;
    const nextNames = n ? json(staticDir, n.to, 'names.json') : null;
    const prevStatic = n ? json(artDir, `static-${n.from}.json`) : null;
    const nextStatic = n ? json(artDir, `static-${n.to}.json`) : null;
    const prevTrees = n ? readJson(path_1.default.join(staticDir, n.from, 'tech-trees.json')) : null;
    const nextTrees = n ? readJson(path_1.default.join(staticDir, n.to, 'tech-trees.json')) : null;
    if (n && !nextNames)
        throw new Error(`no names.json for ${n.to}`);
    const artVersion = input.art?.to ?? readJson(path_1.default.join(artDir, 'state.json'))?.current ?? null;
    const ctx = sectionCtx(artDir, artVersion, nextStatic);
    const trees = (0, notes_diff_js_1.diffTrees)(prevTrees, nextTrees, prevNames?.techs ? new Set(Object.keys(prevNames.techs)) : undefined);
    const sections = [
        ...(nextNames ? (0, notes_diff_js_1.diffSections)(prevNames, nextNames, 'names', ctx, new Map([['techs', (0, notes_diff_js_1.techsShownByTrees)(trees)]])) : []),
        ...(nextStatic ? (0, notes_diff_js_1.diffSections)(prevStatic, nextStatic, 'art', ctx) : []),
    ].sort((x, y) => (0, notes_sections_js_1.sectionOrder)(x.source, x.key) - (0, notes_sections_js_1.sectionOrder)(y.source, y.key) || x.key.localeCompare(y.key));
    const images = input.art
        ? (0, notes_diff_js_1.diffArtNames)(readLines(path_1.default.join(artDir, input.art.from, 'catalog-names.txt')), readLines(path_1.default.join(artDir, input.art.to, 'catalog-names.txt')) ?? [], (0, notes_diff_js_1.claimedArt)(sections, trees, selection_js_1.safeArtName))
        : [];
    // What the game's data calls each new picture (an item, a city look…).
    const textsKey = n?.to ?? input.textsKey ?? null;
    const slice = nextStatic ?? (textsKey ? json(artDir, `static-${textsKey}.json`) : null);
    const namesByStem = (0, notes_diff_js_1.artNamesByStem)(slice, selection_js_1.safeArtName);
    for (const g of images) {
        const named = namesByStem.get(g.stem);
        if (named?.length)
            g.about = { names: named.slice(0, 4) };
    }
    const texts = textsKey
        ? await readTexts(n?.from ?? textsKey, textsKey, {
            fetchTexts: deps.fetchTexts ?? defaultFetchTexts,
            catalogOf: deps.catalogOf ?? defaultCatalogOf,
        }, images)
        : { guides: [], texts: [] };
    return {
        format: notes_diff_js_1.PATCH_NOTES_FORMAT,
        id: input.id,
        date: input.date,
        names: input.names,
        art: input.art,
        sections,
        trees,
        ...texts,
        images,
    };
}
function patchId(date, version) {
    return `${date.slice(0, 10)}-${version.replace(/[^0-9a-z]/gi, '').slice(0, 8)}`.toLowerCase();
}
function isEmpty(n) {
    return !n.sections.length && !n.trees.length && !n.guides.length && !n.texts.length && !n.images.length;
}
/** A renamed chest whose old name the site stores: its records need folding (docs/chest-identity.md). */
function warnStoredRenames(notes, deps) {
    const renamed = notes.sections.find((s) => s.key === 'gifts')?.entries.filter((e) => e.kind === 'renamed' && e.was) ?? [];
    if (!renamed.length || !deps.storedChests)
        return;
    let stored;
    try {
        stored = deps.storedChests(renamed.map((e) => e.was));
    }
    catch {
        return;
    }
    for (const e of renamed) {
        const count = stored.get(e.was) ?? 0;
        if (!count)
            continue;
        log.warn(`Game patch renamed the chest "${e.was}" to "${e.name}"; ${count} record(s) are stored under "${e.was}". ` +
            'New ones arrive under the new name: fold the old row with a migration (docs/chest-identity.md).');
    }
}
/**
 * Note the patch the readers just read, if it is new. Returns what it did;
 * throws when the notes could not be built (notePatchSafely reports it).
 */
async function notePatch(deps = {}) {
    const dir = deps.notesDir ?? notesDir();
    const staticDir = deps.staticDir ?? defaultStaticDir();
    const artDir = deps.artDir ?? defaultArtDir();
    const now = (deps.now ?? (() => new Date()))();
    const cur = deps.current ?? currentVersions();
    const idx = readNotesIndex(dir);
    const fromNames = idx ? idx.names : cur.names ? previousNamesOnDisk(staticDir, cur.names) : null;
    const fromArt = idx ? idx.art : cur.art ? previousArtOnDisk(artDir, cur.art) : null;
    const namesMoved = !!cur.names && !!fromNames && cur.names !== fromNames;
    const artMoved = !!cur.art && !!fromArt && cur.art !== fromArt;
    const base = idx ?? { format: notes_diff_js_1.PATCH_NOTES_FORMAT, names: null, art: null, patches: [] };
    const remember = (patches) => {
        writeJsonAtomic(path_1.default.join(dir, 'index.json'), {
            ...base,
            names: cur.names ?? base.names,
            art: cur.art ?? base.art,
            patches,
        });
    };
    if (!namesMoved && !artMoved) {
        // Nothing to compare against yet (a fresh volume): start from here.
        if (!idx || (cur.names && !idx.names) || (cur.art && !idx.art)) {
            remember(base.patches);
            return { status: 'baseline' };
        }
        return { status: 'unchanged' };
    }
    // The art landing after the data of the same patch: amend that patch.
    const latest = base.patches[0];
    const latestNotes = latest ? readPatchNotes(latest.id, dir) : null;
    if (!namesMoved && artMoved && latestNotes && now.getTime() - Date.parse(latestNotes.date) < AMEND_WINDOW_MS) {
        const notes = await buildPatchNotes({
            id: latestNotes.id,
            date: latestNotes.date,
            names: latestNotes.names,
            art: { from: latestNotes.art?.from ?? fromArt, to: cur.art },
            textsKey: cur.names ?? base.names,
        }, { ...deps, staticDir, artDir });
        writeJsonAtomic(path_1.default.join(dir, `${notes.id}.json`), notes);
        remember([(0, notes_diff_js_1.summarizeNotes)(notes), ...base.patches.slice(1)]);
        log.info(`Game patch notes ${notes.id}: amended with the art catalogue ${cur.art}.`);
        return { status: 'amended', id: notes.id };
    }
    const date = namesMoved ? (builtAtOf(path_1.default.join(staticDir, cur.names, 'names.json')) ?? now.toISOString()) : now.toISOString();
    // On a fresh volume the newest patch was read a while ago: date it by when it was.
    const when = idx ? now.toISOString() : date;
    let id = patchId(when, (namesMoved ? cur.names : cur.art) ?? 'patch');
    if (base.patches.some((p) => p.id === id))
        id = `${id}-${base.patches.length}`;
    const notes = await buildPatchNotes({
        id,
        date: when,
        names: namesMoved ? { from: fromNames, to: cur.names } : null,
        art: artMoved ? { from: fromArt, to: cur.art } : null,
        textsKey: cur.names ?? base.names,
    }, { ...deps, staticDir, artDir });
    if (isEmpty(notes)) {
        remember(base.patches);
        log.info(`Game patch ${id}: nothing new to show (the version moved, the content didn't).`);
        return { status: 'unchanged' };
    }
    writeJsonAtomic(path_1.default.join(dir, `${notes.id}.json`), notes);
    const patches = [(0, notes_diff_js_1.summarizeNotes)(notes), ...base.patches];
    for (const old of patches.splice(exports.MAX_PATCHES)) {
        try {
            fs_1.default.rmSync(path_1.default.join(dir, `${old.id}.json`), { force: true });
        }
        catch {
            // a file that won't go stays; the index no longer lists it
        }
    }
    remember(patches);
    warnStoredRenames(notes, deps);
    const s = (0, notes_diff_js_1.summarizeNotes)(notes);
    log.info(`Game patch notes ${notes.id}: ${Object.entries(s.counts).map(([k, v]) => `${v} ${k}`).join(', ')}` +
        (s.highlights.length ? ` — ${s.highlights.map((h) => h.name).join(', ')}` : '') +
        (notes.textsError ? ` (texts: ${notes.textsError})` : ''));
    return { status: 'noted', id: notes.id };
}
let failed = null;
/**
 * notePatch for the watcher: never throws; a failure is one alerting warning
 * (cleared when notes next build) and a retry after RETRY_MS, or at once with `force`.
 */
async function notePatchSafely(opts = {}) {
    if (failed && !opts.force && Date.now() - failed.at < RETRY_MS)
        return null;
    try {
        // Imported lazily: the watcher's module graph stays free of the database.
        const { getDb } = await import('../data/database.js');
        // The chest names the site stores, with their record counts.
        const storedChests = (names) => {
            if (!names.length)
                return new Map();
            const rows = getDb().prepare(`SELECT c.name AS name, COUNT(r.id) AS n FROM chests c JOIN chest_records r ON r.chest_id = c.id
         WHERE c.name IN (${names.map(() => '?').join(',')}) GROUP BY c.name`).all(...names);
            return new Map(rows.map((r) => [r.name, r.n]));
        };
        const result = await notePatch({ storedChests });
        if (failed)
            (0, log_buffer_js_1.resolveEntries)(exports.NOTES_WARNING_KEY);
        failed = null;
        return result;
    }
    catch (err) {
        const first = !failed;
        failed = { at: Date.now() };
        if (first) {
            log.warn({ resolveKey: exports.NOTES_WARNING_KEY }, `Game patch notes (Tools → What's new) couldn't be built: ${err instanceof Error ? err.message : String(err)}. ` +
                'Retried every 30 minutes; docs/game-patches.md.');
        }
        return null;
    }
}
/** Test seam. */
function resetPatchNotesMemo() {
    failed = null;
    viewMemo.clear();
}
/** URL of a picture the current art has; quiet about holes (these names are guesses, not requests). */
function artUrl(index, name) {
    if (!index || !name)
        return null;
    const img = index.images[name];
    return img ? `/game-art/${index.version}/${img.file}` : null;
}
const firstUrl = (index, names) => {
    for (const n of names ?? []) {
        const u = artUrl(index, n);
        if (u)
            return u;
    }
    return null;
};
function pickLang(t, lang) {
    if (!t)
        return undefined;
    const out = {};
    if (t.en !== undefined)
        out.en = t.en;
    if (lang !== 'en' && t[lang] !== undefined)
        out[lang] = t[lang];
    return out;
}
const viewMemo = new Map();
/** Every patch noted, newest first. */
function patchList(dir = notesDir()) {
    return readNotesIndex(dir)?.patches ?? [];
}
/**
 * One patch's notes as the page reads them: each picture name resolved to the
 * current art's URL (or dropped), texts cut to English + `lang`.
 */
function patchNotesView(id, lang, art, dir = notesDir()) {
    const key = `${dir}|${id}|${lang}|${art?.version ?? ''}`;
    if (viewMemo.has(key))
        return viewMemo.get(key);
    const n = readPatchNotes(id, dir);
    if (!n)
        return null;
    const techIcons = (art?.mappings?.techs ?? {});
    const nodeIcon = (node) => ({
        ...node,
        iconUrl: artUrl(art, techIcons[String(node.techId)] ?? (node.icon ? (0, selection_js_1.safeArtName)(node.icon) : undefined)),
    });
    const view = {
        id: n.id,
        date: n.date,
        sections: n.sections.map((s) => ({
            key: s.key,
            source: s.source,
            entries: s.entries.map(({ icon, art: big, layers, ...e }) => ({
                ...e,
                iconUrl: firstUrl(art, icon),
                artUrl: firstUrl(art, big),
                backUrl: artUrl(art, layers?.back),
                frameUrl: artUrl(art, layers?.frame),
            })),
        })),
        trees: n.trees.map((t) => ({
            ...t,
            tree: {
                ...t.tree,
                iconUrl: t.tree.icon ? artUrl(art, (0, selection_js_1.safeArtName)(t.tree.icon)) : null,
                nodes: t.tree.nodes.map(nodeIcon),
                unplaced: (t.tree.unplaced ?? []).map(nodeIcon),
            },
        })),
        guides: n.guides.map((g) => ({
            key: g.key,
            title: pickLang(g.title, lang),
            parts: g.parts.map((p) => ({ title: pickLang(p.title, lang), texts: p.texts.map((x) => pickLang(x, lang)) })),
        })),
        texts: n.texts.map((g) => ({
            key: g.key,
            title: pickLang(g.title, lang),
            added: g.added.map((x) => ({ key: x.key, text: pickLang(x.text, lang) })),
            changed: g.changed.map((x) => ({ key: x.key, text: pickLang(x.text, lang), was: pickLang(x.was, lang) })),
            removed: g.removed.map((x) => ({ key: x.key, text: pickLang(x.text, lang) })),
        })),
        textsTruncated: n.textsTruncated ?? 0,
        textsUnavailable: !!n.textsError,
        images: n.images
            .map((g) => {
            const pics = g.names
                .map((name) => ({ name, img: art?.images[name] }))
                .filter((p) => !!p.img)
                .sort((a, b) => b.img.w * b.img.h - a.img.w * a.img.h)
                .slice(0, 4)
                .map((p) => ({ name: p.name, url: `/game-art/${art.version}/${p.img.file}`, w: p.img.w, h: p.img.h }));
            const about = g.about
                ? { names: g.about.names ?? [], texts: (g.about.texts ?? []).map((x) => pickLang(x, lang)) }
                : null;
            return { stem: g.stem, names: g.names, pictures: pics, about };
        }),
    };
    viewMemo.set(key, view);
    if (viewMemo.size > 50)
        viewMemo.delete(viewMemo.keys().next().value);
    return view;
}
//# sourceMappingURL=notes.js.map