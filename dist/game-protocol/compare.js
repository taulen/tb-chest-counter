"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeGiftText = normalizeGiftText;
exports.compareGifts = compareGifts;
function normalizeGiftText(s) {
    return s.toLowerCase().replace(/\blvl\b/g, 'level').replace(/[–—]/g, '-').replace(/\s+/g, '');
}
const DETAIL_LIMIT = 30;
/**
 * OCR's earn time comes from the card's "time left", which shows minutes, so a
 * gift that arrived seconds after the capture can read as up to a minute
 * before it. Anything within this window of the capture counts as late.
 */
const LATE_TOLERANCE_S = 120;
function compareGifts(game, ocr, captureEpoch) {
    const key = (g) => `${normalizeGiftText(g.sender)}|${normalizeGiftText(g.chest)}|${normalizeGiftText(g.source)}`;
    const pool = new Map();
    for (const g of game)
        pool.set(key(g), [...(pool.get(key(g)) ?? []), g]);
    let matched = 0;
    const unmatched = [];
    for (const r of ocr) {
        const hit = pool.get(key(r));
        if (hit?.length) {
            hit.pop();
            matched++;
        }
        else {
            unmatched.push(r);
        }
    }
    const gameOnly = [...pool.values()].flat();
    const isLate = (r) => r.at !== undefined && r.at > captureEpoch - LATE_TOLERANCE_S;
    const late = unmatched.filter(isLate);
    let ocrOnly = unmatched.filter((r) => !isLate(r));
    const misreads = [];
    const stillOcrOnly = [];
    for (const r of ocrOnly) {
        const i = gameOnly.findIndex((g) => normalizeGiftText(g.chest) === normalizeGiftText(r.chest) && normalizeGiftText(g.source) === normalizeGiftText(r.source));
        if (i >= 0) {
            misreads.push(`OCR "${r.sender}" vs game "${gameOnly[i].sender}" (${r.chest} | ${r.source})`);
            gameOnly.splice(i, 1);
        }
        else {
            stillOcrOnly.push(r);
        }
    }
    ocrOnly = stillOcrOnly;
    const fmt = (g) => `${g.sender} | ${g.chest} | ${g.source}`;
    return {
        game: game.length,
        ocr: ocr.length,
        matched,
        misreads: misreads.length,
        ocrOnly: ocrOnly.length,
        ocrLate: late.length,
        gameOnly: gameOnly.length,
        details: {
            misreads: misreads.slice(0, DETAIL_LIMIT),
            ocrOnly: ocrOnly.slice(0, DETAIL_LIMIT).map(fmt),
            gameOnly: gameOnly.slice(0, DETAIL_LIMIT).map(fmt),
        },
    };
}
//# sourceMappingURL=compare.js.map