/**
 * Read every clan member's "might" (power level) off the in-game member list.
 *
 * The member list shows, per row: the name plus map coordinates on the first
 * line, badge icons and an online/last-seen line below it, and the might number
 * on the far right — vertically level with the badges, NOT with the name. So
 * name and might land on two different OCR text rows and have to be paired
 * positionally.
 *
 * The pairing anchor is the coordinate marker. Every real member row carries
 * "(K:302 X:173 Y:269)"; rank-group headers (LEADER / SUPERIOR / OFFICER),
 * "Online" and "Was yesterday" do not. So each coord-bearing row opens a band
 * that runs down to the next coord-bearing row, and this member's might is the
 * right-most digits-only region inside that band. Measured 10/10 exact on the
 * real noisy captures in data/benchmark_gifts (2026.07.31 set), including rows
 * clipped by the crop edge, and still 10/10 with the crop scaled down 25%.
 *
 * This module is READ-ONLY with respect to the roster. It returns names and
 * numbers; it never touches the `members` table. Resolving a name to a member
 * (and deciding what to do when it doesn't resolve) is the caller's job — see
 * scheduler/might-capture-phase.ts. Keeping it that way means a might capture
 * can never create a member, reactivate one, or move `last_seen` and confuse
 * the inactivity sweep.
 *
 * Nothing here relates to the ChestTracker import; this is our own OCR.
 */
import type { Page } from 'playwright';
import sharp from 'sharp';
import { randomDelay } from '../utils/human-delay.js';
import { mouseMove, mouseWheel } from './input.js';
import { MEMBER_LIST_MAX_PAGES, MEMBER_LIST_DRY_PAGES_TO_STOP } from './member-list-sweep.js';
import { captureFullPage } from './screenshotter.js';
import { cleanPlayerName } from '../vision/player-names.js';
import { namesDifferByAltSuffix } from '../vision/ocr-normalize.js';
import { childLogger } from '../utils/logger.js';
import { requireMemberListCrop } from '../config/calibration.js';
import { DEFAULT_VIEWPORT_WIDTH, DEFAULT_VIEWPORT_HEIGHT } from '../config/viewport.js';
import {
  COORD_RE,
  MEMBER_CANONICAL_WIDTH,
  cropPctToPixels,
  ensureOnMembersTab,
  getCanvasRect,
  paddleMemberOcr,
  paddleMemberText,
  splitBadgeAndName,
  stripLikelyPrefixTag,
  type PRow,
} from './member-capture.js';

const log = childLogger('might-capture');

/**
 * Fraction of the canonical crop width past which a numeric region is treated
 * as the might column rather than part of the row's left-hand text.
 *
 * The might number's centre sat at 82–88 % across every benchmark capture, and
 * the left-hand text it must be told apart from — the coordinate digits — ends
 * by ~30 %. 0.55 is the midpoint of that gap, so it tolerates a crop whose
 * right edge the operator drew generously (pushing the number leftward in
 * canonical space) without ever reaching the coordinates.
 */
const MIGHT_MIN_CENTRE_X = 0.55;

/** Sanity bounds on a parsed value. Might runs from ~1k for a fresh account to
 *  a few billion; anything outside that is an OCR artifact, not a power level. */
const MIGHT_MIN_DIGITS = 4;
const MIGHT_MAX_DIGITS = 13;

// Both limits now live in member-list-sweep.ts, shared with the roster build.
// They were identical rules discovered twice, and the copy that didn't get the
// fix quietly truncated a 100-member roster to 88 — see that file.
const MAX_PAGES = MEMBER_LIST_MAX_PAGES;
const DRY_PAGES_TO_STOP = MEMBER_LIST_DRY_PAGES_TO_STOP;

/**
 * The shield ornament that OCR glues onto the level digits.
 *
 * The badge is a shield with a star, and the detector folds that decoration into the
 * number — the SAME player has come back as "367", "★367" and "大367", another as
 * "中249", another as "d175". It is not reliably a symbol, so excluding letters was
 * the single largest cause of missed levels. It also left the junk in the name, which
 * then matched no member and inflated the distinct-name count with a second variant
 * of one player ("virtus ex aqua" AND "d175 virtus ex aqua").
 *
 * At most two characters, and NEVER a digit. Excluding digits is what stops this
 * eating a genuinely numeric name: "12345 Foo" cannot match, because the ornament
 * class can't consume leading digits and the remainder doesn't leave a space where
 * one is required.
 */
const BADGE_ORNAMENT = /^[^\s\d]{0,2}\s*/u;

/** A badge on its own, as the avatar-strip re-read returns it. */
const BADGE_ALONE = /^[^\s\d]{0,2}\s*(\d{1,4})$/u;

/**
 * Above this, a parsed level is treated as OCR damage rather than a power level
 * when it has to compete with another reading.
 *
 * Levels run to roughly 600 in the live game. Four digits are still accepted at the
 * parse — a cap that silently drops readings would be worse than one that ranks them
 * — but a four-digit read never beats a plausible three-digit one. See betterLevel.
 */
const LEVEL_PLAUSIBLE_MAX = 999;

/**
 * Fraction of the crop width the avatar column occupies, for the badge re-read.
 *
 * Measured: names start at ~14 % of the canonical width when the rectangle includes
 * the avatars, so the frame and its badge sit below that. 0.20 leaves margin, and any
 * name text it catches is harmless — only a bare number can be taken as a level.
 */
const AVATAR_STRIP_FRACTION = 0.2;

/**
 * Width the avatar strip is upscaled to before OCR, and now the TRUE effective
 * resolution the badges are read at.
 *
 * It did not used to be: paddleMemberOcr silently rescaled the strip again to its own
 * 1000px canonical width, so the real figure was 1000 and this constant understated it.
 * That mattered twice over — the extra upscale doubled the OCR cost, and it invalidated
 * the strip-to-crop coordinate inverse in fillLevelsFromAvatarStrip, which assumes the
 * strip is still this wide. Badges were being mapped ~43% too far down the crop.
 *
 * Measured across three real production captures (9 hero levels with known values):
 *
 *     effective width   correct   strip OCR
 *     1000 (old)          9/9      1024 ms
 *      700 (now)          9/9       617 ms
 *      500                9/9       539 ms
 *      350                9/9       549 ms
 *
 * Left at 700 rather than pushed lower: accuracy holds all the way down, but the time
 * curve flattens below 700 (PaddleOCR has fixed per-call overhead), so the remaining
 * ~80ms is not worth narrowing the legibility margin for on a nine-reading corpus,
 * across clans that may render the UI at other scales.
 */
