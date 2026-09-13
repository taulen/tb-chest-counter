/**
 * Icon-matching diagnostic for the resource-history OCR pipeline.
 *
 * Mirrors the crop + scoring logic in src/vision/resource-ocr.ts. For every
 * transaction row in every screenshot it prints the ranked template scores, so you
 * can see which resources are being confused and by how much.
 *
 * Row geometry comes from real PaddleOCR word boxes (--ocr, the default) so that
 * `rowTop`, `rowH` and `amountRight` match production exactly. This matters: the
 * contour search window is sized as rowH ± 0.6·rowH, so a synthesised rowH changes
 * which contours merge and hides real failures. Models load from
 * assets/paddle-models/ — no network, no DB.
 *
 * --bands falls back to detecting rows from the alternating background stripes.
 * Faster and needs no models, but the geometry is only approximate — use it for a
 * quick sweep, never to judge contour behaviour.
 *
 * Usage:
 *   node scripts/diagnose-resource-icons.mjs [screenshotDir] [--bands] [--dump]
 *
 *   --dump   also write the winning crop of each row to
 *            data/icon-diagnostic/<screenshot>_r<NN>_<slug>.png
 */

import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import * as ort from 'onnxruntime-node';
import { Image, PaddleOcrService } from 'paddleocr';

const CANONICAL_WIDTH = 1000;
const NCC_MATCH_THRESHOLD = 0.68;
const NCC_BOOST_GATE = 0.65;
const BIAS_SIGMA = 20;
const BIAS_WEIGHT = 0.25;
const STRIP_GAP = 3;
const MAX_ICON_H_OVER_W = 1.10;
// Narrowest contour that can be an icon. Real icons measure 37-46px wide here; the
// history list's scrollbar thumb measures 11-17px and, being far taller, used to win
// the largest-area contest and steal the match. See src/vision/resource-ocr.ts.
const MIN_ICON_CONTOUR_W = 24;
const BG = { r: 205, g: 184, b: 152 };

const args = process.argv.slice(2);
const dump = args.includes('--dump');
const useBands = args.includes('--bands');
// --legacy disables the vertical-merge / left-clip handling so the same harness can
// produce a before-and-after diff for that change.
const legacy = args.includes('--legacy');
const shotDir = path.resolve(args.find((a) => !a.startsWith('--')) ?? 'data/benchmark_gifts');
const iconDir = path.resolve('assets', 'resource-icons');
const dumpDir = path.resolve('data', 'icon-diagnostic');
const ROW_GAP = 20; // matches resource-ocr.ts

// ── scoring (copied from resource-ocr.ts) ────────────────────────────────────

function channelStats(data, stride, offset) {
  const n = data.length / stride;
  const pixels = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) { pixels[i] = data[i * stride + offset]; sum += pixels[i]; }
  const mean = sum / n;
  let v = 0;
  for (let i = 0; i < n; i++) v += (pixels[i] - mean) ** 2;
  return { pixels, mean, std: Math.sqrt(v / n) };
}

function pixelStatsRgb(data) {
  return { r: channelStats(data, 3, 0), g: channelStats(data, 3, 1), b: channelStats(data, 3, 2) };
}

function ncc(a, ma, sa, b, mb, sb) {
  if (sa < 1e-6 || sb < 1e-6) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - ma) * (b[i] - mb);
  return sum / (a.length * sa * sb);
}

function nccRgb(a, b) {
  return (
    ncc(a.r.pixels, a.r.mean, a.r.std, b.r.pixels, b.r.mean, b.r.std) +
    ncc(a.g.pixels, a.g.mean, a.g.std, b.g.pixels, b.g.mean, b.g.std) +
    ncc(a.b.pixels, a.b.mean, a.b.std, b.b.pixels, b.b.mean, b.b.std)
  ) / 3;
}

function nccCombined(a, b) {
  const score = nccRgb(a, b);
  if (score < NCC_BOOST_GATE) return score;
  const d = (a.r.mean - a.b.mean) - (b.r.mean - b.b.mean);
  return score * (1 + BIAS_WEIGHT * Math.exp(-(d * d) / (2 * BIAS_SIGMA * BIAS_SIGMA)));
}

async function statsFromBuffer(buf) {
  const data = await sharp(buf)
    .flatten({ background: BG })
    .resize(48, 48, { fit: 'fill', kernel: 'lanczos3' })
    .raw().toBuffer();
  return pixelStatsRgb(data);
}

// ── templates ────────────────────────────────────────────────────────────────

