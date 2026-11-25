/**
 * Parse the Rise of the Ancients per-tier targets an admin pastes from the
 * Ancient planner (Events → Ancients → Targets). The event rankings themselves
 * are read from the game (data/event-scores.ts); their paste parser went with
 * pasting (Nov 25 2026).
 *
 * Pure — no database — so tests can run it on its own.
 */

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
