"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PaddleOcrProvider = void 0;
exports.groupRows = groupRows;
exports.regionsToText = regionsToText;
/**
 * PaddleOCR vision provider for the normal game scan — the app's OCR engine,
 * backed by the shared PP-OCRv6_small ONNX service (paddle-service.ts).
 *
 * Implementation notes:
 *  - PaddleOCR returns positioned text regions, not a newline blob. We
 *    reconstruct newline text by grouping regions into rows (by Y centre)
 *    and joining left-to-right, then feed that to parseGiftCards
 *    (gift-parser.ts) — so all the downstream name/chest/source normalization
 *    is shared.
 *  - Non-Latin player names: the v6 rec model reads Latin+CJK only, so when a
 *    "From:" row's name reads as empty/non-Latin we re-OCR just that region
 *    with the bundled Cyrillic/Arabic models (paddle-lang.ts). Gated by
 *    config.scanNonLatinFallback; only fires on failed Latin reads.
 *  - No worker pool and no WASM-heap leak, so teardown() is a no-op.
 */
const sharp_1 = __importDefault(require("sharp"));
const enums_js_1 = require("../models/enums.js");
const paddle_service_js_1 = require("./paddle-service.js");
const paddle_lang_js_1 = require("./paddle-lang.js");
const screen_state_js_1 = require("./screen-state.js");
const gift_parser_js_1 = require("./gift-parser.js");
const player_names_js_1 = require("./player-names.js");
const logger_js_1 = require("../utils/logger.js");
const log = (0, logger_js_1.childLogger)('paddle-provider');
/** Width every image is resized to before detection, so the row-grouping gap
 *  below is calibrated against one consistent scale regardless of the
 *  operator's crop rectangle or the source screenshot resolution. */
const CANONICAL_WIDTH = 1000;
/** Regions whose Y-centres are within this many px (at CANONICAL_WIDTH) are
 *  treated as the same text row. */
const ROW_GAP = 20;
const FROM_RE = /\b[ft]rom\b/i;
const SOURCE_RE = /^\s*(?:s[0o]urce|ure)\b/i;
// Tokens that mark the end of the name span on a From row (time-left / Open).
const TIME_OR_OPEN_RE = /\b(?:t(?:ime|ome|iel)|left|open)\b|\d{1,2}\s*h\b/i;
/** Group regions into rows by Y-centre proximity, dropping the "Clan" icon
 *  badge that sits on every card and would otherwise prefix the chest name.
 *  Rows ordered top→bottom, words within a row ordered left→right. */
function groupRows(regions) {
    const kept = regions.filter((r) => !/^\s*clan\s*$/i.test(r.text));
    const sorted = [...kept].sort((a, b) => a.box.y - b.box.y);
    const rows = [];
    for (const r of sorted) {
        const cy = r.box.y + r.box.height / 2;
        const row = rows.find((x) => Math.abs(x.cy - cy) < ROW_GAP);
        if (row) {
            row.words.push(r);
            row.cy = (row.cy * (row.words.length - 1) + cy) / row.words.length;
        }
        else {
            rows.push({ cy, words: [r] });
        }
    }
    for (const row of rows)
        row.words.sort((a, b) => a.box.x - b.box.x);
    rows.sort((a, b) => a.cy - b.cy);
    return rows;
}
const rowText = (row) => row.words.map((w) => w.text).join(' ');
/** Reconstruct newline-delimited text from positioned OCR regions. */
function regionsToText(regions) {
    return groupRows(regions).map(rowText).join('\n');
}
function isFromRow(line) {
    return FROM_RE.test(line) && !SOURCE_RE.test(line);
}
/** The player-name substring of a From line (before the time-left marker). */
function fromLineName(line) {
    const m = line.match(/\b[ft]rom[:\s;,.]*(.+?)(?:\s*(?:t(?:ime|ome|iel)|left|\d{1,2}\s*h|open)|\s*$)/i);
    return (m?.[1] ?? '').trim();
}
/**
 * A player-name read is "bad" (worth a non-Latin recovery attempt) when it is
 * empty, has fewer than 2 ASCII letters, or contains any non-ASCII character.
 * The last case is the important one: the Latin-only v6 model maps Cyrillic
 * onto Latin/accented homoglyphs ("Рей" → "Peǔ"), which passes a naive "is it
 * Latin?" check but won't match the roster. Recovery is safe even when this
 * fires on a genuinely accented Latin name (e.g. "José") — the language models
 * only return text carrying ≥2 Cyrillic/Arabic letters, so a Latin name yields
 * nothing and the original read is kept. */
function isBadName(name) {
    const t = name.trim();
    if (!t)
        return true;
    if (/[^\x00-\x7F]/.test(t))
        return true;
    return (t.match(/[A-Za-z]/g) || []).length < 2;
}
/** Bounding box (in canonical pixels) spanning the name portion of a From
 *  row — from the "From" word (or the row start, when v6 emitted no readable
 *  "From" token) through the last word before a time/Open token. */
