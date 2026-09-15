import type { Page } from 'playwright';
import { humanClick, randomDelay } from '../utils/human-delay.js';
import { keyPress, mouseClick, mouseMove, mouseWheel } from './input.js';
import { captureFullPage } from './screenshotter.js';
import { cleanPlayerName } from '../vision/player-names.js';
import * as memberRepo from '../data/repositories/member-repo.js';
import { loadPlayerNameCanonicaliser } from '../data/repositories/merge-repo.js';
import { childLogger } from '../utils/logger.js';
import { getConfig } from '../config/index.js';
import { getPaddleOcr } from '../vision/paddle-service.js';
import { recognizeNonLatinName, isLangFallbackAvailable, prewarmLangModels } from '../vision/paddle-lang.js';
import sharp from 'sharp';
import {
  requireUiPosition,
  requireMemberListCrop,
  type MemberListCrop,
} from '../config/calibration.js';
import { DEFAULT_VIEWPORT_WIDTH, DEFAULT_VIEWPORT_HEIGHT } from '../config/viewport.js';
import { MEMBER_LIST_MAX_PAGES, MEMBER_LIST_DRY_PAGES_TO_STOP } from './member-list-sweep.js';
import { looksLikeStoreOverlayText } from '../vision/screen-state.js';
import { withDeadline } from '../utils/deadline.js';

// Shared with the might sweep, which measured these — see member-list-sweep.ts.
// This sweep's own ceiling used to be 50, which is where a 100-member roster
// came back as 88: it ran out of pages, and running out looks exactly like
// reaching the end.
const MAX_MEMBER_PAGES = MEMBER_LIST_MAX_PAGES;
const DRY_PAGES_BEFORE_STOP = MEMBER_LIST_DRY_PAGES_TO_STOP;

interface MemberInfo {
  name: string;
}

type CanvasRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

const log = childLogger('member-capture');

// ── PaddleOCR member-list helpers ─────────────────────────────────────────────
/** Canonical width every member-list crop is resized to before OCR. Exported
 *  because callers that reason about region x-positions (e.g. "is this text in
 *  the right-hand might column") need the same denominator. */
export const MEMBER_CANONICAL_WIDTH = 1000;
/** Every real member row carries "(K:302 X:173 Y:269)". Headers, rank-group
 *  labels and "Online"/"Was yesterday" status lines don't, which makes this the
 *  reliable "this row is a member" signal for both readers of the panel. */
