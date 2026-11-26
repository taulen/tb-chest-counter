"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TREES_FORMAT = exports.TABLE_BUILDINGS = exports.TABLE_FACTORY = exports.TABLE_CLIENT_CONFIG = void 0;
exports.readBranches = readBranches;
exports.buildTechTrees = buildTechTrees;
exports.buildTechLevels = buildTechLevels;
exports.asTreeLayout = asTreeLayout;
exports.layoutFromBundle = layoutFromBundle;
exports.readAnyTables = readAnyTables;
exports.clearTechTreesRetry = clearTechTreesRetry;
exports.loadTechTrees = loadTechTrees;
exports.cachedTechTrees = cachedTechTrees;
exports.loadTechLevels = loadTechLevels;
exports.resetTechTreesMemo = resetTechTreesMemo;
/**
 * Research and hero-talent TREES — what a page needs to draw every player's
 * levels the way the game's Academy does: trees, their nodes (name, icon, max
 * level), where each node sits and which nodes unlock it.
 *
 * Three public sources, all from the game's own CDN:
 *
 *   static data (see static-data.ts)
 *     T21 techs   f1 name vector · f2 description vector · f3 icon sprite ·
 *                 f4 branch (tree) id · f5 levels {n: [n, …, [conditionRef], …]}
 *                 Each level's condition string gates buying that level:
 *                 "HasTech(1223,10,10)&&HasBuildingLevel(1,25,1)" — HasTech(id,
 *                 minLevel, _) on ANOTHER tech is a prerequisite (the third
 *                 argument varies by tree and isn't needed); on the tech itself
 *                 it's just "own previous level".
 *     T1  client config (client-config.ts): which trees exist, their Academy
 *         tabs ("Unlock" / "Boost") and order, the hero's talent trees
 *   Unity client assets (the art pipeline's reader, src/game-art: catalog,
 *   UnityFS + LZ4, SerializedFile type trees)
 *     a JSON TextAsset per tree, named after the branch's `tree` ("guardTree"
 *     → asset "guardtree"): {name, techs: [{id, x, y, linkType, …}]}. x grows
 *     to the right in steps of 390, y runs 0 → −330 downward in steps of 165
 *     (three rows, with half-steps between). linkType/linkPlace only pick the
 *     connector sprite; the real edges are the HasTech prerequisites.
 *
 * Gem combining is not a tree of its own: "Combining gems I–IV" are nodes of
 * the Blacksmithing research tree.
 *
 * The result is a small tech-trees.json cached next to names.json under
 * data/game-static/<static version>/, rebuilt when the static data, the
 * translations or the client's asset catalog change.
 */
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const codec_js_1 = require("./codec.js");
const static_data_js_1 = require("./static-data.js");
const client_config_js_1 = require("./client-config.js");
Object.defineProperty(exports, "TABLE_CLIENT_CONFIG", { enumerable: true, get: function () { return client_config_js_1.TABLE_CLIENT_CONFIG; } });
const catalog_js_1 = require("../game-art/catalog.js");
const extract_js_1 = require("../game-art/extract.js");
const logger_js_1 = require("../utils/logger.js");
const status_js_1 = require("../game-patch/status.js");
const log = (0, logger_js_1.childLogger)('tech-trees');
const VERSIONS_URL = 'https://versions.totalbattle.com/config/?branch=current&simple=true';
const STATIC_BASE = 'https://assets-client-static.totalbattle.dev/';
const TRANSLATIONS_BASE = 'https://assets-translations.totalbattle.dev//';
const STATIC_BRANCH = 'production';
const UNITY_PLATFORM = 'webgl';
const ENGLISH = 'csv_en_US';
const FETCH_TIMEOUT_MS = 120_000;
/**
 * T12 Factory (FactoryPosStatic): what a research level costs and how long it
 * takes, keyed by the level's factoryPosId. T14 Buildings: the names of the
 * buildings a level asks for (f3 name vector). T8 Items: what a level is paid
 * in — its name (f3) and the game's own description of it (f4: "Skylands
 * Points: Earned by collecting Campaign Chest rewards").
 * See docs/game-protocol.md → "Research levels, costs and units".
 */
