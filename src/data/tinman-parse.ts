/**
 * Parse a pasted event ranking (Rise of the Ancients, Olympus, Ragnarok,
 * Dark Omens) into rows.
 *
 * Accepts what people actually paste:
 *   - a markdown table:        `| 1 | Fiin SK 2 | 63,965,364 |`
 *   - spreadsheet columns:     `1 <tab> Fiin SK 2 <tab> 63965364`
 *   - CSV, quoted or not:      `1,Fiin SK 2,"63,965,364"` / `1;Fiin SK 2;63.965.364`
 *   - plain lines:             `1. Fiin SK 2  63,965,364`, `#1 Fiin SK 2 - 63,965,364 pts`
 * Markdown bold, a medal emoji in place of the rank, and a trailing "points" /
 * "pts" are tolerated. Header and separator lines are skipped, and anything
 * else that doesn't read as a row is reported back rather than dropped
 * silently.
 *
 * Points may use `,` `.` `'` or spaces as thousands separators — one kind per
 * number. A separator only counts between full groups of three digits, so a
 * name ending in a number stays intact: in `98 STRUGGLE 1 0` the name is
 * "STRUGGLE 1" and the points are 0, and in `Fiin SK 3 239,421` it is
 * "Fiin SK 3".
 *
 * Pure — no database — so tests can run it on its own.
 */

export interface TinmanRow {
  rank: number;
  name: string;
  points: number;
}

export interface TinmanParseResult {
  rows: TinmanRow[];
  /** Non-blank lines that were neither a row nor a header/separator. */
  skipped: string[];
}

const MAX_RANK = 1000;
const MAX_NAME_LENGTH = 80;

/**
 * Points with optional thousands grouping: 63,965,364 / 63.965.364 /
 * 63 965 364 / 63'965'364 / 0. The same separator throughout (`\s` covers the
 * no-break and narrow no-break spaces), so `3 239,421` is not one number.
 */
const POINTS = String.raw`(\d{1,3}(?<sep>[,.'’\s])\d{3}(?:\k<sep>\d{3})*|\d+)`;

/** Between a name and its points: spaces, `,` `;` `:` `=` `–` `—`, or a spaced hyphen. */
const NAME_SEP = String.raw`(?:\s*[,;:=–—]\s*|\s+-+\s*|\s+)`;