const AVATAR_STRIP_WIDTH = 700;

export interface MightRow {
  /** Cleaned name, put through the same steps member capture uses. */
  name: string;
  might: number;
  /**
   * Hero level, from the gold badge on the avatar frame, or null when the avatar
   * wasn't inside the crop.
   *
   * Only present when the calibrated rectangle reaches left far enough to include
   * the avatars. PaddleOCR reads it reliably when it is there — 12/12 detected and
   * 7/7 correct against hand-checked screenshots — but the default calibration
   * deliberately starts right of the avatar frames, so it is normally null.
   */
  level: number | null;
  /**
   * Vertical centre, in CANONICAL coordinates, of the text row this member's name
   * was read from.
   *
   * This is the anchor a hero-level badge is matched against — see
   * fillLevelsFromAvatarStrip. Carried explicitly rather than being re-derived from
   * `bandTop` because the two answer different questions: the band is an extent to
   * cut a crop from, the anchor is a point to measure a distance to, and matching a
   * badge against the band's EDGE is precisely the bug this field exists to remove.
   */
  anchorCy: number;
  /**
   * Vertical extent of this member's row in CANONICAL coordinates (the 1000px-wide
   * space paddleMemberOcr works in), so the caller can cut the row out of the page
   * crop as review evidence. `bottom` is null for the last row on a page, whose
   * band is open-ended — clamp it to the crop height.
   */
  bandTop: number;
  bandBottom: number | null;
  /** Path to a saved crop of this row, when one was kept. See keepCropFor. */
  cropPath?: string;
}

export interface MightCaptureResult {
  rows: MightRow[];
  pagesScanned: number;
  /** Member rows seen (coord-marker anchors), before dedupe. */
  coordRowsSeen: number;
  /**
   * Sum, over pages, of member rows where no number was found in the band.
   *
   * Usually benign and usually the SAME row counted repeatedly. The might number
   * sits below-right of the name (level with the badge icons), so whenever a name
   * lands near the bottom of the crop its number falls past the crop's bottom
   * edge — one such row per page, on every page that fits an extra name. The next
   * scroll brings that member higher up and the value is read then.
   *
   * `unresolvedNames` is the number that actually matters; compare the two.
   */
  rowsWithoutMight: number;
  /**
   * Members whose name was read but who never yielded a value on ANY page.
   *
   * This is real loss, and it has one systematic cause: the last member in the
   * list. Once the sweep is scrolled to the bottom there is no further page to
   * re-read them from, so if the crop's bottom edge sits above the panel's, the
   * final row's number is permanently out of view. Fixed by dragging the Stage 4
   * rectangle's bottom edge down to (or past) the bottom of the member panel.
   */
  unresolvedNames: string[];
  /** Same member read twice with different values across scroll overlap. */
  disagreements: number;
  /** True when the members panel could not be reached at all. */
  navigationFailed: boolean;
}

/**
 * Parse a might string. Deliberately strict: only a run of digits with optional
 * thousands separators. That rejects "(K:302", "X:173", "Y:269)", "18 h", and
 * any stray glyph, so nothing that isn't a bare number can be mistaken for a
 * power level even if it lands in the right-hand column.
 */
