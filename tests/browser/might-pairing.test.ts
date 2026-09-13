import { describe, expect, it } from 'vitest';
import {
  betterLevel, fillLevelsFromAvatarStrip, nameMatchCandidates, ownerForBadge, pairNamesWithMight,
  parseMight, resolveLevel, sameOcrSkeleton,
} from '../../src/browser/might-capture.js';
import type { MightRow } from '../../src/browser/might-capture.js';
import { splitBadgeAndName } from '../../src/browser/member-capture.js';
import type { PRow } from '../../src/browser/member-capture.js';

/**
 * Guard for the name↔might pairing.
 *
 * This is the part of might capture that can be silently, dangerously wrong:
 * everything else either works or visibly produces nothing, but a pairing bug
 * attaches a real number to the wrong player and looks like data.
 *
 * The fixtures below are the actual PaddleOCR output (text + box geometry,
 * canonical 1000px width) from the real member-list captures in
 * data/benchmark_gifts — coordinate markers, badge rows, rank-group headers and
 * "Was yesterday" status lines included. Coordinates are rounded but otherwise
 * as measured, so these encode the real vertical offset between a name row and
 * the might number that sits below-right of it.
 */

/**
 * Just the name↔might pairing, dropping the band geometry each row also carries
 * (used only to cut an evidence crop out of the page). These tests are about
 * which number lands on which player, so comparing the geometry too would make
 * them fail on changes that don't affect that.
 */
function paired(rows: PRow[]): Array<{ name: string; might: number }> {
  return pairNamesWithMight(rows).pairs.map(({ name, might }) => ({ name, might }));
}

/** Build a row from (centre-y, [text, x, width]) tuples. */
function row(cy: number, words: Array<[string, number, number]>): PRow {
  return {
    cy,
    words: words.map(([text, x, width]) => ({
      text,
      box: { x, y: cy - 15, width, height: 30 },
    })),
  };
}

describe('parseMight', () => {
  it('accepts digit runs with any thousands separator', () => {
    expect(parseMight('163,162,151')).toBe(163_162_151);
    expect(parseMight('158.113.825')).toBe(158_113_825);
    expect(parseMight('80 573 194')).toBe(80_573_194);
    expect(parseMight('  541,654,071 ')).toBe(541_654_071);
  });

  it('rejects the coordinate fragments that share the row', () => {
    // These are the strings most likely to be mistaken for a power level, since
    // they sit on the same OCR row as the name and contain digits.
    expect(parseMight('(K:302')).toBeNull();
    expect(parseMight('X:173')).toBeNull();
    expect(parseMight('Y:269)')).toBeNull();
    expect(parseMight('K:302 X:173 Y:269')).toBeNull();
  });

  it('rejects text, mixed content and out-of-range magnitudes', () => {
    expect(parseMight('Online')).toBeNull();
    expect(parseMight('Was yesterday')).toBeNull();
    expect(parseMight('18 h')).toBeNull();
    expect(parseMight('')).toBeNull();
    expect(parseMight('123')).toBeNull();            // under 4 digits — not a might
    expect(parseMight('1234567890123456')).toBeNull(); // absurd, so OCR damage
  });
});

/**
 * Every case here is a real reading from the first production run that was
 * dropped as "unmatched" — verified against a prod backup. They exist because
 * the roster is built from two sources that disagree about clan tags, and
 * because this font's zero reads as an o.
 */
