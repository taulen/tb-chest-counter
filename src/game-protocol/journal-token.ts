/**
 * The journal token: the game login reply (203) carries a JWT for the
 * battle-report service (journal.ts), recognised by `"aud": "Journal"` in its
 * payload — at index 16 of the reply root on Nov 27 2026, found by audience so
 * a reshuffled reply doesn't lose it. Kept apart from journal.ts so the game
 * client can read it without importing the socket code.
 */
import type { Wire } from './codec.js';

export interface JournalTokenPayload {
  aud?: string;
  /** Unix seconds it stops working (~36 days after the login). */
  exp?: number;
  /** The player's id (realm × 2³² + player number), as a string. */
  name?: string;
}

/** The token's payload, or null when it isn't a readable JWT. */
export function journalTokenPayload(token: string): JournalTokenPayload | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const b64 = decodeURIComponent(part).replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as unknown;
    return json && typeof json === 'object' && !Array.isArray(json) ? (json as JournalTokenPayload) : null;
  } catch {
    return null;
  }
}

/** The journal token in a login reply's root: the string that is a JWT for the "Journal" audience. */
export function findJournalToken(root: Wire): string | null {
  if (!Array.isArray(root)) return null;
  for (const v of root) {
    if (typeof v === 'string' && v.startsWith('eyJ') && v.split('.').length === 3 && journalTokenPayload(v)?.aud === 'Journal') return v;
  }
  return null;
}

/** Unix seconds when the token stops working, or null when it doesn't say. */
export function journalTokenExpiry(token: string): number | null {
  const exp = journalTokenPayload(token)?.exp;
  return typeof exp === 'number' ? exp : null;
}
