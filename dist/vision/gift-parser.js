"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseGiftCards = parseGiftCards;
const chest_names_js_1 = require("./chest-names.js");
const screen_state_js_1 = require("./screen-state.js");
const logger_js_1 = require("../utils/logger.js");
const log = (0, logger_js_1.childLogger)('gift-parser');
/**
 * Parse the OCR text of one or more gift cards into structured entries.
 *
 * Card layout is three stacked rows:
 *   <gift name>
 *   From: <player>      Time left: <time>
 *   Source: <location>  [Open]
 * A card is therefore identified by its "From:" line, and the gift NAME
 * is whatever real-word text immediately precedes it — NOT by the word
 * "Chest". Every gift on the clan Gifts tab is a countable chest,
 * including event rewards whose names don't contain "Chest" (e.g.
 * "Prepared alchemical cauldron" from an Alchemy tournament). The old
 * parser keyed the name line on /chest/i, which silently dropped those
 * gifts and made the scanner treat the list as empty.
 *
 * OCR-tolerant throughout: "From"→"trom", "Source"→"s0urce"/"ure",
 * "Time left"→"Tome left"/"Tiel"/… and digit↔letter player confusions.
 * (These confusions originate from the OCR engine; the parser is engine-
 * agnostic and is fed reconstructed text by the PaddleOCR provider.)
 *
 * Exported (rather than a private method) so it can be unit-tested
 * directly without driving OCR.
 */
function parseGiftCards(text) {
    // The game's "Connection lost" dialog is drawn over the open panel, and its
    // body — "Someone has logged into your account from another device." — ends
    // in a phrase this parser is built to look for. "from another" satisfies the
    // From-line matcher below, with "Connection lost" sitting immediately above
    // it as the pending name, so the dialog reads out as a perfectly well-formed
    // gift: player "another", chest "Connection lost". That is exactly what was
    // inserted into clan #2 on 2026-09-15, and it also minted "another" as a
    // clan member, which then showed up in the might capture's roster.
    //
    // Refusing the whole text (rather than dropping the one bad card) is
    // deliberate: the dialog means the session is dead, so any real card visible
    // behind it cannot be claimed by a click either, and the callers all treat
    // "no cards" as a signal to look at the screen state — which now classifies
    // this same text as SESSION_KICKED and aborts the scan.
    const kickReason = (0, screen_state_js_1.describeSessionKickText)(text);
    if (kickReason !== null) {
        log.warn({ noAlert: true }, `Refusing to parse gift cards — ${kickReason}. No cards can be claimed while it is up.`);
        return [];
    }
    const gifts = [];
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    // Most recent line that looks like a gift name: carries a 3+ letter
    // word and isn't a From/Source/Time/Open/Delete/Claim control line.
    // Consumed when the next "From:" line completes the card.
    let pendingName = '';
    let current = null;
    const setName = (raw) => {
        const cleaned = raw.replace(/[.:;,|]+\s*$/, '').trim();
        // Require a real 3+ letter word so stray time fragments ("17h 49m"),
        // button glyphs, and punctuation noise can't become phantom names.
        if (/[a-z]{3,}/i.test(cleaned))
            pendingName = cleaned;
    };
    for (const line of lines) {
        // A line beginning with "Source"/"ure" is a source row, never a From
        // row — guard so a source value that happens to contain "from"
        // (e.g. "Gift from event") isn't mis-parsed as the player line.
        const isSourceLine = /^\s*(?:s[0o]urce|ure)\b/i.test(line);
        // ── From line: completes the card identity (name + player + time). ──
        // OCR regularly mis-reads "From" as "trom" (f→t) so we accept
        // either spelling. Time-left marker variants observed in real scans:
        // "Time left", "Tome left", "Tiel", "Tele", "Telell", bare "Te" / "mel".
        const fromMatch = isSourceLine
            ? null
            : line.match(/\b[ft]rom[:\s;,.]*(.+?)(?:\s+['"]*(?:t(?:ime|ome|iel|imed?|ele\w*)|mel|te\b)(.*)|\s*$)/i);
        if (fromMatch) {
            // Recover an inline name when OCR merged it onto the From line
            // ("Stone Chest From: X") instead of giving it its own row.
            if (!pendingName) {
                const fromIdx = line.search(/\b[ft]rom\b/i);
                if (fromIdx > 0)
                    setName(line.slice(0, fromIdx));
            }
            const candidate = fromMatch[1].trim().replace(/[|,'"]/g, '').replace(/[.,;:]+$/, '').trim();
            // Reject garbage players: single chars, or short all-digit/punct
            // strings ("0"). Accept 3+ char all-numeric ("050" = player "oSo")
            // — the fuzzy matcher downstream resolves it to the real name.
            const validPlayer = candidate.length >= 3
                || (candidate.length >= 2 && !/^[\d\s\W]+$/.test(candidate));
            // Extract hours AND minutes from time left.
            // OCR formats: "ime left: R19 h : 42", "ime left: 19h 30m", "imeleft: B19h: 30"
            let timeLeft = '';
            const timeRest = fromMatch[2] || '';
            const hourMatch = timeRest.match(/(\d{1,2})\s*h/);
            if (hourMatch) {
                const hours = hourMatch[1];
                const afterH = timeRest.slice(timeRest.indexOf(hourMatch[0]) + hourMatch[0].length);
                const minMatch = afterH.match(/(\d{1,2})/);
                const mins = minMatch ? minMatch[1] : '0';
                timeLeft = `${hours}h${mins}m`;
            }
            if (pendingName && validPlayer) {
                current = {
                    playerName: candidate,
                    chestName: (0, chest_names_js_1.correctChestName)(pendingName),
                    chestType: (0, chest_names_js_1.getChestRarity)(pendingName),
                    source: '',
                    timeLeft,
                    giftTab: 'gifts',
                    quantity: 1,
                    confidence: 0.6,
                };
                log.debug(`Parsed: "${candidate}" | "${current.chestName}" | time="${timeLeft}"`);
                gifts.push(current);
            }
            else {
                // No usable name or player — don't start a card, and don't let a
                // following Source line attach to the previous one.
                current = null;
            }
            pendingName = '';
        }
        // ── Source line: fills in the current card's source. May share the
        //    line with the From text on fully-merged single-line cards, so
        //    this runs even after a From match (we hold the same `current`
        //    reference that was just pushed). "Source" mis-reads as "ure"
        //    (drops the "So") or "S0urce" (o→0). ──
        const sourceMatch = line.match(/(?:s[0o]urce|\bure)[:\s;,.]*(.+?)(?:\s*\[?\s*(?:open|oper|oer)\b|\s*\||\s*$)/i);
        if (sourceMatch) {
            if (current) {
                current.source = sourceMatch[1].trim().replace(/[[\]]/g, '').replace(/[.,;:]+$/, '').trim();
            }
            continue;
        }
        // ── Otherwise: a (potential) gift name for the NEXT card. Skip the
        //    From line we already handled and trailing control rows. ──
        if (fromMatch)
            continue;
        if (/^(?:time|tome|delete|claim|open|oper)\b/i.test(line))
            continue;
        setName(line);
    }
    return gifts;
}
//# sourceMappingURL=gift-parser.js.map