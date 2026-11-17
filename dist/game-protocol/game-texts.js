"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.textsFileName = exports.UI_TEXT_KEYS = exports.GAME_TEXTS_FORMAT = exports.GAME_TEXT_LANGUAGE_CODES = exports.GAME_TEXT_LANGUAGES = void 0;
exports.isGameTextLanguage = isGameTextLanguage;
exports.pairTexts = pairTexts;
exports.localQuotes = localQuotes;
exports.fillPattern = fillPattern;
exports.buildGameTexts = buildGameTexts;
exports.labelTexts = labelTexts;
exports.writeGameTexts = writeGameTexts;
exports.useGameTextsDir = useGameTextsDir;
exports.gameTextsResponse = gameTextsResponse;
exports.resetGameTexts = resetGameTexts;
/**
 * The game's own names in every site language — what tGame() shows.
 *
 * The site stores and computes with the game's ENGLISH names (scans, names.json)
 * and translates only where a name is displayed: tGame(englishName) in
 * src/web/public/lib/i18n.js. Its dictionary is built here, from the game's own
 * translation files — the same CSVs the game client downloads — so a German
 * player reads exactly the names their own client shows:
 *
 *   1. The names build (static-data.ts) runs once with the English CSV behind a
 *      recording lookup: names.json, plus the set of translation keys it used.
 *   2. Each language's CSV is parsed keeping only those keys (+ UI_TEXT_KEYS),
 *      and the SAME build runs again with that language in front of English.
 *   3. The two results are walked side by side (pairTexts): every string at the
 *      same position is an English → localized pair. Templated names come out
 *      concrete on both sides ("Level 15 epic Crypt" → "Epische Gruft Level 15"),
 *      so no template logic is repeated here; patterns with {n} — tGame's own
 *      pattern syntax — are derived from those pairs (buildGameTexts).
 *   4. The result is cached as texts-<lang>.json next to names.json, and served
 *      by GET /api/game-texts/<lang> (src/web/routes/game-texts.ts).
 *
 * The hand `game` block of lib/i18n/<lang>.js keeps only names the game's files
 * don't cover (the app's own shorthands like "Ancients"); the game's text wins
 * over it. Full background: docs/i18n.md.
 */
