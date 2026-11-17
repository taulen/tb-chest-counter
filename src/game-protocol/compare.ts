/**
 * Parallel-run check: the gifts the game listed right before a scan vs the rows
 * that OCR scan recorded. Matching is by (sender, chest, source) after
 * normalising case, spacing, "Lvl"/"Level" and dash style; a leftover pair with
 * the same chest + source but different senders is a probable OCR name misread.
 * A gift that arrived after the capture can only be on the OCR side, so those
 * are counted apart. Pure; see docs/game-protocol.md.
 */
export interface GiftKey {
  sender: string;
  chest: string;
  source: string;
  /** OCR rows: unix seconds the gift was earned/captured, for the late check. */
  at?: number;
}

export interface GiftComparison {
  game: number;
  ocr: number;
  matched: number;
  misreads: number;
  ocrOnly: number;
  ocrLate: number;
  gameOnly: number;
  details: {
    misreads: string[];
    ocrOnly: string[];
    gameOnly: string[];
  };
}

export function normalizeGiftText(s: string): string {
  return s.toLowerCase().replace(/\blvl\b/g, 'level').replace(/[–—]/g, '-').replace(/\s+/g, '');
}

const DETAIL_LIMIT = 30;
/**
 * OCR's earn time comes from the card's "time left", which shows minutes, so a
 * gift that arrived seconds after the capture can read as up to a minute
 * before it. Anything within this window of the capture counts as late.
 */
const LATE_TOLERANCE_S = 120;

export function compareGifts(game: GiftKey[], ocr: GiftKey[], captureEpoch: number): GiftComparison {
  const key = (g: GiftKey) => `${normalizeGiftText(g.sender)}|${normalizeGiftText(g.chest)}|${normalizeGiftText(g.source)}`;
  const pool = new Map<string, GiftKey[]>();
  for (const g of game) pool.set(key(g), [...(pool.get(key(g)) ?? []), g]);

  let matched = 0;
  const unmatched: GiftKey[] = [];
  for (const r of ocr) {
    const hit = pool.get(key(r));
    if (hit?.length) {
      hit.pop();
      matched++;
    } else {
      unmatched.push(r);
    }
  }
  const gameOnly = [...pool.values()].flat();
  const isLate = (r: GiftKey) => r.at !== undefined && r.at > captureEpoch - LATE_TOLERANCE_S;
  const late = unmatched.filter(isLate);
  let ocrOnly = unmatched.filter((r) => !isLate(r));

  const misreads: string[] = [];
  const stillOcrOnly: GiftKey[] = [];
  for (const r of ocrOnly) {
    const i = gameOnly.findIndex(
      (g) => normalizeGiftText(g.chest) === normalizeGiftText(r.chest) && normalizeGiftText(g.source) === normalizeGiftText(r.source),
    );
    if (i >= 0) {
      misreads.push(`OCR "${r.sender}" vs game "${gameOnly[i].sender}" (${r.chest} | ${r.source})`);
      gameOnly.splice(i, 1);
    } else {
      stillOcrOnly.push(r);
    }
  }
  ocrOnly = stillOcrOnly;
  const fmt = (g: GiftKey) => `${g.sender} | ${g.chest} | ${g.source}`;
  return {
    game: game.length,
    ocr: ocr.length,
    matched,
    misreads: misreads.length,
    ocrOnly: ocrOnly.length,
    ocrLate: late.length,
    gameOnly: gameOnly.length,
    details: {
      misreads: misreads.slice(0, DETAIL_LIMIT),
      ocrOnly: ocrOnly.slice(0, DETAIL_LIMIT).map(fmt),
      gameOnly: gameOnly.slice(0, DETAIL_LIMIT).map(fmt),
    },
  };
}