export function parseMight(text: string): number | null {
  const t = text.trim();
  if (!/^\d[\d.,\s]*\d$/.test(t) && !/^\d$/.test(t)) return null;
  // Separators vary by locale (1,234 / 1.234 / 1 234) and carry no meaning
  // here, so strip them rather than trying to interpret them.
  const digits = t.replace(/[^\d]/g, '');
  if (digits.length < MIGHT_MIN_DIGITS || digits.length > MIGHT_MAX_DIGITS) return null;
  const n = Number.parseInt(digits, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Pair each member row on one OCR'd page with its might value.
 *
 * Exported for tests — this is the part that can silently attach the wrong
 * number to the wrong player, so it's kept pure (rows in, pairs out) and
 * covered directly.
 */
export function pairNamesWithMight(
  rows: PRow[],
  canonicalWidth = MEMBER_CANONICAL_WIDTH,
): {
  pairs: MightRow[];
  names: string[];
  anchors: number;
  withoutMight: number;
  /**
   * Canonical cy of EVERY member row on the page, including the ones that never
   * became a pair — a name mangled below two letters, or a might value clipped off
   * the crop edge.
   *
   * They are dropped from `pairs` but they are still rows on the screen with an
   * avatar and a badge, so the hero-level matcher has to know they exist: a badge
   * belonging to a dropped row must be discarded, not handed to whichever surviving
   * member is next-nearest. See ownerForBadge.
   */
  anchorYs: number[];
} {
  const anchorIdx: number[] = [];
  rows.forEach((row, i) => {
    if (COORD_RE.test(row.words.map((w) => w.text).join(' '))) anchorIdx.push(i);
  });

  const pairs: MightRow[] = [];
  /** Every usable member name on this page, whether or not a value was found. */
  const names: string[] = [];
  let withoutMight = 0;

  for (let a = 0; a < anchorIdx.length; a++) {
    const anchor = rows[anchorIdx[a]];

    // Split the avatar's level badge off the front of the row before reading the
    // name.
    //
    // The badge sits at the avatar's top-right, level with the name's vertical
    // centre, so PaddleOCR groups it into the NAME's text row as a separate leading
    // word. Left in place it becomes part of the name — measured on real captures:
    // "220 GlaiveError", "213 Tax Collector" — which matches no member, and since
    // an unmatched name now creates one, it would mint a junk member every day.
    //
    // Structural rather than positional: the level is always the row's FIRST word
    // and always bare digits, so there's no crop-relative threshold to get wrong. A
    // name that merely starts with digits ("1337gamer") is one word, not a bare
    // digit run, so it is untouched. The guard on words.length keeps a row whose
    // only content is a number from being read as a nameless level.
    const words = [...anchor.words];
    let level: number | null = null;
    const firstBare = words[0]?.text.trim().replace(BADGE_ORNAMENT, '') ?? '';
    if (words.length > 1 && /^\d{1,4}$/.test(firstBare)) {
      const parsed = Number.parseInt(firstBare, 10);
      // Levels run 1..600 today; allow to 9999 for headroom without letting a
      // stray 4-digit read pass as a level.
      if (parsed >= 1 && parsed <= 9999) {
        level = parsed;
        words.shift();
      }
    }
    const line2 = words.map((w) => w.text).join(' ');
    // Whether the badge became its own region is not stable: the detector merges it
    // into the name when they sit close enough, so the SAME player can come back as
    // two words on one page and one word on the next. Observed in production —
    // "vacation" on page 1, "261 vacation" on page 2 — which slipped past the
    // word-level split above, counted as a second distinct name, and would have
    // created a bogus "261 vacation" member. So the merged form is stripped too,
    // below, once the name has been extracted.

    // The name is everything before the coordinate marker. Non-greedy up to the
    // marker rather than a character class, so names with spaces and punctuation
    // ("John Wick II", "Princess of Chaos") survive intact.
    const m = line2.match(/^\s*(.+?)\s*\(?\s*[Kk]\s*[:.]?\s*\d/);
    // Cleaned but NOT prefix-stripped. stripLikelyPrefixTag treats any leading
    // token of ≤3 letters as a clan tag, which mangles perfectly ordinary names:
    // against the live roster it turned "Tax Collector" into "Collector", "DS
    // PORTOS" into "PORTOS" and "Mr Mathman" into "Mathman", none of which then
    // matched the member row storing the full name. The caller tries both forms —
    // see nameMatchCandidates — so keeping the unabridged read here loses nothing
    // for genuinely tag-prefixed names.
    let name = cleanPlayerName((m?.[1] ?? '').trim());

    // Merged case: OCR returned the badge and the name as ONE region ("261
    // vacation"). Whether the badge gets its own region isn't stable — it depends on
    // how close the two land at that scroll position — so the same player arrives
    // split on one page and merged on the next, and this branch is where most of the
    // coverage lives.
    //
    // The digits are the badge. That was briefly doubted because the member list
    // renders one player as what OCR returns as "367 LORD DRÁCON", which looked like a
    // numeric name prefix — but the screenshot shows 367 sitting in the avatar's green
    // level shield, and the leading glyph was just noise off the ornate frame. So it
    // is a level, and refusing to record it only lost data.
    //
    // Stripping it off the name is separately necessary: leaving it in produces a name
    // that matches no member, and since an unmatched name now creates one, it would
    // mint a junk member every day.
    if (level === null) {
      const merged = splitBadgeAndName(name);
      if (merged) {
        level = merged.level;
        name = merged.name;
      }
    }

    // The band this member owns: from its own text row down to the next
    // member's. The last member's band runs to the bottom of the crop.
    const anchorCy = anchor.cy;
    const bandTop = anchorCy - 1;
    const bandBottom = a + 1 < anchorIdx.length
      ? rows[anchorIdx[a + 1]].cy
      : Number.POSITIVE_INFINITY;

    let best: { value: number; x: number } | null = null;
    for (let i = anchorIdx[a]; i < rows.length; i++) {
      if (rows[i].cy >= bandBottom) break;
      if (rows[i].cy < bandTop) continue;
      for (const word of rows[i].words) {
        const centreX = (word.box.x + word.box.width / 2) / canonicalWidth;
        if (centreX < MIGHT_MIN_CENTRE_X) continue;
        const value = parseMight(word.text);
        if (value === null) continue;
        // Right-most wins. The might number is the last thing on the row, so
        // if a future UI change ever adds another number to its left this
        // still picks the right one.
        if (!best || word.box.x > best.x) best = { value, x: word.box.x };
      }
    }

    // A letter count guard mirroring member capture's: two letters minimum, any
    // script, so a name mangled down to punctuation can't become a roster
    // lookup. Counted as "without might" only when the name was usable —
    // otherwise a garbled row would look like a crop problem.
    const letters = (name.match(/\p{L}/gu) || []).length;
    if (name.length < 2 || letters < 2) continue;

    names.push(name);

    if (best === null) {
      withoutMight++;
      continue;
    }
    pairs.push({
      name,
      might: best.value,
      level,
      anchorCy,
      bandTop,
      bandBottom: Number.isFinite(bandBottom) ? bandBottom : null,
    });
  }

  return {
    pairs,
    names,
    anchors: anchorIdx.length,
    withoutMight,
    anchorYs: anchorIdx.map((i) => rows[i].cy),
  };
}

/**
 * How far a badge may sit from a member's name row, as a fraction of the row pitch,
 * before it is treated as belonging to nobody on this page.
 *
 * Only a backstop against a badge from a row whose name fell outside the crop; the
 * real assignment is nearest-anchor. 0.6 is comfortably past the largest offset a
 * badge has ever shown against its own name (single-digit canonical px, see
 * ownerForBadge) and comfortably short of a full row.
 */
const BADGE_MAX_REACH_FRACTION = 0.6;

/**
 * Member rows a page crop holds, used only to guess a row pitch when there is
 * exactly one member on the page and no gap to measure. The calibrated rectangle
 * shows 3–4 rows.
 */
const ROWS_PER_PAGE_ESTIMATE = 3;

/**
 * Which member a hero-level badge belongs to: the one whose NAME ROW it sits
 * closest to.
 *
 * Nearest anchor, NOT containment in a band, and the distinction was worth 45% of
 * the roster. What it replaced looked safe and had no margin at all:
 *
 *   bandTop_a    = cy_a - 1          (pairNamesWithMight)
 *   bandBottom_a = cy_{a+1}          (NOT cy_{a+1} - 1)
 *
 * so consecutive bands OVERLAP on [cy_{a+1} - 1, cy_{a+1}) — and the matcher used
 * `find`, which takes the first hit in top-to-bottom order, so everything landing in
 * that sliver went to the member ABOVE. The badge is not drawn above its name, as
 * was assumed for a while; measured across four real production crops it sits within
 * ±0.5 canonical px of its own name row's centre, dead on the overlap. The effective
 * tolerance was therefore ZERO, not the one pixel the `- 1` appears to buy, and
 * which side of it a badge fell on was decided by sub-pixel scroll alignment.
 *
 * Production shows the result. Across 15 game days and 2376 readings, 238 hero
 * levels sit off the longest non-decreasing run a level is physically allowed to
 * take; taking the scan's own sighting order, 156 of them are the level of the
 * member read immediately AFTER them, against 14 the other way and ~4 expected by
 * chance. Reproduced directly on tests/fixtures/member-list-page1-leader.png: shift
 * that crop by 1–34 native px — an ordinary scroll alignment, which every page after
 * the first has — and taulen302 is handed Princess of Chaos's level in 5 of 8
 * offsets, Princess ending up with none. Offset 0 is the one alignment where all
 * three are right, which is why the fixture test passed throughout.
 *
 * Nearest-anchor trades that zero-pixel margin for half a row pitch (~75 canonical
 * px on the same crop) and cannot be tipped by a pixel.
 *
 * Two things it must be told about, or it re-opens the same hole from the other end:
 *
 *   - EVERY pair, not just the ones still missing a level. A badge nearest a member
 *     who already has one belongs to them, and must be dropped rather than handed to
 *     whichever unread member is next-nearest.
 *   - `allAnchorYs`, every member row on the page INCLUDING those pairNamesWithMight
 *     dropped — a name mangled below two letters, or a might value clipped off the
 *     crop edge. They are still rows on screen wearing a badge. Judged against the
 *     survivors alone, a dropped row's badge is simply the nearest neighbour's, which
 *     is the original bug wearing a different hat.
 */
export function ownerForBadge(
  pairs: MightRow[],
  y: number,
  canonH: number,
  allAnchorYs?: number[],
): MightRow | null {
  if (pairs.length === 0) return null;

  // Fall back to the pairs' own anchors when the caller has nothing better; every
  // in-tree caller passes the full list.
  const anchors = allAnchorYs && allAnchorYs.length > 0
    ? [...allAnchorYs].sort((a, b) => a - b)
    : pairs.map((p) => p.anchorCy);

  let nearest = anchors[0];
  let bestDist = Number.POSITIVE_INFINITY;
  for (const cy of anchors) {
    const d = Math.abs(y - cy);
    if (d < bestDist) { bestDist = d; nearest = cy; }
  }

  // Lower median rather than mean: rank-group headers (LEADER / SUPERIOR / OFFICER)
  // push one pair of rows much further apart than the rest, and anything that lets
  // that gap set the pitch would stretch the reach for every row on the page.
  const gaps: number[] = [];
  for (let i = 1; i < anchors.length; i++) {
    const gap = anchors[i] - anchors[i - 1];
    if (gap > 0) gaps.push(gap);
  }
  gaps.sort((a, b) => a - b);
  const pitch = gaps.length > 0
    ? gaps[Math.floor((gaps.length - 1) / 2)]
    : canonH / ROWS_PER_PAGE_ESTIMATE;

  if (bestDist > pitch * BADGE_MAX_REACH_FRACTION) return null;
  // Nearest anchor identified — but it only yields a level if it is a member we are
  // actually recording. A badge closest to a dropped row belongs to nobody.
  return pairs.find((p) => p.anchorCy === nearest) ?? null;
}

/**
 * Second-chance read of the hero-level badges, on the avatar column alone.
 *
 * Fills in `level` for rows the main pass left null, in place. Runs only once the
 * capture has established that the crop actually contains avatars, so a rectangle
 * calibrated to start right of them never pays for this.
 *
 * Each badge goes to the member whose name row it sits NEAREST — see ownerForBadge
 * for why containment in a band was the wrong test and what it cost.
 */
export async function fillLevelsFromAvatarStrip(
  pageCrop: Buffer,
  canonH: number,
  pairs: MightRow[],
  allAnchorYs?: number[],
): Promise<number> {
  const needy = pairs.filter((p) => p.level === null);
  if (needy.length === 0) return 0;

  try {
    const meta = await sharp(pageCrop).metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    const stripW = Math.round(width * AVATAR_STRIP_FRACTION);
    if (stripW < 20 || height < 20) return 0;

    const strip = await sharp(pageCrop)
      .extract({ left: 0, top: 0, width: stripW, height })
      .resize({ width: AVATAR_STRIP_WIDTH, kernel: 'lanczos3' })
      .png()
      .toBuffer();

    // Tell the OCR the strip is already at its intended resolution. Without this it
    // rescaled 700 -> 1000, which made the row coordinates 1.43x larger than
    // toMainCanon below expects — mapping every badge ~43% too far down the crop. Three
    // members per page have bands wide enough to absorb that; eight or ten do not,
    // which is the likeliest reason coverage plateaued around 85%.
    const { rows } = await paddleMemberOcr(strip, { canonicalWidth: AVATAR_STRIP_WIDTH });

    // Strip-canonical y → main-canonical y. The strip was cut at native scale then
    // resized to AVATAR_STRIP_WIDTH, so undo that and re-apply the main crop's scale.
    const toMainCanon = (yStrip: number): number =>
      (yStrip * (stripW / AVATAR_STRIP_WIDTH)) * (MEMBER_CANONICAL_WIDTH / width);

    let filled = 0;
    for (const row of rows) {
      for (const word of row.words) {
        const m = word.text.trim().match(BADGE_ALONE);
        if (!m) continue;
        const value = Number.parseInt(m[1], 10);
        if (value < 1 || value > 9999) continue;

        // The BADGE's own centre, not the row's. A strip row is usually the badge
        // alone, but the strip is 20% of the crop wide and often clips the first
        // letters of the name in beside it — and paddleMemberOcr's row centre is the
        // running mean of its words, so whether that fragment was detected shifted
        // the badge's apparent y by a dozen canonical pixels from page to page. That
        // wobble is what made the old band test flip between the right member and the
        // one above; the word box does not move.
        const y = toMainCanon(word.box.y + word.box.height / 2);
        const owner = ownerForBadge(pairs, y, canonH, allAnchorYs);
        if (!owner || owner.level !== null) continue;
        owner.level = value;
        filled++;
      }
    }
    return filled;
  } catch (err) {
    // Never fatal: the might values are what matter, and a level is a bonus.
    log.debug(`Avatar-strip level re-read failed: ${String(err)}`);
    return 0;
  }
}

/**
 * True when two readings differ only by characters this OCR confuses.
 *
 * Distinguishes the two reasons two readings can resolve to the same member:
 *
 *   same player, read twice   "mikl" / "mikI"   — capital-I for lowercase-l
 *   two different players     "Bain" / "Fain"   — B and F look nothing alike
 *
 * Both are one edit apart, so distance can't tell them apart, and the caller's
 * decision hinges on it: a different player must become a new member (or their
 * reading is lost), while the same player read twice must NOT (or every capture
 * mints a duplicate). Production produced exactly that — "mikI" was created as a
 * member alongside "mikl".
 *
 * Collapses the confusable classes onto one representative each. Deliberately
 * separate from vision/ocr-normalize's ocrNormalize, which maps 1→l but has no
 * i↔l rule and is shared with chest-name matching — this needs the letter pair and
 * nothing else needs it.
 */
export function sameOcrSkeleton(a: string, b: string): boolean {
  // The skeleton throws digits away, which is right for the ones that are letter
  // lookalikes and wrong for the rest: it collapsed "FELI" and "FELI 2" onto "fell"
  // and reported one player read twice, so the second member was dropped from every
  // capture. Identity digits are settled first, on the unskeletonised names.
  if (namesDifferByAltSuffix(a, b)) return false;
  const skeleton = (s: string): string => s
    .toLowerCase()
    .replace(/[il1|!]/g, 'l')  // capital-I, lowercase-l, one, pipe, bang
    .replace(/[o0]/g, 'o')
    .replace(/[s5]/g, 's')
    .replace(/[b8]/g, 'b')
    .replace(/[g9]/g, 'g')
    .replace(/[^a-z]/g, '');
  const sa = skeleton(a);
  return sa.length > 0 && sa === skeleton(b);
}

/** Same key member capture dedupes on, so scroll overlap collapses identically. */
function normalizeKey(name: string): string {
  return name.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * Reconcile two hero-level reads of the same member across scroll pages.
 *
 * Either can be null — the badge only resolves on some pages — so a value always
 * beats nothing. When both have a value and they differ, that's OCR damage, because
 * a level cannot change during one capture. The longer digit run wins: the badge sits
 * hard against the avatar frame, so the failure mode is a clipped LEADING digit.
 * Measured on the live roster, where one member read as 66 on one page and 166 on the
 * next — first-wins would have stored 66.
 *
 * Exported for tests: silently keeping the wrong one of two plausible levels is the
 * kind of bug that never announces itself.
 */
export function betterLevel(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  if (a === b) return a;
  // An implausible value loses to a plausible one before digit count is consulted.
  //
  // Without this the "longer digit run wins" rule below cuts the wrong way against
  // the ornament: the shield's star decoration is read as a leading glyph, and when
  // that glyph comes back as a DIGIT the badge parses one digit too long. Production
  // recorded a member at 1240 whose level is 240 — a four-digit run beating the
  // three-digit truth, which then also beat it in the same-day MAX() upsert and
  // stuck. Levels run to roughly 600 today; parsing still accepts four digits for
  // headroom, but a four-digit read never outranks a plausible three-digit one.
  const plausibleA = a <= LEVEL_PLAUSIBLE_MAX;
  const plausibleB = b <= LEVEL_PLAUSIBLE_MAX;
  if (plausibleA !== plausibleB) return plausibleA ? a : b;
  const da = String(a).length;
  const db = String(b).length;
  if (da !== db) return da > db ? a : b;
  // Same digit count and still different: no principled tie-break, so take the
  // larger, which is the direction a level can actually move.
  return Math.max(a, b);
}

/**
 * Resolve one member's hero level from every reading the sweep took of them.
 *
 * Majority vote, because scroll overlap shows each member on 2–4 pages and a level
 * cannot change during a single capture — so the readings are repeat measurements of
 * one constant and the modal value is simply the best estimate of it. The previous
 * rule reconciled them pairwise with betterLevel alone, which is order-dependent and
 * lets ONE damaged page outrank several clean ones: a single clipped or
 * ornament-inflated read won on digit count no matter how many pages disagreed.
 *
 * betterLevel stays as the tie-break, which is where it belongs — with the votes
 * level, the question really is "which of these two is the better read", and a
 * clipped leading digit (66 for 166) is exactly that case.
 */
export function resolveLevel(votes: Map<number, number>): number | null {
  // Plausibility outranks the count. An ornament read as a leading digit inflates the
  // badge by one digit, and that damage can repeat across pages — the star sits in
  // the same place on every one — so a majority of 1240s is exactly as wrong as a
  // single one when the level is 240. Only applied when a plausible reading exists to
  // fall back on, so a member whose every reading came back four digits still gets a
  // value rather than nothing.
  const candidates = [...votes].filter(([level]) => level <= LEVEL_PLAUSIBLE_MAX);
  const pool = candidates.length > 0 ? candidates : [...votes];

  let best: number | null = null;
  let bestCount = 0;
  for (const [level, count] of pool) {
    if (count > bestCount) { best = level; bestCount = count; }
    else if (count === bestCount) best = betterLevel(best, level);
  }
  return best;
}

/** Vertical padding around a saved row crop, in canonical px, so the cut doesn't
 *  shave the glyphs it's meant to show. */
const ROW_CROP_PAD = 6;

/**
 * Cut one member's row out of the page crop and save it as review evidence.
 *
 * Only called for a name the caller flagged as new, and only the first time that
 * name is seen, so this is roughly one small PNG per new member ever.
 *
 * Returns the saved path, or undefined when no crop was wanted or the extract
 * failed. A failure is never fatal: the member still gets created and reviewed,
 * just without a picture, which is strictly better than losing the reading.
 */
async function maybeSaveRowCrop(
  pageCrop: Buffer,
  canonH: number,
  row: MightRow,
  keepCropFor: ((name: string) => boolean) | undefined,
): Promise<string | undefined> {
  if (!keepCropFor || !keepCropFor(row.name)) return undefined;

  try {
    const meta = await sharp(pageCrop).metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (width < 8 || height < 8) return undefined;

    // Band coordinates are canonical (1000px wide); scale back to this crop.
    const scale = height / Math.max(1, canonH);
    const topCanon = Math.max(0, row.bandTop - ROW_CROP_PAD);
    const bottomCanon = Math.min(canonH, (row.bandBottom ?? canonH) + ROW_CROP_PAD);
    const top = Math.max(0, Math.round(topCanon * scale));
    const bottom = Math.min(height, Math.round(bottomCanon * scale));
    if (bottom - top < 8) return undefined;

    const slice = await sharp(pageCrop)
      .extract({ left: 0, top, width, height: bottom - top })
      .png()
      .toBuffer();

    const { saveScreenshot } = await import('./screenshotter.js');
    const { MIGHT_NEW_MEMBER_CROP_DIR } = await import('../utils/crop-dirs.js');
    // Forced: this is evidence an admin needs, not a debug aid, so it must land
    // regardless of log level.
    const saved = await saveScreenshot(
      slice,
      MIGHT_NEW_MEMBER_CROP_DIR,
      `might_new_member_${normalizeKey(row.name) || 'row'}`,
      { force: true },
    );
    return saved || undefined;
  } catch (err) {
    log.debug(`Could not save a might row crop for "${row.name}": ${String(err)}`);
    return undefined;
  }
}

/**
 * The name forms to try when resolving a reading to a member, best first.
 *
 * Two forms exist because the roster is built from two sources that disagree
 * about clan tags. Member capture applies stripLikelyPrefixTag, so a player it
 * captured may be stored as "Megros" even though the member list renders "XG
 * Megros"; the chest-scan path doesn't strip, so anyone who arrived that way is
 * stored with their name intact, tag and all ("Tax Collector"). Trying the
 * verbatim read first and the stripped variant second matches both without
 * guessing which source a given member came from.
 */
export function nameMatchCandidates(name: string): string[] {
  const forms = [name];

  const stripped = stripLikelyPrefixTag(name);
  if (stripped && stripped !== name) forms.push(stripped);

  // Belt-and-braces for a level badge that survived into the name.
  //
  // pairNamesWithMight strips it, so this rarely fires — but a badge whose ornament
  // OCR'd as four or more characters would slip past that, and the consequence there
  // is a duplicate member rather than a missing number. Offering the stripped form as
  // a match candidate costs nothing and never changes what gets stored.
  const badgeLeftover = splitBadgeAndName(name);
  if (badgeLeftover) forms.push(badgeLeftover.name);

  // And for the ornament WITHOUT the digits: the badge can get its own OCR region
  // (so the level is already known and the digits are gone) while the shield's lower
  // point stays attached to the name — "/ WrongPortal". Nothing upstream strips that,
  // because cleanPlayerName's leading-junk class covers decorative symbols and not
  // separators, and widening it would reach the gift scan too.
  //
  // A candidate only, deliberately. A name that genuinely opens with punctuation
  // ("-=Ghost=-") keeps its stored spelling; this just also lets it match a roster
  // row that has it without.
  const ornamentStripped = name.replace(/^[^\s\p{L}\p{N}]{1,3}\s*/u, '');
  if (ornamentStripped !== name && (ornamentStripped.match(/\p{L}/gu) || []).length >= 2) {
    forms.push(ornamentStripped);
  }

  // Zero-for-oh, the one homoglyph this font actually produces. Measured on the
  // live roster: "mimooooo" read as "mimo0000" and "CHaoS JOooO" as "CHaoS
  // JO00O". Both are several edits away once every o is involved, so the fuzzy
  // budget can't reach them — but folded they match exactly.
  //
  // Only ever a fallback (the verbatim form is tried first), so names that
  // legitimately contain a zero — "Andrev60", "taulen302" — resolve on their own
  // spelling before this is consulted, and only a name that matched nothing at
  // all can be affected.
  for (const form of [...forms]) {
    if (form.includes('0')) forms.push(form.replace(/0/g, 'o'));
  }

  return [...new Set(forms)];
}

export interface MightCaptureOptions {
  /** Save the navigation/crop debug PNGs. Off by default: this runs daily, and
   *  the forced saves inside ensureOnMembersTab would otherwise deposit a new
   *  set every single day. */
  saveDebugShots?: boolean;
  onProgress?: (message: string) => void;
  /**
   * Whether to keep a screenshot crop of this member's row as review evidence.
   *
   * The caller decides, because only it knows the roster — this module is
   * deliberately DB-free. In practice it answers "is this name new to us", which
   * keeps the cost at roughly one small PNG per new member ever rather than one
   * per member per day. Called at most once per unique name per capture.
   */
  keepCropFor?: (name: string) => boolean;
}

/**
 * Navigate to CLAN → Members, scroll the whole list, and return one
 * (name, might) pair per member found.
 *
 * Throws only on a genuinely broken precondition (missing calibration). A
 * navigation failure is reported via `navigationFailed` rather than thrown,
 * because the caller treats every outcome the same way: log it and move on
 * without disturbing the scan that already completed.
 */
/**
 * Wheel events fired upwards before a sweep starts, to guarantee the member
 * list is at the top. Sized for a full 100-member clan: the sweep advances a
 * page with 4 events, and a full roster is ~25 pages, so 120 covers it with
 * room for the shorter rows a clan of taller entries produces.
 */
const REWIND_WHEEL_EVENTS = 120;

export async function captureMemberMight(
  page: Page,
  opts: MightCaptureOptions = {},
): Promise<MightCaptureResult> {
  const { onProgress } = opts;
  const result: MightCaptureResult = {
    rows: [],
    pagesScanned: 0,
    coordRowsSeen: 0,
    rowsWithoutMight: 0,
    unresolvedNames: [],
    disagreements: 0,
    navigationFailed: false,
  };

  const firstShot = await captureFullPage(page);
  const firstMeta = await sharp(firstShot).metadata();
  const screenshotSize = {
    width: firstMeta.width ?? DEFAULT_VIEWPORT_WIDTH,
    height: firstMeta.height ?? DEFAULT_VIEWPORT_HEIGHT,
  };
  const canvasRect = await getCanvasRect(page);

  // ensureOnMembersTab forces its debug saves; wrap the real saver so a daily
  // run can opt out without changing that behaviour for member capture.
  const { saveScreenshot } = await import('./screenshotter.js');
  const save = opts.saveDebugShots
    ? saveScreenshot
    : async (): Promise<string> => '';

  const onMembers = await ensureOnMembersTab(
    page,
    (buffer: Buffer) => paddleMemberText(buffer),
    screenshotSize,
    canvasRect,
    save,
    onProgress,
  );
  if (!onMembers) {
    result.navigationFailed = true;
    return result;
  }

  const cropPx = cropPctToPixels(requireMemberListCrop(), canvasRect, screenshotSize);
  log.debug(
    `Might capture crop px=[${cropPx.left},${cropPx.top}–${cropPx.left + cropPx.width},${cropPx.top + cropPx.height}]`,
  );

  // Scroll with the cursor over the middle of the calibrated rectangle.
  //
  // Member capture hardcodes (700, 450), which on a real deployment sits ~90px
  // LEFT of the member rows — over the My Clan dialog's sidebar rail. The wheel
  // still moved the list (the dialog propagates it), but aiming at an element we
  // only hope forwards the event is not something to inherit. The calibrated
  // rectangle is, by definition, on the member rows.
  //
  // Converted from screenshot pixels to CSS pixels because mouse coordinates are
  // CSS and a screenshot is device pixels — identical at dpr 1 (the scanner's
  // 1920x1080 viewport), but not something to assume.
  const viewport = page.viewportSize();
  const cssScaleX = viewport ? viewport.width / screenshotSize.width : 1;
  const cssScaleY = viewport ? viewport.height / screenshotSize.height : 1;
  const scrollAt = {
    x: Math.round((cropPx.left + cropPx.width / 2) * cssScaleX),
    y: Math.round((cropPx.top + cropPx.height / 2) * cssScaleY),
  };
  log.debug(`Might capture scrolling at CSS (${scrollAt.x}, ${scrollAt.y})`);

  // Rewind to the top of the list before reading anything.
  //
  // The sweep below walks downwards and stops when the view stops changing, so
  // it silently reads only the tail if the list is already scrolled. That was
  // survivable while the only caller opened the Members panel fresh — the panel
  // opens at the top — and stopped being survivable the moment member capture
  // started chaining this straight after its own sweep, which ends at the
  // bottom. The failure is the quiet kind: a snapshot of the last four members,
  // recorded as the day's capture, which then satisfies the once-a-day gate and
  // keeps the real one from running.
  //
  // Unconditional rather than "scroll up if we might be scrolled": at the top
  // of the list these wheel events do nothing, which is a cheap price for not
  // having to know where the previous caller left the view.
  await mouseMove(page, scrollAt.x, scrollAt.y);
  for (let i = 0; i < REWIND_WHEEL_EVENTS; i++) {
    await mouseWheel(page, 0, -100);
    await randomDelay(15, 30);
  }
  await randomDelay(300, 500);

  // First read wins on ties, but a longer digit run beats a shorter one: a row
  // clipped by the crop edge reads short ("63,162,151" for "163,162,151"), and
  // within a single capture the true value cannot have changed between pages, so
  // any disagreement is OCR damage and the fuller read is the better one.
  //
  // Hero levels are NOT reconciled pairwise like the might is. They are tallied —
  // every page that reads a badge for a member casts a vote, and resolveLevel takes
  // the winner at the end. A level cannot change mid-capture, so the 2–4 reads scroll
  // overlap produces are repeat measurements of one constant, and a majority is a
  // strictly better estimator than any order-dependent pairwise rule.
  const byKey = new Map<string, {
    name: string; might: number; digits: number; levelVotes: Map<number, number>; cropPath?: string;
  }>();
  // Every member name the sweep saw, valued or not. Differencing this against
  // byKey at the end turns "N rows had no number" — which is mostly the same
  // clipped row counted once per page — into "these specific members never got a
  // value", which is the only version of that fact worth acting on.
  const namesSeen = new Map<string, string>();
  const crypto = await import('crypto');
  let lastHash = '';
  let sameCount = 0;
  let dryPages = 0;
  /** Set once any page yields a hero level, which proves the crop reaches the avatars
   *  and so gates the extra avatar-strip OCR pass. */
  let avatarsInCrop = false;

  for (let pageNum = 0; pageNum < MAX_PAGES; pageNum++) {
    const uniqueBefore = byKey.size;
    const screenshot = await captureFullPage(page);

    let cropped: Buffer;
    try {
      cropped = await sharp(screenshot).extract(cropPx).png().toBuffer();
    } catch {
      log.debug('Could not crop the member list for might; using the full screenshot');
      cropped = screenshot;
    }

    // One forced debug crop per capture, so what the calibrated rectangle actually
    // contains is answerable without guessing. Needed because the interesting
    // questions are all about the edges — is the might column inside, is the last
    // row's number inside, are the avatars (and so the hero-level badges) inside —
    // and a description of the rectangle can't answer them. Same pattern, and the
    // same one-file-per-scan cost, as member capture's members_crop_debug.
    if (pageNum === 0) {
      const { saveScreenshot } = await import('./screenshotter.js');
      await saveScreenshot(cropped, './data/screenshots', 'might_crop_debug', { force: true })
        .catch(() => '');
    }

    const { rows, canonH } = await paddleMemberOcr(cropped);
    const { pairs, names, anchors, withoutMight, anchorYs } = pairNamesWithMight(rows);

    // Second-chance badge read, gated on this capture having already proved the crop
    // contains avatars. That gate is what keeps a rectangle calibrated to start right
    // of them from paying for an extra OCR on every page forever — it can never be
    // satisfied there, so the strip pass simply never runs.
    if (pairs.some((p) => p.level !== null)) avatarsInCrop = true;
    // Always attempt the strip on the FIRST page, before anything has proved avatars
    // are in the crop.
    //
    // The gate used to require the main pass to read a badge before the strip re-read
    // was allowed to run, which quietly guaranteed that page 1 got no levels at all:
    // measured on three real captures, the main pass read 0-1 of 3 badges while the
    // strip recovered every one. That is survivable for a member who reappears on
    // page 2 — and permanent for anyone who does not. The clan leader is always row 1
    // and never appears on a later page, so her hero level was missed three days
    // running until an operator noticed.
    //
    // The cost of being wrong the other way is one extra strip OCR on page 1 of a clan
    // whose rectangle excludes the avatars. The strip's own result then decides
    // whether to keep trying, so that clan pays it exactly once per capture rather
    // than once per page.
    if (avatarsInCrop || pageNum === 0) {
      const filled = await fillLevelsFromAvatarStrip(cropped, canonH, pairs, anchorYs);
      // The strip finding a badge is itself proof the avatars are in the crop — a
      // stronger signal than the main pass, which reads them far less reliably.
      if (filled > 0) {
        avatarsInCrop = true;
        log.debug(`Avatar-strip re-read recovered ${filled} hero level(s)`);
      }
    }

    result.pagesScanned = pageNum + 1;
    result.coordRowsSeen += anchors;
    result.rowsWithoutMight += withoutMight;

    for (const seen of names) {
      const key = normalizeKey(seen);
      if (key && !namesSeen.has(key)) namesSeen.set(key, seen);
    }

    for (const pair of pairs) {
      const key = normalizeKey(pair.name);
      if (!key) continue;
      const digits = String(pair.might).length;
      const existing = byKey.get(key);
      if (!existing) {
        const cropPath = await maybeSaveRowCrop(cropped, canonH, pair, opts.keepCropFor);
        const levelVotes = new Map<number, number>();
        if (pair.level !== null) levelVotes.set(pair.level, 1);
        byKey.set(key, { name: pair.name, might: pair.might, digits, levelVotes, cropPath });
        continue;
      }
      // Record the level on EVERY re-sighting, before any decision about the might.
      //
      // This used to sit behind an early `continue` that fired whenever the might
      // agreed — the normal case for a member seen on several pages — so a badge read
      // on any page after the first was discarded. Since the badge only resolves on
      // some pages, that threw away most of them: members whose level is plainly
      // visible in the crop ("Roli girl", "Medio") came out with none at all.
      //
      // Mutated in place: the vote tally belongs to the member, not to whichever
      // branch below happens to win the might, and forgetting to carry it through one
      // of those branches is precisely how levels were lost before.
      if (pair.level !== null) {
        existing.levelVotes.set(pair.level, (existing.levelVotes.get(pair.level) ?? 0) + 1);
      }

      if (existing.might === pair.might) continue;
      result.disagreements++;
      if (digits > existing.digits) {
        log.debug(
          `Might reread for "${pair.name}": ${existing.might} → ${pair.might} (longer digit run wins)`,
        );
        // Keep whatever crop we already saved — one per member is the point.
        existing.name = pair.name;
        existing.might = pair.might;
        existing.digits = digits;
      }
    }

    // Per-page info line, mirroring the chest sweep's per-batch logging so a
    // might capture is just as followable in container stdout as a scan is. A
    // few sample readings ride along because this feature can only be validated
    // against the live game — seeing "Feli=233,585,301" scroll past is how the
    // operator confirms the crop is landing on the right column, without having
    // to raise the log level. ~20 lines once a day; info doesn't reach the
    // System page's warning ring buffer, so nothing gets evicted.
    const samples = pairs.slice(0, 3)
      .map((p) => `${p.name}=${p.might.toLocaleString('en-US')}${p.level !== null ? ` (hero ${p.level})` : ''}`)
      .join(', ');
    log.info(
      `Might page ${pageNum + 1}: ${anchors} member row(s), ${pairs.length} with a value`
      // "no number in view", not "no number": the value is almost always just
      // below the crop edge and gets read on the next page.
      + (withoutMight > 0 ? `, ${withoutMight} with no number in view` : '')
      // "distinct name(s)", NOT "unique members". This module has no database, so
      // it can only dedupe by text — and with ~50% scroll overlap every row is read
      // 2–3 times, so one OCR wobble on one of those passes yields two strings for
      // one player and counts twice. The caller resolves strings to members and
      // reports the real member count; conflating the two made a genuine coverage
      // gap ("87 read, 85 recorded") look like a rounding quirk.
      + ` — ${byKey.size} distinct name(s) so far`
      + (samples ? ` · ${samples}` : ''),
    );

    onProgress?.(`Might: ${byKey.size} member(s) read (page ${pageNum + 1})`);

    // End of list: no new member on this page, several pages running.
    //
    // Primary stop condition, because it's about the data rather than the
    // pixels. The crop hash below stays as a second signal for the case where
    // the list genuinely stops moving, but on its own it was too eager: an
    // identical crop also happens when a wheel event doesn't take, and three of
    // those in a row would end a capture less than half way down the roster.
    if (byKey.size === uniqueBefore) {
      dryPages++;
      if (dryPages >= DRY_PAGES_TO_STOP) {
        log.info(
          `Might capture: no new names for ${dryPages} consecutive page(s) — treating that as the `
          + `end of the list at ${byKey.size} distinct name(s).`,
        );
        break;
      }
    } else {
      dryPages = 0;
    }

    const hash = crypto.createHash('md5').update(cropped).digest('hex');
    if (hash === lastHash) {
      sameCount++;
      // Deliberately more patient than member capture's 3: an unchanged crop
      // proves only that this scroll didn't move anything, and combined with the
      // dry-page rule above we can afford to keep trying.
      if (sameCount >= DRY_PAGES_TO_STOP) {
        log.info(
          `Might capture: the member list stopped scrolling after ${pageNum + 1} page(s) `
          + `at ${byKey.size} member(s).`,
        );
        break;
      }
    } else {
      sameCount = 0;
    }
    lastHash = hash;

    await mouseMove(page, scrollAt.x, scrollAt.y);
    for (let i = 0; i < 4; i++) {
      await mouseWheel(page, 0, 100);
      await randomDelay(20, 40);
    }
    await randomDelay(100, 200);
  }

  if (result.pagesScanned >= MAX_PAGES) {
    log.warn(
      `Might capture hit the ${MAX_PAGES}-page backstop with ${byKey.size} member(s) read — the `
      + 'roster may be truncated. Either the list is enormous or scrolling is advancing very little '
      + 'per page.',
    );
  }

  // Names seen but never valued on any page. Distinct from rowsWithoutMight,
  // which double-counts the same clipped row across pages.
  for (const [key, name] of namesSeen) {
    if (!byKey.has(key)) result.unresolvedNames.push(name);
  }
  if (result.unresolvedNames.length > 0) {
    log.warn(
      { noAlert: true },
      `Might capture: ${result.unresolvedNames.length} member(s) were read but never yielded a `
      + `power number on any page — ${result.unresolvedNames.join(', ')}. The usual cause is the `
      + 'bottom of the list: the number sits below the name, so once scrolling stops there is no '
      + 'further page to catch a value that falls past the crop\'s bottom edge. Extend the Stage 4 '
      + 'rectangle downward to the bottom of the member panel to fix it.',
    );
  }

  // Band geometry was only needed while the page crop was still in hand; the
  // caller gets the name, the value, and the evidence path. The per-page level
  // votes collapse to one winner here, at the last moment every page has had its
  // say.
  const contested = [...byKey.values()].filter((v) => v.levelVotes.size > 1);
  if (contested.length > 0) {
    // Never an alert: pages disagreeing about a badge is the normal condition this
    // vote exists to settle, and it is only worth reading when a level looks wrong.
    log.debug(
      `Hero-level votes split for ${contested.length} member(s): `
      + contested.slice(0, 10).map((v) => `${v.name} {${
        [...v.levelVotes].map(([lv, n]) => `${lv}×${n}`).join(' ')
      }} → ${resolveLevel(v.levelVotes)}`).join(', '),
    );
  }
  result.rows = [...byKey.values()].map(({ name, might, levelVotes, cropPath }) => ({
    name, might, level: resolveLevel(levelVotes), cropPath, anchorCy: 0, bandTop: 0, bandBottom: null,
  }));
  return result;
}