function nameSpanBox(row, canonH) {
    const fromIdx = row.words.findIndex((w) => FROM_RE.test(w.text));
    // When the "From" word is its own label-only region ("From:" / "From"),
    // start after it so the crop excludes the Latin label. When the label is
    // merged with the name in one region, include it (the language pass strips
    // the Latin part). When there's no readable From word, take the whole row.
    let startIdx = 0;
    if (fromIdx >= 0) {
        startIdx = /^[ft]rom[:.\s]*$/i.test(row.words[fromIdx].text.trim()) ? fromIdx + 1 : fromIdx;
    }
    const nameWords = [];
    for (let i = startIdx; i < row.words.length; i++) {
        if (i > startIdx && TIME_OR_OPEN_RE.test(row.words[i].text))
            break;
        nameWords.push(row.words[i]);
    }
    if (!nameWords.length)
        return null;
    const left = Math.max(0, Math.min(...nameWords.map((w) => w.box.x)) - 2);
    const top = Math.max(0, Math.min(...nameWords.map((w) => w.box.y)) - 2);
    const right = Math.min(CANONICAL_WIDTH, Math.max(...nameWords.map((w) => w.box.x + w.box.width)) + 2);
    const bottom = Math.min(canonH, Math.max(...nameWords.map((w) => w.box.y + w.box.height)) + 2);
    if (right - left < 8 || bottom - top < 8)
        return null;
    return { left, top, width: right - left, height: bottom - top };
}
class PaddleOcrProvider {
    name = 'PaddleOCR (Local, ONNX)';
    requiresApiKey = false;
    supportsImages = false;
    lastMaintenanceDurationMs = null;
    nonLatinFallback = true;
    langAvailable = false;
    /** Active clan roster, set per-scan via setScanContext. Used to skip the
     *  non-Latin recovery pass for names that already resolve to a known
     *  member. */
    knownMembers = [];
    getLastMaintenanceDurationMs() {
        return this.lastMaintenanceDurationMs;
    }
    /**
     * Called by the scan pipeline before a scan with the active clan roster.
     * Two jobs: (1) let extractCardsFromCrop skip the non-Latin recovery pass
     * for names that already resolve to a known member (an accented-Latin name
     * like "Crème À la mode Pie" that v6 reads fine costs nothing); (2) pre-warm
     * the language models so the first genuine recovery doesn't stall mid-scan.
     * Recovery still fires for names that DON'T resolve — homoglyph-garbled
     * non-Latin reads and brand-new non-Latin members not yet in the roster.
     */
    setScanContext(knownMembers) {
        this.knownMembers = knownMembers;
        if (this.langAvailable)
            (0, paddle_lang_js_1.prewarmLangModels)();
    }
    async initialize(config) {
        this.nonLatinFallback = config?.scanNonLatinFallback ?? true;
        this.langAvailable = this.nonLatinFallback && (0, paddle_lang_js_1.isLangFallbackAvailable)();
        if (this.nonLatinFallback && !this.langAvailable) {
            log.warn('scanNonLatinFallback is on but language models are missing under assets/paddle-lang-models/ — non-Latin names will not be recovered');
        }
        await (0, paddle_service_js_1.getPaddleOcr)();
        log.debug(`PaddleOCR provider initialized (nonLatinFallback=${this.langAvailable})`);
    }
    /**
     * Release the loaded models so a long-running process can give the memory
     * back. Used to be a no-op on the grounds that there is no worker pool and
     * no WASM heap to recycle — true, but it overlooked ONNX Runtime's CPU
     * arenas, which grow to fit the largest input shapes they've seen and never
     * shrink. Over days of scanning that is the resident cost, and releasing the
     * sessions is the only way to reclaim it.
     *
     * Order matters: drop the per-language service cache first, or those cached
     * instances keep wrapping sessions we are about to free. Models reload
     * lazily on the next OCR call.
     */
    async teardown() {
        (0, paddle_lang_js_1.resetLangServices)();
        const released = await (0, paddle_service_js_1.releaseAllOrtSessions)();
        log.debug(`PaddleOCR provider teardown released ${released} ORT session(s)`);
    }
    /** Resize to canonical width, run det+rec. Returns regions plus the
     *  canonical-scale PNG so callers can re-crop sub-regions (non-Latin pass). */
    async recognize(buffer) {
        const meta = await (0, sharp_1.default)(buffer).metadata();
        const w = meta.width ?? CANONICAL_WIDTH;
        const h = meta.height ?? CANONICAL_WIDTH;
        const canonH = Math.max(1, Math.round((h / w) * CANONICAL_WIDTH));
        const canonicalPng = await (0, sharp_1.default)(buffer)
            .resize(CANONICAL_WIDTH, canonH, { kernel: 'lanczos3' })
            .png()
            .toBuffer();
        const { data, info } = await (0, sharp_1.default)(canonicalPng).raw().toBuffer({ resolveWithObject: true });
        (0, paddle_service_js_1.normalizeInputToRgb)({ width: info.width, height: info.height, data: new Uint8Array(data) });
        const svc = await (0, paddle_service_js_1.getPaddleOcr)();
        const regions = await svc.recognize({ width: info.width, height: info.height, data: new Uint8Array(data) });
        return { regions: regions, canonicalPng, canonH };
    }
    async detectScreenState(screenshot) {
        this.lastMaintenanceDurationMs = null;
        let regions;
        try {
            ({ regions } = await this.recognize(screenshot));
        }
        catch (err) {
            log.warn('detectScreenState OCR failed: ' + String(err));
            return enums_js_1.ScreenState.UNKNOWN;
        }
        const text = regions.map((r) => r.text).join(' ');
        log.info(`Screen state OCR (first 200 chars): "${text.substring(0, 200)}"`);
        const { state, maintenanceDurationMs } = (0, screen_state_js_1.classifyScreenStateText)(text);
        this.lastMaintenanceDurationMs = maintenanceDurationMs;
        if (state === enums_js_1.ScreenState.MAINTENANCE && maintenanceDurationMs !== null) {
            log.warn(`Maintenance detected, duration parsed as ${Math.round(maintenanceDurationMs / 60_000)} minutes`);
        }
        return state;
    }
    async findUIElement(_screenshot, _description) {
        return null;
    }
    /** Re-OCR a From row whose Latin name read failed, using the bundled
     *  Cyrillic/Arabic models. Returns the recovered name or null. */
    async recoverNonLatinName(row, canonicalPng, canonH) {
        const box = nameSpanBox(row, canonH);
        if (!box)
            return null;
        let crop;
        try {
            crop = await (0, sharp_1.default)(canonicalPng).extract(box).png().toBuffer();
        }
        catch {
            return null;
        }
        const recovered = await (0, paddle_lang_js_1.recognizeNonLatinName)(crop);
        if (!recovered)
            return null;
        // The crop may include the Latin "From" label — strip leading Latin/space/
        // punct up to the first non-Latin character, and any trailing time fragment.
        const name = recovered
            .replace(/^[\sA-Za-z:.,;|]+/, '')
            .replace(/\s*\d{1,2}\s*[hm].*$/i, '')
            .trim();
        return name.length >= 2 ? name : null;
    }
    async extractCardsFromCrop(cropBuffer) {
        let regions;
        let canonicalPng;
        let canonH;
        try {
            ({ regions, canonicalPng, canonH } = await this.recognize(cropBuffer));
        }
        catch (err) {
            log.debug('extractCardsFromCrop OCR failed: ' + String(err));
            return { entries: [], rawText: '' };
        }
        const rows = groupRows(regions);
        const rowTexts = rows.map(rowText);
        // Rows that read as a Source line — the From row is always the one directly
        // above it, which lets us locate an Arabic/Cyrillic From row even when v6
        // produced no readable "From" token for it at all.
        const isSourceIdx = rowTexts.map((t) => SOURCE_RE.test(t));
        const lines = [];
        for (let i = 0; i < rows.length; i++) {
            let line = rowTexts[i];
            const looksFrom = isFromRow(line);
            const positionalFrom = !looksFrom && !isSourceIdx[i] && i + 1 < rows.length && isSourceIdx[i + 1];
            if (this.langAvailable && (looksFrom || positionalFrom)) {
                const name = looksFrom ? fromLineName(line) : line;
                // Skip recovery when the primary read already resolves to a known
                // member — recovery can't improve on an already-correct name, and this
                // avoids the wasted language-model passes on accented-Latin names like
                // "Crème À la mode Pie". Recovery still runs for UNRESOLVED names:
                // homoglyph-garbled non-Latin, or a new non-Latin member who joined
                // after the roster was captured (so composition-based gating would
                // miss them — matching does not).
                const cleaned = (0, player_names_js_1.cleanPlayerName)(name);
                const resolvesToKnown = this.knownMembers.length > 0
                    && this.knownMembers.includes((0, player_names_js_1.matchKnownPlayer)(cleaned, this.knownMembers));
                if (!resolvesToKnown && isBadName(name)) {
                    try {
                        const recovered = await this.recoverNonLatinName(rows[i], canonicalPng, canonH);
                        if (recovered) {
                            const timeM = line.match(/((?:t(?:ime|ome|iel)|left|\d{1,2}\s*h)[^]*)$/i);
                            line = `From: ${recovered}` + (timeM ? ` ${timeM[1]}` : '');
                            log.info(`non-Latin name recovered: "${recovered}"`);
                        }
                    }
                    catch (err) {
                        log.debug('non-Latin recovery failed for row: ' + String(err));
                    }
                }
            }
            lines.push(line);
        }
        const rawText = lines.join('\n');
        log.info(`card-crop OCR (${rawText.length} chars): "${rawText.substring(0, 200).replace(/\n/g, ' | ')}"`);
        const entries = (0, gift_parser_js_1.parseGiftCards)(rawText);
        return { entries, rawText };
    }
    async extractTopCardFromCrop(cropBuffer) {
        const { entries } = await this.extractCardsFromCrop(cropBuffer);
        return entries.length > 0 ? entries[0] : null;
    }
}
exports.PaddleOcrProvider = PaddleOcrProvider;
//# sourceMappingURL=paddle-provider.js.map