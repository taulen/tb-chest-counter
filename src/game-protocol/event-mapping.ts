/**
 * Which of the site's events (EVENT_CATALOG) a game event is: by its English
 * title against the catalog's in-game names (`calendarNames`, the names the
 * tbclanportal feed uses — "Rise of the Ancients", "Trials of Olympus",
 * "Ragnarök", "Dark Omens") and the catalog name. No per-event code: an event
 * the catalog doesn't know stays unmapped and is shown under the game's own
 * title.
 *
 * Olympus' five stages are game events of their own ("Trial of the Chimera" …
 * "Trial of Briareus", game-protocol/olympus.ts) and map onto olympus too —
 * they are its days.
 */
import { EVENT_CATALOG } from '../config/event-catalog.js';
import { OLYMPUS_STAGES } from './olympus.js';

/** Case-, accent- and spacing-insensitive form of a title. */
export function normalizeEventTitle(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

let index: Map<string, string> | null = null;
function titleIndex(): Map<string, string> {
  if (index) return index;
  index = new Map();
  for (const e of EVENT_CATALOG) {
    for (const n of [...(e.calendarNames ?? []), e.name]) {
      const k = normalizeEventTitle(n);
      if (k && !index.has(k)) index.set(k, e.key);
    }
  }
  for (const s of OLYMPUS_STAGES) index.set(normalizeEventTitle(s.title), 'olympus');
  return index;
}

/** The catalog key for a game event title, or null when the site has no tab for it. */
export function catalogKeyForEventTitle(title: string): string | null {
  if (!title) return null;
  return titleIndex().get(normalizeEventTitle(title)) ?? null;
}

let stageIndex: Map<string, number> | null = null;

/** The day of an Olympus run a game event title is the stage of, or null when it is no Olympus stage. */
export function olympusStageDay(title: string): number | null {
  if (!title) return null;
  stageIndex ??= new Map(OLYMPUS_STAGES.map((s) => [normalizeEventTitle(s.title), s.day]));
  return stageIndex.get(normalizeEventTitle(title)) ?? null;
}
