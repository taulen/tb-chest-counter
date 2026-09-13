import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearClanNeedsReauth,
  getClanById,
  markClanNeedsReauth,
} from '../../../src/data/repositories/clan-repo.js';
import { makeTestDb, seedTwoClans } from '../../helpers/test-db.js';

/**
 * The needs-reauth flag drives the Clans page badge and a Discord alert, and
 * it used to be a one-way door: only the login bridge writing a fresh
 * storage-state could clear it. So one transient failure — a game canvas that
 * timed out because the container was under memory pressure, not because the
 * cookies had expired — pinned a clan to "Needs re-authentication" forever,
 * while every scan afterwards signed in perfectly well and said nothing. The
 * badge's own tooltip claimed to mean "the most recent scan was able to load
 * the game", which nothing enforced.
 *
 * The auth-check phase now clears it on every verified session, so these tests
 * pin down the transition reporting that makes the one-shot Discord notices on
 * both edges work.
 */
describe('clan needs-reauth flag', () => {
  let cleanup: () => void;
  let clanA: number;
  let clanB: number;

  beforeEach(() => {
    ({ cleanup } = makeTestDb());
    ({ clanIdA: clanA, clanIdB: clanB } = seedTwoClans());
  });

  afterEach(() => cleanup());

  it('starts clear', () => {
    expect(getClanById(clanA)?.needsReauth).toBe(false);
  });

  it('reports firstTime only on the 0 → 1 transition', () => {
    expect(markClanNeedsReauth(clanA).firstTime).toBe(true);
    expect(markClanNeedsReauth(clanA).firstTime).toBe(false);
    expect(markClanNeedsReauth(clanA).firstTime).toBe(false);
    expect(getClanById(clanA)?.needsReauth).toBe(true);
  });

  it('reports recovered only on the 1 → 0 transition', () => {
    markClanNeedsReauth(clanA);

    expect(clearClanNeedsReauth(clanA).recovered).toBe(true);
    // A healthy clan scanning every cycle must not re-announce a recovery.
    expect(clearClanNeedsReauth(clanA).recovered).toBe(false);
    expect(clearClanNeedsReauth(clanA).recovered).toBe(false);
    expect(getClanById(clanA)?.needsReauth).toBe(false);
  });

  it('is clearable without a prior mark, and stays quiet about it', () => {
    // The overwhelmingly common case: the auth check succeeds on a clan that
    // was never flagged. Must be a no-op, not a recovery.
    expect(clearClanNeedsReauth(clanA).recovered).toBe(false);
    expect(getClanById(clanA)?.needsReauth).toBe(false);
  });

  it('re-arms the alert after a recovery, so a later failure notifies again', () => {
    markClanNeedsReauth(clanA);
    clearClanNeedsReauth(clanA);

    // This is the regression that matters for the Discord notice: if clearing
    // left the flag set, the next genuine expiry would be silent.
    expect(markClanNeedsReauth(clanA).firstTime).toBe(true);
  });

  it('records when the failure happened and drops it on recovery', () => {
    markClanNeedsReauth(clanA);
    const flagged = getClanById(clanA);
    expect(flagged?.reauthFailedAt).not.toBe('');
    expect(Number.isNaN(Date.parse(flagged!.reauthFailedAt))).toBe(false);

    clearClanNeedsReauth(clanA);
    expect(getClanById(clanA)?.reauthFailedAt).toBe('');
  });

  it('never touches another clan', () => {
    markClanNeedsReauth(clanA);
    markClanNeedsReauth(clanB);

    clearClanNeedsReauth(clanA);

    expect(getClanById(clanA)?.needsReauth).toBe(false);
    expect(getClanById(clanB)?.needsReauth).toBe(true);
  });
});
