import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { paddleMemberOcr } from '../../src/browser/member-capture.js';
import { fillLevelsFromAvatarStrip, pairNamesWithMight } from '../../src/browser/might-capture.js';

/**
 * The clan leader's hero level must survive the FIRST page of a might capture.
 *
 * This is a real regression, not a hypothetical: the avatar-strip re-read used to be
 * gated on the main OCR pass having already produced a badge somewhere, so page 1 —
 * where nothing has run yet — got no levels at all. Members who reappear on page 2
 * were unaffected, which is why it went unnoticed. The clan leader is always row 1 and
 * never appears on a later page, so her level was missed on three consecutive days.
 *
 * The fixture is the genuine `might_crop_debug` PNG from the production capture that
 * exposed it, so this pins the behaviour against the real thing rather than a
 * synthesised approximation. Expected values are cross-checked against a screenshot of
 * the same moment: Queen of Chaos 162, taulen302 179, Princess of Chaos 159.
 */
describe('might capture: hero levels on the first page', () => {
  const fixture = path.resolve('tests/fixtures/member-list-page1-leader.png');

  it('recovers every level from the avatar strip, including the leader in row 1', async () => {
    const buf = fs.readFileSync(fixture);
    const { rows, canonH } = await paddleMemberOcr(buf);
    const { pairs } = pairNamesWithMight(rows);

    // The precondition that made this bug possible: the main pass reads almost no
    // badges on this crop. If that ever changes the bug is masked, not fixed, so
    // assert it rather than assume it.
    const fromMainPass = pairs.filter((p) => p.level !== null).length;
    expect(fromMainPass).toBeLessThan(pairs.length);

    const filled = await fillLevelsFromAvatarStrip(buf, canonH, pairs);
    expect(filled).toBeGreaterThan(0);

    const byName = new Map(pairs.map((p) => [p.name, p.level]));
    expect(byName.get('Queen of Chaos')).toBe(162);
    expect(byName.get('taulen302')).toBe(179);
    expect(byName.get('Princess of Chaos')).toBe(159);
  }, 60_000);

  /**
   * The same three levels, at scroll alignments other than the fixture's own.
   *
   * This is the test that was missing, and its absence is why a badge going to the
   * WRONG member survived for weeks under a passing suite. Badges were matched by
   * containment in a row band, and consecutive bands overlapped by exactly one
   * canonical pixel (`bandTop = cy - 1` against an exclusive `bandBottom = cy_next`)
   * with the overlap resolved to the FIRST — upper — member. The badge sits within
   * half a pixel of its own name row's centre, i.e. right on that seam, so which
   * member got it came down to sub-pixel alignment.
   *
   * The fixture happens to be captured at the one offset where all three land on the
   * correct side. Shifting it a few pixels — an ordinary scroll position, which every
   * page after the first has — made taulen302 wear Princess of Chaos's 159 in 5 of 8
   * offsets, with Princess left null. That is the production symptom exactly: a level
   * that jumps to a neighbour's value and back, on a quantity that cannot fall.
   *
   * Assert on ALL THREE members at EVERY offset, not on a total or a count: the bug's
   * signature is one member's level appearing on another, so a check that only counts
   * how many levels were read scores a swap as a perfect capture.
   */
  it('keeps every level on its own member at any scroll alignment', async () => {
    const buf = fs.readFileSync(fixture);
    const meta = await sharp(buf).metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;

    for (const offset of [1, 2, 3, 5, 8, 13, 21, 34]) {
      // Slide the crop window down by `offset` native px, exactly as a scroll would.
      const shifted = await sharp(buf)
        .extract({ left: 0, top: offset, width, height: height - offset })
        .png().toBuffer();

      const { rows, canonH } = await paddleMemberOcr(shifted);
      const { pairs, anchorYs } = pairNamesWithMight(rows);
      await fillLevelsFromAvatarStrip(shifted, canonH, pairs, anchorYs);

      const byName = new Map(pairs.map((p) => [p.name, p.level]));
      // A level may legitimately go unread at some alignments — the badge can be
      // clipped by the crop edge. It may never be someone else's.
      for (const [name, level] of [
        ['Queen of Chaos', 162], ['taulen302', 179], ['Princess of Chaos', 159],
      ] as Array<[string, number]>) {
        if (!byName.has(name)) continue;
        expect(byName.get(name), `${name} at scroll offset ${offset}`).toBeOneOf([level, null]);
      }
    }
  }, 180_000);
});
