import { Image } from 'paddleocr';
import type { PaddleOcrService } from 'paddleocr';
import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import { getPaddleOcr, normalizeInputToRgb } from './paddle-service.js';
import type { ClanMember } from '../models/types.js';
import type { ResourceType } from '../data/repositories/resource-repo.js';
import { UNTRACKED_RESOURCE_SLUGS } from '../data/repositories/resource-repo.js';
import { fuzzyMatchMember } from '../utils/fuzzy.js';
import { childLogger } from '../utils/logger.js';
import { UNRESOLVED_CROP_DIR } from '../utils/crop-dirs.js';

const log = childLogger('resource-ocr');

const CANONICAL_WIDTH = 1000;
const ROW_GAP = 20;   // px; PaddleOCR regions within this Y distance are the same row
const STRIP_GAP = 3;  // px gap between amount right edge and contour-search strip start


// Vertical padding around the OCR text row when cropping it out, as a fraction of
// the row height. The icon is taller than the text and the row's own separator
// lines help an admin see where one row ends, so this is generous on purpose.
const CROP_PAD_RATIO = 0.55;

export interface ExtractedRow {
  /**
   * null when no existing member matched the OCR'd name. The row is still
   * returned — the caller creates the member, exactly as the scanner does for a
   * name it hasn't seen before — so the contribution isn't silently lost. This
   * module deliberately stays DB-free, so it cannot do the upsert itself.
   */
  memberId: number | null;
  resourceTypeId: number | null;
  direction: 1 | -1;
  amount: number;
  transactionDate: string;
  rawPlayerName: string;
  /**
   * Absolute path to a PNG of the screenshot row this came from, or null. Written
   * only when the row could not be fully resolved — no icon match, or a name that
   * matched no member — because those are the cases an admin reconciles by hand.
   * See saveUnresolvedRowCrop.
   */
  rowCropPath?: string | null;
}

export interface ScreenshotResult {
  rows: ExtractedRow[];
  errors: string[];
  /**
   * OCR'd player names that matched no existing member. Their rows ARE returned
   * (with memberId null) — this is reported so the caller can tell the admin which
   * names it had to create, not because anything was discarded.
   */
  unmatchedNames: string[];
  /**
   * The date label in effect at the BOTTOM of this image — either the last
   * "TODAY / YESTERDAY / N DAYS AGO" header it saw, or `initialDateLabel`
   * unchanged if it saw none.
   *
   * Only matters to the automated scroll capture, which reads one list across
   * many screenshots: a page that begins mid-day contains no header, so without
   * carrying this forward every row after the first page would be dated TODAY.
   */
  finalDateLabel: string;
}

/**
 * Resolve a relative date label to an ISO date string (YYYY-MM-DD).
 *
 * `uploadDate` has to be the date the *capturing browser* would call "today",
 * because that is what the game's header means: the list buckets rows at the
 * browser's local midnight, client-side, and never exposes an hour. For the
 * scanner that browser is pinned so its midnight is the game rollover
 * (src/config/game-timezone.ts), which makes these labels game days; for a
 * hand-uploaded screenshot it is the uploader's own calendar date.
 */
export function resolveTransactionDate(dateLabel: string, uploadDate: Date): string {
  const label = dateLabel.trim().toUpperCase();
  const base = new Date(uploadDate);
  base.setUTCHours(0, 0, 0, 0);

  if (label === 'TODAY') return base.toISOString().slice(0, 10);
  if (label === 'YESTERDAY') {
    base.setUTCDate(base.getUTCDate() - 1);
    return base.toISOString().slice(0, 10);
  }
  const daysAgo = label.match(/^(\d+)\s+DAYS?\s*AGO$/);
  if (daysAgo) {
    base.setUTCDate(base.getUTCDate() - Number.parseInt(daysAgo[1], 10));
    return base.toISOString().slice(0, 10);
  }
  return uploadDate.toISOString().slice(0, 10);
}

type ParsedLine =
  | { type: 'date-header'; label: string }
  | { type: 'transaction'; rawPlayerName: string; direction: 1 | -1; amount: number; knownResourceSlug?: string };

/**
 * Longest amount we will believe. Real amounts top out around 25,000,000 (8 digits)
 * in two years of history, so twelve digits is four orders of magnitude of headroom
 * and anything past it is a garbled read. Dropping the row is safe and much better
 * than storing 10^14 silver: the sweep reads every row on ~4 consecutive pages, so a
 * clean read of the same transaction almost always lands anyway.
 */
const MAX_AMOUNT_DIGITS = 12;

/**
 * Read the digits out of an amount blob, ignoring whatever the OCR chose for the
 * thousands separator.
 *
 * The game always writes a comma, but PaddleOCR reads it as a PERIOD on ~0.6% of
 * amounts — 25 of 4,053 amount regions across one 269-page sweep. The pattern that
 * used to capture the amount was `[\d,]+`, which simply STOPS at the first period, so
 * "+25.620.000" was stored as 25 and "+1.247.528" as 1. Half of the 24 rows affected
 * in that sweep lost six digits.
 *
 * The damage is worse than one wrong number, because the amount is part of the row's
 * dedupe key. Every row is read on several consecutive pages, so the same transaction
 * WAS read correctly nearby — and the truncated read did not collapse into it, it was
 * inserted alongside it. George's +25,620,000 read correctly on pages 134 and 135 and
 * as "+25.620.000" on 133, so the history ended up holding both 25,620,000 and 25.
 *
 * Amounts in this list are always integers, so every digit belongs to the number and
 * the separators carry nothing — concatenate and be done.
 *
 * The separator set in the pattern above deliberately EXCLUDES a plain space. Row text
 * is built by joining OCR regions with a space, and the resource icon comes back as its
 * own text region on 11% of rows, reading "2", "S" or "LVL". Accepting a space would
 * turn "+1 2" — amount 1, icon misread as a 2 — into 12.
 */
