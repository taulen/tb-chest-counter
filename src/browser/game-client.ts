import type { Page } from 'playwright';
import { withDeadline } from '../utils/deadline.js';

/**
 * Which Total Battle web client a page is running.
 *
 * totalbattle.com serves two clients, "classic" and "new", chosen per game
 * ACCOUNT, and the site's HTML header above the game canvas offers a link to
 * whichever one is not running. Every calibrated click position was taken on
 * the classic client, and the new one lays the screen out differently: the
 * CLAN click opens nothing and the Gifts click lands on a city building.
 *
 * 2026-11-04: clan #2's account was switched to the new client (by a human
 * logging in, not by us). Every scan for that clan then failed navigation for
 * ~5h, and nothing in the log or on the Sessions page said why. Both clicks
 * reported hitting the game canvas, which reads as "game ignored us", not
 * "different game". The only tell was the header text in the full-page OCR.
 */
export type GameClient = 'classic' | 'new' | 'unknown';

/** Classify from the page's visible text. The link names the OTHER client. */
export function classifyGameClient(pageText: string): GameClient {
  if (/switch\s+to\s+classic\s+version/i.test(pageText)) return 'new';
  if (/switch\s+to\s+new\s+version/i.test(pageText)) return 'classic';
  // Another site language, or a header we have not seen. Say nothing rather
  // than guess: this only ever feeds an explanation, never a decision.
  return 'unknown';
}

const CLIENT_PROBE_DEADLINE_MS = 5_000;

/**
 * Read the client off the page DOM. The header is plain HTML in the main frame
 * (the same document `getCanvasBounds` finds the game canvas in), so this is a
 * text read, not OCR. `innerText` rather than `textContent`, so a link the
 * site renders but hides cannot answer for the visible one.
 *
 * Deadlined like every page.evaluate (a wedged renderer never answers), and
 * any failure is 'unknown' — this runs on a path that is already failing.
 */
export async function detectGameClient(page: Page): Promise<GameClient> {
  const text = await withDeadline(
    page.evaluate(() => document.body?.innerText ?? ''),
    CLIENT_PROBE_DEADLINE_MS,
    'game client probe',
  ).catch(() => '');
  return classifyGameClient(text);
}

/** The failure line for a navigation that could not reach the Gifts tab. */
export function describeNavFailure(client: GameClient): string {
  const base = 'Could not verify Gifts tab after 3 attempts';
  if (client !== 'new') return base;
  return `${base}. This clan's game account is on Total Battle's NEW client `
    + '(the game page offers "Switch to classic version"), and the scanner\'s click '
    + 'positions are calibrated on the classic client. Log in to the account and '
    + 'switch it back to the classic version.';
}
