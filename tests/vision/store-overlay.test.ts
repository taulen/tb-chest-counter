/**
 * Pins the store/offer-overlay detector against the OCR that produced it.
 *
 * A first member capture on a fresh install failed three verification passes
 * and reported "Most likely Stage 2 (Members sidebar) is mis-calibrated —
 * re-run the calibration wizard's Stage 2". The calibration was correct. What
 * the scanner was actually looking at was an in-game offer popup that the
 * Escape sweep could not close, so every click landed on the promo:
 *
 *   "epicmonster clan | hunters chests x5 | clan 7d | free | sale |
 *    24,000 180,000 30 180,000 | ... | 50% 7d. 3d. 15m. 15h. 8h. | 529 nok 52"
 *
 * The strings below are verbatim from that run's log. The failure mode this
 * guards is a detector that quietly stops matching — which costs nothing
 * visible, and silently restores the old behaviour of sending operators to
 * re-calibrate something that was never wrong.
 */

import { describe, it, expect } from 'vitest';
import { looksLikeStoreOverlayText } from '../../src/vision/screen-state.js';

const REAL_OVERLAY_READS = [
  'epicmonster clan | hunters chests x5 | clan 7d | free | sale | 24,000 180,000 30 180,000 '
    + '| clan 3d. 1d | 3 7 12 20 | 5,000 10,000 50% 8h 3h 1h | 12 10 30 50 70 '
    + '| 50% 7d. 3d. 15m. 15h. 8h. | 529 nok 52',
  'clan 7d. | 24,000 180,000 30 180,000 5 | clan 3d. 1d. 15h. | 3 2 1 7 12 20 '
    + '| 5,000 10,000 50% 8h. 3h. 1h. | 12 2 10 30 50 70 | 50% 7d. 3d. 15m. 15h. 8h. | 529 nok 529 nok',
];

describe('looksLikeStoreOverlayText', () => {
  it('recognises the offer popup that blocked a real member capture', () => {
    for (const text of REAL_OVERLAY_READS) {
      expect(looksLikeStoreOverlayText(text), text.slice(0, 60)).toBe(true);
    }
  });

  it('does not accuse a popup when the member list is what was read', () => {
    // A real member-list crop: names, coordinates, and might values whose
    // thousands separators are the one store-ish signal present.
    const memberList = 'wolfich (k:34 x:394 y:540) 633,977,025 | wrongportal (k:34 x:385 y:481) '
      + '986,518,755 | succubusmom (k:34 x:406 y:544) 860,498,425 | taulen (k:34 x:188 y:534) 477,211,725';
    expect(looksLikeStoreOverlayText(memberList)).toBe(false);
  });

  it('does not accuse a popup on a gifts panel', () => {
    // Chest rows carry "source", levels and times — none of which are pricing.
    const gifts = 'orc chest from: amsicora source: level 25 crypt time left 18h 36m open '
      + "| priest's chest from: ds portos source: level 20 epic crypt time left 18h 37m open";
    expect(looksLikeStoreOverlayText(gifts)).toBe(false);
  });

  it('needs more than one signal', () => {
    // "free" alone shows up in ordinary UI copy; one hit must not be enough or
    // the detector would blame a popup for every failed read.
    expect(looksLikeStoreOverlayText('free reinforcements available')).toBe(false);
    expect(looksLikeStoreOverlayText('members 100/100')).toBe(false);
  });
});