async function loadTemplates() {
  const bySlug = new Map();
  for (const file of fs.readdirSync(iconDir).filter((f) => f.endsWith('.png') && !f.startsWith('_'))) {
    const slug = file.replace(/-\d+\.png$/, '').replace(/\.png$/, '');
    const stats = await statsFromBuffer(path.join(iconDir, file));
    if (!bySlug.has(slug)) bySlug.set(slug, []);
    bySlug.get(slug).push({ file, stats });
  }
  return bySlug;
}

// ── row banding: find the dark separator lines between history rows ──────────

async function findRowBands(canonicalBuffer, width, height) {
  const { data } = await sharp(canonicalBuffer).greyscale().raw().toBuffer({ resolveWithObject: true });
  const textCols = Math.round(width * 0.9); // ignore the icon column when profiling
  const means = [];
  for (let y = 0; y < height; y++) {
    let s = 0;
    for (let x = 5; x < textCols; x++) s += data[y * width + x];
    means.push(s / (textCols - 5));
  }
  const lo = Math.min(...means);
  const hi = Math.max(...means);
  const thr = lo + (hi - lo) * 0.35;

  const seps = [];
  let inSep = false;
  for (let y = 0; y < height; y++) {
    if (means[y] < thr) { if (!inSep) { seps.push(y); inSep = true; } } else inSep = false;
  }
  // Keep separators spaced by a plausible row pitch; derive bands between them.
  const bands = [];
  for (let i = 0; i < seps.length - 1; i++) {
    const h = seps[i + 1] - seps[i];
    if (h > 20 && h < 120) bands.push({ top: seps[i], height: h });
  }
  return bands;
}

// ── OCR-backed row geometry (mirrors processResourceScreenshot exactly) ──────

let _ocr = null;
async function getOcr() {
  if (_ocr) return _ocr;
  const dir = path.resolve('assets', 'paddle-models');
  const det = fs.readFileSync(path.join(dir, 'det.onnx'));
  const rec = fs.readFileSync(path.join(dir, 'rec.onnx'));
  const dict = fs.readFileSync(path.join(dir, 'ppocrv6_dict.txt'), 'utf-8')
    .trimEnd().split(/\r?\n/).concat([' ']);
  const runtime = {
    Tensor: ort.Tensor,
    InferenceSession: {
      create: (b) => ort.InferenceSession.create(b, {
        intraOpNumThreads: 4, interOpNumThreads: 1, executionMode: 'sequential',
      }),
    },
  };
  _ocr = await PaddleOcrService.createInstance({
    ort: runtime,
    modelPreset: 'PP-OCRv6_small',
    detection: { modelBuffer: det.buffer.slice(det.byteOffset, det.byteOffset + det.byteLength) },
    recognition: {
      modelBuffer: rec.buffer.slice(rec.byteOffset, rec.byteOffset + rec.byteLength),
      charactersDictionary: dict,
    },
  });
  return _ocr;
}

function isLikelyAmount(text) {
  return text.includes(',') || /^[+\-−]\d/.test(text) || /^\d{4,}$/.test(text);
}

/**
 * Group OCR regions into rows and derive the same three numbers production uses:
 * rowTop (min word y), rowH (text bbox height) and amountRight (right edge of the
 * amount word). Rows whose amount sits left of 70 % width are skipped, as in
 * resource-ocr.ts.
 */
async function findRowsViaOcr(rawRgb, info) {
  const ocr = await getOcr();
  const regions = await ocr.recognize({ width: info.width, height: info.height, data: new Uint8Array(rawRgb) });

  const groups = [];
  for (const r of [...regions].sort((a, b) => a.box.y - b.box.y)) {
    const cy = r.box.y + r.box.height / 2;
    const g = groups.find((x) => Math.abs(x.cy - cy) < ROW_GAP);
    if (g) {
      g.words.push({ text: r.text, box: r.box });
      g.cy = (g.cy * (g.words.length - 1) + cy) / g.words.length;
    } else {
      groups.push({ cy, words: [{ text: r.text, box: r.box }] });
    }
  }
  groups.sort((a, b) => a.cy - b.cy);

  const rows = [];
  for (const g of groups) {
    const text = g.words.map((w) => w.text).join(' ');
    // Only transaction rows reach icon matching in production; speedups are
    // identified from text and date headers carry no icon.
    if (/speeded/i.test(text)) continue;
    if (!/^(.+?)(sent|took)\s*resources/i.test(text.trim())) continue;

    const byRight = [...g.words].sort((a, b) => (b.box.x + b.box.width) - (a.box.x + a.box.width));
    const amountWord = byRight.find((w) => isLikelyAmount(w.text)) ?? byRight.find((w) => /\d/.test(w.text));
    if (!amountWord) continue;
    const amountRight = Math.round(amountWord.box.x + amountWord.box.width);
    if (amountRight < CANONICAL_WIDTH * 0.7) continue;

    const top = Math.min(...g.words.map((w) => w.box.y));
    const height = Math.max(...g.words.map((w) => w.box.y + w.box.height)) - top;
    rows.push({ top, height, amountRight, text });
  }
  return rows;
}