const PLAIN_LINE = new RegExp(String.raw`^#?(\d{1,4})(?:[.):,;]\s*|\s+)(.+?)${NAME_SEP}${POINTS}$`);
const NAME_POINTS_LINE = new RegExp(String.raw`^(.+?)${NAME_SEP}${POINTS}$`);
const POINTS_ONLY = new RegExp(String.raw`^${POINTS}$`);
/** A rank cell: `1`, `#1`, `1.`, `1)`. */
const RANK_CELL = /^#?(\d{1,4})[.)]?$/;
/** A rank written into the name cell, with punctuation so a name like "300 Spartans" stays whole. */
const RANK_IN_NAME = /^(?:#(\d{1,4})\s*|(\d{1,4})[.):]\s*)(.+)$/;

/** A unit after the number: "3,279,585 pts", "… points", "… Punkte". */
function stripUnit(s: string): string {
  return s.replace(/(\d)\s*(?:points?|pts?|puntos|punkte|очк[а-яё]*)\.?\s*$/i, '$1');
}

function toPoints(s: string): number | null {
  const t = stripUnit(s.trim());
  if (!POINTS_ONLY.test(t)) return null;
  const n = Number(t.replace(/\D/g, ''));
  return Number.isSafeInteger(n) ? n : null;
}

function cleanName(s: string): string {
  const name = s.replace(/\s+/g, ' ').trim();
  const quoted = /^(["'])(.+)\1$|^“(.+)”$/.exec(name);
  return (quoted ? (quoted[2] ?? quoted[3]).trim() : name).slice(0, MAX_NAME_LENGTH);
}

/**
 * Markdown bold/underline (`**Ariron**`, `__3,279,585__`) and a medal in place
 * of the rank (`🥇 Ariron SK 3,279,585`) — as chat assistants format a ranking.
 */
function normalizeLine(raw: string): string {
  return raw
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/^\s*(?:🥇|🥈|🥉)\s*/u, '')
    .trim();
}

interface Field {
  text: string;
  quoted: boolean;
}

/** Split one CSV line on `delim`, honouring `"quoted, fields"` and `""` escapes. */
function splitDelimited(line: string, delim: string): Field[] {
  const out: Field[] = [];
  let i = 0;
  for (;;) {
    while (line[i] === ' ') i++;
    let text = '';
    const quoted = line[i] === '"';
    if (quoted) {
      for (i++; i < line.length; i++) {
        if (line[i] !== '"') text += line[i];
        else if (line[i + 1] === '"') text += line[++i];
        else {
          i++;
          break;
        }
      }
    }
    while (i < line.length && line[i] !== delim) text += line[i++];
    out.push({ text: text.trim(), quoted });
    if (i >= line.length) return out;
    i++;
  }
}

/**
 * A CSV row as `[rank, name, points]` (or `[name, points]`), or null when the
 * line isn't one. A line counts as CSV when it starts with a bare rank field
 * and has at least three fields, or uses quoted fields; anything else — like
 * `1. Fiin SK 2 63,965,364`, whose commas are thousands separators — is left
 * to the plain-line reading.
 *
 * Unquoted points split by the CSV commas (`1,Ariron SK,3,279,585`) are glued
 * back together, and the name is the field(s) before them, so a name ending
 * in a number (`10,Fiin SK 3,239,421`) keeps it.
 */
function delimitedCells(line: string): string[] | null {
  for (const delim of [';', ',']) {
    const fields = splitDelimited(line, delim);
    if (fields.length < 2) continue;
    const ranked = RANK_CELL.test(fields[0].text);
    if (!(ranked && fields.length >= 3) && !fields.some((f) => f.quoted)) continue;
    const nameStart = ranked ? 1 : 0;
    let pointsStart = fields.length - 1;
    const group = (f: Field) => !f.quoted && /^\d{3}$/.test(f.text);
    const head = (f: Field) => !f.quoted && /^\d{1,3}$/.test(f.text);
    if (delim === ',') {
      while (pointsStart > nameStart + 1 && group(fields[pointsStart]) && head(fields[pointsStart - 1])) pointsStart--;
    }
    if (pointsStart <= nameStart) continue;
    const name = fields.slice(nameStart, pointsStart).map((f) => f.text).join(`${delim} `);
    const points = fields.slice(pointsStart).map((f) => f.text).join(',');
    return ranked ? [fields[0].text, name, points] : [name, points];
  }
  return null;
}

/**
 * A stand-in for a name the source couldn't read — "*(Name not visible)*",
 * "(unknown)", "???". Two of them are NOT the same player, so each is given a
 * name of its own built from its rank; it then reaches the review list like
 * any unmatched name, where an admin can say who it is.
 */
const PLACEHOLDER = /^[*_\s]*\(.*\)[*_\s]*$|not visible|unreadable|^\?+$|^unknown$/i;

function realName(name: string, rank: number): string {
  return PLACEHOLDER.test(name) ? `(name not visible · rank ${rank})` : name;
}

// ─── Per-tier targets ────────────────────────────────────────────

export const TARGET_TIERS = ['t9', 'g9', 'g8', 'g7', 'g6', 'g5', 'g4', 'g3', 'g2', 'g1'] as const;
export type TargetTier = (typeof TARGET_TIERS)[number];

export interface TierTargets {
  /** Points each member of a tier is asked for over the run. */
  tiers: Partial<Record<TargetTier, number>>;
  /** Kills the targets were made for ("For 3 kills"), when the paste says. */
  kills: number | null;
  skipped: string[];
}

const SCALE: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };

/** "61.3M" / "484K" / "6.05K" / "61,300,000" / "1,45M" → a number, or null. */
function parseAmount(token: string): number | null {
  const m = /^(\d[\d,.\s]*?)\s*([KMBT])?$/i.exec(token.trim());
  if (!m) return null;
  const num = m[1].trim();
  if (m[2]) {
    const v = Number(num.replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(v) ? Math.round(v * SCALE[m[2].toUpperCase()]) : null;
  }
  if (/^\d{1,3}(?:[,.\s]\d{3})+$/.test(num)) return Number(num.replace(/\D/g, ''));
  const v = Number(num.replace(',', '.'));
  return Number.isFinite(v) ? Math.round(v) : null;
}

/**
 * Parse the Ancient planner's "Points per member" table (Tools → Ancient
 * planner), pasted as copied:
 *
 *     For 3 kills, already lowered for a 15% overshoot.
 *     G9 	6 members 	61.3M 	368M 	19.2%
 *
 * The figure taken per tier is POINTS EACH — the first amount after the tier
 * once the member count and the share are set aside. Also reads plain
 * "G9 61.3M" lines and markdown rows.
 *
 * The planner is translated (lib/i18n.js), so the table can arrive as
 * "G9 · 6 miembros · 61.3M" or "Für 3 Kills, …": the member count is any
 * number followed by a word, and the kill count accepts the word each
 * dictionary uses for '{n} kills' — keep KILL_WORDS in step with them.
 */
const KILL_WORDS = 'kills?|muertes?|éliminations?|убийств[оа]?';
const KILLS_RE = new RegExp(`(?<![\\p{L}\\d.,])(\\d+)\\s+(?:${KILL_WORDS})(?!\\p{L})`, 'iu');

export function parseTierTargets(text: string): TierTargets {
  const tiers: TierTargets['tiers'] = {};
  const skipped: string[] = [];
  let kills: number | null = null;

  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.replace(/\|/g, ' ').trim();
    if (!line) continue;
    const k = KILLS_RE.exec(line);
    if (k) {
      kills = Number(k[1]);
      continue;
    }
    const t = /^(T9|G[1-9])\b(.*)$/i.exec(line);
    if (!t) continue; // headers and prose
    const rest = t[2]
      .replace(/(?<![\p{L}\d.,])\d+\s+\p{L}{2,}/u, ' ')
      .replace(/[\d.,]+\s*%/g, ' ');
    const amount = /(\d[\d,.]*(?:\s\d{3})*\s*[KMBT]?)(?![\w%])/i.exec(rest);
    const value = amount ? parseAmount(amount[1]) : null;
    if (value === null) {
      skipped.push(rawLine.trim());
      continue;
    }
    tiers[t[1].toLowerCase() as TargetTier] = value;
  }
  return { tiers, kills, skipped };
}

/**
 * Ranks absent between 1 and the highest one pasted. The in-game list is
 * contiguous, so a gap means the copy skipped rows — worth saying out loud,
 * because those players' points are simply missing from this summon.
 */
export function missingRanks(rows: TinmanRow[]): number[] {
  const seen = new Set(rows.map((r) => r.rank));
  const max = Math.max(0, ...seen);
  const out: number[] = [];
  for (let r = 1; r <= max; r++) if (!seen.has(r)) out.push(r);
  return out;
}

function isHeaderOrRule(line: string): boolean {
  if (/^[\s|:+=-]+$/.test(line)) return true; // | :--- | :--- |  /  -----
  const lower = line.toLowerCase();
  if (/\brank\b/.test(lower) && /\b(name|player)\b/.test(lower)) return true;
  // A row always carries points, so a line without a digit naming the columns is a header.
  return !/\d/.test(line) && /\b(rank|name|player|member|points?|score|damage)\b/.test(lower);
}

function validRank(rank: number): boolean {
  return rank >= 1 && rank <= MAX_RANK;
}

/** `[rank, name…, points]` or `[name, points]` cells → a row, or null. */
function rowFromCells(cells: string[], nextRank: number): TinmanRow | null {
  const filled = cells.filter((c) => c !== '');
  if (filled.length < 2) return null;
  const points = toPoints(filled[filled.length - 1]);
  if (points === null) return null;
  const rank = RANK_CELL.exec(filled[0]);
  if (filled.length >= 3 && rank) {
    const name = cleanName(filled.slice(1, -1).join(' '));
    return name && validRank(Number(rank[1])) ? { rank: Number(rank[1]), name, points } : null;
  }
  if (filled.length !== 2) return null;
  // "1. Fiin SK 2 | 63,965,364" — the rank shares the name's cell.
  const inName = RANK_IN_NAME.exec(filled[0]);
  if (inName && validRank(Number(inName[1] ?? inName[2]))) {
    const name = cleanName(inName[3]);
    if (name) return { rank: Number(inName[1] ?? inName[2]), name, points };
  }
  const name = cleanName(filled[0]);
  return name ? { rank: nextRank, name, points } : null;
}

/** `1. Fiin SK 2 63,965,364`, `Fiin SK 2: 63,965,364` → a row, or null. */
function rowFromPlainLine(line: string, nextRank: number): TinmanRow | null {
  const text = stripUnit(line);
  const plain = PLAIN_LINE.exec(text);
  if (plain) {
    const rank = Number(plain[1]);
    const name = cleanName(plain[2]);
    const points = toPoints(plain[3]);
    if (name && points !== null && validRank(rank)) return { rank, name, points };
  }
  const named = NAME_POINTS_LINE.exec(text);
  if (named) {
    const name = cleanName(named[1]);
    const points = toPoints(named[2]);
    if (name && points !== null) return { rank: nextRank, name, points };
  }
  return null;
}

export function parseTinmanStandings(text: string): TinmanParseResult {
  const rows: TinmanRow[] = [];
  const skipped: string[] = [];

  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = normalizeLine(rawLine);
    if (!line) continue;
    if (isHeaderOrRule(line)) continue;

    let cells: string[] | null = null;
    if (line.includes('|')) {
      cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    } else if (line.includes('\t')) {
      cells = line.split('\t').map((c) => c.trim());
    }

    const nextRank = rows.length + 1;
    const row = cells
      ? rowFromCells(cells, nextRank)
      : rowFromCells(delimitedCells(line) ?? [], nextRank) ?? rowFromPlainLine(line, nextRank);
    if (row) rows.push(row);
    else skipped.push(rawLine.trim());
  }

  return { rows: rows.map((r) => ({ ...r, name: realName(r.name, r.rank) })), skipped };
}