const crypto_1 = __importDefault(require("crypto"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
/** Site language → the game's translation file (its translations index `name`). */
exports.GAME_TEXT_LANGUAGES = {
    de: 'csv_de_DE',
    es: 'csv_es_ES',
    fr: 'csv_fr_FR',
    ru: 'csv_ru_RU',
};
exports.GAME_TEXT_LANGUAGE_CODES = Object.keys(exports.GAME_TEXT_LANGUAGES);
function isGameTextLanguage(v) {
    return typeof v === 'string' && Object.prototype.hasOwnProperty.call(exports.GAME_TEXT_LANGUAGES, v);
}
/** Bump when texts-<lang>.json changes shape; served files of another format are ignored. */
exports.GAME_TEXTS_FORMAT = 1;
/**
 * Labels the site shows through tGame that the names build never reaches —
 * the game client's own UI words, by translation key. `en` is the English the
 * site passes to tGame ({n} for a placeholder); the build keys the entry by it
 * and logs (once per build) when the game's English for the key has moved away
 * from it, so a renamed label is noticed instead of silently going English.
 */
exports.UI_TEXT_KEYS = [
    // Clan ranks (game-facts.js GAME_CLAN_RANKS)
    { key: 'client_config.value.clan.common.name_by_rank.1', en: 'Leader' },
    { key: 'client_config.value.clan.common.name_by_rank.2', en: 'Superior' },
    { key: 'client_config.value.clan.common.name_by_rank.3', en: 'Officer' },
    { key: 'client_config.value.clan.common.name_by_rank.4', en: 'Veteran' },
    { key: 'client_config.value.clan.common.name_by_rank.5', en: 'Soldier' },
    // Hall of Fame and the Dragon (member profile → Captains)
    { key: 'client.fractions_hall.altar_label', en: 'Level: {n}' },
    { key: 'client.fractions_hall.upgrade_fraction.bonuses.title', en: 'Faction bonuses' },
    { key: 'client.fractions_hall.upgrade_hall.bonuses.title', en: 'Hall of Fame bonuses' },
    { key: 'client_config.value.feature_dragon.evolve_tab_title_mobile', en: 'Evolution' },
    { key: 'client_config.value.feature_dragon.notification_evolution_required', en: "Raise your Dragon's evolution to unlock access to new levels." },
    { key: 'client_config.value.feature_dragon.max_level', en: 'Reached the maximum level of the Dragon.' },
    { key: 'client_config.value.feature_dragon.max_evolution', en: 'Reached the maximum evolution of the Dragon.' },
    // Troop groups (research tiers, the Guards column)
    { key: 'client_config.value.fort.tabs.0.name', en: 'Guardsmen' },
    { key: 'client_config.value.fort.tabs.1.name', en: 'Specialists' },
    { key: 'client_config.value.fort.tabs.name.monsters', en: 'Monsters' },
    // Events and features the site names
    { key: 'client.sabotage.monsters_tab.dark_omens.title', en: 'Dark Omens' },
    { key: 'client_config.value.watchtower.checklist.monster_suboption_stronghold', en: 'Citadels' },
    { key: 'client_config.value.help.windows.multistage.title', en: 'Trials of Olympus' },
    { key: 'client.battle_throne.info.title', en: 'Clash for the Throne' },
    { key: 'client.union_of_triumph.title', en: 'Union of Triumph' },
    { key: 'market_client_config.client_config.value.multistage_market_tab_1', en: 'Hermes' },
    // The Ancients' artifacts (Tools → Ancients), a troop trait, the Temple (Tools → Stacks)
    { key: 'global_tournament.client.value.clandoom.artifact.n0001.name_title', en: 'Tome of Knowledge' },
    { key: 'global_tournament.client.value.clandoom.artifact.n0002.name_title', en: 'Enchanted Figurine' },
    { key: 'global_tournament.client.value.clandoom.artifact.n0003.name_title', en: 'Mysterious Clock' },
    { key: 'client_config.value.unit_info.unit_traits.epic_monster_hunter', en: 'Epic Monster Hunter' },
    { key: 'building.name.n0018', en: 'Temple' },
];
/**
 * Walk two results of the same build — one English, one localized — side by
 * side and count every pair of strings at the same position. Objects pair by
 * key, arrays by index; anything present on one side only is skipped.
 */
function pairTexts(en, loc, pairs = new Map()) {
    if (typeof en === 'string') {
        if (typeof loc !== 'string')
            return pairs;
        let m = pairs.get(en);
        if (!m)
            pairs.set(en, (m = new Map()));
        m.set(loc, (m.get(loc) ?? 0) + 1);
        return pairs;
    }
    if (Array.isArray(en)) {
        if (!Array.isArray(loc))
            return pairs;
        const n = Math.min(en.length, loc.length);
        for (let i = 0; i < n; i++)
            pairTexts(en[i], loc[i], pairs);
        return pairs;
    }
    if (en && typeof en === 'object' && loc && typeof loc === 'object' && !Array.isArray(loc)) {
        const l = loc;
        for (const [k, v] of Object.entries(en)) {
            if (Object.prototype.hasOwnProperty.call(l, k))
                pairTexts(v, l[k], pairs);
        }
    }
    return pairs;
}
const QUOTES = {
    de: ['„', '“'],
    fr: ['« ', ' »'],
    ru: ['«', '»'],
    es: ['«', '»'],
};
/**
 * The game writes quoted names with a plain `"` (Zauber "Monstertöter"). tGame's
 * output lands in HTML attributes unescaped in places (t() params), where a `"`
 * would end the attribute — so quotes become the language's own marks.
 */
function localQuotes(text, lang) {
    if (!text.includes('"'))
        return text;
    const [open, close] = QUOTES[lang] ?? ['“', '”'];
    let opening = true;
    return text.replace(/"/g, () => {
        const q = opening ? open : close;
        opening = !opening;
        return q;
    });
}
const hasLetter = (s) => /\p{L}/u.test(s);
const MARKUP = /[<>]/;
const numbersOf = (s) => s.match(/\d+/g) ?? [];
/** Fill a {n} pattern with numbers in order (tGame's rule, mirrored for the compaction). */
function fillPattern(pattern, numbers) {
    let i = 0;
    return pattern.replace(/\{n\}/g, () => numbers[i++] ?? '');
}
/**
 * English → localized for one language: exact names, plus {n} patterns for
 * names with numbers where every instance agrees ("Level {n} epic Crypt" →
 * "Epische Gruft Level {n}"); exact entries a pattern reproduces are dropped.
 *
 * - Several translations of one English text (the game words a name differently
 *   in two places): the most frequent wins, then the first seen.
 * - Strings without a letter ("---", "+5") and anything with markup are left out.
 * - Quotes become the language's own (localQuotes).
 */
function buildGameTexts(input) {
    const exact = new Map();
    for (const [en, counts] of input.pairs) {
        if (!hasLetter(en) || MARKUP.test(en) || en.includes('{n}'))
            continue;
        let best = '';
        let bestCount = 0;
        for (const [loc, n] of counts) {
            if (n > bestCount) {
                best = loc;
                bestCount = n;
            }
        }
        if (!best.trim() || MARKUP.test(best))
            continue;
        if (best === en && !input.englishTexts.has(en))
            continue;
        exact.set(en, localQuotes(best, input.lang));
    }
    const labelPatterns = new Map();
    for (const [en, loc] of input.labels ?? []) {
        if (!loc.trim() || MARKUP.test(loc))
            continue;
        if (en.includes('{n}'))
            labelPatterns.set(en, localQuotes(loc, input.lang));
        else
            exact.set(en, localQuotes(loc, input.lang));
    }
    // Patterns: an exact pair whose numbers appear in the same order on both
    // sides suggests one; it is kept only when every pair behind it agrees.
    const candidates = new Map();
    for (const [en, loc] of exact) {
        const n = numbersOf(en);
        if (!n.length || numbersOf(loc).join() !== n.join())
            continue;
        const pe = en.replace(/\d+/g, '{n}');
        let s = candidates.get(pe);
        if (!s)
            candidates.set(pe, (s = new Set()));
        s.add(loc.replace(/\d+/g, '{n}'));
    }
    const patterns = new Map();
    for (const [pe, locs] of candidates)
        if (locs.size === 1)
            patterns.set(pe, [...locs][0]);
    for (const [pe, pl] of labelPatterns)
        patterns.set(pe, pl);
    const out = {};
    for (const [pe, pl] of patterns)
        out[pe] = pl;
    for (const [en, loc] of exact) {
        const n = numbersOf(en);
        const p = n.length ? patterns.get(en.replace(/\d+/g, '{n}')) : undefined;
        if (p !== undefined && fillPattern(p, n) === loc)
            continue;
        out[en] = loc;
    }
    return out;
}
const placeholderList = (s) => s.match(/%[A-Za-z0-9_]+%/g) ?? [];
const collapse = (s) => s.replace(/\s+/g, ' ').trim();
/**
 * UI_TEXT_KEYS → [the site's English, the language's text] for one language.
 * A key the game no longer has, or whose language text lacks a translation or
 * reorders its placeholders, is left out; `drift` names keys whose English has
 * moved away from the label the site uses.
 */
function labelTexts(keys, en, loc) {
    const labels = [];
    const drift = [];
    for (const { key, en: label } of keys) {
        const english = en.get(key);
        if (english === undefined) {
            drift.push(`${key} (gone)`);
            continue;
        }
        const englishLabel = collapse(english).replace(/%[A-Za-z0-9_]+%/g, '{n}');
        if (englishLabel !== label)
            drift.push(`${key} ("${englishLabel}" ≠ "${label}")`);
        const text = loc.get(key);
        if (!text || !collapse(text))
            continue;
        if (placeholderList(text).join() !== placeholderList(english).join())
            continue;
        labels.push([label, collapse(text).replace(/%[A-Za-z0-9_]+%/g, '{n}')]);
    }
    return { labels, drift };
}
const textsFileName = (lang) => `texts-${lang}.json`;
exports.textsFileName = textsFileName;
/** Cache of the game's static data. GAME_STATIC_DIR overrides it for local runs and tools, never needed in prod. */
function staticDir() {
    return process.env.GAME_STATIC_DIR ? path_1.default.resolve(process.env.GAME_STATIC_DIR) : path_1.default.resolve('data', 'game-static');
}
function writeGameTexts(dir, lang, version, texts) {
    const body = { version, lang, format: exports.GAME_TEXTS_FORMAT, builtAt: new Date().toISOString(), texts };
    fs_1.default.mkdirSync(dir, { recursive: true });
    fs_1.default.writeFileSync(path_1.default.join(dir, (0, exports.textsFileName)(lang)), JSON.stringify(body));
}
/** The names version in use (set by static-data.ts whenever it resolves one); null until then. */
let currentDir = null;
const served = new Map();
/** static-data.ts: the names (and texts) of this directory are now the current ones; `rebuilt` = its files were just written. */
function useGameTextsDir(dir, rebuilt = false) {
    if (currentDir === dir && !rebuilt)
        return;
    currentDir = dir;
    served.clear();
}
/** The newest version directory that holds this language's texts (before any names were resolved). */
function newestTextsDir(lang) {
    const root = staticDir();
    if (!fs_1.default.existsSync(root))
        return null;
    const files = fs_1.default.readdirSync(root)
        .map((d) => path_1.default.join(root, d, (0, exports.textsFileName)(lang)))
        .filter((f) => fs_1.default.existsSync(f))
        .sort((a, b) => fs_1.default.statSync(b).mtimeMs - fs_1.default.statSync(a).mtimeMs);
    return files[0] ? path_1.default.dirname(files[0]) : null;
}
/**
 * One language's texts as served: memory, else the current version's file,
 * else the newest file on disk. Null when there are none (the site then shows
 * names in English, or the hand dictionary's) — never a network fetch.
 */
function gameTextsResponse(lang) {
    if (!isGameTextLanguage(lang))
        return null;
    const key = `${currentDir ?? ''}|${lang}`;
    if (served.has(key))
        return served.get(key) ?? null;
    let result = null;
    const dir = currentDir && fs_1.default.existsSync(path_1.default.join(currentDir, (0, exports.textsFileName)(lang))) ? currentDir : newestTextsDir(lang);
    if (dir) {
        try {
            const body = fs_1.default.readFileSync(path_1.default.join(dir, (0, exports.textsFileName)(lang)), 'utf8');
            const parsed = JSON.parse(body);
            if (parsed.format === exports.GAME_TEXTS_FORMAT && parsed.lang === lang && parsed.texts && typeof parsed.texts === 'object') {
                result = {
                    body,
                    etag: `"${crypto_1.default.createHash('sha1').update(body).digest('hex').slice(0, 20)}"`,
                    version: String(parsed.version ?? ''),
                };
            }
        }
        catch {
            result = null;
        }
    }
    // A miss is not remembered while nothing is current: the first build may be about to write it.
    if (result || currentDir)
        served.set(key, result);
    return result;
}
/** Test seam. */
function resetGameTexts() {
    currentDir = null;
    served.clear();
}
//# sourceMappingURL=game-texts.js.map