describe('nameMatchCandidates', () => {
  it('tries the verbatim name first', () => {
    expect(nameMatchCandidates('Feli')[0]).toBe('Feli');
    expect(nameMatchCandidates('Feli')).toEqual(['Feli']);
  });

  it('offers the tag-stripped variant as a fallback, never as the primary', () => {
    // "XG Megros" is the tag case stripLikelyPrefixTag exists for: member
    // capture may have stored this player as "Megros".
    expect(nameMatchCandidates('XG Megros')).toEqual(['XG Megros', 'Megros']);
  });

  it('keeps ordinary two-word names matchable in full', () => {
    // The regression that lost real readings: a ≤3-letter first word looks like a
    // clan tag to the stripper, so "Tax Collector" was only ever tried as
    // "Collector" — which matched nothing, because the roster stores the full
    // name. Both forms are offered now, full name first.
    for (const name of ['Tax Collector', 'DS PORTOS', 'Mr Mathman', 'Jon Snow']) {
      expect(nameMatchCandidates(name)[0]).toBe(name);
    }
  });

  it('folds zero to o so a homoglyph read can still resolve', () => {
    // Measured: "mimooooo" read as "mimo0000", "CHaoS JOooO" as "CHaoS JO00O".
    // Too many edits for the fuzzy budget, but exact once folded.
    expect(nameMatchCandidates('mimo0000')).toContain('mimooooo');
    expect(nameMatchCandidates('CHaoS JO00O')).toContain('CHaoS JOooO');
  });

  it('leaves a name with a legitimate digit resolvable on its own spelling', () => {
    // The folded form is only ever a fallback, so these still match themselves.
    for (const name of ['Andrev60', 'taulen302', 'Bully26']) {
      expect(nameMatchCandidates(name)[0]).toBe(name);
    }
  });

  it('never returns duplicates', () => {
    for (const name of ['Feli', 'Tax Collector', 'mimo0000', 'XG Megros']) {
      const forms = nameMatchCandidates(name);
      expect(new Set(forms).size).toBe(forms.length);
    }
  });
});

/**
 * Two readings can resolve to the same member for two opposite reasons, and the
 * caller's decision turns on which: a different player must become a new member or
 * their reading is lost, while one player read twice must not or every capture mints
 * a duplicate. Distance can't separate them — both are one edit — so the characters
 * have to.
 */
describe('sameOcrSkeleton', () => {
  it('treats capital-I for lowercase-l as the same player', () => {
    // Production created "mikI" as a member alongside "mikl" for exactly this.
    expect(sameOcrSkeleton('mikl', 'mikI')).toBe(true);
    expect(sameOcrSkeleton('LizDidntDoIt', 'LizDidntDolt')).toBe(true);
  });

  it('treats the other substitutions this OCR makes as the same player', () => {
    expect(sameOcrSkeleton('mimooooo', 'mimo0000')).toBe(true);
    expect(sameOcrSkeleton('oSo', '050')).toBe(true);
    expect(sameOcrSkeleton('Megrond', 'Me9rond')).toBe(true);
  });

  it('keeps two genuinely different players apart', () => {
    // One edit, but B and F look nothing alike — this pair is why the rule exists.
    expect(sameOcrSkeleton('Bain', 'Fain')).toBe(false);
    expect(sameOcrSkeleton('Bain', 'Bardin')).toBe(false);
    expect(sameOcrSkeleton('XERN', 'Kern')).toBe(false);
  });

  it('is not fooled by an empty or punctuation-only reading', () => {
    // Stripping to nothing would make every such pair "equal", collapsing unrelated
    // rows onto one member.
    expect(sameOcrSkeleton('', '')).toBe(false);
    expect(sameOcrSkeleton('...', '---')).toBe(false);
  });
});