// ── contour-based icon location (mirrors findIconContour) ────────────────────

function findIconContour(fullImage, canonicalH, stripLeft, rowTop, rowH, darkThreshold) {
  const margin = Math.round(rowH * 0.6);
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
    const val = gray < darkThreshold ? 255 : 0;
    inverted[i * 3] = inverted[i * 3 + 1] = inverted[i * 3 + 2] = val;
  }

  const invImage = new Image(stripW, stripH, 3, inverted);
  const contours = invImage.threshold({ threshold: 127 }).dilate({ k: 2 }).contours({ minArea: 20 });
  if (!contours.length) return null;
  // Mirrors the scrollbar filter in src/vision/resource-ocr.ts. This file is only
  // useful as long as it behaves identically to production — a harness that reports
  // failures production no longer has, or misses ones it does, is worse than none.
  const iconish = contours.filter((c) => c.width >= MIN_ICON_CONTOUR_W && c.width <= 85);
  const pool = iconish.length > 0 ? iconish : contours;
  const best = pool.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
  return {
    x: stripX + best.x, y: stripY + best.y, w: best.width, h: best.height,
    clippedLeft: best.x === 0,
  };
}

// ── per-row scoring (mirrors cropAndMatchIconMultiScale, but ranks everything) ─

async function scoreRow(canonicalBuffer, canonicalH, fullImage, amountRight, rowTop, rowH, darkThreshold, templates) {
  const contour = findIconContour(fullImage, canonicalH, amountRight + STRIP_GAP, rowTop, rowH, darkThreshold);
  const goodContour = contour && contour.w >= 10 && contour.h >= 10 && contour.w <= contour.h * 3 && contour.w <= 85;

  // Vertical-merge guard — mirrors MAX_ICON_H_OVER_W in resource-ocr.ts.
  const mergedVertically = !legacy && !!contour && contour.h > contour.w * MAX_ICON_H_OVER_W;
  const iconH = mergedVertically ? contour.w : contour?.h ?? 0;

  let cx, cy, baseSize;
  if (goodContour) {
    cx = contour.x + contour.w / 2;
    cy = mergedVertically ? rowTop + rowH / 2 : contour.y + contour.h / 2;
    baseSize = Math.max(contour.w, iconH);
  } else {
    const sz = Math.max(rowH, 44);
    cx = amountRight + 25 + sz / 2;
    cy = rowTop + rowH / 2;
    baseSize = sz;
  }

  const avgSize = goodContour ? Math.round((contour.w + iconH) / 2) : baseSize;
  const baseSizes = [...new Set([baseSize, avgSize])];
  // Anchors — mirrors resource-ocr.ts.
  const xAnchors = [{ cx }];
  if (!legacy && goodContour && contour.clippedLeft) xAnchors.push({ right: contour.x + contour.w });
  const cyCandidates = [cy];
  if (goodContour && contour.h < contour.w * 0.65) cyCandidates.push(cy - Math.round(contour.h * 0.3));
  if (mergedVertically) cyCandidates.push(cy + 2, cy - 2);

  // best score per slug across every crop variant
  const bestBySlug = new Map();
  let bestOverall = { slug: null, score: -Infinity, crop: null, file: null, sz: 0 };

  for (const xa of xAnchors)
    for (const cyT of cyCandidates)
    for (const base of baseSizes)
      for (const delta of [-4, 0, 4, 8, 12, 16]) {
        const sz = Math.max(20, Math.round(base + delta));
        const l = Math.max(0, Math.round(xa.cx !== undefined ? xa.cx - sz / 2 : xa.right - sz));
        const t = Math.max(0, Math.round(cyT - sz / 2));
        const w = Math.min(sz, CANONICAL_WIDTH - l);
        const h = Math.min(sz, canonicalH - t);
        if (w < 10 || h < 10) continue;

        let crop;
        try {
          crop = await sharp(canonicalBuffer).extract({ left: l, top: t, width: w, height: h }).png().toBuffer();
        } catch { continue; }

        let cand;
        try { cand = await statsFromBuffer(crop); } catch { continue; }

        for (const [slug, variants] of templates) {
          for (const v of variants) {
            const s = nccCombined(cand, v.stats);
            if (s > (bestBySlug.get(slug) ?? -Infinity)) bestBySlug.set(slug, s);
            if (s > bestOverall.score) bestOverall = { slug, score: s, crop, file: v.file, sz };
          }
        }
      }

  const ranked = [...bestBySlug.entries()].sort((a, b) => b[1] - a[1]);
  return { ranked, bestOverall, contour, goodContour };
}

