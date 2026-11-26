"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.NAMES_FORMAT = exports.BASE_RESOURCE_MAX_ID = exports.VIP_ITEM_KIND = exports.SPEEDUP_ITEM_KINDS = exports.TABLE_EFFECTS = exports.TABLE_TITLES = exports.TABLE_DRAGONS = exports.TABLE_FACTIONS = exports.TABLE_HERO_LEVELS = exports.TABLE_EQUIPMENT = exports.TABLE_ARTIFACT_BONUSES = exports.TABLE_ARTIFACT_LEVELS = exports.TABLE_ARTIFACT_STARS = exports.TABLE_ARTIFACTS = exports.TABLE_TOURNAMENTS = exports.TABLE_CLAN_MEDALS = exports.TABLE_CAPTAINS = exports.TABLE_TECHS = exports.TABLE_HEROES = exports.TABLE_GIFT_TYPES = exports.TABLE_TERRAINS = exports.TABLE_MAP_OBJECTS = void 0;
exports.fetchStaticVersion = fetchStaticVersion;
exports.unzipFirst = unzipFirst;
exports.parseTranslationsCsv = parseTranslationsCsv;
exports.fetchCatalogTexts = fetchCatalogTexts;
exports.catalogOfNamesKey = catalogOfNamesKey;
exports.readTables = readTables;
exports.asIdRecord = asIdRecord;
exports.buildNames = buildNames;
exports.buildSpeeds = buildSpeeds;
exports.nameTexts = nameTexts;
exports.buildNamesInLanguages = buildNamesInLanguages;
exports.textLines = textLines;
exports.buildTitles = buildTitles;
exports.fixedResourceGrants = fixedResourceGrants;
exports.readItem = readItem;
exports.buildDragon = buildDragon;
exports.buildEvents = buildEvents;
exports.buildHeroLevels = buildHeroLevels;
exports.conditionTexts = conditionTexts;
exports.buildFactions = buildFactions;
exports.clearGameNamesRetry = clearGameNamesRetry;
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
 *   T8  gift types    f3 chest name vector, f14 source template vector — and every
 *                     other item: f1 kind, f8/f12 duration, f10 quality, f7 grants
 *                     (see GameItem; a chest's rewards are T8 items too)
 *   T13 hero avatars  f1 name vector, f3 icon string
 *   T21 techs         f1 name vector, f5 levels (research + hero talents)
 *   T11 equipment     see TABLE_EQUIPMENT (gems/enchantments are T8 items)
 *   T75 captains      see TABLE_CAPTAINS
 *   T110–T113         artifacts (types, star levels, levels, random-bonus pools)
 *                     — `$pairs` tables keyed `[type]`, see TABLE_ARTIFACTS
 *   T29 titles        see TABLE_TITLES
 *
 * The raw files are ~67 MB, so a rebuild happens only when the game ships new
 * static data: the result is a small names.json cached under
 * data/game-static/<version>/; the raw files are only ever held in memory. Decoding skips
 * every table we don't need without building it, which keeps a rebuild inside
 * the container's heap. Full background: docs/game-protocol.md.
 *
 * The same rebuild writes texts-<lang>.json beside names.json: the names in
 * German, Spanish, French and Russian from the game's own translation CSVs,
 * for tGame() on the site (game-texts.ts).
 */
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const zlib_1 = __importDefault(require("zlib"));
const codec_js_1 = require("./codec.js");
const client_config_js_1 = require("./client-config.js");
const game_texts_js_1 = require("./game-texts.js");
const logger_js_1 = require("../utils/logger.js");
const status_js_1 = require("../game-patch/status.js");
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
 * Tournaments (events): $pairs keyed `[[type, run], stage]` → f10 the event's
 * client config JSON, whose `info_title` is its title key
 * ("global_tournament.client.value.clandoom_epic.info.title" → "Rise of the
 * Ancients"). The `[type, run]` pair is what the event messages (24001 list,
 * 38003 clan-member standings) carry. Found Nov 2026.
 */
exports.TABLE_TOURNAMENTS = 44;
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
/**
 * The game's Heroes (the client's `StaticAll.Heroes`, HeroStatic): the hero
 * (row 1) and every captain (row = its T75 id; f15 battler unit id). Keyed by
 * the id city field 9 lists. f7 = its 600 levels (HeroLevelStatic), each
 * `[level, expRequired (cumulative, "…n" past 2^53), reward, leadership,
 * authority, dominance, effectId, clientInfo, ratingContribution]` — the
 * Stats screen shows leadership / authority / dominance ÷ 100 (Carter level
 * 200: 4,000,000 → "Leadership 40,000"). See docs/game-protocol.md.
 */
exports.TABLE_HERO_LEVELS = 10;
/**
 * The Hall of Fame's factions: `[id, …, visualRef, techId]` — f4 a JSON string
 * ({banner, frameIcon, icon, stainedGlass, tooltipDescription:
 * "battler_fraction.tooltip.<key>"}), f5 the city TECH that holds the
 * faction's level: 1 Lions of Courage → 800, 2 Eagles of Resolve → 802,
 * 3 Wolves of Tenacity → 801. The ids are the captains' T75 f1 faction. The
 * Hall of Fame itself is tech 803, whose levels require
 * `HasFractionLevel(800,801,802,N)`. Every member's city techs (field 17)
 * carry them, so the levels are in game_player_techs like research.
 */
exports.TABLE_FACTIONS = 78;
/**
 * The Dragon (city field 26), one row (key 1):
 *   f2 its 300 levels `{level: [level, xpRequired (cumulative), effectId,
 *      textRef, 0]}` — the text is JSON `{"effect_strings": [{id, text, value}]}`,
 *      the bonuses AT that level (ids 0–9: Army strength, Army health,
 *      Strength / Health against players, Leadership, Authority, Dominance,
 *      Experience / Valor / Conquest points; `value` in percent);
 *   f3 its 8 evolution stages `{stage: [stage, levelCap, cost, effectId,
 *      textRef, …]}` (caps 20 / 50 / 100 / 150 / 200 / 250 / 300 / 300) — the
 *      text adds the stage's sprites: `icon_linkage` (icon_red_dragon_<s>),
 *      `full_dragon_linkage` (red_dragon_<s>);
 *   f4 the window's config JSON: `icon_frame_linkage` (frame_icon_red_dragon),
 *      `background_linkage` (red_dragon_back) and its title keys.
 * A dragon at its stage's cap gains no XP until it evolves: prod holds them at
 * exactly the cap level's threshold (L100 1,404,294,900). See docs/game-protocol.md.
 */
exports.TABLE_DRAGONS = 73;
/**
 * Titles (TitleStatic, 244 rows; a player's 402 field 19 / city field 21 hold
 * their ids — game-protocol/titles.ts):
 *   f0 id, f1 name vector, f2 description vector (the bonus lines, `\n`
 *   between them), f3 visual JSON {smallIcon (round, 28 px, an atlas sprite),
 *   bigIcon, mobileIcon / rewardIcon (72 px)}, f4 effect, f5 hidden in the
 *   palace, f6 max owners, f7 timeActive (seconds; 0 = no set end), f8
 *   unassignable on voting, f9 client config JSON, f10 main tournament title,
 *   f11 palace cooldown, f12 source vector ("Received from the Loyalty
 *   Bonus"), f13 blocked by title, f14 city visual.
 * Id 29 is the Loyalty Bonus's "Prefect": +50% Valor, Conquest and Experience
 * points for 7 days (604800).
 */
exports.TABLE_TITLES = 29;
/**
 * T20 Effects: f3 `[[kind, textRef, [], [cond], 0, value, flat]]` — value a
 * multiplier ×10000 (10050 = +0.5 %). Kind 0 is construction speed, 2 troop
 * training speed, 17 research speed (a city's field 14 lists the effects it
 * has; city-speeds.ts sums them the way the game's Statistics page does).
 */
exports.TABLE_EFFECTS = 20;
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
    exports.TABLE_TOURNAMENTS,
    exports.TABLE_TERRAINS,
    exports.TABLE_HERO_LEVELS,
    exports.TABLE_FACTIONS,
    exports.TABLE_DRAGONS,
    exports.TABLE_TITLES,
    exports.TABLE_EFFECTS,
    // The client config, for the tech trees' and Academy tabs' names (game-texts).
    client_config_js_1.TABLE_CLIENT_CONFIG,
];
/** Item kinds (T8 f1) whose f8 is a duration in seconds: Speedup, Clan Speedup. */
exports.SPEEDUP_ITEM_KINDS = new Set([3, 11]);
/** VIP status (T8 f1); its duration is f12. */
exports.VIP_ITEM_KIND = 6;
/**
 * Items below this id are the base resources and currencies (Gold 1, Silver 2,
 * Lumber 3, Iron 4, Stone 5, Food 6, Tar 13, Dragon Coins 30, Epic Tar 32,
 * Rare Tar 34, Sacred Potion 35) — the same line the art pipeline draws
 * (RESOURCE_ITEM_MAX_ID, game-art/selection.ts).
 */