describe('pairNamesWithMight', () => {
  it('pairs each member with the number in its own row band', () => {
    // From 2026.07.31_001533_fUdUbxVa.png — includes an "Online" status line and
    // a SUPERIOR rank-group header between two members.
    const rows: PRow[] = [
      row(38, [['Queen of Chaos (K:302 X:173 Y:269)', 60, 380]]),
      row(83, [['163,162,151', 780, 130]]),
      row(144, [['Online', 20, 70]]),
      row(210, [['SUPERIOR', 350, 110]]),
      row(270, [['taulen302 (K:302 X:182 Y:262)', 40, 320]]),
      row(316, [['158,113,825', 790, 130]]),
      row(379, [['Was yesterday', 30, 140]]),
      row(446, [['Princess of Chaos (K:302 X:172 Y:270)', 60, 400]]),
      row(492, [['141,530,766', 790, 130]]),
    ];

    const { anchors, withoutMight } = pairNamesWithMight(rows);
    expect(anchors).toBe(3);
    expect(withoutMight).toBe(0);
    expect(paired(rows)).toEqual([
      { name: 'Queen of Chaos', might: 163_162_151 },
      { name: 'taulen302', might: 158_113_825 },
      { name: 'Princess of Chaos', might: 141_530_766 },
    ]);
  });

  it('ignores a status line that has no member row above it', () => {
    // From 2026.07.31_001548_edzDsByl.png: the crop starts mid-row, so the first
    // thing on the page is the tail of a member whose name is off-crop. It must
    // not be able to steal the next member's number.
    const rows: PRow[] = [
      row(21, [['Was yesterday', 30, 140]]),
      row(84, [['OFFICER', 360, 90]]),
      row(143, [['Feli (K:302 X:170 Y:266)', 30, 250]]),
      row(189, [['233,585,301', 790, 130]]),
      row(250, [['Was yesterday', 30, 140]]),
      row(317, [['Eydaen (K:302 X:177 Y:259)', 40, 270]]),
      row(361, [['203,551,605', 790, 130]]),
    ];

    expect(paired(rows)).toEqual([
      { name: 'Feli', might: 233_585_301 },
      { name: 'Eydaen', might: 203_551_605 },
    ]);
  });

  it('reports a clipped row as seen-but-unvalued, not as absent', () => {
    // The common shape: the crop fits one more NAME than it fits values, because
    // the number sits below the name (level with the badge icons). The last row's
    // number is past the bottom edge, so it counts toward withoutMight — but the
    // name is still reported in `names`, which is what lets the caller tell
    // "clipped, will be read on the next page" from "never read at all".
    const rows: PRow[] = [
      row(38, [['Alpha (K:302 X:1 Y:1)', 30, 220]]),
      row(83, [['11,111,111', 790, 130]]),
      row(200, [['Bravo (K:302 X:2 Y:2)', 30, 220]]),
      // Bravo's number would be at cy≈246 — below the crop, so absent here.
    ];
    const { names, anchors, withoutMight } = pairNamesWithMight(rows);
    expect(anchors).toBe(2);
    expect(withoutMight).toBe(1);
    expect(paired(rows)).toEqual([{ name: 'Alpha', might: 11_111_111 }]);
    // Both names surface, so the sweep can resolve Bravo on a later page.
    expect(names).toEqual(['Alpha', 'Bravo']);
  });

  it('does not report a name that failed the letter guard as seen', () => {
    // A row mangled to punctuation must not be counted as a member we saw and
    // failed to value — that would look like a crop problem forever.
    const rows: PRow[] = [
      row(38, [['. (K:302 X:1 Y:1)', 30, 200]]),
      row(200, [['Bravo (K:302 X:2 Y:2)', 30, 220]]),
      row(246, [['22,222,222', 790, 130]]),
    ];
    expect(pairNamesWithMight(rows).names).toEqual(['Bravo']);
  });

  describe('avatar level badge', () => {
    // Measured on real captures: when the crop reaches left over the avatars, the
    // level badge lands in the NAME's text row as a leading word — "220 GlaiveError",
    // "213 Tax Collector". Left in the name it matches no member, and since an
    // unmatched name now creates one, it would mint a junk member every day.
    it('splits the level off the name and returns it', () => {
      const rows: PRow[] = [
        row(38, [['220', 20, 40], ['GlaiveError (K:289 X:939 Y:475)', 90, 330]]),
        row(83, [['289,981,625', 790, 130]]),
      ];
      const { pairs } = pairNamesWithMight(rows);
      expect(pairs).toHaveLength(1);
      expect(pairs[0].name).toBe('GlaiveError');
      expect(pairs[0].level).toBe(220);
      expect(pairs[0].might).toBe(289_981_625);
    });

    it('reports a null level when the avatar is outside the crop', () => {
      // The default calibration starts right of the avatars, so this is the norm.
      const rows: PRow[] = [
        row(38, [['GlaiveError (K:289 X:939 Y:475)', 30, 330]]),
        row(83, [['289,981,625', 790, 130]]),
      ];
      expect(pairNamesWithMight(rows).pairs[0].level).toBeNull();
    });

    it('skips the avatar-strip re-read when there is nothing to fill or nothing to read', () => {
      // The re-read is a second OCR pass per page, so it must bail cheaply. It also
      // must never throw: a level is a bonus and the might values are the product.
      const filled = [{
        name: 'Alpha', might: 1, level: 220, anchorCy: 1, bandTop: 0, bandBottom: null,
      }];
      return Promise.all([
        // Nothing null → no work.
        fillLevelsFromAvatarStrip(Buffer.alloc(0), 100, filled).then((n) => expect(n).toBe(0)),
        // Nothing to fill and an unreadable buffer → 0, not a throw.
        fillLevelsFromAvatarStrip(Buffer.alloc(0), 100, []).then((n) => expect(n).toBe(0)),
        // Needy row but a degenerate image → 0, not a throw.
        fillLevelsFromAvatarStrip(
          Buffer.from('not an image'), 100,
          [{ name: 'Beta', might: 1, level: null, anchorCy: 1, bandTop: 0, bandBottom: null }],
        ).then((n) => expect(n).toBe(0)),
      ]);
    });

    it('gives a badge to the nearest member even when it sits above their band', () => {
      // THE regression. Bands start at `anchor.cy - 1`, but the badge is drawn on the
      // avatar frame, level with the name to within a pixel or two either way — on the
      // real production crop the three badges landed 1.4, 1.3 and 1.4 canonical px
      // inside their own band. Anything that nudged one past that top edge handed it
      // to the member ABOVE, and production shows exactly that: 131 hero levels that
      // are the level of the member immediately below the victim in the list, against
      // 4.6 expected by chance.
      const page = (): MightRow[] => ([
        { name: 'Alpha', might: 1, level: null, anchorCy: 100, bandTop: 99, bandBottom: 250 },
        { name: 'Bravo', might: 2, level: null, anchorCy: 250, bandTop: 249, bandBottom: 400 },
        { name: 'Cara', might: 3, level: null, anchorCy: 400, bandTop: 399, bandBottom: null },
      ]);

      // Dead on the anchor, and either side of it. Every one of these used to be a
      // coin toss decided by a single pixel; all three must now name the same member.
      for (const y of [250, 249, 248, 240, 235, 262]) {
        expect(ownerForBadge(page(), y, 500)?.name).toBe('Bravo');
      }
      // Still the row above when the badge really does belong to them.
      expect(ownerForBadge(page(), 108, 500)?.name).toBe('Alpha');
      // And the open-ended last row.
      expect(ownerForBadge(page(), 396, 500)?.name).toBe('Cara');
    });

    it('drops a badge nearest a member who already has one, rather than re-homing it', () => {
      // The caller only fills rows still missing a level, so searching just those
      // would let a badge that plainly belongs to a member already read be handed to
      // whichever unread member happened to be next-nearest — turning one redundant
      // reading into one wrong one.
      const pairs: MightRow[] = [
        { name: 'Alpha', might: 1, level: 220, anchorCy: 100, bandTop: 99, bandBottom: 250 },
        { name: 'Bravo', might: 2, level: null, anchorCy: 250, bandTop: 249, bandBottom: null },
      ];
      expect(ownerForBadge(pairs, 101, 500)?.name).toBe('Alpha');
    });

    it('refuses a badge that is nowhere near any member on the page', () => {
      // A row whose name fell outside the crop still shows its avatar, so its badge
      // can be read with no anchor to own it. Reaching for the nearest one regardless
      // would glue it onto whoever happens to be at the top or bottom of the page.
      const pairs: MightRow[] = [
        { name: 'Alpha', might: 1, level: null, anchorCy: 300, bandTop: 299, bandBottom: 450 },
        { name: 'Bravo', might: 2, level: null, anchorCy: 450, bandTop: 449, bandBottom: null },
      ];
      expect(ownerForBadge(pairs, 20, 600)).toBeNull();
      expect(ownerForBadge([], 300, 600)).toBeNull();
    });

    it('settles a split hero-level read by majority, not by digit count', () => {
      // Scroll overlap reads each member on 2-4 pages, and a level cannot change
      // mid-capture, so the readings are repeat measurements of one constant.
      expect(resolveLevel(new Map([[220, 3], [247, 1]]))).toBe(220);
      // ...which is the part digit count alone got wrong: a single ornament-inflated
      // read used to win on length no matter how many pages disagreed. Production
      // recorded a member at 1240 whose level is 240.
      expect(resolveLevel(new Map([[240, 2], [1240, 1]]))).toBe(240);
      expect(betterLevel(240, 1240)).toBe(240);
      expect(betterLevel(1240, 240)).toBe(240);
      // Level votes, and the clipped-leading-digit rule takes over — which is exactly
      // the case betterLevel was written for.
      expect(resolveLevel(new Map([[66, 1], [166, 1]]))).toBe(166);
      expect(resolveLevel(new Map([[220, 1]]))).toBe(220);
      expect(resolveLevel(new Map())).toBeNull();
    });

    it('resolves conflicting reads of one member towards the fuller number', () => {
      // Levels can't change mid-capture, so a disagreement is OCR damage. The badge
      // sits hard against the avatar frame, so digits get clipped — measured on the
      // live roster, one member read 66 on one page and 166 on the next, and
      // first-wins would have stored 66.
      expect(betterLevel(66, 166)).toBe(166);
      expect(betterLevel(166, 66)).toBe(166);
      expect(betterLevel(21, 214)).toBe(214);
      // A value always beats nothing: the badge only resolves on some pages.
      expect(betterLevel(null, 220)).toBe(220);
      expect(betterLevel(220, null)).toBe(220);
      expect(betterLevel(null, null)).toBeNull();
      expect(betterLevel(220, 220)).toBe(220);
      // Same digit count, still different — no principled tie-break, so take the
      // direction a level can actually move.
      expect(betterLevel(219, 220)).toBe(220);
    });

    it('strips merged leading digits off the name and records them as the level', () => {
      // Whether the badge becomes its own region is not stable — the detector merges
      // it when they sit close enough, so the SAME player arrives as two words on one
      // page and one word on the next. Production showed "vacation" then
      // "261 vacation", which counted as a second distinct name and would have
      // created a bogus "261 vacation" member. So the digits come off the name.
      //
      // But they are NOT trusted as a level, because textually this is
      // indistinguishable from a numeric name prefix — and production proved that
      // case is real: the roster's "LORD DRACON" renders as "大367 LORD DRÁCON", and
      // 367 was being stored as their hero level.
      const rows: PRow[] = [
        row(38, [['261 vacation (K:289 X:938 Y:472)', 20, 380]]),
        row(83, [['462,642,195', 790, 130]]),
      ];
      const { pairs } = pairNamesWithMight(rows);
      expect(pairs[0].name).toBe('vacation');
      expect(pairs[0].level).toBe(261);
    });

    it('tolerates the badge ornament glued onto the digits', () => {
      // The badge is a shield with a star, and OCR sometimes returns that ornament as
      // a glyph attached to the number. The same player has come back as "367",
      // "★367" and "大367" across runs. Untolerated, that row loses its level AND
      // keeps the junk in its name, which then matches no member and creates a
      // duplicate — the worse half of the two failures.
      // Every shape measured on the live roster. The ornament is not reliably a
      // symbol, is not reliably flush against the digits, and excluding either case
      // was the largest single cause of missed levels — so all of these have to yield
      // both the level and a clean name.
      for (const prefix of ['367', '★367', '大367', '中 367', 'd 367']) {
        const rows: PRow[] = [
          row(38, [[`${prefix} LORD DRACON (K:289 X:1 Y:1)`, 20, 380]]),
          row(83, [['1,310,381,155', 780, 140]]),
        ];
        const { pairs } = pairNamesWithMight(rows);
        expect(pairs[0].name).toBe('LORD DRACON');
        expect(pairs[0].level).toBe(367);
      }
    });

    it('cannot eat a genuinely numeric name', () => {
      // The ornament class excludes digits, which is what keeps the rule from
      // swallowing a name that simply starts with a long number: the class can't
      // consume the leading digits, so the required space never lines up.
      const rows: PRow[] = [
        row(38, [['12345 Foo (K:289 X:1 Y:1)', 20, 300]]),
        row(83, [['11,111,111', 790, 130]]),
      ];
      const { pairs } = pairNamesWithMight(rows);
      expect(pairs[0].name).toBe('12345 Foo');
      expect(pairs[0].level).toBeNull();
    });

    it('dedupes the merged and split forms to the same name', () => {
      // The two forms have to normalise identically or scroll overlap inflates the
      // distinct-name count and mints a duplicate member.
      const split: PRow[] = [
        row(38, [['261', 20, 40], ['vacation (K:289 X:1 Y:1)', 90, 300]]),
        row(83, [['462,642,195', 790, 130]]),
      ];
      const merged: PRow[] = [
        row(38, [['261 vacation (K:289 X:1 Y:1)', 20, 340]]),
        row(83, [['462,642,195', 790, 130]]),
      ];
      expect(pairNamesWithMight(split).pairs[0].name)
        .toBe(pairNamesWithMight(merged).pairs[0].name);
    });

    it('drops a row rather than emitting a one-letter name', () => {
      // Stripping "220 " off "220 X" would leave a single letter. Since digits aren't
      // letters, the remainder's letter count always equals the whole name's, so such
      // a row fails the two-letter floor either way and is discarded — no junk name,
      // and nothing for the caller to create a member from.
      const rows: PRow[] = [
        row(38, [['220 X (K:289 X:1 Y:1)', 20, 200]]),
        row(83, [['11,111,111', 790, 130]]),
      ];
      const { pairs, names, anchors } = pairNamesWithMight(rows);
      expect(anchors).toBe(1);
      expect(pairs).toEqual([]);
      expect(names).toEqual([]);
    });

    it('strips a merged prefix down to a two-letter name, the floor', () => {
      const rows: PRow[] = [
        row(38, [['220 Xy (K:289 X:1 Y:1)', 20, 220]]),
        row(83, [['11,111,111', 790, 130]]),
      ];
      const { pairs } = pairNamesWithMight(rows);
      expect(pairs[0].name).toBe('Xy');
      expect(pairs[0].level).toBe(220);
    });

    it('does not mistake a name that begins with digits for a level', () => {
      // "1337gamer" is ONE word, not a bare digit run, so the structural rule leaves
      // it alone — a positional threshold would have been much easier to get wrong.
      const rows: PRow[] = [
        row(38, [['1337gamer (K:289 X:1 Y:1)', 30, 260]]),
        row(83, [['12,345,678', 790, 130]]),
      ];
      const { pairs } = pairNamesWithMight(rows);
      expect(pairs[0].name).toBe('1337gamer');
      expect(pairs[0].level).toBeNull();
    });

    it('accepts four digits, for levels past 999', () => {
      const rows: PRow[] = [
        row(38, [['1024', 20, 50], ['Ascended (K:289 X:1 Y:1)', 90, 260]]),
        row(83, [['99,999,999', 790, 130]]),
      ];
      const { pairs } = pairNamesWithMight(rows);
      expect(pairs[0].level).toBe(1024);
      expect(pairs[0].name).toBe('Ascended');
    });

    it('does not strip the only word on the row', () => {
      // A row whose entire content is a number has no name to salvage; consuming it
      // as a level would leave a nameless member.
      const rows: PRow[] = [row(38, [['220 (K:289 X:1 Y:1)', 30, 200]])];
      expect(pairNamesWithMight(rows).names).toEqual([]);
    });
  });

  it('does not read the coordinates as a might value', () => {
    // A member row with NO might in the crop (the pre-widening Stage 4
    // rectangle). The coordinate digits are the only numbers present, and they
    // must be rejected on position AND on shape — reporting "no number found"
    // is what tells the operator to re-calibrate.
    const rows: PRow[] = [
      row(38, [['Queen of Chaos (K:302 X:173 Y:269)', 60, 380]]),
      row(144, [['Online', 20, 70]]),
    ];
    const { anchors, withoutMight } = pairNamesWithMight(rows);
    expect(anchors).toBe(1);
    expect(withoutMight).toBe(1);
    expect(paired(rows)).toEqual([]);
  });

  it('never takes a number from the next member down', () => {
    // The pairing has to be bounded below by the next anchor. If the band leaked
    // past it, member A would take member B's number and every row after would
    // be shifted by one — the exact failure this bound exists to prevent.
    const rows: PRow[] = [
      row(38, [['Alpha (K:302 X:1 Y:1)', 30, 220]]),
      row(200, [['Bravo (K:302 X:2 Y:2)', 30, 220]]),
      row(246, [['99,999,999', 790, 130]]),
    ];
    const { withoutMight } = pairNamesWithMight(rows);
    expect(withoutMight).toBe(1);
    expect(paired(rows)).toEqual([{ name: 'Bravo', might: 99_999_999 }]);
  });

  it('takes the right-most number when the band holds more than one', () => {
    const rows: PRow[] = [
      row(38, [['Alpha (K:302 X:1 Y:1)', 30, 220], ['12,345', 600, 90], ['87,654,321', 800, 130]]),
    ];
    expect(paired(rows)).toEqual([{ name: 'Alpha', might: 87_654_321 }]);
  });

  it('drops rows whose name did not survive OCR', () => {
    // Two letters minimum, mirroring member capture's guard, so a row mangled
    // down to punctuation can't become a roster lookup.
    const rows: PRow[] = [
      row(38, [['. (K:302 X:1 Y:1)', 30, 200]]),
      row(83, [['11,111,111', 790, 130]]),
      row(200, [['Bravo (K:302 X:2 Y:2)', 30, 220]]),
      row(246, [['22,222,222', 790, 130]]),
    ];
    expect(paired(rows)).toEqual([{ name: 'Bravo', might: 22_222_222 }]);
  });
});