exports.TABLE_FACTORY = 12;
exports.TABLE_BUILDINGS = 14;
const TABLE_ITEMS = 8;
const NEEDED_TABLES = [client_config_js_1.TABLE_CLIENT_CONFIG, static_data_js_1.TABLE_TECHS, exports.TABLE_FACTORY, exports.TABLE_BUILDINGS, TABLE_ITEMS];
/** The client's node pitch in layout units: one column, one row. */
const COL_UNIT = 390;
const ROW_UNIT = 165;
/** Bump when the build changes what a cached tech-trees.json holds: an older one is rebuilt once. */
exports.TREES_FORMAT = 4;
// ---------------------------------------------------------------------------
// Pure decoding
// ---------------------------------------------------------------------------
function resolver(src) {
    const { strings, vectors, en } = src;
    const str = (ref) => typeof ref === 'number' && typeof strings[ref] === 'string' ? strings[ref] : undefined;
    const text = (ref) => {
        const k = str(ref);
        return k === undefined ? undefined : (en.get(k) ?? k);
    };
    // Same rule as static-data's names: a vector [templateRef, placeholderRef,
    // valueRef, …]; anything resolving to a JSON fragment isn't text.
    const vecText = (vref) => {
        const v = typeof vref === 'number' ? vectors[vref] : undefined;
        if (!Array.isArray(v) || !v.length)
            return undefined;
        let out = text(v[0]) ?? '';
        for (let i = 1; i + 1 < v.length; i += 2)
            out = out.replace(str(v[i]) ?? '\u0000', str(v[i + 1]) ?? '');
        out = out.replace(/\s+/g, ' ').trim();
        return out && !out.startsWith('{') && !out.startsWith('[') ? out : undefined;
    };
    return { str, text, vecText };
}
const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const numList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'number') : []);
/** Every tree the client config declares, in-game English names resolved. */
function readBranches(src) {
    return (0, client_config_js_1.readBranchDefs)(src.tables.get(client_config_js_1.TABLE_CLIENT_CONFIG), resolver(src).str, src.en);
}
/** Prerequisites on other techs, from each level's condition strings. */
function requirementsOf(techId, levels, str) {
    const seen = new Map();
    const order = Object.keys(levels).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    for (const lv of order) {
        const row = levels[String(lv)];
        const conds = Array.isArray(row) && Array.isArray(row[3]) ? row[3] : [];
        for (const ref of conds) {
            for (const m of (str(ref) ?? '').matchAll(/(!?)HasTech\((\d+),(\d+)/g)) {
                const other = Number(m[2]);
                if (m[1] || other === techId || seen.has(other))
                    continue;
                seen.set(other, { techId: other, level: Number(m[3]), atLevel: lv });
            }
        }
    }
    return [...seen.values()];
}
const half = (v) => Math.round(v * 2) / 2 || 0;
/** Turn the static data + client layouts into drawable trees. Pure; unit-tested. */
function buildTechTrees(version, src, layouts) {
    const { str, text, vecText } = resolver(src);
    const t21 = src.tables.get(static_data_js_1.TABLE_TECHS);
    const techs = isRecord(t21) ? t21 : {};
    const t1 = src.tables.get(client_config_js_1.TABLE_CLIENT_CONFIG);
    const academy = (0, client_config_js_1.clientConfig)(t1, str, 'academy/branches');
    const heroInfo = (0, client_config_js_1.clientConfig)(t1, str, 'hero_info');
    const talentIds = numList(heroInfo?.branches);
    const tabOf = (0, client_config_js_1.academyTabs)(t1, str, src.en);
    const rank = new Map();
    for (const id of [...numList(academy?.order), ...talentIds])
        if (!rank.has(id))
            rank.set(id, rank.size);
    const layoutOf = new Map(layouts.map((l) => [l.name.toLowerCase(), l]));
    const kindOf = (b) => {
        if (b.type === 'heroAbility')
            return talentIds.length === 0 || talentIds.includes(b.id) ? 'talent' : 'other';
        // A tree in an Academy tab is the player's research, whatever its layout is
        // called: the Clan Duel trees ("clanDuelTree27") are researched by each
        // player with Battle Crests, in the Academy's "Clan Duel" tab.
        if (tabOf.has(b.id))
            return 'research';
        if (b.type === 'clanTalents' || /^clan/i.test(b.tree))
            return 'clan';
        return b.type === 'tech' ? 'research' : 'other';
    };
    // Every tech by its branch (T21 f4): what a layout doesn't place is kept too.
    // Retired techs ("(!!!)Irrelevant(!!!)") stay out: they are history, not news.
    const byBranch = new Map();
    for (const [id, row] of Object.entries(techs)) {
        if (!Array.isArray(row) || typeof row[4] !== 'number')
            continue;
        if ((vecText(row[2]) ?? '').includes('(!!!)'))
            continue;
        if (!byBranch.has(row[4]))
            byBranch.set(row[4], []);
        byBranch.get(row[4]).push(id);
    }
    const nodeOf = (id) => {
        const row = techs[String(id)];
        if (!Array.isArray(row))
            return null;
        const levels = isRecord(row[5]) ? row[5] : {};
        const description = vecText(row[2]) ?? '';
        const icon = str(row[3]) ?? '';
        return {
            techId: id,
            name: vecText(row[1]) ?? text(row[1]) ?? `#${id}`,
            // Retired techs carry a placeholder description "(!!!)Irrelevant(!!!)".
            description: description.includes('(!!!)') ? '' : description,
            icon: /^[\w-]+$/.test(icon) ? icon : '',
            maxLevel: Object.keys(levels).length,
            requires: requirementsOf(id, levels, str),
        };
    };
    const trees = [];
    for (const b of readBranches(src)) {
        const layout = layoutOf.get(b.tree.toLowerCase());
        const nodes = [];
        const placed = new Set();
        for (const pos of layout?.techs ?? []) {
            const node = nodeOf(pos.id);
            if (!node)
                continue;
            placed.add(pos.id);
            nodes.push({ ...node, col: half(pos.x / COL_UNIT), row: half(-pos.y / ROW_UNIT) });
        }
        const unplaced = (byBranch.get(b.id) ?? [])
            .map(Number)
            .filter((id) => !placed.has(id))
            .sort((x, y) => x - y)
            .map(nodeOf)
            .filter((n) => !!n && n.maxLevel > 0 && !/^#\d+$/.test(n.name));
        // A tree the client doesn't draw yet but whose research is in the game's
        // data is kept (nodes empty) — the Research pages skip it, What's new shows it.
        if (!nodes.length && !unplaced.length)
            continue;
        trees.push({
            id: b.id,
            name: b.name || layout?.name || '',
            description: b.description,
            kind: kindOf(b),
            tab: tabOf.get(b.id) ?? null,
            icon: b.visual,
            layout: b.tree,
            nodes,
            ...(unplaced.length ? { unplaced } : {}),
        });
    }
    trees.sort((a, b) => (rank.get(a.id) ?? 1e6 + a.id) - (rank.get(b.id) ?? 1e6 + b.id));
    return { version, builtAt: new Date().toISOString(), format: exports.TREES_FORMAT, trees };
}
/**
 * Every level of every research a tree holds (placed or not): cost and time
 * from its T12 Factory row, Might and bonus lines from the T21 level row, the
 * building level its condition asks for. Pure; unit-tested.
 */
function buildTechLevels(version, src, trees) {
    const { str, text, vecText } = resolver(src);
    const t21 = src.tables.get(static_data_js_1.TABLE_TECHS);
    const techs = isRecord(t21) ? t21 : {};
    const t12 = src.tables.get(exports.TABLE_FACTORY);
    const factory = isRecord(t12) ? t12 : {};
    const t14 = src.tables.get(exports.TABLE_BUILDINGS);
    const buildingRows = isRecord(t14) ? t14 : {};
    const num = (v) => (typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : Number(v) || 0);
    const out = {};
    const buildings = {};
    for (const tree of trees) {
        for (const node of [...tree.nodes, ...(tree.unplaced ?? [])]) {
            const row = techs[String(node.techId)];
            const levels = Array.isArray(row) && isRecord(row[5]) ? row[5] : {};
            const list = [];
            for (const key of Object.keys(levels).map(Number).filter(Number.isFinite).sort((a, b) => a - b)) {
                const lv = levels[String(key)];
                if (!Array.isArray(lv))
                    continue;
                // FactoryPosStatic: [id, positionType, price [{item: amount}, {}, n], …, f7 produceTime]
                const pos = factory[String(lv[2])];
                const price = Array.isArray(pos) && Array.isArray(pos[2]) && isRecord(pos[2][0]) ? pos[2][0] : {};
                const cost = {};
                for (const [item, amount] of Object.entries(price))
                    if (num(amount) > 0)
                        cost[item] = num(amount);
                let lines = [];
                try {
                    const props = JSON.parse(str(lv[4]) ?? '{}').props ?? [];
                    lines = props
                        // The Might line ("1_power_22") is `might`.
                        .filter((p) => typeof p.propText === 'string' && p.propText && p.icon !== '1_power_22')
                        .map((p) => [src.en.get(p.propText) ?? p.propText, String(p.propValue ?? '')]);
                }
                catch {
                    lines = [];
                }
                let building;
                // Every research this level asks for, at the level it asks (never OR'd;
                // a "!HasTech" is only "not this level yet") — what a tier's path adds up.
                const needs = new Map();
                for (const ref of Array.isArray(lv[3]) ? lv[3] : []) {
                    const cond = str(ref) ?? '';
                    for (const m of cond.matchAll(/HasBuildingLevel\((\d+),(\d+)/g)) {
                        const at = [Number(m[1]), Number(m[2])];
                        if (!building || at[1] > building[1])
                            building = at;
                    }
                    for (const m of cond.matchAll(/(!?)HasTech\((\d+),(\d+)/g)) {
                        const other = Number(m[2]);
                        if (m[1] || other === node.techId)
                            continue;
                        needs.set(other, Math.max(needs.get(other) ?? 0, Number(m[3])));
                    }
                }
                if (building && !(String(building[0]) in buildings)) {
                    const b = buildingRows[String(building[0])];
                    const name = Array.isArray(b) ? (vecText(b[3]) ?? text(b[3])) : undefined;
                    if (name)
                        buildings[String(building[0])] = name;
                }
                list.push({
                    level: key,
                    cost,
                    seconds: Array.isArray(pos) ? num(pos[7]) : 0,
                    might: num(lv[5]),
                    lines,
                    ...(building ? { building } : {}),
                    ...(needs.size ? { needs: [...needs] } : {}),
                });
            }
            if (list.length)
                out[String(node.techId)] = list;
        }
    }
    // What the levels are paid in, as the game describes it: T8 f3 the item's
    // name vector, f4 its tooltip vector. (Not "item.tooltip.<the name's code>":
    // the resources' codes differ — Valor points is item.name.n0040 and
    // item.tooltip.n0285, and n0040's tooltip is another item's.)
    const t8 = src.tables.get(TABLE_ITEMS);
    const itemRows = isRecord(t8) ? t8 : {};
    const items = {};
    for (const list of Object.values(out)) {
        for (const l of list) {
            for (const id of Object.keys(l.cost)) {
                if (items[id])
                    continue;
                const row = itemRows[id];
                if (!Array.isArray(row))
                    continue;
                const name = vecText(row[3]) ?? '';
                const tooltip = vecText(row[4]) ?? '';
                if (name)
                    items[id] = { name, tooltip };
            }
        }
    }
    return { version, techs: out, items, buildings };
}
/** A layout TextAsset's JSON, or null when it isn't one. */
function asTreeLayout(v) {
    if (!isRecord(v) || typeof v.name !== 'string' || !Array.isArray(v.techs))
        return null;
    const techs = v.techs
        .filter(isRecord)
        .filter((n) => typeof n.id === 'number' && typeof n.x === 'number' && typeof n.y === 'number')
        .map((n) => ({ id: n.id, x: n.x, y: n.y }));
    return { name: v.name, techs };
}
/**
 * The tree layout a layout bundle holds: its first TextAsset whose text is a
 * layout's JSON (a leading BOM allowed). Read with the art pipeline's Unity
 * reader — the bundle's SerializedFile, by its type tree.
 */
function layoutFromBundle(bundle) {
    for (const text of (0, extract_js_1.extractTexts)(bundle, () => true).values()) {
        let json;
        try {
            json = JSON.parse(text.replace(/^﻿/, ''));
        }
        catch {
            continue;
        }
        const layout = asTreeLayout(json);
        if (layout)
            return layout;
    }
    return null;
}
// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------
async function fetchBuffer(url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok)
        throw new Error(`GET ${url} → HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
}
async function fetchTreeVersion() {
    const body = JSON.parse((await fetchBuffer(VERSIONS_URL)).toString('utf8'));
    const branch = body.result?.client_static_version?.[STATIC_BRANCH];
    const catalog = body.result?.client_translations_catalog_version;
    const unity = body.result?.unity_catalog_version?.[UNITY_PLATFORM];
    if (!branch?.composite_hash || !branch.strings || !branch.vectors || !branch.no_duplicates || !catalog || !unity) {
        throw new Error('versions config is missing the static data, translations or asset catalog entries');
    }
    const dirKey = `${branch.composite_hash.slice(0, 16)}-${catalog.replace(/\.json$/, '')}`;
    return {
        dirKey,
        version: `${dirKey}:${unity}`,
        files: { strings: branch.strings, vectors: branch.vectors, noDuplicates: branch.no_duplicates },
        translationsCatalog: catalog,
        unityCatalog: unity,
    };
}
/** The pool files are a one-element array wrapping the real array. */
function readWrappedArray(buf) {
    const r = new codec_js_1.WireReader(buf);
    if (r.arrayLength() !== 1)
        throw new Error('expected a wrapped array');
    const n = r.arrayLength();
    const out = new Array(n);
    for (let i = 0; i < n; i++)
        out[i] = r.value();
    return out;
}
/** Decode the requested tables of no_duplicates — arrays too (T1 is one); the rest are skipped unbuilt. */
function readAnyTables(buf, wanted) {
    const r = new codec_js_1.WireReader(buf);
    const count = r.arrayLength();
    const want = new Set(wanted);
    const out = new Map();
    for (let i = 0; i < count; i++) {
        if (want.has(i))
            out.set(i, r.value());
        else
            r.skip();
    }
    return out;
}
async function fetchEnglish(catalog) {
    const index = JSON.parse((await fetchBuffer(TRANSLATIONS_BASE + catalog)).toString('utf8'));
    const entry = index.files?.find((f) => f.name === ENGLISH);
    if (!entry)
        throw new Error(`translations index has no ${ENGLISH}`);
    return (0, static_data_js_1.parseTranslationsCsv)((0, static_data_js_1.unzipFirst)(await fetchBuffer(TRANSLATIONS_BASE + entry.fileName)).toString('utf8'));
}
async function fetchLayouts(unityCatalog, names) {
    const bundleOf = (0, catalog_js_1.nameIndex)((0, catalog_js_1.parseCatalog)(await fetchBuffer(catalog_js_1.UNITY_BASE + unityCatalog)));
    const layouts = [];
    const missing = [];
    const queue = [...new Set(names)];
    const worker = async () => {
        for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
            const bundle = bundleOf.get(name.toLowerCase());
            try {
                if (!bundle)
                    throw new Error('not in the asset catalog');
                const layout = layoutFromBundle(await fetchBuffer(catalog_js_1.UNITY_BASE + bundle));
                if (!layout)
                    throw new Error('bundle holds no tree layout');
                layouts.push({ ...layout, name });
            }
            catch (err) {
                missing.push(`${name} (${err instanceof Error ? err.message : String(err)})`);
            }
        }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    return { layouts, missing };
}
async function buildFromCdn(v) {
    const [stringsBuf, vectorsBuf, tablesBuf, en] = await Promise.all([
        fetchBuffer(STATIC_BASE + v.files.strings),
        fetchBuffer(STATIC_BASE + v.files.vectors),
        fetchBuffer(STATIC_BASE + v.files.noDuplicates),
        fetchEnglish(v.translationsCatalog),
    ]);
    const src = {
        strings: readWrappedArray(stringsBuf),
        vectors: readWrappedArray(vectorsBuf),
        tables: readAnyTables(tablesBuf, NEEDED_TABLES),
        en,
    };
    const branches = readBranches(src);
    if (!branches.length)
        throw new Error('client config declares no tech trees');
    const { layouts, missing } = await fetchLayouts(v.unityCatalog, branches.map((b) => b.tree));
    if (!layouts.length)
        throw new Error(`no tree layout could be read: ${missing.slice(0, 3).join('; ')}`);
    if (missing.length)
        log.warn({ noAlert: true }, `Tech trees without a layout, left out: ${missing.join('; ')}`);
    const trees = buildTechTrees(v.version, src, layouts);
    return { trees, levels: buildTechLevels(v.version, src, trees.trees) };
}
// ---------------------------------------------------------------------------
// Cache on the data volume
// ---------------------------------------------------------------------------
const TREES_FILE = 'tech-trees.json';
const LEVELS_FILE = 'tech-levels.json';
/** Cache of the game's static data. GAME_STATIC_DIR overrides it for local runs and tools, never needed in prod. */
function staticDir() {
    return process.env.GAME_STATIC_DIR ? path_1.default.resolve(process.env.GAME_STATIC_DIR) : path_1.default.resolve('data', 'game-static');
}
let memo = null;
let building = null;
/**
 * A game version whose trees failed to build. Not rebuilt (~67 MB of
 * downloads) on every page load and scan: retried after FAILED_BUILD_RETRY_MS,
 * the last trees built being served meanwhile.
 */
let failedBuild = null;
const FAILED_BUILD_RETRY_MS = 30 * 60_000;
/** Lift the retry wait (System → Game Patch → Check now). */
function clearTechTreesRetry() {
    failedBuild = null;
}
/**
 * Trees for the live game version: from memory, else the on-disk cache, else
 * rebuilt from the CDN (~67 MB of static data plus ~25 small layout bundles,
 * once per game patch). Falls back to the newest cached trees when the
 * versions endpoint can't be reached, or when a patch's trees can't be built
 * (a format change in the game's files) — one patch old beats a blank
 * Research tab. Throws only when there are no trees at all.
 */
async function loadTechTrees() {
    let v;
    try {
        v = await fetchTreeVersion();
    }
    catch (err) {
        const cached = memo ?? newestCachedTrees();
        if (cached) {
            log.warn({ noAlert: true }, `Game versions endpoint unreachable (${String(err)}); using cached tech trees ${cached.version}.`);
            return cached;
        }
        throw err;
    }
    if (memo?.version === v.version && (memo.format ?? 1) >= exports.TREES_FORMAT)
        return memo;
    const file = path_1.default.join(staticDir(), v.dirKey, TREES_FILE);
    if (fs_1.default.existsSync(file)) {
        const cached = JSON.parse(fs_1.default.readFileSync(file, 'utf8'));
        if (cached.version === v.version && (cached.format ?? 1) >= exports.TREES_FORMAT) {
            memo = cached;
            (0, status_js_1.reportReaderOk)('trees', v.version);
            return cached;
        }
    }
    if (failedBuild?.version === v.version && Date.now() - failedBuild.at < FAILED_BUILD_RETRY_MS) {
        const cached = memo ?? newestCachedTrees();
        if (cached)
            return cached;
        throw new Error(failedBuild.error);
    }
    if (!building) {
        building = (async () => {
            log.info(`Building tech trees for ${v.version}`);
            const started = Date.now();
            let trees;
            let levels;
            try {
                ({ trees, levels } = await buildFromCdn(v));
            }
            catch (err) {
                failedBuild = { version: v.version, at: Date.now(), error: String(err) };
                const cached = memo ?? newestCachedTrees();
                (0, status_js_1.reportReaderFailed)('trees', v.version, cached?.version ?? null, err);
                if (cached)
                    return cached;
                throw err;
            }
            fs_1.default.mkdirSync(path_1.default.dirname(file), { recursive: true });
            // Levels first: a trees file says the levels beside it are there.
            fs_1.default.writeFileSync(path_1.default.join(path_1.default.dirname(file), LEVELS_FILE), JSON.stringify(levels));
            fs_1.default.writeFileSync(file, JSON.stringify(trees));
            log.info(`Tech trees ${v.version} built in ${Math.round((Date.now() - started) / 1000)}s: ${trees.trees.length} trees, ` +
                `${trees.trees.reduce((n, t) => n + t.nodes.length, 0)} nodes, ${Object.keys(levels.techs).length} researches' levels`);
            failedBuild = null;
            (0, status_js_1.reportReaderOk)('trees', v.version);
            memo = trees;
            levelsMemo = levels;
            return trees;
        })().finally(() => {
            building = null;
        });
    }
    return building;
}
function newestCachedTrees() {
    const dir = staticDir();
    if (!fs_1.default.existsSync(dir))
        return null;
    const files = fs_1.default.readdirSync(dir)
        .map((d) => path_1.default.join(dir, d, TREES_FILE))
        .filter((f) => fs_1.default.existsSync(f))
        .sort((a, b) => fs_1.default.statSync(b).mtimeMs - fs_1.default.statSync(a).mtimeMs);
    return files[0] ? JSON.parse(fs_1.default.readFileSync(files[0], 'utf8')) : null;
}
/**
 * The trees already in hand, without any network: memory, else the newest file
 * on disk, else null. For synchronous readers (troop tiers in the guards
 * estimator) — the scan keeps them current by calling loadTechTrees().
 */
function cachedTechTrees() {
    if (!memo)
        memo = newestCachedTrees();
    return memo;
}
let levelsMemo = null;
/**
 * Every research's levels (cost, time, Might, bonuses) for the trees
 * loadTechTrees serves, from tech-levels.json beside them; null when those
 * trees came without one (an older cache serving while a patch can't be read).
 */
async function loadTechLevels() {
    const trees = await loadTechTrees();
    if (levelsMemo?.version === trees.version)
        return levelsMemo;
    const file = path_1.default.join(staticDir(), trees.version.split(':')[0], LEVELS_FILE);
    try {
        const levels = JSON.parse(fs_1.default.readFileSync(file, 'utf8'));
        if (levels.version !== trees.version)
            return null;
        levelsMemo = levels;
        return levels;
    }
    catch {
        return null;
    }
}
/** Test seam. */
function resetTechTreesMemo() {
    memo = null;
    levelsMemo = null;
    failedBuild = null;
}
//# sourceMappingURL=tech-trees.js.map