// ── main ─────────────────────────────────────────────────────────────────────

const templates = await loadTemplates();
console.log(`templates: ${[...templates].map(([s, v]) => `${s}×${v.length}`).join(', ')}\n`);

if (dump) fs.mkdirSync(dumpDir, { recursive: true });

const limit = Number(args.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? Infinity);
const every = Number(args.find((a) => a.startsWith('--every='))?.split('=')[1] ?? 1);
const shots = fs.readdirSync(shotDir)
  .filter((f) => /\.(png|jpe?g)$/i.test(f))
  .sort()
  .filter((_, i) => i % every === 0)
  .slice(0, limit);
const tally = new Map();
const margins = new Map();

for (const shot of shots) {
  const p = path.join(shotDir, shot);
  const meta = await sharp(p).metadata();
  const canonicalH = Math.round((meta.height / meta.width) * CANONICAL_WIDTH);
  const canonicalBuffer = await sharp(p).resize(CANONICAL_WIDTH, canonicalH, { kernel: 'lanczos3' }).toBuffer();
  const darkThreshold = meta.width < CANONICAL_WIDTH ? 155 : 140;

  const { data: rawRgb, info } = await sharp(canonicalBuffer).raw().toBuffer({ resolveWithObject: true });
  const fullImage = new Image(info.width, info.height, info.channels, new Uint8Array(rawRgb));

  const rows = useBands
    ? (await findRowBands(canonicalBuffer, info.width, info.height))
        .map((b) => ({ top: b.top, height: b.height, amountRight: Math.round(CANONICAL_WIDTH * 0.895) }))
    : await findRowsViaOcr(rawRgb, info);
  console.log(
    `── ${shot}  (${meta.width}×${meta.height} → ${CANONICAL_WIDTH}×${canonicalH},` +
    ` ${rows.length} rows${useBands ? ', bands' : ''})`,
  );

  for (let i = 0; i < rows.length; i++) {
    const { top, height: rowH, amountRight } = rows[i];
    const { ranked, bestOverall, contour, goodContour } = await scoreRow(
      canonicalBuffer, canonicalH, fullImage, amountRight, top, rowH, darkThreshold, templates,
    );

    const top3 = ranked.slice(0, 3).map(([s, v]) => `${s} ${v.toFixed(3)}`).join('  |  ');
    const win = bestOverall.score >= NCC_MATCH_THRESHOLD ? bestOverall.slug : 'NO MATCH';
    const c = contour ? `${contour.w}×${contour.h}${goodContour ? '' : ' REJ'}` : 'none';
    // Margin = winner − best *other* resource. This is the number that predicts
    // flakiness: boards and steel each failed in production at margin ≈ 0.02–0.13
    // while scoring above the 0.68 threshold.
    const margin = ranked.length > 1 ? ranked[0][1] - ranked[1][1] : Infinity;
    const flag = win !== 'NO MATCH' && margin < 0.25 ? ' ⚠ NARROW' : '';
    console.log(
      `  r${String(i).padStart(2, '0')}  ${String(win).padEnd(22)} contour ${c.padEnd(14)}` +
      ` m=${margin === Infinity ? '  inf' : margin.toFixed(3)}  ${top3}${flag}`,
    );

    tally.set(win, (tally.get(win) ?? 0) + 1);
    if (win !== 'NO MATCH') {
      const prev = margins.get(win);
      if (!prev || margin < prev.margin) {
        margins.set(win, { margin, score: ranked[0][1], runnerUp: ranked[1]?.[0] ?? '—', where: `${shot} r${i}` });
      }
    }

    if (dump && bestOverall.crop) {
      const name = `${shot.replace(/\.\w+$/, '')}_r${String(i).padStart(2, '0')}_${win}_${bestOverall.score.toFixed(3)}.png`;
      await sharp(bestOverall.crop).resize(192, 192, { kernel: 'nearest' }).png().toFile(path.join(dumpDir, name));
    }
  }
  console.log();
}

console.log('── tally ──');
for (const [slug, n] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`  ${String(slug).padEnd(24)} ${n}`);

// Worst-case margin per resource. A healthy template clears its nearest rival by
// ~0.3+; anything under 0.25 is one rescaling artifact away from a misread and
// usually means the template's aspect ratio doesn't match the real icon.
console.log('\n── narrowest margin per resource (lower = flakier) ──');
const rows = [...margins].sort((a, b) => a[1].margin - b[1].margin);
for (const [slug, m] of rows) {
  console.log(
    `  ${slug.padEnd(24)} m=${m.margin.toFixed(3)}  score=${m.score.toFixed(3)}` +
    `  vs ${m.runnerUp.padEnd(22)} ${m.where}${m.margin < 0.25 ? '  ⚠' : ''}`,
  );
}
