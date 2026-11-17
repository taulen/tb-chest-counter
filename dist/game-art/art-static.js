"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TABLE_EQUIPMENT = exports.TABLE_ARTIFACTS = exports.ART_STATIC_FORMAT = exports.TABLE_CUSTOMIZATIONS = exports.TABLE_CAPTAINS = exports.TABLE_TECHS = exports.TABLE_HERO_AVATARS = exports.TABLE_UNITS = exports.TABLE_ITEMS = void 0;
exports.buildArtStatic = buildArtStatic;
exports.staticKey = staticKey;
exports.loadArtStatic = loadArtStatic;
/**
 * The slice of the game's static data the art pipeline needs: which icon each
 * hero avatar, unit, tech and item uses. A separate loader from
 * game-protocol/static-data.ts (which keeps its own small names.json) so that
 * module's exports and cache stay as they are; it reuses its parsers.
 *
 *   T8  items        f3 name vector, f6 visual JSON {"icon": "<72px icon>"}
 *   T9  units        f1 name vector, f2 tier (0–10: Archer I = 1, Corax II = 9;
 *                    picks the icon's frame colour, unit-frames.ts), f4 icon,
 *                    f10 strength, f12 health
 *   T13 hero avatars f1 name vector, f3 icon — a player's heroAvatar IS the T13 id
 *   T21 techs        f1 name vector, f3 icon (research and hero talents)
 *   T52 customizations f1 kind (1 portrait frame, 2 city look, 3 …), f2 name
 *                    vector, f4 visual JSON {"visual": "<frame sprite>", …} —
 *                    a player's 402 field 6 IS the id of their frame, field 5
 *                    of their city look (whose visual is JSON again, with an
 *                    icon per city level: {"icon": {"1": …, "5": …}})
 *   T110 artifacts   f7 JSON config {"icon": …}, f8 name vector
 *   T11 equipment    f2 icon address, f3 name vector (gems/enchantments: T8 f1 8/9)
 *
 * The raw files are ~67 MB and only held in memory; the result is cached as
 * data/game-art/static-<version>.json, rebuilt once per game patch.
 */
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const codec_js_1 = require("../game-protocol/codec.js");
const static_data_js_1 = require("../game-protocol/static-data.js");
const STATIC_BASE = 'https://assets-client-static.totalbattle.dev/';
const TRANSLATIONS_BASE = 'https://assets-translations.totalbattle.dev//';
const ENGLISH = 'csv_en_US';
const FETCH_TIMEOUT_MS = 120_000;
exports.TABLE_ITEMS = 8;
exports.TABLE_UNITS = 9;
exports.TABLE_HERO_AVATARS = 13;
exports.TABLE_TECHS = 21;
/** Captains: f5 name vector, f7 JSON config naming the sprites (smallIcon, unitAltarArt). */
exports.TABLE_CAPTAINS = 75;
/** Customizations (portrait frames, city looks): f1 kind, f2 name vector, f4 visual JSON. */
exports.TABLE_CUSTOMIZATIONS = 52;
/** T52 kind of a hero-portrait frame. */
const CUSTOMIZATION_FRAME = 1;
/** T52 kind of a city look; its visual JSON holds another JSON with {"icon": {minCityLevel: icon}}. */
const CUSTOMIZATION_CITY = 2;
/** Bumped when ArtStatic gains a field: a cache file of an older format is rebuilt once (2: unit tiers, portrait frames). */
exports.ART_STATIC_FORMAT = 3;
/** Artifact types: f7 JSON config {"icon": …}, f8 name vector. A `$pairs` table keyed [type]. */
exports.TABLE_ARTIFACTS = 110;
/** Equipment: f2 icon address ("arch_body"), f3 name vector. */
exports.TABLE_EQUIPMENT = 11;
async function fetchBuffer(url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok)
        throw new Error(`GET ${url} → HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
}
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
async function fetchEnglish(catalog) {
    const index = JSON.parse((await fetchBuffer(TRANSLATIONS_BASE + catalog)).toString('utf8'));
    const entry = index.files?.find((f) => f.name === ENGLISH);
    if (!entry)
        throw new Error(`translations index has no ${ENGLISH}`);
    return (0, static_data_js_1.parseTranslationsCsv)((0, static_data_js_1.unzipFirst)(await fetchBuffer(TRANSLATIONS_BASE + entry.fileName)).toString('utf8'));
}
/** Pure: pools + tables + English → the icon slice. Unit-tested with synthetic tables. */
function buildArtStatic(version, strings, vectors, tables, en) {
    const str = (ref) => (typeof ref === 'number' && typeof strings[ref] === 'string' ? strings[ref] : undefined);
    const name = (vref) => {
        const v = typeof vref === 'number' ? vectors[vref] : undefined;
        if (!Array.isArray(v) || !v.length)
            return '';
        const key = str(v[0]);
        const text = key === undefined ? '' : (en.get(key) ?? '');
        return text.replace(/\s+/g, ' ').trim();
    };
    const rows = (t) => Object.entries(tables.get(t) ?? {})
        .filter((e) => Array.isArray(e[1]))
        .map(([id, row]) => [Number(id), row])
        .sort((a, b) => a[0] - b[0]);
    const num = (v) => (typeof v === 'number' ? v : 0);
    const heroes = {};
    for (const [id, row] of rows(exports.TABLE_HERO_AVATARS)) {
        const icon = str(row[3]);
        if (icon)
            heroes[id] = { name: name(row[1]), icon };
    }
    const units = [];
    for (const [id, row] of rows(exports.TABLE_UNITS)) {
        const icon = str(row[4]);
        const n = name(row[1]);
        if (icon && n)
            units.push({ id, name: n, tier: num(row[2]), strength: num(row[10]), health: num(row[12]), icon });
    }
    const techs = {};
    for (const [id, row] of rows(exports.TABLE_TECHS)) {
        const icon = str(row[3]);
        if (icon)
            techs[id] = { name: name(row[1]), icon };
    }
    const items = [];
    for (const [id, row] of rows(exports.TABLE_ITEMS)) {
        const visual = str(row[6]);
        if (!visual || !visual.startsWith('{'))
            continue;
        let icon;
        try {
            icon = JSON.parse(visual).icon;
        }
        catch {
            continue;
        }
        const n = name(row[3]);
        if (typeof icon === 'string' && icon && n)
            items.push({ id, name: n, icon });
    }
    const captains = {};
    for (const [id, row] of rows(exports.TABLE_CAPTAINS)) {
        const n = name(row[5]);
        let cfg = {};
        try {
            cfg = JSON.parse(str(row[7]) ?? '{}');
        }
        catch {
            continue;
        }
        const icon = typeof cfg.smallIcon === 'string' ? cfg.smallIcon : '';
        const art = typeof cfg.unitAltarArt === 'string' ? cfg.unitAltarArt : '';
        if (n && (icon || art))
            captains[id] = { name: n, icon, art };
    }
    const frames = {};
    const cityLooks = {};
    for (const [id, row] of rows(exports.TABLE_CUSTOMIZATIONS)) {
        if (row[1] !== CUSTOMIZATION_FRAME && row[1] !== CUSTOMIZATION_CITY)
            continue;
        let cfg = {};
        try {
            cfg = JSON.parse(str(row[4]) ?? '{}');
        }
        catch {
            continue;
        }
        if (typeof cfg.visual !== 'string' || !cfg.visual)
            continue;
        if (row[1] === CUSTOMIZATION_FRAME) {
            // Animated frames name a Spine animation separately; `visual` is their still.
            frames[id] = { name: name(row[2]), visual: cfg.visual };
            continue;
        }
        let look = {};
        try {
            look = JSON.parse(cfg.visual);
        }
        catch {
            continue;
        }
        const icons = {};
        if (look.icon && typeof look.icon === 'object') {
            for (const [lvl, icon] of Object.entries(look.icon)) {
                if (/^\d+$/.test(lvl) && typeof icon === 'string' && icon)
                    icons[lvl] = icon;
            }
        }
        if (Object.keys(icons).length)
            cityLooks[id] = { name: name(row[2]), icons };
    }
    const artifacts = {};
    for (const [id, row] of rows(exports.TABLE_ARTIFACTS)) {
        let cfg = {};
        try {
            cfg = JSON.parse(str(row[7]) ?? '{}');
        }
        catch {
            continue;
        }
        if (typeof cfg.icon === 'string' && cfg.icon)
            artifacts[id] = { name: name(row[8]), icon: cfg.icon };
    }
    const equipment = {};
    for (const [id, row] of rows(exports.TABLE_EQUIPMENT)) {
        const icon = str(row[2]);
        if (icon && /^[a-z0-9_]+$/i.test(icon))
            equipment[id] = { name: name(row[3]), icon };
    }
    const inserts = {};
    for (const [id, row] of rows(exports.TABLE_ITEMS)) {
        if (row[1] !== 8 && row[1] !== 9)
            continue;
        let icon;
        try {
            icon = JSON.parse(str(row[6]) ?? '{}').icon;
        }
        catch {
            continue;
        }
        if (typeof icon === 'string' && icon)
            inserts[id] = { name: name(row[3]), icon };
    }
    return { version, format: exports.ART_STATIC_FORMAT, heroes, units, techs, items, captains, frames, cityLooks, artifacts, equipment, inserts };
}
function staticKey(v) {
    return `${v.composite.slice(0, 16)}-${v.translationsCatalog.replace(/\.json$/, '')}`;
}
function cacheFile(dir, key) {
    return path_1.default.join(dir, `static-${key}.json`);
}
/**
 * The icon slice for the live static data: from the on-disk cache, else
 * rebuilt from the CDN. Falls back to the newest cache when the versions
 * endpoint is unreachable. Keeps the two newest cache files.
 */
async function loadArtStatic(dir) {
    let version;
    try {
        version = await (0, static_data_js_1.fetchStaticVersion)();
    }
    catch (err) {
        const cached = newestCache(dir);
        if (cached)
            return cached;
        throw err;
    }
    const key = staticKey(version);
    const file = cacheFile(dir, key);
    if (fs_1.default.existsSync(file)) {
        const cached = JSON.parse(fs_1.default.readFileSync(file, 'utf8'));
        // A cache from an older format (no captains, no unit tiers, no artifacts or
        // equipment) is rebuilt once.
        if (cached.captains && cached.format === exports.ART_STATIC_FORMAT && cached.artifacts && cached.equipment)
            return cached;
    }
    const [stringsBuf, vectorsBuf, tablesBuf, en] = await Promise.all([
        fetchBuffer(STATIC_BASE + version.files.strings),
        fetchBuffer(STATIC_BASE + version.files.vectors),
        fetchBuffer(STATIC_BASE + version.files.noDuplicates),
        fetchEnglish(version.translationsCatalog),
    ]);
    const data = buildArtStatic(key, readWrappedArray(stringsBuf), readWrappedArray(vectorsBuf), (0, static_data_js_1.readTables)(tablesBuf, [exports.TABLE_ITEMS, exports.TABLE_UNITS, exports.TABLE_HERO_AVATARS, exports.TABLE_TECHS, exports.TABLE_CAPTAINS, exports.TABLE_CUSTOMIZATIONS, exports.TABLE_ARTIFACTS, exports.TABLE_EQUIPMENT]), en);
    fs_1.default.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs_1.default.writeFileSync(tmp, JSON.stringify(data));
    fs_1.default.renameSync(tmp, file);
    pruneCaches(dir, 2);
    return data;
}
function cacheFiles(dir) {
    if (!fs_1.default.existsSync(dir))
        return [];
    return fs_1.default.readdirSync(dir)
        .filter((f) => /^static-.+\.json$/.test(f))
        .map((f) => path_1.default.join(dir, f))
        .sort((a, b) => fs_1.default.statSync(b).mtimeMs - fs_1.default.statSync(a).mtimeMs);
}
function newestCache(dir) {
    const f = cacheFiles(dir)[0];
    return f ? JSON.parse(fs_1.default.readFileSync(f, 'utf8')) : null;
}
function pruneCaches(dir, keep) {
    for (const f of cacheFiles(dir).slice(keep)) {
        try {
            fs_1.default.unlinkSync(f);
        }
        catch {
            // another process may have removed it; nothing to do
        }
    }
}
//# sourceMappingURL=art-static.js.map