/**
 * Splitting the hero-level badge off a name it was OCR'd into one region with.
 *
 * This leaked for weeks and the symptom was a new member per LEVEL-UP. The badge is
 * drawn in the avatar's shield, and the shield's lower point comes back from OCR as a
 * "/" sitting between the digits and the name. The old pattern required whitespace
 * straight after the digits, so it matched none of it and the whole badge survived
 * into the name — and because an unmatched name creates a member, the live roster
 * collected one row per level the player was seen at:
 *
 *     "370/ WrongPortal"  member, 2026-08-21
 *     "372/ WrongPortal"  member, 2026-08-30
 *     "373/ WrongPortal"  member, 2026-09-01
 *     "185/ taulen302"    member, 2026-08-22
 *
 * A merge rule per level is not a fix — each was written, and the next level-up would
 * have minted the next one. The level was lost too: this branch is what records it.
 *
 * The negative cases are every digit-bearing name on the real roster. They are the
 * expensive half: a badge that fails to strip costs a junk member row an admin can
 * merge away, but a NAME wrongly read as a badge silently renames a real player and
 * files their might under the wrong row.
 */
describe('splitBadgeAndName', () => {
  const split = (s: string): string => {
    const r = splitBadgeAndName(s);
    return r ? `${r.level}|${r.name}` : 'none';
  };

  it('strips a badge separated by the shield ornament', () => {
    // The four production readings, verbatim.
    expect(split('373/ WrongPortal')).toBe('373|WrongPortal');
    expect(split('372/ WrongPortal')).toBe('372|WrongPortal');
    expect(split('370/ WrongPortal')).toBe('370|WrongPortal');
    expect(split('185/ taulen302')).toBe('185|taulen302');
  });

  it('strips it however the ornament and the spacing fell', () => {
    // "373 / WrongPortal" is the one form the old pattern DID match, and it was worse
    // than a miss: `\s+` was satisfied and the name came back as "/ WrongPortal".
    expect(split('373 / WrongPortal')).toBe('373|WrongPortal');
    expect(split('373/WrongPortal')).toBe('373|WrongPortal');
    expect(split('373| WrongPortal')).toBe('373|WrongPortal');
    expect(split('373. WrongPortal')).toBe('373|WrongPortal');
    expect(split('373: WrongPortal')).toBe('373|WrongPortal');
  });

  it('still strips the plain whitespace form, and the ornament on the left', () => {
    // Regression cover for the reads this already handled: "vacation" came back as
    // "261 vacation" on one page and bare on the next, and the ornament does not
    // reliably sit flush against the digits.
    expect(split('261 vacation')).toBe('261|vacation');
    expect(split('367 LORD DRÁCON')).toBe('367|LORD DRÁCON');
    expect(split('中 249 Lothar')).toBe('249|Lothar');
    expect(split('d 175 virtus ex aqua')).toBe('175|virtus ex aqua');
  });

  it('never treats a real digit-bearing name as a badge', () => {
    // Every member on the live roster whose name contains a digit. A false strip here
    // renames a real player, which is far worse than a missed badge.
    for (const name of [
      '5miley', '1337gamer', 'alex21rus', 'Goztepe 1925', 'T3li', 'LuC14nT', 'Sm4sH',
      'AboS3D', 'F3GINIR', 'Wallst1', 'Cordarus 1', 'Kurt 2', 'Max75', 'Ale88',
      'Spartano666', 'Carleone86', 'HUSNAIN13', 'Stafford85', 'Bully26', 'bacardy1',
      'Darrinel2', 'Sezot0', 'Warrior 1977', 'taulen302', 'WrongPortal',
    ]) {
      expect(split(name), name).toBe('none');
    }
  });

  it('requires whitespace for a single-digit level', () => {
    // "5.Element" is the shape of an ordinary name, and a level-1-to-9 account is not
    // what turns up on a clan member list. Whitespace is unambiguous, so it stands.
    expect(split('5.Element')).toBe('none');
    expect(split('9-Lives')).toBe('none');
    expect(split('5 Somename')).toBe('5|Somename');
  });

  it('rejects a level outside the parse range and a name that is only punctuation', () => {
    expect(split('12345 Foo')).toBe('none');
    expect(split('0 Foo')).toBe('none');
    expect(split('373/ -')).toBe('none');
    expect(split('373/ A')).toBe('none');
  });
});
