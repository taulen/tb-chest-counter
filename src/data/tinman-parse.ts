/**
 * Parse a pasted Rise of the Ancients ranking into rows.
 *
 * Accepts what people actually paste: a markdown table (`| 1 | Fiin SK 2 |
 * 63,965,364 |`), tab-separated columns from a spreadsheet, or plain lines
 * (`1. Fiin SK 2  63,965,364`). Header and separator lines are skipped, and
 * anything else that doesn't read as a row is reported back rather than dropped
 * silently.
 *
 * Points may use `,` `.` `'` or spaces as thousands separators. A space only
 * counts as one between full groups of three digits, so a name ending in a
 * number stays intact: in `98 STRUGGLE 1 0` the name is "STRUGGLE 1" and the
 * points are 0.
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

/** Points with optional thousands grouping: 63,965,364 / 63.965.364 / 63 965 364 / 0. */
const POINTS = String.raw`(\d{1,3}(?:[,.'   ]\d{3})+|\d+)`;

const PLAIN_LINE = new RegExp(String.raw`^#?(\d{1,4})[.):]?\s+(.+?)\s+${POINTS}$`);
const NAME_POINTS_LINE = new RegExp(String.raw`^(.+?)\s+${POINTS}$`);
const POINTS_ONLY = new RegExp(String.raw`^${POINTS}$`);

function toPoints(s: string): number | null {
  const t = s.trim();
  if (!POINTS_ONLY.test(t)) return null;
  const n = Number(t.replace(/\D/g, ''));
  return Number.isSafeInteger(n) ? n : null;
}

function cleanName(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
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

function isHeaderOrRule(cells: string[], line: string): boolean {
  if (/^[\s|:+-]+$/.test(line)) return true; // | :--- | :--- |
  const joined = cells.join(' ').toLowerCase();
  return /\brank\b/.test(joined) && /\b(name|player)\b/.test(joined);
}

export function parseTinmanStandings(text: string): TinmanParseResult {
  const rows: TinmanRow[] = [];
  const skipped: string[] = [];

  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    let cells: string[] | null = null;
    if (line.includes('|')) {
      cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    } else if (line.includes('\t')) {
      cells = line.split('\t').map((c) => c.trim());
    }

    if (cells) {
      if (isHeaderOrRule(cells, line)) continue;
      const filled = cells.filter((c) => c !== '');
      const last = filled.length ? toPoints(filled[filled.length - 1]) : null;
      if (filled.length >= 3 && /^\d{1,4}$/.test(filled[0]) && last !== null) {
        const name = cleanName(filled.slice(1, -1).join(' '));
        const rank = Number(filled[0]);
        if (name && rank >= 1 && rank <= MAX_RANK) {
          rows.push({ rank, name, points: last });
          continue;
        }
      }
      if (filled.length === 2 && last !== null) {
        const name = cleanName(filled[0]);
        if (name) {
          rows.push({ rank: rows.length + 1, name, points: last });
          continue;
        }
      }
      skipped.push(line);
      continue;
    }

    if (isHeaderOrRule([line], line)) continue;
    const plain = PLAIN_LINE.exec(line);
    if (plain) {
      const rank = Number(plain[1]);
      const name = cleanName(plain[2]);
      const points = toPoints(plain[3]);
      if (name && points !== null && rank >= 1 && rank <= MAX_RANK) {
        rows.push({ rank, name, points });
        continue;
      }
    }
    const named = NAME_POINTS_LINE.exec(line);
    if (named) {
      const name = cleanName(named[1]);
      const points = toPoints(named[2]);
      if (name && points !== null) {
        rows.push({ rank: rows.length + 1, name, points });
        continue;
      }
    }
    skipped.push(line);
  }

  return { rows: rows.map((r) => ({ ...r, name: realName(r.name, r.rank) })), skipped };
}
