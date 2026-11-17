"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.NAMES_FORMAT = exports.TABLE_EQUIPMENT = exports.TABLE_ARTIFACT_BONUSES = exports.TABLE_ARTIFACT_LEVELS = exports.TABLE_ARTIFACT_STARS = exports.TABLE_ARTIFACTS = exports.TABLE_CLAN_MEDALS = exports.TABLE_CAPTAINS = exports.TABLE_TECHS = exports.TABLE_HEROES = exports.TABLE_GIFT_TYPES = exports.TABLE_TERRAINS = exports.TABLE_MAP_OBJECTS = void 0;
exports.fetchStaticVersion = fetchStaticVersion;
exports.unzipFirst = unzipFirst;
exports.parseTranslationsCsv = parseTranslationsCsv;
exports.readTables = readTables;
exports.asIdRecord = asIdRecord;
exports.buildNames = buildNames;
exports.loadGameNames = loadGameNames;
exports.resetGameNamesMemo = resetGameNamesMemo;
/**
 * Names for the game's numeric ids, built from Total Battle's own public static
 * data — the same files the game client downloads.
 *
 *   versions.totalbattle.com/config/?branch=current&simple=true
 *     .client_static_version.production   → strings / vectors / no_duplicates file names
 *     .client_translations_catalog_version → translations index → csv_en_US zip
 *
 * Table cells reference the string pool by index (no offset); localised text
 * fields reference a VECTOR of string refs, and templated text ("Level %value%
 * Crypt") is [templateRef, placeholderRef, valueRef, ...]. Each table has its
 * own id space. The tables we use:
 *
 *   T7  map objects   f3 name vector
 *   T8  gift types    f3 chest name vector, f14 source template vector
 *   T13 hero avatars  f1 name vector, f3 icon string
 *   T21 techs         f1 name vector, f5 levels (research + hero talents)
 *   T11 equipment     see TABLE_EQUIPMENT (gems/enchantments are T8 items)
 *   T75 captains      see TABLE_CAPTAINS
 *   T110–T113         artifacts (types, star levels, levels, random-bonus pools)
 *                     — `$pairs` tables keyed `[type]`, see TABLE_ARTIFACTS
 *
 * The raw files are ~67 MB, so a rebuild happens only when the game ships new
 * static data: the result is a small names.json cached under
 * data/game-static/<version>/; the raw files are only ever held in memory. Decoding skips
 * every table we don't need without building it, which keeps a rebuild inside
 * the container's heap. Full background: docs/game-protocol.md.
 */
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const zlib_1 = __importDefault(require("zlib"));
const codec_js_1 = require("./codec.js");
const logger_js_1 = require("../utils/logger.js");
const log = (0, logger_js_1.childLogger)('game-static');
const VERSIONS_URL = 'https://versions.totalbattle.com/config/?branch=current&simple=true';
const STATIC_BASE = 'https://assets-client-static.totalbattle.dev/';
const TRANSLATIONS_BASE = 'https://assets-translations.totalbattle.dev//';
const STATIC_BRANCH = 'production';
const ENGLISH = 'csv_en_US';
exports.TABLE_MAP_OBJECTS = 7;
/** Terrain types ("Dense forest", "Forested hills"): f2 name vector — a chat tile share's staticId. */
exports.TABLE_TERRAINS = 4;
exports.TABLE_GIFT_TYPES = 8;
exports.TABLE_HEROES = 13;
exports.TABLE_TECHS = 21;
/** Captains (Hercules, Skadi, Aurora…): f1 kind, f2 rarity, f5 name, f7 JSON config with the sprite names. */
exports.TABLE_CAPTAINS = 75;
/** Clan medals (ids 1–40): f1 icon, f2 inactive icon, f4 unlock text vector, f5 name vector, f6 tier 1 bronze … 4 platinum. */
exports.TABLE_CLAN_MEDALS = 62;
/**
 * Artifacts, all keyed by the artifact TYPE (one per type per player):
 *   T110 types        f7 JSON config {"icon": …}, f8 name vector, f9 tooltip
 *                     vector, f11 rarity (4 epic, 5 legendary, 6 mythic)
 *   T111 star levels  [[type], {star: [star, bigStar, effectId, cost, propsRef, …]}]
 *   T112 levels       [[type], xpItem, {level: [level, effectId, cond, xp, propsRef, …]}]
 *   T113 bonus pool   [[type], {effectId: [weight, propTextRef, valueTextRef, quality]}, unlocks]
 * An effect id (T20) names exactly one level, star level or random bonus of
 * one type, so a city's active effects (601 field 14) say which artifacts the
 * line-up captains wear, at what level and star level, with which rolls.
 */