exports.BASE_RESOURCE_MAX_ID = 100;
/**
 * Bump when names.json gains a field the app reads (2: captain star bonuses
 * and rarity labels; 3: clan medals; 4: artifacts, equipment, gems; 5: event
 * titles (T44); 6: terrain names; 7: hero and captain levels — XP thresholds,
 * Stats, Might; 8: the Hall of Fame's factions and the real names of techs
 * 800–803; 9: the Dragon (T73); 10: items — kind, quality grade, resource pack
 * amounts and speedup durations, for the chest rewards; 11: titles (T29);
 * 12: texts-<lang>.json beside it, the names in the site's other languages;
 * 13: speeds — what each effect adds to construction, training and research
 * speed — Nov 2026); a cached file with an older format is rebuilt.
 */
exports.NAMES_FORMAT = 13;
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
/**
 * Parse "key","text" CSV (quoted fields, "" escapes, newlines allowed in
 * quotes). `keep` limits the result to those keys — a language's CSV holds
 * ~25,000 texts and the names use a few thousand.
 */
function parseTranslationsCsv(text, keep) {
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
        if (key && (!keep || keep.has(key)))
            out.set(key, value);
    }
    return out;
}
async function fetchTranslationsIndex(catalog) {
    const index = JSON.parse((await fetchBuffer(TRANSLATIONS_BASE + catalog)).toString('utf8'));
    return index.files ?? [];
}
/** One language's translations zip (the index's `name`, e.g. csv_de_DE). */
async function fetchTranslationsZip(index, name) {
    const entry = index.find((f) => f.name === name);
    if (!entry)
        throw new Error(`translations index has no ${name}`);
    return fetchBuffer(TRANSLATIONS_BASE + entry.fileName);
}
/**
 * One translations catalogue's texts ("49206e7320e37a92.json"): every English
 * text, or a language's texts limited to `keep`. The CDN keeps a catalogue's
 * files after the next patch, which is what lets the patch notes compare two
 * of them (game-patch/notes.ts).
 */