export const COORD_RE = /\(?\s*[Kk]\s*[:.]?\s*\d/;

export interface PRegion { text: string; box: { x: number; y: number; width: number; height: number }; }
export interface PRow { cy: number; words: PRegion[] }

/** Resize a member-list crop to canonical width, run PaddleOCR, group regions
 *  into rows (adaptive Y threshold), and return the rows plus the canonical
 *  PNG so non-Latin name spans can be re-cropped.
 *
 *  Exported for might-capture.ts, the second reader of this panel: it needs the
 *  positioned rows (not just their text) to pair each member with the power
 *  number on the far right of the same row band. */
export async function paddleMemberOcr(
  buffer: Buffer,
  opts: { withCanonicalPng?: boolean; canonicalWidth?: number } = {},
): Promise<{ rows: PRow[]; canonicalPng: Buffer | null; canonH: number }> {
  // Callers that have ALREADY scaled their image to the resolution they want pass its
  // width here, so this does not silently rescale it again. The avatar-strip re-read
  // needs that: it upscales a narrow strip on purpose, and a second canonicalisation
  // both multiplied the OCR cost and invalidated the caller's own inverse mapping
  // from strip coordinates back to member rows.
  const canonicalWidth = opts.canonicalWidth ?? MEMBER_CANONICAL_WIDTH;
  const meta = await sharp(buffer).metadata();
  const w = meta.width ?? canonicalWidth;
  const h = meta.height ?? canonicalWidth;
  const canonH = Math.max(1, Math.round((h / w) * canonicalWidth));
  // Resize straight to raw for the OCR call. This used to encode the canonical image
  // to PNG and immediately decode it again, purely to hand it to the next sharp()
  // call — a lossless round trip whose output was never used. Measured at 83ms versus
  // 10ms on a small crop, and it is paid on EVERY pass, which might capture makes
  // twice per page (the avatar-strip level re-read).
  const { data, info } = await sharp(buffer)
    .resize(canonicalWidth, canonH, { kernel: 'lanczos3' })
    .raw().toBuffer({ resolveWithObject: true });
  const svc = await getPaddleOcr();
  const regions = (await svc.recognize({ width: info.width, height: info.height, data: new Uint8Array(data) })) as unknown as PRegion[];

  const sorted = [...regions].sort((a, b) => a.box.y - b.box.y);
  const rows: PRow[] = [];
  for (const r of sorted) {
    const cy = r.box.y + r.box.height / 2;
    const row = rows.find((x) => Math.abs(x.cy - cy) < Math.max(12, r.box.height * 0.6));
    if (row) { row.words.push(r); row.cy = (row.cy * (row.words.length - 1) + cy) / row.words.length; }
    else rows.push({ cy, words: [r] });
  }
  for (const row of rows) row.words.sort((a, b) => a.box.x - b.box.x);
  rows.sort((a, b) => a.cy - b.cy);
  // Only encoded when a caller actually needs it — the non-Latin name recovery is the
  // one that does. Three of the four call sites (including both of might capture's,
  // which run once per scroll page each) want only the rows, and were paying to encode
  // a 1000px-wide PNG that was then discarded.
  const canonicalPng = opts.withCanonicalPng
    ? await sharp(data, {
        raw: { width: info.width, height: info.height, channels: info.channels },
      }).png().toBuffer()
    : null;
  return { rows, canonicalPng, canonH };
}

/** Return the recognised text of a member-list crop (rows joined by newline). */
export async function paddleMemberText(buffer: Buffer): Promise<string> {
  const { rows } = await paddleMemberOcr(buffer);
  return rows.map((row) => row.words.map((wd) => wd.text).join(' ')).join('\n');
}

/** Extract raw member-name candidates from a crop via PaddleOCR. Coord-marker
 *  rows ("… (K:289 X:919 Y:555)") anchor real member rows; the name is the text
 *  before the marker. Non-Latin names — which the Latin regex can't capture —
 *  are recovered from that region span via the bundled language models. */
/**
 * The member's name as it sits on the row: every word to the LEFT of the
 * "(K:… X:… Y:…)" coordinates.
 *
 * Deliberately makes no demand on what the name is made of. The regex this
 * backs up requires a leading Latin letter, which is true of most names and
 * silently false for the ones that open with a digit, a clan tag in brackets,
 * or an emoji — and a name dropped here never reaches the roster that every
 * later scan matches against.
 *
 * Returns '' when the coordinates are the first thing on the row (nothing to
 * the left of them to read).
 */
export function positionalMemberName(words: Array<{ text: string }>, coordIdx: number): string {
  if (coordIdx <= 0) return '';
  return words.slice(0, coordIdx).map((w) => w.text).join(' ').trim();
}

export interface MemberNameRead {
  names: string[];
  /** Rows carrying "(K:… X:… Y:…)" — i.e. real member rows, readable or not. */
  coordRows: number;
  /** Coord rows that produced no usable name at all, with a sample of the raw line. */
  unreadable: string[];
}

export async function extractRawNamesPaddle(
  cropBuffer: Buffer,
  langAvailable: boolean,
): Promise<MemberNameRead> {
  const { rows, canonicalPng, canonH } = await paddleMemberOcr(cropBuffer, {
    withCanonicalPng: true,
  });
  const names: string[] = [];
  const unreadable: string[] = [];
  let coordRows = 0;
  for (const row of rows) {
    const line = row.words.map((wd) => wd.text).join(' ');
    if (!COORD_RE.test(line)) continue;
    coordRows++;

    const m = line.match(/([A-Za-z][A-Za-z0-9 _.'"-]{1,30}?)\s*\(?\s*[Kk]\s*[:.]?\s*\d/);
    const latinName = (m?.[1] ?? '').trim();

    // The Latin-only v6 model reads Cyrillic/Arabic names as empty or Latin
    // homoglyphs ("Рей" → "Pe"), which the regex above happily accepts. Member
    // capture is a one-time roster build, so we re-OCR the name span with the
    // language models whenever the Latin read is empty, short, or carries
    // non-ASCII glyphs, and prefer a strong non-Latin result when found.
    const worthRecovering = langAvailable
      && (!latinName || latinName.length <= 3 || /[^\x00-\x7F]/.test(latinName));

    // Where the coordinates start. Everything before it is the name, whatever
    // it is made of — needed by both the non-Latin re-read and the positional
    // fallback below.
    const coordIdx = row.words.findIndex((wd) => /[Kk]\s*[:.]?\s*\d/.test(wd.text));

    let recovered = '';
    if (worthRecovering) {
      const nameWords = row.words.slice(0, coordIdx >= 0 ? coordIdx : row.words.length);
      if (nameWords.length) {
        const left = Math.max(0, Math.min(...nameWords.map((wd) => wd.box.x)) - 2);
        const top = Math.max(0, Math.min(...nameWords.map((wd) => wd.box.y)) - 2);
        const right = Math.min(MEMBER_CANONICAL_WIDTH, Math.max(...nameWords.map((wd) => wd.box.x + wd.box.width)) + 2);
        const bottom = Math.min(canonH, Math.max(...nameWords.map((wd) => wd.box.y + wd.box.height)) + 2);
        // canonicalPng is non-null here because this function requests it above; the
        // guard keeps that contract explicit rather than asserting it away.
        if (canonicalPng && right - left >= 8 && bottom - top >= 8) {
          try {
            const crop = await sharp(canonicalPng).extract({ left, top, width: right - left, height: bottom - top }).png().toBuffer();
            recovered = await recognizeNonLatinName(crop);
          } catch { /* keep the Latin read */ }
        }
      }
    }

    // Positional fallback: the words before the coordinates.
    //
    // The regex above demands a name that STARTS with a Latin letter, so every
    // row whose name opens with a digit, a symbol or an emoji failed it and was
    // dropped without a word — and the roster build is the worst place to lose
    // a member, because the roster is what every later scan matches against.
    // This is how the might sweep has always read a name (the words left of the
    // coordinate anchor), and on a 100-member clan that read 89 names, it is
    // the difference the two paths disagreed by.
    const positional = positionalMemberName(row.words, coordIdx);

    const name = recovered || latinName || positional;
    if (name) {
      names.push(name);
    } else {
      unreadable.push(line.slice(0, 40));
    }
  }
  return { names, coordRows, unreadable };
}

function normalizeMemberKey(name: string): string {
  // Keep letters (any script) + digits so non-Latin names get distinct keys;
  // for ASCII names this is identical to the old [^a-z0-9] stripping.
  return name.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/** Exported for might-capture.ts: a might reading has to match the roster name
 *  that member capture stored, so it must go through the identical cleaning
 *  steps — otherwise "XG Megros" would fail to find the "Megros" row. */
export function stripLikelyPrefixTag(name: string): string {
  const compact = name.replace(/\s+/g, ' ').trim();
  if (!compact) return compact;

  // Token form: "XG Megros", "ERT Naty", "la Lothar"
  const tokenMatch = compact.match(/^([A-Za-z]{1,4})\s+([A-Za-z][A-Za-z0-9 _.'"-]{1,30})$/);
  if (tokenMatch) {
    const prefix = tokenMatch[1];
    const rest = tokenMatch[2].trim();
    const prefixLooksLikeTag =
      prefix.length <= 3 || /^[A-Z]{2,4}$/.test(prefix) || /^[a-z]{1,2}$/.test(prefix);
    if (prefixLooksLikeTag && rest.length >= 3) {
      return rest;
    }
  }

  // Joined OCR form: "XGMegros" or "ERTNaty". Only strip when the remainder
  // starts with uppercase and has enough letters to look like a real name.
  const joinedMatch = compact.match(/^([A-Z]{2,4})([A-Z][a-z][A-Za-z0-9 _.'"-]{1,30})$/);
  if (joinedMatch) {
    return joinedMatch[2].trim();
  }

  return compact;
}

/**
 * Ornament, 1-4 digit level, separator, then the name — the merged-into-one-region form.
 *
 * The `\s*` after the ornament is load-bearing: OCR does not reliably keep the
 * decoration flush against the digits, and the measured reads include "中 249 Lothar"
 * and "d 175 virtus ex aqua" with a space in between. Requiring adjacency missed both.
 *
 * The separator (group 2) is why this is a raw pattern with guards in
 * {@link splitBadgeAndName} rather than a regex that decides on its own. It used to be
 * a bare `\s+`, and the decoration on the RIGHT of the digits — the shield's lower
 * point, which OCR renders as a "/" — is not whitespace. So the whole badge survived
 * into the name on every read of an affected player, and since an unmatched name
 * creates a member, each of them minted a fresh row PER LEVEL-UP:
 *
 *     "370/ WrongPortal"  →  member, 2026-08-21
 *     "372/ WrongPortal"  →  member, 2026-08-30
 *     "373/ WrongPortal"  →  member, 2026-09-01
 *     "185/ taulen302"    →  member, 2026-08-22
 *
 * A merge rule per level is not a fix — the next level-up mints the next one — and the
 * level itself was lost too, because this branch is what records it.
 *
 * The one form the old pattern DID match was worse than a miss: "373 / WrongPortal"
 * satisfied `\s+` and handed back "/ WrongPortal" as the name.
 */
const BADGE_AND_NAME = /^[^\s\d]{0,2}\s*(\d{1,4})(\s*[^\s\p{L}\p{N}]{0,3}\s*)(.+)$/u;

/**
 * Highest number the badge parse will accept as a level at all.
 *
 * Deliberately looser than might-capture.ts's `LEVEL_PLAUSIBLE_MAX`: a cap that silently drops a
 * reading is worse than one that merely ranks it below a plausible rival, and the
 * value only has to be tight enough that a stray five-digit read isn't a level.
 */
const LEVEL_PARSE_MAX = 9999;

/**
 * Below this, a level is only believed when whitespace separated it from the name.
 *
 * A single-digit level next to bare punctuation is the shape of an ordinary name —
 * "5.Element", "9-Lives" — far more often than it is a real hero level, and a clan
 * member list is not where level-1-to-9 accounts turn up. "5 Somename" still parses,
 * because whitespace is unambiguous.
 */
const LEVEL_NEEDS_SPACE_BELOW = 10;

/**
 * Split a member-list reading into its hero level and the player's name, for the case
 * where OCR returned the level badge and the name as ONE region.
 *
 * Returns null when the text isn't that shape — which is the common case and not a
 * problem; the caller keeps the reading as-is.
 *
 * The guards are here, in one place, rather than at the two call sites. They were
 * duplicated before and had already drifted apart: `pairNamesWithMight` checked the
 * level range and the letter count, `nameMatchCandidates` checked only the letter
 * count, so a five-digit read was rejected as a level by one and offered as a
 * name-match candidate by the other.
 *
 * The separator must be non-empty. Without that, "5miley" and "1337gamer" — real
 * names, both on the roster — parse as a level plus a name.
 */
export function splitBadgeAndName(text: string): { level: number; name: string } | null {
  const m = text.match(BADGE_AND_NAME);
  if (!m) return null;

  const level = Number.parseInt(m[1], 10);
  const separator = m[2];
  const name = m[3].trim();

  if (!(level >= 1 && level <= LEVEL_PARSE_MAX)) return null;
  if (separator.length === 0) return null;
  if (level < LEVEL_NEEDS_SPACE_BELOW && !/\s/u.test(separator)) return null;
  // A name mangled down to punctuation is not a name. Counted across all scripts so a
  // Cyrillic or Arabic reading isn't dropped by a Latin-only guard.
  if ((name.match(/\p{L}/gu) || []).length < 2) return null;

  return { level, name };
}

/** Canvas-relative percentage (0..1) → screenshot pixel point. Used when
 *  the page's CSS canvas rect is unavailable; the screenshot fills the
 *  same canvas content so the percentage applies directly. */
function pctToScreenshotPoint(
  pct: { xPct: number; yPct: number },
  size: { width: number; height: number },
): { x: number; y: number } {
  return {
    x: Math.round(pct.xPct * size.width),
    y: Math.round(pct.yPct * size.height),
  };
}

/** Canvas-relative crop rectangle (percentages) → screenshot pixel rect.
 *  The percentages were saved relative to the game canvas, which can be
 *  offset from the screenshot origin (e.g. 43px chrome at the top), so
 *  the math has to start from canvasBounds, not the raw screenshot
 *  dimensions. Falls back to assuming the canvas covers the screenshot
 *  (offset 0,0) when canvasBounds is unavailable. Width/height floored
 *  at small minimums so a degenerate operator-drawn rectangle doesn't
 *  blow up sharp.extract. */
export function cropPctToPixels(
  crop: MemberListCrop,
  canvasBounds: CanvasRect | null,
  screenshotSize: { width: number; height: number },
): { left: number; top: number; width: number; height: number } {
  const baseLeft = canvasBounds?.left ?? 0;
  const baseTop = canvasBounds?.top ?? 0;
  const baseWidth = canvasBounds?.width ?? screenshotSize.width;
  const baseHeight = canvasBounds?.height ?? screenshotSize.height;

  const rawLeft = baseLeft + crop.leftPct * baseWidth;
  const rawTop = baseTop + crop.topPct * baseHeight;
  const rawRight = baseLeft + crop.rightPct * baseWidth;
  const rawBottom = baseTop + crop.bottomPct * baseHeight;

  const left = Math.max(0, Math.round(rawLeft));
  const top = Math.max(0, Math.round(rawTop));
  const right = Math.min(screenshotSize.width, Math.round(rawRight));
  const bottom = Math.min(screenshotSize.height, Math.round(rawBottom));

  return {
    left,
    top,
    width: Math.max(50, right - left),
    height: Math.max(80, bottom - top),
  };
}

/**
 * The game canvas's bounding rect, or null when the page can't give a usable
 * one (the caller then falls back to whole-screenshot percentages).
 *
 * This is the same probe as navigator.ts's getCanvasBounds and it carries the
 * same three protections, which it spent a long time without:
 *
 *  - **Largest canvas, not the first.** `querySelector('canvas')` returns
 *    whichever comes first in the DOM. The game inserts helper canvases
 *    (text metrics, atlases) and parks them off-screen at left ≈ -1000000,
 *    the standard way to hide an element that still has to be laid out.
 *  - **Reject off-screen rects.** That helper passed the old width/height
 *    guard — it is a real, large canvas, just not on screen. Every
 *    percentage then resolved against a left of -1000000, which is where
 *    the clan #2 might capture's "calibrated Members sidebar coord
 *    (-999416, 384)" came from: a perfectly calibrated 0.3 xPct landing a
 *    million pixels to the left of the viewport. Nothing errored — the click
 *    went nowhere, the panel never opened, and the failure message blamed
 *    the operator's Stage 2 calibration.
 *  - **A deadline.** page.evaluate has no timeout of its own (no timeout
 *    field in its wire schema, so Playwright arms no timer) and this needs
 *    the renderer's main thread, which is exactly what a wedged browser
 *    cannot supply.
 *
 * Why it bit on a clan switch specifically: the rect is read once, right
 * after a fresh launch + navigation, while the game is still assembling its
 * canvases — the window in which a helper canvas is most likely to be the
 * first one in the DOM.
 */
const CANVAS_RECT_DEADLINE_MS = 15_000;

export async function getCanvasRect(page: Page): Promise<CanvasRect | null> {
  try {
    const probe = await withDeadline(page.evaluate(() => {
      const rects = Array.from(document.querySelectorAll('canvas')).map((canvas) => {
        const r = canvas.getBoundingClientRect();
        return { left: r.left, top: r.top, width: r.width, height: r.height };
      });
      if (rects.length === 0) return null;
      let largest = 0;
      for (let i = 1; i < rects.length; i++) {
        if (rects[i].width * rects[i].height > rects[largest].width * rects[largest].height) {
          largest = i;
        }
      }
      return { rect: rects[largest], count: rects.length, wasFirst: largest === 0 };
    }), CANVAS_RECT_DEADLINE_MS, 'member-capture canvas rect probe');

    if (!probe) return null;
    const rect = probe.rect;

    if (probe.count > 1 && !probe.wasFirst) {
      log.warn(
        { noAlert: true },
        `Canvas rect: ${probe.count} canvases on the page; using the largest `
        + `(${Math.round(rect.width)}x${Math.round(rect.height)}) — it is NOT the first in the DOM.`,
      );
    }

    if (rect.width < 200 || rect.height < 150) return null;
    // Off-screen: the rect is real but useless as a click origin. Returning
    // null hands the caller the screenshot-percentage path, which is correct
    // for a full-page screenshot of a 1920x1080 viewport.
    if (rect.left < -100 || rect.top < -100) {
      log.warn(
        `Canvas rect is off-screen (left=${Math.round(rect.left)}, top=${Math.round(rect.top)}) — `
        + 'ignoring it and using whole-screenshot percentages instead. Clicks derived from this rect '
        + 'would have landed outside the viewport entirely.',
      );
      return null;
    }
    return rect;
  } catch {
    return null;
  }
}

function pctToCanvasPoint(
  pct: { xPct: number; yPct: number },
  canvas: CanvasRect,
): { x: number; y: number } {
  return {
    x: Math.round(canvas.left + pct.xPct * canvas.width),
    y: Math.round(canvas.top + pct.yPct * canvas.height),
  };
}

export type SaveFn = (buf: Buffer, dir: string, label: string, options?: { force?: boolean }) => Promise<string>;

/**
 * Navigate to (or verify we're already on) CLAN → Members.
 *
 * Exported for might-capture.ts. Note the `saveScreenshot` injection: the debug
 * saves in here pass `force: true` because the one-time roster build needs the
 * operator to be able to see where the crop landed. A caller that runs daily
 * passes a wrapper that drops the force flag, so a recurring job doesn't write
 * a fresh set of PNGs every day.
 */
export async function ensureOnMembersTab(
  page: Page,
  recognizeText: (buffer: Buffer) => Promise<string>,
  screenshotSize: { width: number; height: number },
  canvasRect: CanvasRect | null,
  saveScreenshot: SaveFn,
  onProgress?: (message: string) => void,
): Promise<boolean> {
  // Read calibrated UI positions. Throws CalibrationMissingError with a
  // stage-specific message if the operator hasn't completed Stages 1/2.
  const clanButtonPct = requireUiPosition('clanButton');
  const membersSidebarPct = requireUiPosition('membersSidebar');
  const memberListCropPct = requireMemberListCrop();

  const membersClick = canvasRect
    ? pctToCanvasPoint(membersSidebarPct, canvasRect)
    : pctToScreenshotPoint(membersSidebarPct, screenshotSize);
  const clanClick = canvasRect
    ? pctToCanvasPoint(clanButtonPct, canvasRect)
    : pctToScreenshotPoint(clanButtonPct, screenshotSize);

  let verifyStep = 0;
  // Kept so the failure path can say what was actually on screen instead of
  // guessing. See the diagnosis at the end of this function.
  let lastVerifyText = '';
  const isMembersVisible = async (): Promise<boolean> => {
    verifyStep++;
    const verifyShot = await captureFullPage(page);
    // Force these debug saves so the operator can verify the crop is
    // actually landing on the member rows. Without `force: true` they
    // silently skip unless log level is debug, which made it look like
    // the saves were broken when really they were just gated.
    await saveScreenshot(verifyShot, './data/screenshots', `member_nav_full_${verifyStep}`, { force: true });
    const crop = cropPctToPixels(memberListCropPct, canvasRect, screenshotSize);
    const verifyCrop = await sharp(verifyShot)
      .extract(crop)
      .png()
      .toBuffer();
    await saveScreenshot(verifyCrop, './data/screenshots', `member_nav_crop_${verifyStep}`, { force: true });
    const verifyProcessed = await sharp(verifyCrop)
      .grayscale()
      .normalize()
      .sharpen({ sigma: 1.3 })
      .resize({ width: Math.max(300, crop.width * 2) })
      .png()
      .toBuffer();
    await saveScreenshot(verifyProcessed, './data/screenshots', `member_nav_ocr_${verifyStep}`, { force: true });
    const text = (await recognizeText(verifyProcessed)).toLowerCase();
    lastVerifyText = text;
    log.info(`Member verify[${verifyStep}] OCR text: "${text.replace(/\n/g, ' | ').substring(0, 200)}"`);
    // Member-list rows are formatted "[level] PlayerName (K:289 X:919 Y:555)" —
    // every visible row contains "(k:". Counting occurrences (rather than
    // checking for any keyword like "members") gates out false positives
    // from random panels that incidentally OCR words like "member" or
    // "kingdom". A real member list shows ~5–10 rows; require at least 2.
    const coordHits = (text.match(/\(\s*k\s*:/g) || []).length;
    const visible = coordHits >= 2;
    log.info(`Member verify[${verifyStep}] coord-marker hits=${coordHits} → membersVisible=${visible}`);
    return visible;
  };

  // If already on members list, avoid any navigation clicks.
  if (await isMembersVisible()) {
    log.info('Members tab already visible; skipping navigation clicks.');
    return true;
  }

  // Navigate: Escape any popups, click CLAN, click Members sidebar. The
  // OCR-based "find members text in screenshot" fallback was removed —
  // calibration is now the source of truth for the sidebar click. If
  // calibration is wrong, the operator should see it on the post-click
  // screenshot (member_nav_after_members.png is forced to save) and
  // re-run Stage 2 of the wizard rather than relying on OCR to bail us out.
  onProgress?.('Opening Members tab...');
  await keyPress(page, 'Escape');
  await randomDelay(150, 300);

  const beforeClanShot = await captureFullPage(page);
  await saveScreenshot(beforeClanShot, './data/screenshots', 'member_nav_before_clan', { force: true });
  log.info(`Clicking CLAN button at viewport (${clanClick.x}, ${clanClick.y})`);
  await mouseClick(page, clanClick.x, clanClick.y);
  await randomDelay(1500, 2200);
  const afterClanShot = await captureFullPage(page);
  await saveScreenshot(afterClanShot, './data/screenshots', 'member_nav_after_clan', { force: true });

  log.info(`Clicking Members sidebar at viewport (${membersClick.x}, ${membersClick.y}) (calibrated)`);
  await mouseClick(page, membersClick.x, membersClick.y);
  await randomDelay(1800, 2500);
  const afterMembersShot = await captureFullPage(page);
  await saveScreenshot(afterMembersShot, './data/screenshots', 'member_nav_after_members', { force: true });

  if (await isMembersVisible()) {
    log.info('Members tab verified for OCR capture');
    return true;
  }

  // One retry — sometimes the first click registers as a focus event
  // rather than a navigation, and a second click does the actual switch.
  // Cheap insurance; still bails if this also fails so we don't spam
  // clicks against a misconfigured calibration.
  log.debug('Members tab not visible after first click; retrying once.');
  await mouseClick(page, membersClick.x, membersClick.y);
  await randomDelay(1800, 2500);
  const retryShot = await captureFullPage(page);
  await saveScreenshot(retryShot, './data/screenshots', 'member_nav_after_members_retry', { force: true });

  if (await isMembersVisible()) {
    log.info('Members tab verified after retry click');
    return true;
  }

  // Last resort: reload the game and try the whole navigation once more.
  //
  // The game raises store/offer popups that Escape does not close, and
  // waitForInteractiveGame gives up on those with a warning rather than a
  // failure — so the clicks below it land on the promo instead of the clan
  // dialog. A reload is the one thing that reliably clears them.
  //
  // Safe HERE specifically, and it is worth being precise about why: member
  // capture only READS the roster, so abandoning and restarting it costs time
  // and nothing else. The OCR phase's exemption from this kind of retry exists
  // because its crops represent chests already claimed in-game (see
  // scan-pipeline.ts); nothing in this function has claimed anything.
  log.warn(
    { noAlert: true },
    'Members tab not visible after the retry click — reloading the game once, in case a popup '
    + 'that Escape cannot close is covering the UI.',
  );
  try {
    const { navigateToGame, waitForInteractiveGame, dismissPopups } = await import('./auth.js');
    const { TB_GAME_URL } = await import('../config/game-url.js');
    await navigateToGame(page, TB_GAME_URL);
    await waitForInteractiveGame(page);
    await dismissPopups(page, 4);

    log.info(`Post-reload: clicking CLAN at (${clanClick.x}, ${clanClick.y}) then Members at (${membersClick.x}, ${membersClick.y}).`);
    await mouseClick(page, clanClick.x, clanClick.y);
    await randomDelay(1500, 2200);
    await mouseClick(page, membersClick.x, membersClick.y);
    await randomDelay(1800, 2500);
    const afterReloadShot = await captureFullPage(page);
    await saveScreenshot(afterReloadShot, './data/screenshots', 'member_nav_after_reload', { force: true });

    if (await isMembersVisible()) {
      log.info('Members tab verified after reloading the game.');
      return true;
    }
  } catch (err) {
    log.warn(`Reload recovery failed: ${String(err instanceof Error ? err.message : err)}`);
  }

  // Only blame calibration when the evidence points there. Both causes produce
  // "no member rows", and the message is the only thing the operator has to go
  // on — one that names the wrong cause sends them to re-run a stage that was
  // already correct.
  const sample = lastVerifyText.replace(/\n/g, ' ').slice(0, 160);
  if (looksLikeStoreOverlayText(lastVerifyText)) {
    log.error(
      'Members tab still not visible, and the screen reads as an in-game store/offer popup — '
      + `not a calibration problem. Last OCR: "${sample}". The popup survived an Escape sweep and `
      + 'a full game reload, so it likely needs dismissing by hand once (open the game in the '
      + 'Clans page login bridge and close it). Member capture will retry on the next cycle.',
    );
  } else {
    log.error(
      `Members tab still not visible after a retry and a reload. The calibrated Members sidebar `
      + `coord (${membersClick.x}, ${membersClick.y}) did not open the Members panel — if the `
      + `screen looks right in data/screenshots/member_nav_after_reload.png, re-run the `
      + `calibration wizard's Stage 2. Last OCR: "${sample}".`,
    );
  }
  return false;
}

/**
 * Navigate to CLAN > Members, capture all member names via OCR,
 * and store them in the database. Runs on first startup when
 * the members table is empty.
 */
export async function captureClanMembers(
  page: Page,
  clanId: number,
  onProgress?: (message: string) => void,
): Promise<string[]> {
  log.info('Capturing clan member list...');
  onProgress?.('Opening clan member list...');

  // OCR via the shared PP-OCRv6_small PaddleOCR service; non-Latin
  // (Cyrillic/Arabic) member names are recovered via the bundled language
  // models when scanNonLatinFallback is on.
  const config = getConfig();
  const langAvailable = config.scanNonLatinFallback && isLangFallbackAvailable();

  await getPaddleOcr();
  if (langAvailable) prewarmLangModels(); // load lang models up front, not mid-capture
  const recognizeText = (buffer: Buffer): Promise<string> => paddleMemberText(buffer);
  // No worker to tear down for the Paddle service; kept as a no-op so the
  // capture flow's teardown call sites stay unchanged.
  const terminateOcr = async (): Promise<void> => {};
  log.info(`Member capture using PaddleOCR${langAvailable ? ' (+non-Latin fallback)' : ''}`);

  const allNames: string[] = [];
  const allMembers: MemberInfo[] = [];
  let lastHash = '';
  let sameCount = 0;
  // Track candidates rejected by the post-clean length guard so a real
  // member whose OCR happens to be brutally short ("oS", "AI") doesn't
  // vanish silently. Same shape as the parseGiftText length-3 reject
  // that hid Wallst1 → "1" — without a counter+samples summary the
  // operator has no way to notice the drop.
  let droppedShortNameCount = 0;
  const droppedShortNameSamples: string[] = [];
  // Member rows the OCR saw against names it could actually read. Differencing
  // these is what turns "we stored 88" into "we stored 88 of the 100 rows we
  // looked at", which is the only version of that fact an operator can act on.
  let coordRowsSeen = 0;
  let namesRead = 0;
  const unreadableSamples: string[] = [];

  // Base screenshot and dimensions for scaled coordinates/crops.
  const firstShot = await captureFullPage(page);
  const firstMeta = await sharp(firstShot).metadata();
  const screenshotSize = {
    width: firstMeta.width ?? DEFAULT_VIEWPORT_WIDTH,
    height: firstMeta.height ?? DEFAULT_VIEWPORT_HEIGHT,
  };

  const viewportSize = page.viewportSize();
  const windowMetrics = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight,
    screenWidth: window.screen.width,
    screenHeight: window.screen.height,
    devicePixelRatio: window.devicePixelRatio,
  }));
  const canvasRect = await getCanvasRect(page);
  log.info(
    `Render metrics: screenshot=${screenshotSize.width}x${screenshotSize.height}, viewport=${viewportSize?.width ?? 'n/a'}x${viewportSize?.height ?? 'n/a'}, inner=${windowMetrics.innerWidth}x${windowMetrics.innerHeight}, dpr=${windowMetrics.devicePixelRatio}`,
  );
  if (canvasRect) {
    log.info(
      `Canvas bounds: left=${Math.round(canvasRect.left)}, top=${Math.round(canvasRect.top)}, width=${Math.round(canvasRect.width)}, height=${Math.round(canvasRect.height)}`,
    );
  } else {
    log.debug('Canvas bounds unavailable; falling back to screenshot-scaled click coordinates.');
  }

  const { saveScreenshot } = await import('./screenshotter.js');
  const onMembers = await ensureOnMembersTab(page, recognizeText, screenshotSize, canvasRect, saveScreenshot, onProgress);
  if (!onMembers) {
    log.info('Could not verify Members tab after retries; skipping member capture for this run.');
    onProgress?.('Could not verify Members tab. Skipping member capture for this run.');
    await terminateOcr();
    return [];
  }

  // Read the calibrated member-list crop once. The same rectangle is used
  // for every scroll page so we don't need to re-read per iteration.
  // Pass canvasRect so the offset (e.g. top=43 with chrome) is applied —
  // without it the percentages get multiplied against the screenshot
  // dimensions and the crop drifts upward to capture the clan banner
  // instead of the member rows.
  const memberListCropPct = requireMemberListCrop();
  const cropPx = cropPctToPixels(memberListCropPct, canvasRect, screenshotSize);
  log.info(
    `Member list crop pct=[${memberListCropPct.leftPct.toFixed(3)},${memberListCropPct.topPct.toFixed(3)}–${memberListCropPct.rightPct.toFixed(3)},${memberListCropPct.bottomPct.toFixed(3)}] → px=[${cropPx.left},${cropPx.top}–${cropPx.left + cropPx.width},${cropPx.top + cropPx.height}]`,
  );

  // Scroll with the cursor over the middle of the calibrated rectangle,
  // converted from screenshot pixels to CSS pixels (identical at dpr 1, which
  // the scanner's 1920x1080 viewport is, but not something to assume).
  const viewport = page.viewportSize();
  const scrollAt = {
    x: Math.round((cropPx.left + cropPx.width / 2) * (viewport ? viewport.width / screenshotSize.width : 1)),
    y: Math.round((cropPx.top + cropPx.height / 2) * (viewport ? viewport.height / screenshotSize.height : 1)),
  };

  let dryPages = 0;
  let pagesScanned = 0;
  // Scroll through the member list and OCR each page
  for (let pageNum = 0; pageNum < MAX_MEMBER_PAGES; pageNum++) {
    pagesScanned = pageNum + 1;
    const uniqueBefore = allNames.length;
    const screenshot = await captureFullPage(page);

    // Crop to the member name area (narrow - just names)
    let cropped: Buffer;
    try {
      cropped = await sharp(screenshot)
        .extract(cropPx)
        .png()
        .toBuffer();
    } catch {
      log.debug('Could not crop member list, using full screenshot');
      cropped = screenshot;
    }

    // Save debug crop on first page. Forced so it always lands on disk
    // regardless of log level — the operator needs this PNG to verify
    // the crop is on the member rows after a calibration change. One
    // file per scan, harmless to always write.
    if (pageNum === 0) {
      await saveScreenshot(cropped, './data/screenshots', `members_crop_debug`, { force: true });
    }

    // Extract raw member-name candidates for this page. Every real member row
    // carries "(K:… X:… Y:…)" coordinates; the name is the text before them.
    // Lines without coordinates are status text / headers — skipped.
    const read = await extractRawNamesPaddle(cropped, langAvailable);
    const rawNames = read.names;
    coordRowsSeen += read.coordRows;
    namesRead += read.names.length;
    for (const sample of read.unreadable) {
      if (unreadableSamples.length < 8) unreadableSamples.push(sample);
    }
    // Was "N coord rows", printed from the NAME count — so a row that was seen
    // and then dropped was invisible in the log, which is exactly the case worth
    // seeing. Both numbers now.
    log.info(
      `Members OCR page ${pageNum}: ${read.coordRows} coord row(s) → ${read.names.length} name(s)`
      + `${read.unreadable.length > 0 ? ` (${read.unreadable.length} unreadable)` : ''}`,
    );

    onProgress?.(`OCR page ${pageNum + 1}: ${allNames.length} members found so far...`);

    for (const raw of rawNames) {
      let name = cleanPlayerName(raw);
      name = stripLikelyPrefixTag(name);

      // Strip a hero-level badge OCR merged into the name.
      //
      // This path had no badge handling at all, and it is the worse place to be
      // missing it: the roster build runs at onboarding and whatever it stores becomes
      // the member's CANONICAL name, so "373/ WrongPortal" would not just be a
      // duplicate to merge away — it would be the spelling every later reading is
      // matched against. The might capture has stripped badges since it was written;
      // this brings the two readers of the same list into line.
      //
      // The level is discarded here on purpose. This module writes roster rows, not
      // snapshots, and the daily might capture reads the level properly.
      const withoutBadge = splitBadgeAndName(name);
      if (withoutBadge) name = withoutBadge.name;

      // Count letters across all scripts (\p{L}) so recovered Cyrillic/Arabic
      // names aren't dropped by a Latin-only guard.
      const letterCount = (name.match(/\p{L}/gu) || []).length;
      if (name.length < 2 || letterCount < 2) {
        droppedShortNameCount++;
        if (droppedShortNameSamples.length < 10) {
          droppedShortNameSamples.push(`"${raw}" → "${name}"`);
        }
        continue;
      }

      // Deduplicate by canonical key so scroll overlap and prefix-tag variants
      // of the same player are collapsed.
      const normKey = normalizeMemberKey(name);
      const isDuplicate = allNames.some(
        (existing) => normalizeMemberKey(stripLikelyPrefixTag(existing)) === normKey,
      );
      if (!isDuplicate) {
        allNames.push(name);
        allMembers.push({ name });
        log.info(`Found member: "${name}"`);

        if (allNames.length % 5 === 0) {
          onProgress?.(`Detected ${allNames.length} unique members so far...`);
        }
      }
    }

    // Bottom detection - hash comparison
    const crypto = await import('crypto');
    const hash = crypto.createHash('md5').update(cropped).digest('hex');
    if (hash === lastHash) {
      sameCount++;
      if (sameCount >= 3) {
        log.info('Members list: reached bottom');
        onProgress?.('Reached end of member list. Saving members...');
        break;
      }
    } else {
      sameCount = 0;
    }
    lastHash = hash;

    // Second stop condition, from the might sweep: pages that keep yielding no
    // NEW member. The hash check alone only fires when the picture stops
    // changing entirely, so a list that has run out but still animates (the
    // "was N ago" timers tick) kept scrolling to the 50-page cap — four pages of
    // one clipped row, ~40 seconds, on the run that prompted this.
    if (allNames.length === uniqueBefore) {
      dryPages++;
      if (dryPages >= DRY_PAGES_BEFORE_STOP) {
        log.info(`Members list: no new member in ${dryPages} page(s) — treating as the end.`);
        onProgress?.('Reached end of member list. Saving members...');
        break;
      }
    } else {
      dryPages = 0;
    }

    // Scroll with the cursor over the calibrated rectangle — by definition on
    // the member rows. This was a hardcoded (700, 450), which on a real
    // deployment lands ~90px left of the rows, over the dialog's sidebar rail;
    // the wheel still moved the list because the dialog forwards it, but aiming
    // at an element we only hope forwards the event is not worth keeping. Same
    // reasoning, same coordinates, as might-capture.
    await mouseMove(page, scrollAt.x, scrollAt.y);
    for (let i = 0; i < 4; i++) {
      await mouseWheel(page, 0, 100);
      await randomDelay(20, 40);
    }
    await randomDelay(100, 200);
  }

  if (pagesScanned >= MAX_MEMBER_PAGES) {
    log.warn(
      `Member capture hit its ${MAX_MEMBER_PAGES}-page ceiling without reaching the end of the `
      + 'list, so the roster may be short. Check that the Stage 4 rectangle sits on the member '
      + 'rows — a rectangle over a part of the panel that never changes also never looks "done".',
    );
  }

  await terminateOcr();

  if (droppedShortNameCount > 0) {
    log.warn(
      `Member capture: dropped ${droppedShortNameCount} candidate(s) as too short after cleaning (length < 2 or letterCount < 2). Samples: ${droppedShortNameSamples.join(', ')}`,
    );
  }

  // Rows seen vs names read, always. A roster short of the clan's real size is
  // the defect that hides best: every later scan matches against this list, and
  // a member missing from it reads as a player who simply never sends anything.
  log.info(
    `Member capture read ${namesRead} name(s) from ${coordRowsSeen} member row(s) across the sweep `
    + `(rows repeat between pages; ${allNames.length} distinct members kept).`,
  );
  if (unreadableSamples.length > 0) {
    log.warn(
      { noAlert: true },
      `Member capture could not read a name on some rows. Samples: ${unreadableSamples.join(' | ')}`,
    );
  }

  // Store in database. Don't swallow per-row errors: a UNIQUE/FK/BUSY
  // failure here means a real member disappears from the active roster
  // and breaks matchKnownPlayer for every future scan involving that
  // player. Log each failure with the name + reason so the operator
  // can repair the roster manually.
  //
  // Every name goes through the clan's player merge rules first. A rule is the
  // admin saying "this reading IS that player", and this is one of the four paths
  // that used to ignore them and mint a roster row under the misread spelling
  // anyway — the gift scan was the only place that ever consulted them. Applied at
  // the upsert rather than at the read so the dedup above still sees exactly the
  // strings OCR produced.
  const canonicalisePlayerName = loadPlayerNameCanonicaliser(clanId);

  // Counted by resolved member id, not by upsert call: two OCR spellings a rule folds
  // onto one player are one roster row, and reporting them as two would overstate the
  // roster the operator is being shown.
  const insertedIds = new Set<number>();
  const failedMembers: string[] = [];
  const rewritten: string[] = [];
  for (const member of allMembers) {
    const name = canonicalisePlayerName(member.name);
    if (name !== member.name) rewritten.push(`"${member.name}" → "${name}"`);
    try {
      insertedIds.add(memberRepo.upsertMember(name, clanId).id);
    } catch (err) {
      failedMembers.push(`"${name}" (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  const inserted = insertedIds.size;

  if (rewritten.length > 0) {
    log.info(
      `Member capture: ${rewritten.length} name(s) resolved through a player merge rule — ${rewritten.join(', ')}`,
    );
  }

  if (failedMembers.length > 0) {
    log.warn(
      `Member capture: failed to upsert ${failedMembers.length} member(s) — ${failedMembers.join('; ')}`,
    );
  }
  log.info(`Captured ${allMembers.length} members, inserted ${inserted} into database`);
  onProgress?.(`Member capture complete: ${allMembers.length} detected, ${inserted} inserted.`);

  // Navigate back to Gifts tab
  await keyPress(page, 'Escape');
  await randomDelay(500, 1000);

  return allNames;
}

/**
 * Check if we should capture the member list (first run, no members in DB).
 */
export function needsMemberCapture(clanId: number): boolean {
  return memberRepo.getMemberCount(clanId) === 0;
}