exports.TABLE_ARTIFACTS = 110;
exports.TABLE_ARTIFACT_STARS = 111;
exports.TABLE_ARTIFACT_LEVELS = 112;
exports.TABLE_ARTIFACT_BONUSES = 113;
/**
 * Equipment (hero and captain gear), one row per item TYPE — and the type
 * includes the quality grade: "Cursed Claw Coat" exists once per grade.
 *   f1 set, f2 icon address ("arch_body": set prefix + slot), f3 name vector,
 *   f5 quality grade 1–8 (Poor … Godlike), f7 durability,
 *   f9 props JSON — the item's bonuses at that grade ("Crypt exploration
 *   efficiency +50,0%"); `equipment.client_info.n0001` is Durability.
 * Gems (T8 f1 8) and enchantments (T8 f1 9) set into an item are T8 items:
 * f3 name vector, f6 visual JSON {"icon": …}.
 */
exports.TABLE_EQUIPMENT = 11;
const NEEDED_TABLES = [
    exports.TABLE_MAP_OBJECTS,
    exports.TABLE_GIFT_TYPES,
    exports.TABLE_HEROES,
    exports.TABLE_TECHS,
    exports.TABLE_CAPTAINS,
    exports.TABLE_ARTIFACTS,
    exports.TABLE_ARTIFACT_STARS,
    exports.TABLE_ARTIFACT_LEVELS,
    exports.TABLE_ARTIFACT_BONUSES,
    exports.TABLE_EQUIPMENT,
    exports.TABLE_CLAN_MEDALS,
    exports.TABLE_TERRAINS,
];
/**
 * Bump when names.json gains a field the app reads (2: captain star bonuses
 * and rarity labels; 3: clan medals; 4: artifacts, equipment, gems; 5: terrain
 * names — Nov 2026); a cached file with an older format is rebuilt.
 */