function amountFromBlob(blob: string): number | null {
  const digits = blob.replace(/\D/g, '');
  if (!digits || digits.length > MAX_AMOUNT_DIGITS) return null;
  const amount = Number.parseInt(digits, 10);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

/**
 * Parse a single text region from PaddleOCR output.
 * PaddleOCR merges adjacent words without spaces (e.g. "taulen302sentresources. +11,250,000"),
 * so regexes use \s* instead of \s+ between tokens.
 * Speedup duration: "2doh" = 2d0h — "oh" artifact when OCR reads "0h" as "oh".
 */
function parseLine(line: string): ParsedLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  // Date headers: TODAY, YESTERDAY, N DAYS AGO
  const dateMatch = trimmed.match(/\b(TODAY|YESTERDAY|\d+\s+DAYS?\s*AGO)\b/i);
  if (dateMatch) {
    const label = dateMatch[1].toUpperCase()
      .replace(/DAYS\s*AGO/, 'DAYS AGO')
      .replace(/\s+/g, ' ');
    return { type: 'date-header', label };
  }

  // Speedup rows: text-based identification — icon matching not needed.
  if (/speeded/i.test(trimmed)) {
    const nameMatch = trimmed.match(/^(.+?)speeded/i);
    const rawPlayerName = (nameMatch?.[1] ?? '').replace(/^[^\p{L}]+/u, '').trim();
    // Parse the duration from the tail after "…process by" so we never read a
    // digit out of the player name. OCR quirks make the duration messy:
    //   • inter-word spaces are preserved ("136 d o h", not "136d0h"),
    //   • a "0" unit is often read as the letter "o" ("136 d o h" = 136d 0h),
    //   • the game omits zero units entirely ("2d" = 2d 0h).
    // Long speedups read as "<d> <h>", short ones as "<h> <m>" (no days). Amounts
    // are stored in HOURS (see resource-format.js), so parse each unit
    // independently and fold days→hours; sub-hour (minutes-only) rounds to 0 and
    // is dropped by the amount<=0 guard, matching the "Xd Yh" display granularity.
    const tail  = trimmed.replace(/^.*?speeded/i, '').split(/process\s*by/i).pop() ?? '';
    const days  = Number.parseInt(tail.match(/(\d+)\s*d/i)?.[1] ?? '0', 10) || 0;
    const hours = Number.parseInt(tail.match(/(\d+)\s*h/i)?.[1] ?? '0', 10) || 0;
    const amount = days * 24 + hours;
    if (!rawPlayerName || amount <= 0) return null;
    return { type: 'transaction', rawPlayerName, direction: 1, amount, knownResourceSlug: 'clan-speedup' };
  }

  // Transaction rows: "<name>sent/tookresources[.] [+/-]N,NNN"
  const txMatch = trimmed.match(
    /^(.+?)(sent|took)\s*resources[.\s]*([+\-−]?[\s]*\d[\d.,'\u2019\u00A0]*)/i,
  );
  if (!txMatch) return null;

  const rawPlayerName = txMatch[1].trim().replace(/^[^\p{L}]+/u, '').trim();
  const verb = txMatch[2].toLowerCase();
  const amount = amountFromBlob(txMatch[3]);

  if (!rawPlayerName || amount == null) return null;

  return {
    type: 'transaction',
    rawPlayerName,
    direction: verb === 'sent' ? 1 : -1,
    amount,
  };
}

/** Exported so the row parser can be regression-tested without running OCR. */
export { parseLine as parseHistoryLine };

// ── Template cache + color-channel NCC ───────────────────────────────────────
// Per-channel (R, G, B) NCC, averaged. Grayscale NCC is color-blind — icons
// like iron (cool gray) and stone (warm brown) have similar luma but different
// hue, so per-channel comparison structurally separates them.

type ChannelStats = { pixels: Float32Array; mean: number; std: number };
type RgbStats = { r: ChannelStats; g: ChannelStats; b: ChannelStats };

const templateCache = new Map<string, RgbStats[]>();

function channelStats(data: Buffer, stride: number, offset: number): ChannelStats {
  const n = data.length / stride;
  const pixels = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) { pixels[i] = data[i * stride + offset]; sum += pixels[i]; }
  const mean = sum / n;
  let v = 0;
  for (let i = 0; i < n; i++) v += (pixels[i] - mean) ** 2;
  return { pixels, mean, std: Math.sqrt(v / n) };
}

function pixelStatsRgb(data: Buffer): RgbStats {
  return {
    r: channelStats(data, 3, 0),
    g: channelStats(data, 3, 1),
    b: channelStats(data, 3, 2),
  };
}

function ncc(a: Float32Array, ma: number, sa: number, b: Float32Array, mb: number, sb: number): number {
  if (sa < 1e-6 || sb < 1e-6) return 0;
  const n = a.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += (a[i] - ma) * (b[i] - mb);
  return sum / (n * sa * sb);
}

function nccRgb(a: RgbStats, b: RgbStats): number {
  return (
    ncc(a.r.pixels, a.r.mean, a.r.std, b.r.pixels, b.r.mean, b.r.std) +
    ncc(a.g.pixels, a.g.mean, a.g.std, b.g.pixels, b.g.mean, b.g.std) +
    ncc(a.b.pixels, a.b.mean, a.b.std, b.b.pixels, b.b.mean, b.b.std)
  ) / 3;
}

// Warm/cool bias = mean(R) − mean(B). Boost the NCC score multiplicatively when
// the candidate and template share the same warm/cool color character.
// NCC_MATCH_THRESHOLD (0.68) — minimum combined score to count as a match.
// NCC_BOOST_GATE (0.65) — minimum NCC to receive a bias boost. The gap between
// 0.65 and 0.68 lets borderline correct matches (NCC slightly below threshold)
// be promoted by color agreement, while keeping the boost from applying to clearly
// wrong matches (NCC < 0.65). σ=20 grey levels, W=0.25 max boost.
const NCC_MATCH_THRESHOLD = 0.68;
const NCC_BOOST_GATE = 0.65;
const BIAS_SIGMA  = 20;
const BIAS_WEIGHT = 0.25;

// Largest height/width ratio a single icon's contour can plausibly have; above this the
// height is treated as a vertical merge (see cropAndMatchIconMultiScale).
//
// Measured over 364 rows of real screenshots, outcome by ratio band:
//
//        ≤1.10   236 matched,  0 failed   clean contour — height is the icon's
//   1.10-1.40      2 matched, 13 failed   PARTIAL merge — height inflated by a sliver
//                                         of the neighbouring row, guard didn't fire
//        ≥1.40    105 matched,  0 failed   full merge — guard fires, width used instead
//
// The distribution is bimodal and the failures sit entirely in the middle band, so the
// cut belongs at its lower edge. This was 1.4, chosen from the Hermes rows where merges
// ran 1.6–3.0; it missed every partial merge, which is what left fragment and Hermes
// rows unmatched even after the geometry fixes.
const MAX_ICON_H_OVER_W = 1.10;

/**
 * Narrowest contour that can plausibly BE an icon, in canonical-width pixels.
 *
 * Measured, not chosen: real icon contours run 37-46px wide across the diagnostic
 * output, while the history list's scrollbar thumb — which sits inside the calibrated
 * rectangle, right of the icons — comes out 11-17px. 24 is the empty middle of that
 * gap. See the filter in findIconContour for why this matters so much.
 */
const MIN_ICON_CONTOUR_W = 24;

/**
 * How far above and below the text row the icon search reaches, as a fraction of the
 * row height. The icon is taller than the text — ~57px against ~33 — so the band has to
 * overshoot; 0.6 each way gives it room to be found without being centred perfectly.
 *
 * That overshoot is also why findIconContour has to reject contours belonging to another
 * row: at 0.6 the band reaches ~1.6 row pitches, into the neighbours.
 */
const ICON_BAND_MARGIN_RATIO = 0.6;

/**
 * Vertical nudges retried when the primary crop candidates matched nothing.
 *
 * The icon's horizontal position is rock solid — the contour comes back 48px wide at
 * x=908 on every row of every page — but its HEIGHT is whatever survived the
 * darkThreshold, and the top and bottom of an icon are exactly where it fades into the
 * tan background. So the bbox is truncated by a pixel or three at one end, and since cy
 * is that bbox's centre, the crop is centred a pixel or three off the icon.
 *
 * That is fatal rather than merely lossy, because NCC on these icons is far peakier than
 * the "2px costs ~0.3" note above suggests — measured over eleven Torch of Olympus rows
 * from one sweep, the score at the true centre is 0.80-0.85 and ONE pixel either side of it
 * is 0.58-0.65. The threshold is 0.68, so a 1px error is the difference between a confident
 * match and an unknown row. Of those eleven, the ones that resolved had contours 42-46px
 * tall and the ones that did not had 40-41; all are recovered at +1 or +2.
 *
 * ±1 and ±2, in that order, because the failures are all sub-3px: +3 and beyond scored
 * 0.47-0.64 on the very same rows, i.e. past the peak and back into noise.
 *
 * **This is the second half of that fix and useless — worse than useless — without the
 * first.** Those rows were torch rows being scored against a torch template cut from the
 * icon's ARTWORK rather than from a history row, so the right answer scored 0.46-0.59 while
 * Chronoglyph Clan Fragment, the other gold jigsaw piece, scored 0.80-0.85. Better centring
 * on its own does not pick a winner, it just sharpens whichever template was already ahead:
 * with this retry and the old templates all eleven rows resolve CONFIDENTLY to chronoglyph,
 * where before seven did and four stayed unknown. A wrong resource looks like a result; an
 * unknown one does not. So if a fragment ever reads as the wrong fragment again, fix the
 * template first and only then come back here — see torch-of-olympus-clan-fragment-2.png.
 *
 * Only reached when the primary pass failed, which is what makes this affordable: a row
 * that already matched costs nothing extra, and a row that didn't was going to be written
 * to the database as "unknown" for an admin to fix by hand. That is also why it is a retry
 * rather than four more entries in cyCandidates — as a widened primary grid it would be
 * 5x the crops on every row of every page rather than on the ~7% that fail. Measured over
 * the 270-page replay corpus: 1,833 -> 2,011 ms/page, i.e. ~10%.
 *
 * Replaying that corpus (scripts/resource-sweep-read + -boundary-accuracy + -replay) also
 * says what this does NOT do, which is the more useful half:
 *
 *   per-page reads   unresolved 349 -> 341;  middle-row unresolved 7 -> 5;  boundary rows
 *                    right 166 -> 172;  WRONG stays at exactly 1, the same pre-existing
 *                    row. So it recovers reads without inventing any.
 *   rows written     identical. 1,945 rows, 10 unknown, same summed amount, zero rows
 *                    differing either way.
 *
 * Not a contradiction — that corpus's failures are rows sliced by the top or bottom of the
 * rectangle, and the stitch already rescues those from the neighbouring page where the same
 * row sat mid-page. This failure mode is the one the stitch CANNOT rescue: the icon is
 * clean and fully inside the rectangle, so every one of the ~4 reads of that row measures
 * the same short contour and misses by the same pixel. Nothing downstream ever sees a good
 * read to prefer, and the row reaches an admin as "unknown" — which is how eleven perfectly
 * legible fragment rows did.
 *
 * Every one of those 8 recovered reads is a NULL becoming a resource; no read changes from
 * one resource to another, in either direction, with or without the new torch template.
 */
const CY_RETRY_OFFSETS = [1, -1, 2, -2] as const;

/**
 * Fraction of the canonical width past which nothing belongs to a list row.
 *
 * Measured over 270 pages: icon contours sit at x 903-960, the panel's close button at
 * x 970-999. 0.965 is the empty middle. See isPanelChrome.
 */
const ICON_COLUMN_RIGHT = 0.965;

/**
 * The history panel's own close button sits at the top-right of the calibrated
 * rectangle, above the first list row, and PaddleOCR returns it as a text region
 * ("X", "x", "×") on half of all pages — 139 of 270 in one sweep. Its y-centre lands
 * within ROW_GAP of the first row's, so it joins that row's group, and two separate
 * things then go wrong. Together they are why a page's first row is by far the most
 * common unresolved row: 262 of 352 unresolved crops over two sweeps were the first
 * unresolved row of their page.
 *
 *   • Row geometry. rowTop is then taken from the button (y≈0) instead of the text,
 *     growing the icon-search band from ~1.6 row pitches to ~2.4 — far enough into the
 *     row below that the largest contour in it can be the neighbour's icon, or the
 *     button itself, whose 28×36px clears the MIN_ICON_CONTOUR_W scrollbar floor.
 *
 *   • Row grouping. The group's running-average centre gets dragged ~7px upward, which
 *     is enough to push the row's OWN amount region back outside ROW_GAP. The amount
 *     then forms a group of its own, neither group parses as a transaction, and the row
 *     is dropped whole — measured twice in 269 pages ("SHAHIN took resources ×" with a
 *     stranded "-42,000", and the same for Feli).
 *
 * The test is conjunctive on purpose: a lone close glyph, narrow, positioned right of
 * the icon column. Player names start at x≈50, so no list content satisfies all three.
 *
 * The width test is what makes this safe on admin UPLOADS, whose canonical layout sits
 * ~40px right of the scanner's: icons there run to x≈987, past ICON_COLUMN_RIGHT, and
 * PaddleOCR does sometimes read an icon as "X". Position alone would delete those. The
 * close button's region measures 28-30px wide against 43-57px for an icon read as text,
 * so the 35px cap separates them with room on both sides.
 */
const CHROME_GLYPH = /^[Xx×✕✖?？]$/;
const MAX_CHROME_GLYPH_W = 35;

function isPanelChrome(region: { text: string; box: { x: number; width: number } }): boolean {
  return CHROME_GLYPH.test(region.text.trim())
    && region.box.x > CANONICAL_WIDTH * ICON_COLUMN_RIGHT
    && region.box.width <= MAX_CHROME_GLYPH_W;
}

function nccCombined(a: RgbStats, b: RgbStats): number {
  const score = nccRgb(a, b);
  if (score < NCC_BOOST_GATE) return score;
  const d = (a.r.mean - a.b.mean) - (b.r.mean - b.b.mean);
  return score * (1 + BIAS_WEIGHT * Math.exp(-(d * d) / (2 * BIAS_SIGMA * BIAS_SIGMA)));
}

async function loadTemplateFile(filePath: string): Promise<RgbStats | null> {
  try {
    const data = await sharp(filePath)
      .flatten({ background: { r: 205, g: 184, b: 152 } })
      .resize(48, 48, { fit: 'fill', kernel: 'lanczos3' })
      .raw().toBuffer();
    return pixelStatsRgb(data);
  } catch {
    return null;
  }
}

/**
 * Load every template for a slug: `<slug>.png` plus `<slug>-2.png` … `-5.png`.
 *
 * Variants exist because one 48×48 crop cannot cover a resource whose icon the game draws
 * more than one way, and matchIcon takes the MAX across them — so adding a variant can only
 * raise that resource's score. What it CANNOT do is lower a rival's, which is the trap:
 *
 * **A template must be cut from a history ROW, not from the icon's artwork.** The two clan
 * fragments are both gold jigsaw pieces differing mainly in the colour of the figure inside,
 * so scale decides the match long before colour does. `torch-of-olympus-clan-fragment.png`
 * is the standalone art (65de25b) and its piece sits at roughly half the linear size the
 * game draws in a row; the multi-scale search cannot close that gap, so real torch rows
 * scored 0.46-0.59 on their own template and 0.80-0.85 on chronoglyph's — and were written
 * as chronoglyph, silently, seven times in eleven. `-2` is the same icon median-stacked from
 * eleven real rows at the 0.92 width-fill scripts/refit-resource-icon.mjs targets, and
 * scores 1.17-1.22.
 *
 * So when a resource reads as a look-alike, compare the two templates' FILL FRACTION against
 * a production row before touching the matcher — see the note on CY_RETRY_OFFSETS for why
 * the matcher was the wrong suspect that time, and how fixing it alone made things worse.
 */
async function loadTemplates(slug: string): Promise<RgbStats[]> {
  if (templateCache.has(slug)) return templateCache.get(slug)!;
  const dir = path.resolve('assets', 'resource-icons');
  const results: RgbStats[] = [];
  const primary = await loadTemplateFile(path.join(dir, `${slug}.png`));
  if (primary) {
    results.push(primary);
    for (let n = 2; n <= 5; n++) {
      const v = await loadTemplateFile(path.join(dir, `${slug}-${n}.png`));
      if (!v) break;
      results.push(v);
    }
  }
  templateCache.set(slug, results);
  return results;
}

async function matchIcon(iconBuffer: Buffer, allTypes: ResourceType[]): Promise<number | null> {
  let cand: RgbStats;
  try {
    const data = await sharp(iconBuffer)
      .flatten({ background: { r: 205, g: 184, b: 152 } })
      .resize(48, 48, { fit: 'fill', kernel: 'lanczos3' })
      .raw().toBuffer();
    cand = pixelStatsRgb(data);
  } catch {
    return null;
  }

  let bestComb = NCC_MATCH_THRESHOLD; // init at threshold: only combined > 0.68 wins
  let bestId: number | null = null;

  for (const type of allTypes) {
    const tmpls = await loadTemplates(type.slug);
    if (!tmpls.length) continue;
    for (const tmpl of tmpls) {
      const combScore = nccCombined(cand, tmpl);
      if (combScore > bestComb) { bestComb = combScore; bestId = type.id; }
    }
  }

  return bestId;
}

// ── Icon detection via Image.contours() ──────────────────────────────────────

/**
 * Find the icon bounding box by inverting dark pixels in the strip to the right
 * of the amount number and finding the largest contour.
 *
 * Game background: bright warm tan (~220 gray). Icon shadows/edges: < darkThreshold.
 * Invert dark→255, bright→0, then dilate+contours to get the icon footprint.
 */
function findIconContour(
  fullImage: Image,
  canonicalH: number,
  stripLeft: number,
  rowTop: number,
  rowH: number,
  darkThreshold: number,
): { x: number; y: number; w: number; h: number; clippedLeft: boolean } | null {
  const margin = Math.round(rowH * ICON_BAND_MARGIN_RATIO);
  const stripX = Math.max(0, stripLeft);
  const stripY = Math.max(0, rowTop - margin);
  const stripW = Math.min(CANONICAL_WIDTH - stripX, 120);
  const stripH = Math.min(rowH + 2 * margin, canonicalH - stripY);
  if (stripW < 8 || stripH < 8) return null;

  const strip = fullImage.crop({ x: stripX, y: stripY, width: stripW, height: stripH });
  const px = strip.data;
  const ch = strip.channels;

  const inverted = new Uint8Array(stripW * stripH * 3);
  for (let i = 0; i < stripW * stripH; i++) {
    const idx = i * ch;
    const gray = Math.round(0.299 * px[idx] + 0.587 * px[idx + 1] + 0.114 * px[idx + 2]);
    const val  = gray < darkThreshold ? 255 : 0;
    inverted[i * 3] = inverted[i * 3 + 1] = inverted[i * 3 + 2] = val;
  }

  const invImage = new Image(stripW, stripH, 3, inverted);
  const contours = invImage.threshold({ threshold: 127 }).dilate({ k: 2 }).contours({ minArea: 20 });
  if (!contours.length) return null;

  // Ignore blobs too narrow to be an icon before taking the largest.
  //
  // The list's SCROLLBAR lives inside the calibrated rectangle, to the right of the
  // icons, and its thumb is a tall solid bar — measured 11-17px wide by 39-88px tall.
  // Picking purely by area let that beat the icon whenever the thumb happened to sit
  // beside the row being read, because it is several times taller than an icon is.
  //
  // That single mistake produced most of the "unknown" rows: the thumb only covers
  // part of the panel's height, so a handful of rows per page failed, and because the
  // thumb MOVES as the sweep scrolls, the very same row failed on one page and read
  // correctly on another — which is what filled the database with resolved/unresolved
  // pairs of the same transaction.
  //
  // The separation is clean and measured, not guessed: every real icon contour in the
  // diagnostic logs is 37-46px wide, every scrollbar blob 11-17px. A floor of 24px
  // sits in the empty middle. Deliberately a WIDTH test, so it still admits the
  // genuine vertical merges the code below handles (a chain of Hermes LVL diamonds
  // measured 46x136 — icon-width, several icons tall).
  // Then ignore blobs that belong to a DIFFERENT row.
  //
  // The strip is deliberately taller than the row (margin = 0.6 × rowH each way) so a
  // clipped or slightly offset icon is still inside it, but that also reaches into the
  // neighbouring rows, whose icons sit at exactly the same x. Taking the largest blob
  // in the strip therefore reads the NEIGHBOUR's icon whenever this row's own icon is
  // unusable — and the result is not a failure the caller can see, it is a confident
  // match against the wrong resource.
  //
  // Measured over a 269-page sweep: Glorgol's +11,970,000 is silver, confirmed by 15
  // reads where the row sat mid-page. On the five pages where it happened to land in the
  // top row it came back as scientific-tractates, dragon-coins, clan-speedup and twice
  // as nothing — each time the icon of the row below. The first row of a page is the
  // usual victim because the panel's top edge, help button and close button dilate into
  // one 92px-wide blob over its icon, which the width test above then discards.
  //
  // An icon is taller than its text and centred on it, so a contour that is genuinely
  // this row's overlaps the text band. A vertical merge (the Hermes LVL chain, up to
  // 3 rows tall) spans the band and so still passes — the caller handles those.
  const rowBottom = rowTop + rowH;
  const inThisRow = contours.filter(
    (c) => stripY + c.y < rowBottom && stripY + c.y + c.height > rowTop,
  );
  if (!inThisRow.length) return null;

  const iconish = inThisRow.filter((c) => c.width >= MIN_ICON_CONTOUR_W && c.width <= 85);
  const pool = iconish.length > 0 ? iconish : inThisRow;
  const best = pool.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
  // Amounts are right-aligned, so a short one ("+1") ends only ~1px before the icon
  // starts and STRIP_GAP lands the strip *inside* the icon. The contour then begins at
  // the strip edge, its width is truncated and its centre is biased right. Flag it so
  // the caller can anchor on the right edge, which stays intact either way.
  return {
    x: stripX + best.x,
    y: stripY + best.y,
    w: best.width,
    h: best.height,
    clippedLeft: best.x === 0,
  };
}

/**
 * Crop the icon at multiple scales around the contour centre and return the crop
 * buffer that produces the highest NCC score across all resource type templates.
 * Multi-scale compensates for size mismatch between the shipped templates
 * (Tesseract-extracted at fixed sizes) and the contour-detected region.
 */
async function cropAndMatchIconMultiScale(
  canonicalRgb: Buffer,
  canonicalH: number,
  fullImage: Image,
  amountRight: number,
  rowTop: number,
  rowH: number,
  darkThreshold: number,
  allTypes: ResourceType[],
): Promise<number | null> {
  const contour = findIconContour(fullImage, canonicalH, amountRight + STRIP_GAP, rowTop, rowH, darkThreshold);

  // Every icon is between 0.74× and ~1.05× as tall as it is wide (all templates are
  // 0.9–1.35 aspect), so a contour much taller than it is wide is not one icon — it's
  // several merged vertically. Hermes' Loyalty Level does this: the LVL diamond is dark
  // almost edge-to-edge and nearly as tall as the row pitch, so consecutive rows'
  // diamonds touch tip-to-tip and dilate() bridges them into one blob up to 3 rows tall
  // (observed 46×136 for a 46×49 icon). Neither the height nor the vertical centre of
  // such a blob describes this row's icon — take the size from the width, which a
  // vertical merge cannot affect, and the centre from the text row. Without this,
  // baseSize = max(w, h) = 136, no crop near the true 49px is ever tried, and the row
  // scores ~0.35 → NO MATCH.
  const mergedVertically = !!contour && contour.h > contour.w * MAX_ICON_H_OVER_W;
  const iconH = mergedVertically ? contour!.w : contour?.h ?? 0;

  let cx: number;
  let cy: number;
  let baseSize: number;

  // Reject contours that are either more than 3× wider than tall OR wider than 85px —
  // these are horizontal separators or UI edges, not icons (icons are ≤55px wide).
  if (contour && contour.w >= 10 && contour.h >= 10 && contour.w <= contour.h * 3 && contour.w <= 85) {
    cx = contour.x + contour.w / 2;
    // A merged blob is usually a symmetric chain, so its centre still lands on this
    // row — but not when the merge is one-sided (top/bottom of the list, or a
    // neighbouring row of a different resource). The text row's centre tracks the icon
    // centre in every case measured, so prefer it whenever a merge is detected.
    cy = mergedVertically ? rowTop + rowH / 2 : contour.y + contour.h / 2;
    baseSize = Math.max(contour.w, iconH);
  } else {
    // Fallback: fixed offset from the amount's right edge. Measured over 269 pages, the
    // icon starts 3-8px past that edge (amount right 905, icon 908-955), so the strip's
    // own left edge is the right anchor. The old +25 put the crop's centre 21px right of
    // the icon — half an icon out, reaching into the scrollbar.
    const sz = Math.max(rowH, 44);
    cx = amountRight + STRIP_GAP + sz / 2;
    cy = rowTop + rowH / 2;
    baseSize = sz;
  }

  let bestComb = NCC_MATCH_THRESHOLD; // init at threshold: only combined > 0.68 wins
  let bestId: number | null = null;

  const goodContour = contour && contour.w >= 10 && contour.h >= 10 && contour.w <= contour.h * 3 && contour.w <= 85;

  // Try crop sizes derived from both max(w,h) and avg(w,h) of the contour.
  // Iron icons (and others) have wide-but-short contours: max gives ~49px but
  // NCC peaks at ~44px; avg(49,29)=39 → 39+4=43 gets much closer.
  const avgSize = goodContour ? Math.round((contour!.w + iconH) / 2) : baseSize;
  const baseSizes = [...new Set([baseSize, avgSize])];

  // NCC on these icons is peaky — the Hermes diamond's diagonal edges decorrelate
  // fast, so a 2px centring error costs ~0.3 of score (measured 1.21 at the true
  // centre vs 0.63 two pixels off). Both axes therefore get more than one candidate.

  // Horizontally: 'cx' uses the contour centre; 'right' pins the crop's right edge to
  // the contour's right edge and grows leftward. Right-anchoring is what rescues a
  // left-clipped contour — the right edge survives the clip, so it reconstructs the
  // box that the truncated width and right-biased centre cannot.
  const xAnchors: Array<{ cx?: number; right?: number }> = [{ cx }];
  if (goodContour && contour!.clippedLeft) {
    xAnchors.push({ right: contour!.x + contour!.w });
  }

  // Vertically: for flat contours (shadow wider than tall) the contour centre sits near
  // the icon bottom, so also try a centre shifted up by 30 % of the contour height.
  const cyCandidates = [cy];
  if (goodContour && contour!.h < contour!.w * 0.65) {
    cyCandidates.push(cy - Math.round(contour!.h * 0.3));
  }
  // When the height was merged, cy came from the text row, which is only an
  // approximation of the icon centre: an OCR box spans cap-height to baseline, whose
  // centre sits ~2px above the row's visual centre that the icon is aligned to.
  if (mergedVertically) {
    cyCandidates.push(cy + 2, cy - 2);
  }
  // An UNmerged contour can be a pixel or two out too, for a different reason — see
  // CY_RETRY_OFFSETS. That case is handled as a retry below rather than here, because it
  // affects every row and this grid is walked for every row that matches on the first try.

  const scanCandidates = async (cys: readonly number[]): Promise<void> => {
    for (const xa of xAnchors)
    for (const cyT of cys)
    for (const base of baseSizes) for (const delta of [-4, 0, 4, 8, 12, 16]) {
      const sz = Math.max(20, Math.round(base + delta));
      const l  = Math.max(0, Math.round(xa.cx !== undefined ? xa.cx - sz / 2 : xa.right! - sz));
      const t  = Math.max(0, Math.round(cyT - sz / 2));
      const w  = Math.min(sz, CANONICAL_WIDTH - l);
      const h  = Math.min(sz, canonicalH - t);
      if (w < 10 || h < 10) continue;

      // One pipeline straight to raw. This used to encode each crop to PNG and decode it
      // again purely to hand it to the next sharp() call — a lossless round-trip whose
      // output was never used, costing an encode+decode per candidate crop.
      let cand: RgbStats;
      try {
        // Sliced from the ALREADY-DECODED canonical pixels, not from the encoded buffer.
        // sharp(canonicalBuffer) re-decodes the whole 1000x869 image on every candidate,
        // and there are up to 72 candidates per row — measured at 3.06ms each versus
        // 0.96ms from raw, i.e. ~2.9s of the ~3.6s a page took, spent decoding the same
        // image over and over. The raw pixels were already in hand for contour detection.
        const data = await sharp(canonicalRgb, {
          raw: { width: CANONICAL_WIDTH, height: canonicalH, channels: 3 },
        })
          .extract({ left: l, top: t, width: w, height: h })
          .flatten({ background: { r: 205, g: 184, b: 152 } })
          .resize(48, 48, { fit: 'fill', kernel: 'lanczos3' })
          .raw().toBuffer();
        cand = pixelStatsRgb(data);
      } catch {
        continue;
      }

      for (const type of allTypes) {
        const tmpls = await loadTemplates(type.slug);
        if (!tmpls.length) continue;
        for (const tmpl of tmpls) {
          const combScore = nccCombined(cand, tmpl);
          if (combScore > bestComb) { bestComb = combScore; bestId = type.id; }
        }
      }
    }
  };

  await scanCandidates(cyCandidates);
  if (bestId == null) {
    await scanCandidates(
      [...new Set(cyCandidates.flatMap((c) => CY_RETRY_OFFSETS.map((d) => c + d)))],
    );
  }

  return bestId;
}

// ── Amount word detection ─────────────────────────────────────────────────────

interface OcrWord {
  text: string;
  box: { x: number; y: number; width: number; height: number };
}

function isLikelyAmount(text: string): boolean {
  return text.includes(',') || /^[+\-−]\d/.test(text) || /^\d{4,}$/.test(text);
}

// ── Unresolved-row crops ─────────────────────────────────────────────────────

/**
 * Write a PNG of one history row so an admin resolving it later can see the
 * original instead of going back to the game to work out which row was which.
 *
 * Crops the FULL canonical width, not just the icon: the player name on the left
 * and the amount on the right are what identify the row, and the icon alone is
 * exactly the thing the importer already failed to read.
 *
 * Best-effort — a failure here must never fail the import, so the caller gets
 * null and the row is stored without a crop (the UI renders "—").
 */
async function saveUnresolvedRowCrop(
  canonicalBuffer: Buffer,
  canonicalH: number,
  rowTop: number,
  rowH: number,
  uploadToken: string,
  rowIndex: number,
): Promise<string | null> {
  const pad = Math.round(rowH * CROP_PAD_RATIO);
  const top = Math.max(0, rowTop - pad);
  const height = Math.min(rowH + 2 * pad, canonicalH - top);
  if (height < 8) return null;

  // The padding leaves parts of the neighbouring rows visible, which is useful
  // context but leaves the admin guessing which row the crop is actually about.
  // Outline the subject row so there's no ambiguity. Grown slightly past the text
  // box because the icon is taller than the text and would otherwise sit outside
  // its own highlight.
  const boxGrow = Math.round(rowH * 0.22);
  const boxY = Math.max(0, rowTop - top - boxGrow);
  const boxH = Math.min(rowH + 2 * boxGrow, height - boxY);
  const overlay = Buffer.from(
    `<svg width="${CANONICAL_WIDTH}" height="${height}">`
    + `<rect x="2" y="${boxY}" width="${CANONICAL_WIDTH - 4}" height="${boxH}"`
    + ` fill="none" stroke="#e8562a" stroke-width="4" rx="4"/></svg>`,
  );

  try {
    await fs.promises.mkdir(UNRESOLVED_CROP_DIR, { recursive: true });
    const file = path.join(
      UNRESOLVED_CROP_DIR,
      `unresolved_${uploadToken}_r${String(rowIndex).padStart(3, '0')}.png`,
    );
    await sharp(canonicalBuffer)
      .extract({ left: 0, top, width: CANONICAL_WIDTH, height })
      .composite([{ input: overlay, top: 0, left: 0 }])
      .png({ compressionLevel: 9 })
      .toFile(file);
    return file;
  } catch (err) {
    log.debug(`resource-ocr: failed to save unresolved row crop: ${String(err)}`);
    return null;
  }
}

// ── Main pipeline ─────────────────────────────────────────────────────────────

/**
 * Process one history screenshot uploaded by an admin. Uses PaddleOCR
 * (PP-OCRv6_small, ONNX Runtime) instead of Tesseract — no worker pool,
 * no TSV bounding-box hacks. Icon positions are found via dark-pixel
 * contour detection on the canonical colour image.
 */
export async function processResourceScreenshot(opts: {
  imageBuffer: Buffer;
  clanId: number;
  uploadDate: Date;
  members: ClanMember[];
  allTypes: ResourceType[];
  /**
   * Unique-per-upload string used in row-crop filenames so concurrent or repeated
   * uploads can't collide. Omit to skip saving crops entirely (tests, callers that
   * don't surface them).
   */
  cropToken?: string;
  /**
   * Date label to attribute rows to until this image's first date header.
   *
   * Defaults to 'TODAY', which is right for a manual upload (an admin
   * screenshots from the top of the list, so the first header is above the first
   * row). The scroll capture passes the previous page's `finalDateLabel`, since
   * page 2 onward can start in the middle of a day with no header in view.
   */
  initialDateLabel?: string;
}): Promise<ScreenshotResult> {
  const { imageBuffer, uploadDate, members, allTypes, cropToken } = opts;

  // Resource types recognised by OCR but not tracked per member (clan-wide) —
  // their rows are identified so they can be skipped rather than mislabeled.
  const untrackedTypeIds = new Set(
    allTypes.filter((t) => UNTRACKED_RESOURCE_SLUGS.has(t.slug)).map((t) => t.id),
  );

  const metadata = await sharp(imageBuffer).metadata();
  const imageWidth  = metadata.width  ?? 1280;
  const imageHeight = metadata.height ?? 1920;

  const canonicalH = Math.round((imageHeight / imageWidth) * CANONICAL_WIDTH);
  const canonicalBuffer = await sharp(imageBuffer)
    .resize(CANONICAL_WIDTH, canonicalH, { kernel: 'lanczos3' })
    .toBuffer();

  // Low-res sources (desktop, imageWidth < CANONICAL_WIDTH) are upscaled, making
  // icon shadows lighter. Raise the dark threshold so the contour finder still
  // captures the icon footprint.
  const darkThreshold = imageWidth < CANONICAL_WIDTH ? 155 : 140;

  // Build canonical Image for pixel-level contour detection.
  const { data: rawRgb, info } = await sharp(canonicalBuffer)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const fullImage = normalizeInputToRgb({
    width: info.width,
    height: info.height,
    data: new Uint8Array(rawRgb),
  });

  // Run PaddleOCR (shared service — see paddle-service.ts).
  const ocr = await getPaddleOcr();
  let rawResults: Awaited<ReturnType<PaddleOcrService['recognize']>>;
  try {
    rawResults = await ocr.recognize({
      width: info.width,
      height: info.height,
      data: new Uint8Array(rawRgb),
    });
  } catch (err) {
    log.warn({ err }, 'resource-ocr: PaddleOCR recognize() failed');
    return {
      rows: [],
      errors: ['OCR failed: ' + String(err)],
      unmatchedNames: [],
      // Nothing was read, so the label the caller handed in is still the one in
      // effect — echoing it back keeps a failed page from resetting the date.
      finalDateLabel: opts.initialDateLabel?.trim() || 'TODAY',
    };
  }

  log.debug(`resource-ocr: OCR returned ${rawResults.length} text regions`);

  // ── Group detected regions into rows by Y-centre proximity ────────────────
  // Panel chrome first: it is not list content, and letting it into a group corrupts
  // both that row's geometry and the grouping of the rows after it (see isPanelChrome).
  const listRegions = rawResults.filter((r) => !isPanelChrome(r));
  const sortedRegions = [...listRegions].sort((a, b) => a.box.y - b.box.y);
  const rowGroups: Array<{ cy: number; words: OcrWord[] }> = [];

  for (const r of sortedRegions) {
    const cy = r.box.y + r.box.height / 2;
    const existing = rowGroups.find(row => Math.abs(row.cy - cy) < ROW_GAP);
    if (existing) {
      existing.words.push({ text: r.text, box: r.box });
      existing.cy = (existing.cy * (existing.words.length - 1) + cy) / existing.words.length;
    } else {
      rowGroups.push({ cy, words: [{ text: r.text, box: r.box }] });
    }
  }

  // Sort words within each row left-to-right; sort rows top-to-bottom.
  for (const row of rowGroups) row.words.sort((a, b) => a.box.x - b.box.x);
  rowGroups.sort((a, b) => a.cy - b.cy);

  log.debug(`resource-ocr: ${rowGroups.length} row groups`);

  // ── Per-row processing ────────────────────────────────────────────────────
  const errors: string[] = [];
  const unmatchedNames: string[] = [];
  const rows: ExtractedRow[] = [];
  let currentDateLabel = opts.initialDateLabel?.trim() || 'TODAY';
  // Counts only rows that get a crop, so filenames stay dense and predictable.
  let rowIndex = 0;

  for (const row of rowGroups) {
    const lineText = row.words.map(w => w.text).join(' ');
    const parsed = parseLine(lineText);
    if (!parsed) continue;

    if (parsed.type === 'date-header') {
      currentDateLabel = parsed.label;
      continue;
    }

    const { rawPlayerName, direction, amount, knownResourceSlug } = parsed;

    // The whole text row, used for the crop. Available for every row regardless of
    // whether an amount word is found, so an unmatched *name* gets evidence too.
    const rowTop = Math.min(...row.words.map(w => w.box.y));
    const rowHeight = Math.max(...row.words.map(w => w.box.y + w.box.height)) - rowTop;

    // A name that matches no existing member is NOT an error and must not drop the
    // row — the scanner upserts such a name into a new member and lets the member
    // review queue surface it, so do the same here. memberId stays null and the
    // caller resolves it; the row still carries rawPlayerName and gets a crop.
    const member = fuzzyMatchMember(rawPlayerName, members);
    if (!member) {
      unmatchedNames.push(rawPlayerName);
    }

    const transactionDate = resolveTransactionDate(currentDateLabel, uploadDate);

    // Speedup rows: knownResourceSlug already set, no icon detection needed.
    if (knownResourceSlug) {
      const found = allTypes.find(t => t.slug === knownResourceSlug);
      rows.push({
        memberId: member?.id ?? null,
        resourceTypeId: found?.id ?? null,
        direction,
        amount,
        transactionDate,
        rawPlayerName,
        rowCropPath: (found == null || member == null) && cropToken
          ? await saveUnresolvedRowCrop(
              canonicalBuffer, canonicalH, rowTop, rowHeight, cropToken, rowIndex++,
            )
          : null,
      });
      continue;
    }

    // Non-speedup rows: find the amount word's right edge, then detect the icon.
    const byRight = [...row.words].sort((a, b) => (b.box.x + b.box.width) - (a.box.x + a.box.width));
    const amountWord =
      byRight.find(w => isLikelyAmount(w.text)) ??
      byRight.find(w => /\d/.test(w.text));

    let resourceTypeId: number | null = null;

    if (amountWord) {
      const amountRight = Math.round(amountWord.box.x + amountWord.box.width);

      // Skip rows where the amount is in the left half — likely an OCR grouping artifact.
      if (amountRight >= CANONICAL_WIDTH * 0.7) {
        try {
          resourceTypeId = await cropAndMatchIconMultiScale(
            rawRgb, canonicalH, fullImage,
            amountRight, rowTop, rowHeight, darkThreshold, allTypes,
          );
        } catch (err) {
          log.warn({ err }, 'resource-ocr: icon matching failed for row');
        }
      }
    }

    // Skip clan-wide resources we don't track per member (e.g. Seal of
    // Suppression) rather than recording them against the player.
    if (resourceTypeId != null && untrackedTypeIds.has(resourceTypeId)) continue;

    // Only unresolved rows get a crop — an unreadable icon or an unrecognised name
    // is the case an admin has to reconcile by hand. Cropping every row would put
    // hundreds of PNGs on disk per upload for no benefit.
    //
    // Every unresolved row, though, including the top and bottom row of a page. A scroll
    // sweep reads each row on ~4 consecutive pages and most boundary reads do pair with a
    // clean one and disappear, so this writes crops that nothing ends up pointing at — but
    // it is not decidable here which ones those are. The rows that reach the database
    // still unknown are exactly the ones where the clean read never came, i.e. the ones an
    // admin has to identify by eye, so withholding the crop from a boundary row removes
    // the evidence from precisely the rows that need it. The sweep prunes the leftovers
    // once it knows which rows survived — see pruneUnreferencedCrops.
    const rowCropPath = (resourceTypeId == null || member == null) && cropToken
      ? await saveUnresolvedRowCrop(
          canonicalBuffer, canonicalH, rowTop, rowHeight, cropToken, rowIndex++,
        )
      : null;

    rows.push({
      memberId: member?.id ?? null,
      resourceTypeId,
      direction,
      amount,
      transactionDate,
      rawPlayerName,
      rowCropPath,
    });
  }

  log.info(
    `resource-ocr: extracted ${rows.length} rows, ${errors.length} errors from screenshot`,
  );

  return { rows, errors, unmatchedNames, finalDateLabel: currentDateLabel };
}
