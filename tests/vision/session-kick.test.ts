/**
 * Pins the "Connection lost" detector against the OCR that produced it, and
 * the gift parser's refusal to read cards out of that dialog.
 *
 * On 2026-09-15 a clan #2 scan navigated to the Gifts tab and the card crop
 * OCR'd as (verbatim from the run's log):
 *
 *   "Gifts Triumphal Gifts | Stone Chest | From:John Wick Time left: 17 h 49 m
 *    | Source: Level 20 Crypt Open | X | Time left: 17 h 51 m | Connection
 *    lost | Open | neone has logged into your account from another | vice. Wou"
 *
 * The dialog's own prose is what made it dangerous. "...from another" is a
 * valid From line to the gift parser, "Connection lost" is sitting directly
 * above it as the pending name, and the result was a gift record for player
 * "another" holding chest "Connection lost" — plus "another" upserted as a
 * clan member, which then turned up in the might capture's roster report.
 *
 * SessionKickedError had existed and been fully handled in scan-finalize the
 * whole time. Nothing ever threw it, because the only thing that inspects the
 * screen state mid-capture is the zero-cards branch, and this dialog yields a
 * card. These cases are what keep that from going quiet again.
 */

import { describe, it, expect } from 'vitest';
import { describeSessionKickText, looksLikeSessionKickedText, classifyScreenStateText } from '../../src/vision/screen-state.js';
import { parseGiftCards } from '../../src/vision/gift-parser.js';
import { ScreenState } from '../../src/models/enums.js';

// Verbatim from the 2026-09-15 clan #2 run, pipe separators and all.
const KICKED_CROP_OCR = 'Gifts Triumphal Gifts | Stone Chest | From:John Wick Time left:  17 h 49 m '
  + '| Source: Level 20 Crypt Open | X | Time left: 17 h 51 m | Connection lost | Open '
  + '| neone has logged into your account from another | vice. Wou';

// The second read, three seconds later: the same dialog with a little more of
// the "Would you like to reconnect?" line recovered.
const KICKED_CROP_OCR_2 = 'Stone Chest | From: John Wick Time left:  17 h : 49 m | Source: Level 20 Crypt Open '
  + '| X | Time left:  17 h : 51 m | Connection lost | Open '
  + '| neone has logged into your account from another | vice. Would you like to r';

describe('describeSessionKickText', () => {
  it('names another login from the real OCR of the dialog', () => {
    for (const text of [KICKED_CROP_OCR, KICKED_CROP_OCR_2]) {
      expect(describeSessionKickText(text)).toMatch(/another device/);
    }
  });

  it('survives Paddle dropping the spaces', () => {
    expect(describeSessionKickText('Connectionlost neonehasloggedintoyouraccountfromanother'))
      .toMatch(/another device/);
  });

  it('tolerates o/0 and l/1 confusion in the anchor phrase', () => {
    expect(describeSessionKickText('someone has l0gged int0 y0ur account from another device'))
      .toMatch(/another device/);
  });

  it('reports the bare banner without claiming a second login', () => {
    const reason = describeSessionKickText('Connection lost | Open');
    expect(reason).not.toBeNull();
    expect(reason).not.toMatch(/another device/);
  });

  it('stays quiet on ordinary gift-tab text', () => {
    expect(describeSessionKickText(
      'Gifts Triumphal Gifts | Stone Chest | From: John Wick Time left: 17 h 49 m | Source: Level 20 Crypt Open',
    )).toBeNull();
    expect(looksLikeSessionKickedText('Elven Citadel Chest From: Nightfrog Source: Level 25 Citadel')).toBe(false);
  });
});

describe('classifyScreenStateText', () => {
  it('classifies the dialog as SESSION_KICKED even though the gifts panel is behind it', () => {
    // The crop carries "Gifts", "Triumphal", "From" and "Time left" — every
    // signal the GIFT_TAB branch looks for. The kick check has to come first
    // or the overlay is invisible to the classifier.
    expect(classifyScreenStateText(KICKED_CROP_OCR).state).toBe(ScreenState.SESSION_KICKED);
  });

  it('still classifies a clean gifts crop as GIFT_TAB', () => {
    expect(classifyScreenStateText(
      'Gifts Triumphal Gifts | Stone Chest | From: John Wick Time left: 17 h 49 m | Source: Level 20 Crypt Open',
    ).state).toBe(ScreenState.GIFT_TAB);
  });
});

describe('parseGiftCards with the kick dialog on screen', () => {
  it('mints no card at all — this is the record that reached the database', () => {
    const cards = parseGiftCards(KICKED_CROP_OCR.split(' | ').join('\n'));
    expect(cards).toEqual([]);
  });

  it('refuses the second read too, which also parsed cleanly before', () => {
    expect(parseGiftCards(KICKED_CROP_OCR_2.split(' | ').join('\n'))).toEqual([]);
  });

  it('drops the genuine card behind the dialog as well, on purpose', () => {
    // "Stone Chest / From: John Wick" is a real gift, but an Open click on a
    // kicked session claims nothing, so recording it would invent a chest the
    // player never received. The scan aborts and re-reads the list next cycle.
    const cards = parseGiftCards(KICKED_CROP_OCR.split(' | ').join('\n'));
    expect(cards.some((c) => c.playerName === 'John Wick')).toBe(false);
  });

  it('still parses that same card when the dialog is not up', () => {
    const clean = ['Stone Chest', 'From: John Wick Time left: 17 h 49 m', 'Source: Level 20 Crypt Open'].join('\n');
    const cards = parseGiftCards(clean);
    expect(cards).toHaveLength(1);
    expect(cards[0].playerName).toBe('John Wick');
    expect(cards[0].chestName).toBe('Stone Chest');
  });
});