exports.NAMES_FORMAT = 5;
/** T62 f6 medal tier → the game's own tier label key (the clan_medals config's goblet tierName). */
const MEDAL_TIER_KEYS = {
    1: 'client_config.value.goblet_bronze',
    2: 'client_config.value.goblet_silver',
    3: 'client_config.value.goblet_gold',
    4: 'client_config.value.goblet_platinum',
};
/** T11 f5 equipment quality grade → the forge's own label key. */
const EQUIPMENT_GRADE_KEYS = {
    1: 'client.craft.gray_item_title',
    2: 'client.craft.white_item_title',
    3: 'client.craft.green_item_title',
    4: 'client.craft.blue_item_title',
    5: 'client.craft.violet_item_title',
    6: 'client.craft.orange_item_title',
    7: 'client.craft.red_item_title',
    8: 'client.craft.gold_item_title',
};
/** The props line that is the item's durability, not a bonus. */
const DURABILITY_PROP = 'equipment.client_info.n0001';
/** T110 f11 rarity → the artifact book's own label key. */
const ARTIFACT_RARITY_KEYS = {
    4: 'client.artifact.window.artifact.epic_rarity',
    5: 'client.artifact.window.artifact.legendary_rarity',
    6: 'client.artifact.window.artifact.mythical_rarity',
};
/** T75 f2 rarity → the game's own label key. */
const CAPTAIN_RARITY_KEYS = {
    1: 'client.captain.info.rare_captain',
    2: 'client.captain.info.epic_captain',
    3: 'client.captain.info.legendary_captain',
    4: 'client.captain.info.mythical_captain',
};
const FETCH_TIMEOUT_MS = 120_000;
async function fetchBuffer(url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok)
        throw new Error(`GET ${url} → HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
}
/** Which static data and translations the live game is on right now. */
async function fetchStaticVersion() {
    const body = JSON.parse((await fetchBuffer(VERSIONS_URL)).toString('utf8'));
    const branch = body.result?.client_static_version?.[STATIC_BRANCH];
    const catalog = body.result?.client_translations_catalog_version;
    if (!branch?.composite_hash || !branch.strings || !branch.vectors || !branch.no_duplicates || !catalog) {
        throw new Error('versions config is missing the static data or translations entries');
    }
    return {
        composite: branch.composite_hash,
        files: { strings: branch.strings, vectors: branch.vectors, noDuplicates: branch.no_duplicates },
        translationsCatalog: catalog,
    };
}
// ---------------------------------------------------------------------------
// Translations: a zip holding one CSV of "key","text" rows
// ---------------------------------------------------------------------------
/** Extract the first file of a zip (stored or deflated), via the central directory. */
function unzipFirst(zip) {
    const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0)
        throw new Error('not a zip: no end-of-central-directory record');
    const cdOffset = zip.readUInt32LE(eocd + 16);
    if (zip.readUInt32LE(cdOffset) !== 0x02014b50)
        throw new Error('zip central directory not found');
    const method = zip.readUInt16LE(cdOffset + 10);
    const compressed = zip.readUInt32LE(cdOffset + 20);
    const localOffset = zip.readUInt32LE(cdOffset + 42);
    const nameLen = zip.readUInt16LE(localOffset + 26);
    const extraLen = zip.readUInt16LE(localOffset + 28);
    const data = zip.subarray(localOffset + 30 + nameLen + extraLen, localOffset + 30 + nameLen + extraLen + compressed);
    if (method === 0)
        return Buffer.from(data);
    if (method === 8)
        return zlib_1.default.inflateRawSync(data);
    throw new Error(`unsupported zip compression method ${method}`);
}
/** Parse "key","text" CSV (quoted fields, "" escapes, newlines allowed in quotes). */
function parseTranslationsCsv(text) {
    const out = new Map();
    let i = 0;
    const n = text.length;
    const field = () => {
        if (text[i] !== '"') {
            const start = i;
            while (i < n && text[i] !== ',' && text[i] !== '\n' && text[i] !== '\r')
                i++;
            return text.slice(start, i);
        }
        i++;
        let s = '';
        while (i < n) {
            const c = text[i];
            if (c === '"') {
                if (text[i + 1] === '"') {
                    s += '"';
                    i += 2;
                    continue;
                }
                i++;
                break;
            }
            s += c;
            i++;
        }
        return s;
    };
    while (i < n) {
        const key = field();
        if (text[i] !== ',') {
            while (i < n && text[i] !== '\n')
                i++;
            i++;
            continue;
        }
        i++;
        const value = field();
        while (i < n && text[i] !== '\n')
            i++;
        i++;
        if (key)
            out.set(key, value);
    }
    return out;
}
async function fetchEnglish(catalog) {
    const index = JSON.parse((await fetchBuffer(TRANSLATIONS_BASE + catalog)).toString('utf8'));
    const entry = index.files?.find((f) => f.name === ENGLISH);
    if (!entry)
        throw new Error(`translations index has no ${ENGLISH}`);
    const csv = unzipFirst(await fetchBuffer(TRANSLATIONS_BASE + entry.fileName)).toString('utf8');
    return parseTranslationsCsv(csv);
}
// ---------------------------------------------------------------------------
// Static tables
// ---------------------------------------------------------------------------
/** The pool files are a one-element array wrapping the real array. */
function readWrappedArray(buf) {
    const r = new codec_js_1.WireReader(buf);
    const outer = r.arrayLength();
    if (outer !== 1)
        throw new Error(`expected a wrapped array, got outer length ${outer}`);
    const n = r.arrayLength();
    const out = new Array(n);
    for (let i = 0; i < n; i++)
        out[i] = r.value();
    return out;
}
/**
 * Decode only the requested tables of no_duplicates; the rest are skipped
 * unbuilt. Most tables are maps keyed by a plain id; some (the artifact tables)
 * are `$pairs` keyed by a one-element array `[id]` — those come back keyed by
 * that id, the same shape as the others.
 */
function readTables(buf, wanted) {
    const r = new codec_js_1.WireReader(buf);
    const count = r.arrayLength();
    const want = new Set(wanted);
    const out = new Map();
    for (let i = 0; i < count; i++) {
        if (!want.has(i)) {
            r.skip();
            continue;
        }
        const t = asIdRecord(r.value());
        if (t)
            out.set(i, t);
    }
    return out;
}
/** A table as `id → row`: a plain map as is, `$pairs` keyed `[id]` (or `id`) re-keyed; anything else null. */
function asIdRecord(t) {
    if (!t || typeof t !== 'object' || Array.isArray(t) || '$bin' in t)
        return null;
    if (!('$pairs' in t))
        return t;
    const rec = {};
    for (const [k, v] of t.$pairs) {
        const id = Array.isArray(k) && k.length === 1 ? k[0] : k;
        if (typeof id === 'number' || typeof id === 'string')
            rec[String(id)] = v;
    }
    return rec;
}
/** Turn pools + tables + English into the compact names we keep. Pure; unit-tested. */
function buildNames(version, strings, vectors, tables, en) {
    const str = (ref) => (typeof ref === 'number' && typeof strings[ref] === 'string' ? strings[ref] : undefined);
    const text = (ref) => {
        const k = str(ref);
        return k === undefined ? undefined : (en.get(k) ?? k);
    };
    const vec = (vref) => {
        const v = typeof vref === 'number' ? vectors[vref] : undefined;
        return Array.isArray(v) ? v : undefined;
    };
    // Localised text is a vector [templateRef, placeholderRef, valueRef, ...]: a
    // plain name is a one-element vector, a templated one ("Level %value% Crypt",
    // "Sacred Potion production %level%") substitutes each placeholder with its
    // raw value. Anything that resolves to a JSON fragment isn't a name.
    const vecText = (vref) => {
        const v = vec(vref);
        if (!v?.length)
            return undefined;
        let out = text(v[0]) ?? '';
        for (let i = 1; i + 1 < v.length; i += 2)
            out = out.replace(str(v[i]) ?? '\u0000', str(v[i + 1]) ?? '');
        out = out.replace(/\s+/g, ' ').trim();
        return out && !out.startsWith('{') && !out.startsWith('[') ? out : undefined;
    };
    const vecTemplate = vecText;
    const rows = (table) => Object.entries(tables.get(table) ?? {}).filter((e) => Array.isArray(e[1]));
    const gifts = {};
    for (const [id, row] of rows(exports.TABLE_GIFT_TYPES)) {
        const chest = vecText(row[3]);
        if (chest)
            gifts[id] = { chest, source: vecTemplate(row[14]) ?? '' };
    }
    const techs = {};
    for (const [id, row] of rows(exports.TABLE_TECHS)) {
        const name = vecText(row[1]);
        const levels = row[5];
        if (name)
            techs[id] = { name, maxLevel: levels && typeof levels === 'object' && !Array.isArray(levels) ? Object.keys(levels).length : 0 };
    }
    const objects = {};
    for (const [id, row] of rows(exports.TABLE_MAP_OBJECTS)) {
        const name = vecText(row[3]);
        if (name)
            objects[id] = name;
    }
    const terrains = {};
    for (const [id, row] of rows(exports.TABLE_TERRAINS)) {
        const name = vecText(row[2]);
        if (name)
            terrains[id] = name;
    }
    const heroes = {};
    for (const [id, row] of rows(exports.TABLE_HEROES)) {
        const name = vecText(row[1]);
        if (name)
            heroes[id] = { name, icon: str(row[3]) ?? '' };
    }
    const captains = {};
    for (const [id, row] of rows(exports.TABLE_CAPTAINS)) {
        let cfg = {};
        try {
            cfg = JSON.parse(str(row[7]) ?? '{}');
        }
        catch { /* not a config */ }
        // The battler's own name (battler_unit.name.<key of battler_<key>_unit>)
        // first: f5 is wrong for some rows — id 28 is Helen (her sprites, her
        // battler) but its f5 vector says "Hercules" (Nov 2026).
        const battler = /^battler_(.+)_unit$/.exec(cfg.animationLinkage ?? '')?.[1];
        const name = (battler ? en.get(`battler_unit.name.${battler}`) : undefined) ?? vecText(row[5]);
        if (!name)
            continue;
        const rarity = typeof row[2] === 'number' ? row[2] : 0;
        const stars = {};
        const starRows = row[12];
        if (starRows && typeof starRows === 'object' && !Array.isArray(starRows)) {
            for (const [star, sr] of Object.entries(starRows)) {
                if (!Array.isArray(sr))
                    continue;
                let props = [];
                try {
                    props = JSON.parse(str(sr[7]) ?? '{}').props ?? [];
                }
                catch { /* no props */ }
                const lines = props
                    .filter((p) => p.propText)
                    .map((p) => [en.get(p.propText) ?? p.propText, String(p.propValue ?? '')]);
                if (lines.length)
                    stars[star] = lines;
            }
        }
        captains[id] = {
            name,
            rarity,
            rarityName: en.get(CAPTAIN_RARITY_KEYS[rarity] ?? '') ?? '',
            icon: cfg.smallIcon ?? '',
            art: cfg.unitAltarArt ?? '',
            stars,
        };
    }
    const medals = {};
    for (const [id, row] of rows(exports.TABLE_CLAN_MEDALS)) {
        const name = vecText(row[5]);
        if (!name)
            continue;
        const tier = typeof row[6] === 'number' ? row[6] : 0;
        medals[id] = {
            name,
            description: vecText(row[4]) ?? '',
            tier,
            tierName: en.get(MEDAL_TIER_KEYS[tier] ?? '') ?? '',
            icon: str(row[1]) ?? '',
        };
    }
    const artifacts = buildArtifacts(tables, str, vecText, en);
    const equipment = {};
    for (const [id, row] of rows(exports.TABLE_EQUIPMENT)) {
        const name = vecText(row[3]);
        const icon = str(row[2]);
        if (!name || !icon)
            continue;
        let props = [];
        try {
            props = JSON.parse(str(row[9]) ?? '{}').props ?? [];
        }
        catch { /* no props */ }
        const lines = props
            .filter((p) => typeof p.propText === 'string' && p.propText && p.propText !== DURABILITY_PROP)
            .map((p) => [en.get(p.propText) ?? p.propText, String(p.propValue ?? '')]);
        equipment[id] = { name, icon, grade: typeof row[5] === 'number' ? row[5] : 0, lines };
    }
    const equipmentGrades = {};
    for (const [grade, key] of Object.entries(EQUIPMENT_GRADE_KEYS)) {
        const label = en.get(key);
        if (label)
            equipmentGrades[grade] = label;
    }
    const inserts = {};
    for (const [id, row] of rows(exports.TABLE_GIFT_TYPES)) {
        if (row[1] !== 8 && row[1] !== 9)
            continue;
        const name = vecText(row[3]);
        if (!name)
            continue;
        let icon = '';
        try {
            const v = JSON.parse(str(row[6]) ?? '{}');
            if (typeof v.icon === 'string')
                icon = v.icon;
        }
        catch { /* no visual */ }
        inserts[id] = { name, icon, kind: row[1] === 8 ? 'gem' : 'enchantment' };
    }
    return {
        version, builtAt: new Date().toISOString(), format: exports.NAMES_FORMAT,
        gifts, techs, objects, terrains, heroes, captains, medals, artifacts, equipment, equipmentGrades, inserts,
    };
}
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && !('$bin' in v) && !('$pairs' in v);
/**
 * T110–T113 → per artifact type: name, rarity, icon, and every level, star
 * level and random bonus by the effect id the game puts in a city's active
 * effects. Lines are the game's own text ("Crypt exploration efficiency",
 * "+130.0%"), from the props JSON a level or star level carries.
 */
function buildArtifacts(tables, str, vecText, en) {
    const propLines = (ref) => {
        let props = [];
        try {
            props = JSON.parse(str(ref) ?? '{}').props ?? [];
        }
        catch { /* no props */ }
        return props
            .filter((p) => typeof p.propText === 'string' && p.propText)
            .map((p) => [en.get(p.propText) ?? p.propText, String(p.propValue ?? '')]);
    };
    const out = {};
    const types = tables.get(exports.TABLE_ARTIFACTS) ?? {};
    for (const [id, row] of Object.entries(types)) {
        if (!Array.isArray(row))
            continue;
        const name = vecText(row[8]);
        if (!name)
            continue;
        let icon = '';
        try {
            const cfg = JSON.parse(str(row[7]) ?? '{}');
            if (typeof cfg.icon === 'string')
                icon = cfg.icon;
        }
        catch { /* no config */ }
        const rarity = typeof row[11] === 'number' ? row[11] : 0;
        const levels = {};
        const lv = tables.get(exports.TABLE_ARTIFACT_LEVELS)?.[id];
        const lvRows = Array.isArray(lv) ? lv[2] : undefined;
        if (lvRows && isPlainObject(lvRows)) {
            for (const r of Object.values(lvRows)) {
                if (Array.isArray(r) && typeof r[0] === 'number' && typeof r[1] === 'number')
                    levels[String(r[1])] = [r[0], propLines(r[4])];
            }
        }
        const stars = {};
        const st = tables.get(exports.TABLE_ARTIFACT_STARS)?.[id];
        const stRows = Array.isArray(st) ? st[1] : undefined;
        if (stRows && isPlainObject(stRows)) {
            for (const r of Object.values(stRows)) {
                if (Array.isArray(r) && typeof r[0] === 'number' && typeof r[2] === 'number')
                    stars[String(r[2])] = [r[0], propLines(r[4])];
            }
        }
        const bonuses = {};
        const bp = tables.get(exports.TABLE_ARTIFACT_BONUSES)?.[id];
        const bpRows = Array.isArray(bp) ? bp[1] : undefined;
        if (bpRows && isPlainObject(bpRows)) {
            for (const [effectId, r] of Object.entries(bpRows)) {
                if (!Array.isArray(r))
                    continue;
                const key = str(r[1]);
                if (!key)
                    continue;
                bonuses[effectId] = [en.get(key) ?? key, str(r[2]) ?? '', typeof r[3] === 'number' ? r[3] : 0];
            }
        }
        const levelNums = Object.values(levels).map(([n]) => n);
        const starNums = Object.values(stars).map(([n]) => n);
        out[id] = {
            name,
            rarity,
            rarityName: en.get(ARTIFACT_RARITY_KEYS[rarity] ?? '') ?? '',
            icon,
            maxLevel: levelNums.length ? Math.max(...levelNums) : 0,
            maxStar: starNums.length ? Math.max(...starNums) : 0,
            levels,
            stars,
            bonuses,
        };
    }
    return out;
}
// ---------------------------------------------------------------------------
// Cache on the data volume
// ---------------------------------------------------------------------------
/** Cache of the game's static data. GAME_STATIC_DIR overrides it for local runs and tools, never needed in prod. */
function staticDir() {
    return process.env.GAME_STATIC_DIR ? path_1.default.resolve(process.env.GAME_STATIC_DIR) : path_1.default.resolve('data', 'game-static');
}
function versionKey(v) {
    return `${v.composite.slice(0, 16)}-${v.translationsCatalog.replace(/\.json$/, '')}`;
}
let memo = null;
/**
 * Names for the live game version: from memory, else from the on-disk cache,
 * else rebuilt from the CDN. Falls back to the newest cached names when the
 * versions endpoint can't be reached, because stale names beat no names.
 */
async function loadGameNames() {
    let version;
    try {
        version = await fetchStaticVersion();
    }
    catch (err) {
        const cached = memo ?? newestCachedNames();
        if (cached) {
            log.warn({ noAlert: true }, `Game versions endpoint unreachable (${String(err)}); using cached names ${cached.version}.`);
            return cached;
        }
        throw err;
    }
    const key = versionKey(version);
    if (memo?.version === key)
        return memo;
    const file = path_1.default.join(staticDir(), key, 'names.json');
    if (fs_1.default.existsSync(file)) {
        const cached = JSON.parse(fs_1.default.readFileSync(file, 'utf8'));
        // A names.json from an older format (before captains' star bonuses) is rebuilt once.
        if ((cached.format ?? 1) >= exports.NAMES_FORMAT) {
            memo = cached;
            return memo;
        }
    }
    log.info(`Building game names for static data ${key} (downloads ~67 MB once per game patch)`);
    const started = Date.now();
    const [stringsBuf, vectorsBuf, tablesBuf, en] = await Promise.all([
        fetchBuffer(STATIC_BASE + version.files.strings),
        fetchBuffer(STATIC_BASE + version.files.vectors),
        fetchBuffer(STATIC_BASE + version.files.noDuplicates),
        fetchEnglish(version.translationsCatalog),
    ]);
    const names = buildNames(key, readWrappedArray(stringsBuf), readWrappedArray(vectorsBuf), readTables(tablesBuf, NEEDED_TABLES), en);
    fs_1.default.mkdirSync(path_1.default.dirname(file), { recursive: true });
    fs_1.default.writeFileSync(file, JSON.stringify(names));
    log.info(`Game names ${key} built in ${Math.round((Date.now() - started) / 1000)}s: ` +
        `${Object.keys(names.gifts).length} gift types, ${Object.keys(names.techs).length} techs, ` +
        `${Object.keys(names.objects).length} map objects, ${Object.keys(names.heroes).length} heroes, ` +
        `${Object.keys(names.captains).length} captains, ${Object.keys(names.artifacts ?? {}).length} artifacts`);
    memo = names;
    return names;
}
function newestCachedNames() {
    const dir = staticDir();
    if (!fs_1.default.existsSync(dir))
        return null;
    const files = fs_1.default.readdirSync(dir)
        .map((d) => path_1.default.join(dir, d, 'names.json'))
        .filter((f) => fs_1.default.existsSync(f))
        .sort((a, b) => fs_1.default.statSync(b).mtimeMs - fs_1.default.statSync(a).mtimeMs);
    return files[0] ? JSON.parse(fs_1.default.readFileSync(files[0], 'utf8')) : null;
}
/** Test seam. */
function resetGameNamesMemo() {
    memo = null;
}
//# sourceMappingURL=static-data.js.map