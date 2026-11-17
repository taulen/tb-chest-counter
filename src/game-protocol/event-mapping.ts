/**
 * Which of the site's events (EVENT_CATALOG) a game event is: by its English
 * title against the catalog's in-game names (`calendarNames`, the names the
 * tbclanportal feed uses — "Rise of the Ancients", "Trials of Olympus",
 * "Ragnarök", "Dark Omens") and the catalog name. No per-event code: an event
 * the catalog doesn't know stays unmapped and is shown under the game's own
 * title.
 */
import { EVENT_CATALOG } from '../config/event-catalog.js';

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
  return index;
}

/** The catalog key for a game event title, or null when the site has no tab for it. */
export function catalogKeyForEventTitle(title: string): string | null {
  if (!title) return null;
  return titleIndex().get(normalizeEventTitle(title)) ?? null;
}
