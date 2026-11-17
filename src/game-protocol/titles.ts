/**
 * A player's titles — "Prefect" from the Loyalty Bonus, a tournament's
 * "Blademaster", Premium's "Great Marshal" — the small round icons the game
 * shows beside a player. Most run out a set time after they were received.
 *
 * Nothing new is requested: two replies the scan already reads carry the same
 * entries (the client metadata names both shapes):
 *
 *   402 player record, every scan   [19] Titles: `[[titleId, assignedAt], …]`
 *                                   [20] TitleHistory: `[[titleId, count], …]`
 *                                        — how often each title was received
 *                                        (UserTitlePair), held or not
 *   601 city, once a game day        [21] Titles: `{titleId: [titleId,
 *                                        eventId, assignedAt]}` (AtomTitleDyn:
 *                                        TitleId, EventId, TimeAssigned) — in
 *                                        every archived city reply too
 *
 * `assignedAt` (unix s) is when the player received it; the title's end is
 * that plus its T29 `timeActive` (names.json `titles`, static-data.ts). The
 * server drops a title once it has run out: none of prod's 517 archived city
 * replies held an expired one (Nov 2026). `timeActive` 0 = no set end (the
 * kingdom's palace titles, Premium's three).
 */
import type { Wire } from './codec.js';
import type { GameNames, GameTitle } from './static-data.js';

/** One title a read showed a player holding. */
export interface HeldTitle {
  /** T29 id. */
  titleId: number;
  /** When the player received it (unix s). */
  assignedAt: number;
  /** City field 21 only: the game's EventId for the grant (0 in a Seasonal Kingdom); null from the player record. */
  eventId: number | null;
}

const isInt = (v: Wire | undefined): v is number => typeof v === 'number' && Number.isInteger(v);

/**
 * 402 field 19 → the titles held, or null when the field is not a list (an
 * unknown reply shape is not "holds nothing").
 */
export function parsePlayerTitles(v: Wire | undefined): HeldTitle[] | null {
  if (!Array.isArray(v)) return null;
  const out: HeldTitle[] = [];
  for (const e of v) {
    if (!Array.isArray(e) || !isInt(e[0]) || !isInt(e[1]) || e[0] <= 0) continue;
    out.push({ titleId: e[0], assignedAt: e[1], eventId: null });
  }
  return out;
}

/** 402 field 20 → title id → how many times the player received it; null when not a list. */
export function parseTitleCounts(v: Wire | undefined): Record<string, number> | null {
  if (!Array.isArray(v)) return null;
  const out: Record<string, number> = {};
  for (const e of v) {
    if (!Array.isArray(e) || !isInt(e[0]) || !isInt(e[1]) || e[0] <= 0 || e[1] <= 0) continue;
    out[String(e[0])] = e[1];
  }
  return out;
}

/**
 * City field 21 → the titles held, or null when the field is not a map. A map
 * with non-scalar keys arrives as `$pairs` (codec.ts); its values are read the
 * same way.
 */
export function parseCityTitles(v: Wire | undefined): HeldTitle[] | null {
  if (!v || typeof v !== 'object' || Array.isArray(v) || '$bin' in v) return null;
  const values: Wire[] = '$pairs' in v && Array.isArray(v.$pairs)
    ? (v.$pairs as Array<[Wire, Wire]>).map(([, x]) => x)
    : Object.values(v as Record<string, Wire>);
  const out: HeldTitle[] = [];
  for (const e of values) {
    if (!Array.isArray(e) || !isInt(e[0]) || !isInt(e[2]) || e[0] <= 0) continue;
    out.push({ titleId: e[0], assignedAt: e[2], eventId: isInt(e[1]) ? e[1] : null });
  }
  return out;
}

/** A held title as the profile shows it. */
export interface TitleView {
  titleId: number;
  /** The game's English texts (tGame translates them); `#id` when the static data lacks the title. */
  name: string;
  /** Bonus lines, the game's own line breaks. */
  description: string;
  /** "Received from the Loyalty Bonus"; '' when the game names none. */
  source: string;
  /** How long it lasts from when it was received (seconds); 0 = no set end. */
  seconds: number;
  /** ISO times: received, and when it runs out (null = no set end). */
  receivedAt: string;
  endsAt: string | null;
  /** How many times the player received it in all (402 field 20); null when unknown. */
  times: number | null;
  firstSeen: string;
  /** The round icon and the bigger picture, null until the art is extracted. */
  iconUrl: string | null;
  artUrl: string | null;
}

/**
 * The titles to show, from what is stored: only those still running at
 * `nowSec` (a title not read since it ran out — its player left the clan — is
 * over all the same), newest received first.
 */
export function titleViews(
  names: Pick<GameNames, 'titles'> | null,
  held: Array<{ titleId: number; assignedAt: number; firstSeen: string; times?: number | null }>,
  nowSec: number,
  urls: { icon: (titleId: number) => string | null; art: (titleId: number) => string | null },
): TitleView[] {
  const out: TitleView[] = [];
  for (const h of held) {
    const t: GameTitle | undefined = names?.titles?.[String(h.titleId)];
    const seconds = t?.seconds ?? 0;
    const end = seconds > 0 ? h.assignedAt + seconds : null;
    if (end !== null && end <= nowSec) continue;
    out.push({
      titleId: h.titleId,
      name: t?.name || `#${h.titleId}`,
      description: t?.description ?? '',
      source: t?.source ?? '',
      seconds,
      receivedAt: new Date(h.assignedAt * 1000).toISOString(),
      endsAt: end === null ? null : new Date(end * 1000).toISOString(),
      times: h.times ?? null,
      firstSeen: h.firstSeen,
      iconUrl: urls.icon(h.titleId),
      artUrl: urls.art(h.titleId),
    });
  }
  return out.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt) || a.titleId - b.titleId);
}
