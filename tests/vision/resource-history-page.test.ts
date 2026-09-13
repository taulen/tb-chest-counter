import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { processResourceScreenshot } from '../../src/vision/resource-ocr.js';

/**
 * Both fixtures are genuine page crops from one 269-page production sweep of the Clan
 * Capital history list, kept because between them they pin the two ways a row sliced by
 * the panel's edge used to be read WRONG rather than not at all.
 *
 * Ground truth for each comes from the other pages of the same sweep, where the same
 * transaction sat mid-page. Mid-page reads are the reliable ones — 0 wrong and 7
 * unresolved out of 3,880 measured — so they are what these assertions are checked
 * against.
 */
describe('resource history page OCR', () => {
  // Anything with a shipped template is matchable, which is exactly what the scanner
  // passes in from resource_types.
  const iconDir = path.resolve('assets', 'resource-icons');
  const allTypes = fs.readdirSync(iconDir)
    .filter((f) => f.endsWith('.png') && !/-\d+\.png$/.test(f))
    .map((f) => f.replace(/\.png$/, ''))
    .sort()
    .map((slug, i) => ({ id: i + 1, slug, name: slug }));
  const slugOf = (id: number | null) => (id == null ? null : allTypes.find((t) => t.id === id)?.slug ?? null);

  const read = (fixture: string) => processResourceScreenshot({
    imageBuffer: fs.readFileSync(path.resolve('tests/fixtures', fixture)),
    clanId: 1,
    uploadDate: new Date('2026-07-31T12:21:00Z'),
    members: [],
    allTypes,
    initialDateLabel: 'TODAY',
  });

  /**
   * The top row of a page must never be given the resource of the row BELOW it.
   *
   * The panel's help and close buttons sit over the first row's icon and dilate with it
   * into one ~92px blob, which the icon-width test discards. The search strip is taller
   * than the row, so the largest remaining blob was the next row's icon — and the row
   * came back as a confident match against the wrong resource. On this page Glorgol's
   * +11,970,000 is silver (15 mid-page reads agree) and it read as
   * scientific-tractates, which is what row 2 actually is.
   */
  it('does not label the first row with its neighbour\'s resource', async () => {
    const { rows } = await read('resource-history-top-row.png');
    expect(rows.length).toBeGreaterThan(10);

    const first = rows[0];
    expect(first.rawPlayerName).toBe('Glorgol');
    expect(first.amount).toBe(11_970_000);
    // Either silver or nothing. Never the neighbour's resource.
    expect(slugOf(first.resourceTypeId)).not.toBe('scientific-tractates');

    // The precondition: row 2 IS scientific-tractates, so a neighbour steal is still
    // possible here and this test would catch it coming back.
    expect(slugOf(rows[1].resourceTypeId)).toBe('scientific-tractates');
  }, 60_000);

  /**
   * The last row of a page is sliced by the panel's bottom frame, which cuts the
   * descenders off the thousands separators — so the commas OCR as periods. The amount
   * pattern used to accept only digits and commas, so it stopped at the first period and
   * kept the leading group alone: "+25.620.000" became 25.
   *
   * That was not a duplicate sitting beside the correct row. The truncated read landed in
   * the stitch overlap, so the clean read of the same transaction on the next page was
   * discarded as already-seen and 25 was what got written. Across this sweep it removed
   * 83.8M of 6.56B resources.
   */
  it('reads an amount whose commas were clipped into periods', async () => {
    const { rows } = await read('resource-history-clipped-comma.png');
    const last = rows[rows.length - 1];
    expect(last.rawPlayerName).toBe('George');
    expect(last.amount).toBe(25_620_000);
  }, 60_000);

  /**
   * The two clan fragments are both gold jigsaw pieces, and telling them apart needs a
   * template cut from the LIST, not from the icon's artwork.
   *
   * Eleven Torch of Olympus rows from one August sweep were reported as unreadable. Four
   * came back unknown; the other seven were silently written as Chronoglyph Clan Fragment,
   * which is the worse half — a wrong resource looks like a result. Both come from one
   * cause: `torch-of-olympus-clan-fragment.png` is the standalone artwork a user supplied
   * (65de25b), and its piece sits at roughly half the linear size of the one the game draws
   * in a history row, so it scores 0.46-0.59 on a real row while chronoglyph — same shape,
   * right scale, wrong colour — scores 0.80-0.85 straight through the 0.68 threshold.
   *
   * `-2` is that same icon cut from eleven real rows (median-stacked to remove the evidence
   * crop's highlight stroke) at the 0.92 width-fill the other templates use. It scores
   * 1.17-1.22 against chronoglyph's 0.80-0.85 on all eleven: a 0.34 margin, not a coin flip.
   *
   * This row is one of the four unknowns, so it also pins CY_RETRY_OFFSETS — its contour
   * comes back 40px tall against the 48px icon, and without the retry the crop is centred
   * 2px high and torch scores 0.59. Template and retry are both load-bearing here, and in
   * that order: with only the retry, all eleven rows resolve confidently to chronoglyph.
   *
   * Unlike the two fixtures above this is not a raw page crop — none were kept for that
   * sweep (debugSavePages is off for scheduled runs) — so it is the unresolved-row evidence
   * crop with the #e8562a rectangle painted back to the panel background. That only makes
   * the icon harder to read: the stroke crosses its lower tab.
   */
  it('tells the Torch fragment from the Chronoglyph one', async () => {
    const { rows } = await read('resource-history-fragment-row.png');
    expect(rows).toHaveLength(1);
    expect(rows[0].rawPlayerName).toBe('Princess of Chaos');
    expect(rows[0].amount).toBe(12);
    expect(slugOf(rows[0].resourceTypeId)).toBe('torch-of-olympus-clan-fragment');
  }, 60_000);

  /**
   * Religious Tractates: a resource the game added after v37 seeded the catalogue.
   *
   * Rows of it had been landing unresolved since at least 30 July before anyone
   * noticed, which is the failure mode this whole file exists for — an icon no
   * template matches produces no error, just a row an admin has to identify by
   * eye, and there is nothing to say whether that is one bad read or a resource
   * the catalogue has never heard of.
   *
   * It is also the first template with no "Select a resource" modal screenshot
   * behind it. The ones in data/screenshots predate the resource, so the only
   * image of the icon that exists anywhere is an unresolved-row evidence crop —
   * see scripts/extract-icon-from-row-crop.mjs, which cuts a template from one.
   *
   * This fixture is a DIFFERENT row from the one the template was cut from — a
   * 31 July sweep against an 7 August crop — so it tests that the template
   * generalises rather than that it can recognise itself. It scores 1.19 here
   * against a 0.68 threshold, and the nearest rival template is 0.45.
   */
  it('reads the Religious Tractates icon', async () => {
    const { rows } = await read('resource-history-religious-tractates-row.png');
    expect(rows).toHaveLength(1);
    expect(rows[0].rawPlayerName).toBe('Red Book Connoisseur');
    expect(rows[0].amount).toBe(422_567);
    expect(slugOf(rows[0].resourceTypeId)).toBe('religious-tractates');
  }, 60_000);

  /** The panel's close button is not a row, and must not become one. */
  it('never emits a row for the panel chrome', async () => {
    const { rows } = await read('resource-history-top-row.png');
    for (const r of rows) {
      expect(r.rawPlayerName).not.toMatch(/^[Xx×?]$/);
      expect(r.amount).toBeGreaterThan(0);
    }
  }, 60_000);
});
