"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeGiftText = normalizeGiftText;
exports.compareGifts = compareGifts;
function normalizeGiftText(s) {
    return s.toLowerCase().replace(/\blvl\b/g, 'level').replace(/[–—]/g, '-').replace(/\s+/g, '');
}
const DETAIL_LIMIT = 30;
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
    const late = unmatched.filter((r) => r.at !== undefined && r.at > captureEpoch);
    let ocrOnly = unmatched.filter((r) => !(r.at !== undefined && r.at > captureEpoch));
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