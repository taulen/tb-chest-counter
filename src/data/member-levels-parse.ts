/**
 * Parse player levels posted in the in-game chat, one player per line:
 *
 *     taulen: G8/M8/S7/E8/C35/D284
 *     Dark Knight: G7.M8.S7.E7.C30.D199
 *     Ironhide: g8 m8 s 7 e 8 c35 d238
 *     Dardaen: g8 m8 s7 e6, g8m8s7e6d250
 *     IamNotHades: g8/m7/s7/e7/dragon 250/c25
 *
 * The name is everything before the first ":" (after an optional chat
 * timestamp and the "[SIK]" clan tag a line copied from the game carries). After it, each letter G M S E C D — or the word "dragon" —
 * followed by a number is one level; separators, case and stray marks
 * ("C30*", "S8(only 1 unlocked)") don't matter. The LAST value of a letter on a
 * line wins ("D234, D 246*" → 246), and a player posting twice is merged
 * field by field, later lines winning — chat runs top to bottom.
 *
 * Anything that isn't a letter-and-number in range is ignored rather than
 * guessed at: "E -12", "EK- Updated", "C/", a bare "/215".
 *
 * Pure — no database — so tests can run it on its own.
 */
import { despace } from '../vision/ocr-normalize.js';

export const LEVEL_KEYS = ['g', 'm', 's', 'e', 'c', 'd'] as const;
export type LevelKey = (typeof LEVEL_KEYS)[number];
export type Levels = Partial<Record<LevelKey, number>>;

/** Highest believable value per letter; anything above is a misread. */
export const LEVEL_MAX: Record<LevelKey, number> = { g: 10, m: 10, s: 10, e: 10, c: 60, d: 500 };

export interface LevelReportLine {
  name: string;
  levels: Levels;
  /** The chat line(s) it came from, as pasted. */
  raw: string;
}

export interface LevelParseResult {
  players: LevelReportLine[];
  /** Non-blank lines with no "name:" or no readable level. */
  skipped: string[];
}

const TIMESTAMP = /^\[?\d{1,2}:\d{2}(?::\d{2})?\]?\s*/;
/** The clan tag a line copied from the in-game chat starts with: "[SIK] Patdaddy: …". */
const CLAN_TAG = /^\[[^\]\s:][^\]:]{0,11}\]\s*/;
const TOKEN = /(dragon|[gmsecd])\s*[:=.]?\s*(\d{1,3})(?!\d)/gi;

export function parseLevelReports(text: string): LevelParseResult {
  const byKey = new Map<string, LevelReportLine>();
  const skipped: string[] = [];

  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const body = line.replace(TIMESTAMP, '').replace(CLAN_TAG, '');
    const colon = body.indexOf(':');
    if (colon <= 0) {
      skipped.push(line);
      continue;
    }
    const name = body.slice(0, colon).replace(/\s+/g, ' ').trim();
    const rest = body.slice(colon + 1);

    const levels: Levels = {};
    for (const m of rest.matchAll(TOKEN)) {
      const key = (m[1].toLowerCase() === 'dragon' ? 'd' : m[1].toLowerCase()) as LevelKey;
      const value = Number(m[2]);
      if (value >= 1 && value <= LEVEL_MAX[key]) levels[key] = value;
    }
    if (!name || Object.keys(levels).length === 0) {
      skipped.push(line);
      continue;
    }

    const key = despace(name) || name.toLowerCase();
    const prev = byKey.get(key);
    if (prev) {
      prev.levels = { ...prev.levels, ...levels };
      prev.raw = `${prev.raw}\n${line}`;
    } else {
      byKey.set(key, { name, levels, raw: line });
    }
  }
  return { players: [...byKey.values()], skipped };
}