async function fetchCatalogTexts(catalog, lang, keep) {
    const index = await fetchTranslationsIndex(catalog);
    const zip = await fetchTranslationsZip(index, lang === 'en' ? ENGLISH : game_texts_js_1.GAME_TEXT_LANGUAGES[lang]);
    return parseTranslationsCsv(unzipFirst(zip).toString('utf8'), keep);
}
/** The translations catalogue a names version key was built from ("…-49206e7320e37a92" → "49206e7320e37a92.json"). */
function catalogOfNamesKey(key) {
    const m = /^[0-9a-f]{16}-([0-9a-z]+)$/i.exec(key);
    return m ? `${m[1]}.json` : null;
}
/** A language's zip, or null (logged) when it can't be had — the names never wait on a translation. */
async function fetchLanguageZip(index, lang) {
    for (let attempt = 1;; attempt++) {
        try {
            return await fetchTranslationsZip(index, game_texts_js_1.GAME_TEXT_LANGUAGES[lang]);
        }
        catch (err) {
            if (attempt >= 2) {
                log.warn({ noAlert: true }, `Game texts: no ${lang} translations (${String(err)}); its names stay English until the next build.`);
                return null;
            }
        }
    }
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
 * that id, the same shape as the others. An array table (T1, the client
 * config) comes back keyed by row index.
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
        const v = r.value();
        const t = Array.isArray(v) ? Object.fromEntries(v.map((row, k) => [String(k), row])) : asIdRecord(v);
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
        // A composite key ([[type, run], stage] in T44) joins its numbers: "1024,1,1".
        else if (Array.isArray(id)) {
            const flat = id.flat(2);
            if (flat.length && flat.every((x) => typeof x === 'number'))
                rec[flat.join(',')] = v;
        }
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
    const items = {};
    for (const [id, row] of rows(exports.TABLE_GIFT_TYPES)) {
        const chest = vecText(row[3]);
        if (!chest)
            continue;
        gifts[id] = { chest, source: vecTemplate(row[14]) ?? '' };
        const item = readItem(row);
        if (item)
            items[id] = item;
    }
    const techs = {};
    for (const [id, row] of rows(exports.TABLE_TECHS)) {
        const name = vecText(row[1]);
        const levels = row[5];
        if (name)
            techs[id] = { name, maxLevel: levels && typeof levels === 'object' && !Array.isArray(levels) ? Object.keys(levels).length : 0 };
    }
    // The Hall of Fame. Its techs' own name vectors are placeholders ("Ranged
    // units' strength I" for the Lions' tech 800), which every research list
    // would show — they take the factions' real names.
    const { factions, hallOfFame } = buildFactions(tables, str, en);
    for (const f of [...Object.values(factions), ...(hallOfFame ? [hallOfFame] : [])]) {
        techs[String(f.techId)] = { name: f.name, maxLevel: f.maxLevel };
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
        const starMight = {};
        const starRows = row[12];
        if (starRows && typeof starRows === 'object' && !Array.isArray(starRows)) {
            for (const [star, sr] of Object.entries(starRows)) {
                if (!Array.isArray(sr))
                    continue;
                if (typeof sr[8] === 'number')
                    starMight[star] = sr[8];
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
            starMight,
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
    const dragon = buildDragon(tables.get(exports.TABLE_DRAGONS), str, en);
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
        items,
        events: buildEvents(tables.get(exports.TABLE_TOURNAMENTS), str, en),
        heroLevels: buildHeroLevels(rows(exports.TABLE_HERO_LEVELS)),
        factions, ...(hallOfFame ? { hallOfFame } : {}),
        ...(dragon ? { dragon } : {}),
        titles: buildTitles(tables.get(exports.TABLE_TITLES), str, vec, en),
        speeds: buildSpeeds(tables.get(exports.TABLE_EFFECTS), rows(exports.TABLE_TECHS)),
    };
}
/** Effect kinds (T20 f3 entry [0]) behind the Statistics page's three speeds. */
const SPEED_KIND = { construction: 0, training: 2, research: 17 };
/**
 * What every effect adds to construction, troop training and research speed,
 * and which research levels carry such an effect. Checked against the game's
 * Statistics page (Nov 26 2026: research 2026.3 %, construction 1345.8 %):
 * every construction and research entry counts; for training only the
 * general one — the entries whose text is a troop type's own ("Guardsmen's
 * training speed") apply to that type alone. The general text is the one
 * research speed always uses. Pure.
 */
function buildSpeeds(effects, techRows) {
    const entriesOf = (row) => (Array.isArray(row) && Array.isArray(row[3]) ? row[3].filter((e) => Array.isArray(e)) : []);
    const textCount = new Map();
    for (const row of Object.values(effects ?? {})) {
        for (const e of entriesOf(row))
            if (e[0] === SPEED_KIND.research)
                textCount.set(e[1], (textCount.get(e[1]) ?? 0) + 1);
    }
    const general = [...textCount].sort((a, b) => b[1] - a[1])[0]?.[0];
    const round = (v) => Math.round(v * 100) / 100;
    const out = { effects: {}, techs: {} };
    for (const [id, row] of Object.entries(effects ?? {})) {
        const sum = [0, 0, 0];
        for (const e of entriesOf(row)) {
            if (typeof e[5] !== 'number' || e[5] === 0)
                continue;
            const pct = (e[5] - 10000) / 100;
            if (e[0] === SPEED_KIND.construction)
                sum[0] += pct;
            else if (e[0] === SPEED_KIND.training && e[1] === general)
                sum[1] += pct;
            else if (e[0] === SPEED_KIND.research)
                sum[2] += pct;
        }
        if (sum.some((v) => v !== 0))
            out.effects[id] = [round(sum[0]), round(sum[1]), round(sum[2])];
    }
    for (const [id, row] of techRows) {
        const levels = row[5];
        if (!levels || typeof levels !== 'object' || Array.isArray(levels))
            continue;
        const byLevel = {};
        for (const lv of Object.values(levels)) {
            if (Array.isArray(lv) && typeof lv[0] === 'number' && typeof lv[1] === 'number' && out.effects[String(lv[1])])
                byLevel[String(lv[0])] = lv[1];
        }
        if (Object.keys(byLevel).length)
            out.techs[id] = byLevel;
    }
    return out;
}
/**
 * Everything the names build shows as text, for one translation lookup: the
 * names, the tech trees' names and their Academy tabs (T1). Built once per
 * language and walked against the English build (game-texts.ts), so templated
 * names come out concrete on both sides. Pure.
 */
function nameTexts(version, strings, vectors, tables, lookup) {
    const str = (ref) => (typeof ref === 'number' && typeof strings[ref] === 'string' ? strings[ref] : undefined);
    const t1 = tables.get(client_config_js_1.TABLE_CLIENT_CONFIG);
    return {
        names: buildNames(version, strings, vectors, tables, lookup),
        trees: (0, client_config_js_1.readBranchDefs)(t1, str, lookup).map((b) => b.name),
        tabs: [...(0, client_config_js_1.academyTabs)(t1, str, lookup).values()],
    };
}
/** A build's texts without the fields that are not text (version, build time, numbers-only tables). */
function textParts(t) {
    const { version: _v, builtAt: _b, format: _f, heroLevels: _h, items: _i, ...rest } = t.names;
    return { names: rest, trees: t.trees, tabs: t.tabs };
}
/**
 * The names build in every site language: the English build (with a lookup
 * that records each translation key it reads) and each language's CSV,
 * keeping only those keys, behind that language's own build. `languageCsv`
 * hands over one language's CSV text at a time (unzipped only when asked);
 * a language it has none for is left out. Pure; unit-tested.
 */
function buildNamesInLanguages(version, strings, vectors, tables, en, languageCsv) {
    const used = new Set();
    const recording = {
        get: (k) => {
            used.add(k);
            return en.get(k);
        },
    };
    const english = nameTexts(version, strings, vectors, tables, recording);
    const collapse = (s) => s.replace(/\s+/g, ' ').trim();
    const englishTexts = new Set();
    for (const k of used) {
        const v = en.get(k);
        if (v)
            englishTexts.add(collapse(v));
    }
    const keep = new Set([...used, ...game_texts_js_1.UI_TEXT_KEYS.map((u) => u.key)]);
    const englishParts = textParts(english);
    const texts = new Map();
    let drift = [];
    for (const lang of game_texts_js_1.GAME_TEXT_LANGUAGE_CODES) {
        const csv = languageCsv(lang);
        if (!csv)
            continue;
        const loc = parseTranslationsCsv(csv, keep);
        // A key the language lacks (or leaves empty) reads as the English, so the
        // build keeps its shape — but that English is no translation, and must
        // not stand in for one (it would override a hand-kept name).
        const untranslated = new Set();
        const lookup = {
            get: (k) => {
                const v = loc.get(k);
                if (v)
                    return v;
                const e = en.get(k);
                if (e)
                    untranslated.add(collapse(e));
                return e;
            },
        };
        const localized = textParts(nameTexts(version, strings, vectors, tables, lookup));
        const translated = new Set([...englishTexts].filter((t) => !untranslated.has(t)));
        const labels = (0, game_texts_js_1.labelTexts)(game_texts_js_1.UI_TEXT_KEYS, en, loc);
        drift = labels.drift;
        texts.set(lang, (0, game_texts_js_1.buildGameTexts)({ lang, pairs: (0, game_texts_js_1.pairTexts)(englishParts, localized), englishTexts: translated, labels: labels.labels }));
    }
    return { names: english.names, texts, drift };
}
/**
 * The game's text of a localised vector with its line breaks kept: the
 * translation files write a break as the two characters `\n`. Each line's
 * spaces collapse; empty lines go. Placeholders are filled like a name's.
 */
function textLines(v, str, en) {
    if (!v?.length)
        return '';
    const key = str(v[0]);
    let out = key === undefined ? '' : (en.get(key) ?? '');
    for (let i = 1; i + 1 < v.length; i += 2)
        out = out.replace(str(v[i]) ?? '\u0000', str(v[i + 1]) ?? '');
    return out
        .split(/\\n|\r?\n/)
        .map((l) => l.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join('\n');
}
/**
 * Titles (T29, see TABLE_TITLES): every row whose name has English text — the
 * few without one are test rows ("test_pvp_a").
 */
function buildTitles(table, str, vec, en) {
    const out = {};
    for (const [id, row] of Object.entries(table ?? {})) {
        if (!Array.isArray(row))
            continue;
        const nameKey = str(vec(row[1])?.[0] ?? -1);
        if (!nameKey || !en.get(nameKey))
            continue;
        const name = textLines(vec(row[1]), str, en).replace(/\n/g, ' ');
        let visual = {};
        try {
            visual = JSON.parse(str(row[3]) ?? '{}');
        }
        catch { /* no visual */ }
        const icon = typeof visual.smallIcon === 'string' ? visual.smallIcon : '';
        const art = typeof visual.mobileIcon === 'string' && visual.mobileIcon
            ? visual.mobileIcon
            : typeof visual.rewardIcon === 'string' ? visual.rewardIcon : '';
        out[id] = {
            name,
            description: textLines(vec(row[2]), str, en),
            source: textLines(vec(row[12]), str, en).replace(/\n/g, ' '),
            seconds: typeof row[7] === 'number' && row[7] > 0 ? row[7] : 0,
            icon,
            art,
        };
    }
    return out;
}
const isPositive = (v) => typeof v === 'number' && v > 0;
/** An empty map or list — or no container at all (a number, a string, nothing). */
function isEmptyCell(v) {
    if (Array.isArray(v))
        return v.length === 0;
    if (v && typeof v === 'object')
        return Object.keys(v).length === 0;
    return true;
}
/**
 * T8 f7 → the resources the item always gives, when that is ALL it gives:
 * exactly one entry (no draw) whose payload grants only base resources (ids
 * below BASE_RESOURCE_MAX_ID) and no units, items or timed effects. A chest's
 * weighted draw, a booster's effect or a pack of other items is no fixed
 * resource grant: undefined.
 */
function fixedResourceGrants(f7) {
    if (!Array.isArray(f7) || f7.length !== 1 || !Array.isArray(f7[0]) || f7[0].length !== 1)
        return undefined;
    const entry = f7[0][0];
    if (!Array.isArray(entry) || !Array.isArray(entry[2]))
        return undefined;
    const payload = entry[2];
    const grants = payload[0];
    if (!grants || typeof grants !== 'object' || Array.isArray(grants) || '$pairs' in grants)
        return undefined;
    // The payload cells after the resource map that can grant something else:
    // [1] units, [2]/[3] item lists, [9] and [15] maps, [11] timed effects (a booster's).
    if (![1, 2, 3, 9, 11, 15].every((i) => isEmptyCell(payload[i])))
        return undefined;
    const out = {};
    for (const [id, amount] of Object.entries(grants)) {
        const n = Number(id);
        if (!Number.isInteger(n) || n <= 0 || n >= exports.BASE_RESOURCE_MAX_ID || !isPositive(amount))
            return undefined;
        out[id] = amount;
    }
    return Object.keys(out).length ? out : undefined;
}
/** One T8 row → its GameItem; null when the row has no kind. */
function readItem(row) {
    const kind = row[1];
    if (typeof kind !== 'number')
        return null;
    const item = { kind };
    if (isPositive(row[10]))
        item.quality = row[10];
    const seconds = exports.SPEEDUP_ITEM_KINDS.has(kind) ? row[8] : kind === exports.VIP_ITEM_KIND ? row[12] : undefined;
    if (isPositive(seconds))
        item.seconds = seconds;
    const grants = fixedResourceGrants(row[7]);
    if (grants)
        item.grants = grants;
    return item;
}
/** A T73 text's effect_strings → [translation key, value] in id order; [] when it has none. */
function effectStrings(json) {
    let parsed = {};
    try {
        parsed = JSON.parse(json ?? '{}');
    }
    catch {
        return [];
    }
    return (parsed.effect_strings ?? [])
        .filter((e) => typeof e.text === 'string' && typeof e.value === 'number')
        .sort((a, b) => Number(a.id) - Number(b.id))
        .map((e) => [e.text, e.value]);
}
/**
 * T73 → the Dragon: XP thresholds and bonuses per level, the evolution stages
 * with their caps, bonuses and sprites. Null when the table lacks a usable row
 * (levels must run 1…N without a gap, or the index-by-level arrays would lie).
 * Pure; unit-tested.
 */
function buildDragon(table, str, en) {
    const row = table?.['1'];
    if (!Array.isArray(row) || !isPlainObject(row[2]))
        return null;
    const levels = Object.values(row[2])
        .filter((e) => Array.isArray(e) && typeof e[0] === 'number')
        .sort((a, b) => a[0] - b[0]);
    if (!levels.length || levels.some((e, i) => e[0] !== i + 1))
        return null;
    // The bonus lines are named by the first level's effect_strings; every
    // level and stage lists the same ten keys in the same order.
    const keys = effectStrings(str(levels[0][3])).map(([k]) => k);
    const valuesOf = (json) => {
        const byKey = new Map(effectStrings(json));
        return keys.map((k) => byKey.get(k) ?? 0);
    };
    const xp = [];
    const levelBonuses = [];
    for (const e of levels) {
        xp.push(wireNumber(e[1]) ?? 0);
        levelBonuses.push(valuesOf(str(e[3])));
    }
    const stages = {};
    for (const [stage, s] of Object.entries(isPlainObject(row[3]) ? row[3] : {})) {
        if (!Array.isArray(s) || typeof s[1] !== 'number')
            continue;
        const json = str(s[4]);
        let sprites = {};
        try {
            sprites = JSON.parse(json ?? '{}');
        }
        catch { /* no sprites */ }
        stages[stage] = {
            levelCap: s[1],
            bonuses: valuesOf(json),
            icon: typeof sprites.icon_linkage === 'string' ? sprites.icon_linkage : '',
            art: typeof sprites.full_dragon_linkage === 'string' ? sprites.full_dragon_linkage : '',
        };
    }
    let cfg = {};
    try {
        cfg = JSON.parse(str(row[4]) ?? '{}');
    }
    catch { /* no config */ }
    const nameKey = typeof cfg.dragon_name_title === 'string' ? cfg.dragon_name_title : '';
    return {
        name: (nameKey && en.get(nameKey)) || 'Dragon',
        bonusNames: keys.map((k) => en.get(k) ?? k),
        xp,
        levelBonuses,
        stages,
        art: {
            frame: typeof cfg.icon_frame_linkage === 'string' ? cfg.icon_frame_linkage : '',
            back: typeof cfg.background_linkage === 'string' ? cfg.background_linkage : '',
        },
    };
}
/**
 * T44 → "type,run" → code, title key and English title. Rows are keyed
 * "type,run,stage" (asIdRecord joins the composite key); the first stage of a
 * run names it. The title is the config's `info_title` key.
 */
function buildEvents(table, str, en) {
    const out = {};
    for (const [key, row] of Object.entries(table ?? {})) {
        const m = /^(\d+),(\d+)(?:,\d+)?$/.exec(key);
        if (!m || !Array.isArray(row))
            continue;
        const id = `${m[1]},${m[2]}`;
        if (out[id])
            continue;
        let cfg = {};
        try {
            cfg = JSON.parse(str(row[10]) ?? '{}');
        }
        catch {
            continue;
        }
        const titleKey = typeof cfg.info_title === 'string' ? cfg.info_title : '';
        if (!titleKey)
            continue;
        const code = /^global_tournament\.client\.value\.([a-z0-9_]+)\./.exec(titleKey)?.[1] ?? '';
        out[id] = { code, titleKey, title: en.get(titleKey) ?? '' };
    }
    return out;
}
/** A wire number as a JS number; past 2^53 the codec hands "…n" strings — approximate is fine there. */
const wireNumber = (v) => {
    if (typeof v === 'number')
        return v;
    if (typeof v === 'string' && /^-?\d+n$/.test(v))
        return Number(v.slice(0, -1));
    return null;
};
/**
 * T10 (Heroes) → the level series of the hero and every captain, each
 * distinct series stored once. A row without a usable 600-level f7 is skipped.
 */
function buildHeroLevels(heroRows) {
    const series = [];
    const seen = new Map();
    const intern = (values) => {
        const key = values.join(',');
        let i = seen.get(key);
        if (i === undefined) {
            i = series.length;
            series.push(values);
            seen.set(key, i);
        }
        return i;
    };
    const heroes = {};
    for (const [id, row] of heroRows) {
        const levels = Array.isArray(row[7]) ? row[7].filter((e) => Array.isArray(e) && typeof e[0] === 'number') : [];
        if (!levels.length)
            continue;
        levels.sort((a, b) => a[0] - b[0]);
        // Contiguous from level 1, or the index-by-level arrays would lie.
        if (levels.some((e, i) => e[0] !== i + 1))
            continue;
        const col = (c, scale = 1) => levels.map((e) => {
            const n = wireNumber(e[c]);
            return n === null ? 0 : scale === 1 ? n : Math.round(n / scale);
        });
        heroes[id] = {
            xp: intern(col(1)),
            leadership: intern(col(3, 100)),
            authority: intern(col(4, 100)),
            dominance: intern(col(5, 100)),
            might: intern(col(8)),
        };
    }
    return { series, heroes };
}
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && !('$bin' in v) && !('$pairs' in v);
/**
 * The game's own texts for what reaching a tech level requires, from its
 * condition strings. "HasTech(…)" on the level before is left out (implied);
 * an unknown condition is left out rather than shown raw.
 *   HasCaptainFractionRarityLevel(lvl, faction, rarity, count)
 *     → "Level 150 epic, legendary or mythic Captains of this faction needed: 2"
 *   HasFractionLevel(800,801,802, lvl) → "Required level of all factions: 46"
 */
function conditionTexts(conds, en) {
    const out = [];
    for (const cond of conds) {
        for (const part of cond.split('&&').map((p) => p.trim())) {
            const captains = /^HasCaptainFractionRarityLevel\((\d+),(\d+),(\d+),(\d+)\)$/.exec(part);
            if (captains) {
                // Rarity 2 = epic and up; 3 = legendary and up (T75 f2: 1 rare … 4 mythic).
                const key = Number(captains[3]) >= 3 ? 'legendary' : 'epic';
                const tpl = en.get(`client_config.value.conditions.has_captain_fraction_rarity_level.${key}`);
                if (tpl)
                    out.push(tpl.replace('%lvl%', captains[1]).replace('%count%', captains[4]));
                continue;
            }
            const all = /^HasFractionLevel\((?:\d+,)+(\d+)\)$/.exec(part);
            if (all) {
                const tpl = en.get('client.conditions.has_fraction_level');
                if (tpl)
                    out.push(tpl.replace('%lvl%', all[1]));
            }
        }
    }
    return out;
}
/**
 * The Hall of Fame from the static data: the three factions (T78 → their
 * techs' levels) and the Hall of Fame tech (the one whose levels require
 * `HasFractionLevel(…)`). Per level: the bonuses at that level and the game's
 * texts for its requirements. Pure; unit-tested.
 */
function buildFactions(tables, str, en) {
    const techRows = tables.get(exports.TABLE_TECHS) ?? {};
    const levelled = (techId, name) => {
        const row = techRows[String(techId)];
        const lv = Array.isArray(row) ? row[5] : undefined;
        if (!lv || !isPlainObject(lv))
            return null;
        const levels = {};
        for (const [level, r] of Object.entries(lv)) {
            if (!Array.isArray(r))
                continue;
            // [level, effectId, …, [conditionRefs], propsRef, …]
            let props = [];
            try {
                props = JSON.parse(str(r[4]) ?? '{}').props ?? [];
            }
            catch { /* no props */ }
            const lines = props
                .filter((p) => typeof p.propText === 'string' && p.propText)
                .map((p) => [en.get(p.propText) ?? p.propText, String(p.propValue ?? '')]);
            const conds = (Array.isArray(r[3]) ? r[3] : []).map((c) => str(c)).filter((c) => !!c);
            levels[level] = { lines, requires: conditionTexts(conds, en) };
        }
        return { techId, name, maxLevel: Object.keys(levels).length, levels };
    };
    const factions = {};
    for (const [id, row] of Object.entries(tables.get(exports.TABLE_FACTIONS) ?? {})) {
        if (!Array.isArray(row) || typeof row[5] !== 'number')
            continue;
        let visual = {};
        try {
            visual = JSON.parse(str(row[4]) ?? '{}');
        }
        catch { /* no visual */ }
        const key = /battler_fraction\.tooltip\.([a-z_]+)/.exec(visual.tooltipDescription ?? '')?.[1] ?? '';
        const name = (key && en.get(`battler_fraction.description.${key}`)) || `#${id}`;
        const tech = levelled(row[5], name);
        if (!tech)
            continue;
        factions[id] = {
            ...tech,
            id: Number(id),
            key,
            art: { stainedGlass: visual.stainedGlass ?? '', icon: visual.icon ?? '', banner: visual.banner ?? '', frameIcon: visual.frameIcon ?? '' },
        };
    }
    let hallOfFame = null;
    for (const [id, row] of Object.entries(techRows)) {
        const lv = Array.isArray(row) ? row[5] : undefined;
        if (!lv || !isPlainObject(lv))
            continue;
        const first = Object.values(lv)[0];
        const conds = Array.isArray(first) && Array.isArray(first[3]) ? first[3].map((c) => str(c) ?? '') : [];
        if (conds.some((c) => c.startsWith('HasFractionLevel('))) {
            hallOfFame = levelled(Number(id), en.get('client.fractions_hall.title') ?? 'Hall of Fame');
            break;
        }
    }
    return { factions, hallOfFame };
}
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
 * A rebuild in flight: clans on different accounts scan at the same time
 * (scan-lanes.ts), and after a game patch each would otherwise download and
 * decode the ~67 MB of static data on its own.
 */
let building = null;
/**
 * Versions whose last build lacked a language's texts (its CSV could not be
 * fetched), and when the next try may run: a missing language rebuilds, but
 * never more often than this — each rebuild downloads the ~67 MB again.
 */
const textsRetryAt = new Map();
const TEXTS_RETRY_MS = 6 * 3600_000;
/** A patch whose names failed to build; retried after FAILED_BUILD_RETRY_MS. */
let failedBuild = null;
const FAILED_BUILD_RETRY_MS = 30 * 60_000;
/** Lift the retry wait (System → Game Patch → Check now). */
function clearGameNamesRetry() {
    failedBuild = null;
}
/** Every site language's texts were written with these names — or a rebuild for them waits its turn. */
function textsSettled(names, key) {
    if (game_texts_js_1.GAME_TEXT_LANGUAGE_CODES.every((l) => names.textLanguages?.includes(l)))
        return true;
    return (textsRetryAt.get(key) ?? 0) > Date.now();
}
/**
 * Names for the live game version: from memory, else from the on-disk cache,
 * else rebuilt from the CDN. Falls back to the newest cached names when the
 * versions endpoint can't be reached or a patch's names can't be built,
 * because stale names beat no names; throws only when there are none at all.
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
    if (memo?.version === key && textsSettled(memo, key))
        return memo;
    const file = path_1.default.join(staticDir(), key, 'names.json');
    if (fs_1.default.existsSync(file)) {
        const cached = JSON.parse(fs_1.default.readFileSync(file, 'utf8'));
        // A names.json from an older format (before captains' star bonuses) is rebuilt once.
        if ((cached.format ?? 1) >= exports.NAMES_FORMAT && textsSettled(cached, key)) {
            memo = cached;
            (0, game_texts_js_1.useGameTextsDir)(path_1.default.dirname(file));
            (0, status_js_1.reportReaderOk)('names', key);
            return memo;
        }
    }
    if (failedBuild?.key === key && Date.now() - failedBuild.at < FAILED_BUILD_RETRY_MS) {
        const cached = memo ?? newestCachedNames();
        if (cached)
            return cached;
        throw new Error(failedBuild.error);
    }
    if (building?.key === key)
        return building.promise;
    // A patch whose names can't be built (a format change in the game's files)
    // serves the newest names on disk — stale names beat no names — and is
    // retried every FAILED_BUILD_RETRY_MS, not on every caller.
    const promise = buildAndCacheNames(version, key, file).then((names) => {
        failedBuild = null;
        (0, status_js_1.reportReaderOk)('names', key);
        return names;
    }, (err) => {
        failedBuild = { key, at: Date.now(), error: String(err) };
        const cached = memo ?? newestCachedNames();
        (0, status_js_1.reportReaderFailed)('names', key, cached?.version ?? null, err);
        if (cached)
            return cached;
        throw err;
    });
    building = { key, promise };
    try {
        return await promise;
    }
    finally {
        if (building?.promise === promise)
            building = null;
    }
}
async function buildAndCacheNames(version, key, file) {
    log.info(`Building game names for static data ${key} (downloads ~70 MB once per game patch)`);
    const started = Date.now();
    const index = await fetchTranslationsIndex(version.translationsCatalog);
    const [stringsBuf, vectorsBuf, tablesBuf, enZip, ...langZips] = await Promise.all([
        fetchBuffer(STATIC_BASE + version.files.strings),
        fetchBuffer(STATIC_BASE + version.files.vectors),
        fetchBuffer(STATIC_BASE + version.files.noDuplicates),
        fetchTranslationsZip(index, ENGLISH),
        ...game_texts_js_1.GAME_TEXT_LANGUAGE_CODES.map((l) => fetchLanguageZip(index, l)),
    ]);
    const zipOf = new Map(game_texts_js_1.GAME_TEXT_LANGUAGE_CODES.map((l, i) => [l, langZips[i]]));
    const en = parseTranslationsCsv(unzipFirst(enZip).toString('utf8'));
    const { names, texts, drift } = buildNamesInLanguages(key, readWrappedArray(stringsBuf), readWrappedArray(vectorsBuf), readTables(tablesBuf, NEEDED_TABLES), en, (lang) => {
        const zip = zipOf.get(lang);
        if (!zip)
            return null;
        try {
            return unzipFirst(zip).toString('utf8');
        }
        catch (err) {
            log.warn({ noAlert: true }, `Game texts: unreadable ${lang} translations (${String(err)}).`);
            return null;
        }
    });
    if (drift.length) {
        log.warn({ noAlert: true }, `Game texts: ${drift.length} UI label key(s) changed in the game, their tGame labels may show English: ${drift.join('; ')}`);
    }
    const dir = path_1.default.dirname(file);
    fs_1.default.mkdirSync(dir, { recursive: true });
    for (const [lang, dict] of texts)
        (0, game_texts_js_1.writeGameTexts)(dir, lang, key, dict);
    names.textLanguages = [...texts.keys()];
    if (texts.size < game_texts_js_1.GAME_TEXT_LANGUAGE_CODES.length)
        textsRetryAt.set(key, Date.now() + TEXTS_RETRY_MS);
    // names.json last: its presence says the texts beside it are as complete as they will get.
    fs_1.default.writeFileSync(file, JSON.stringify(names));
    (0, game_texts_js_1.useGameTextsDir)(dir, true);
    const heap = Math.round(process.memoryUsage().heapUsed / 1e6);
    log.info(`Game names ${key} built in ${Math.round((Date.now() - started) / 1000)}s (heap ${heap} MB): ` +
        `${Object.keys(names.gifts).length} gift types, ${Object.keys(names.techs).length} techs, ` +
        `${Object.keys(names.objects).length} map objects, ${Object.keys(names.heroes).length} heroes, ` +
        `${Object.keys(names.captains).length} captains, ${Object.keys(names.artifacts ?? {}).length} artifacts; ` +
        `texts ${[...texts].map(([l, d]) => `${l} ${Object.keys(d).length}`).join(', ') || 'none'}`);
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
    if (!files[0])
        return null;
    (0, game_texts_js_1.useGameTextsDir)(path_1.default.dirname(files[0]));
    return JSON.parse(fs_1.default.readFileSync(files[0], 'utf8'));
}
/** Test seam. */
function resetGameNamesMemo() {
    memo = null;
    failedBuild = null;
    textsRetryAt.clear();
}
//# sourceMappingURL=static-data.js.map