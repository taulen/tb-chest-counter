import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createShareLink,
  revokeActiveShareLink,
  getActiveShareLink,
  shareLinkTokenExists,
  recordVisit,
  recordApiHit,
  recordBeacon,
  listRecentRevoked,
  getShareLinkAnalytics,
  recoverShareLink,
} from '../../../src/data/repositories/share-link-repo.js';
import {
  getClanById,
  setClanPublicShareToken,
  deleteClan,
} from '../../../src/data/repositories/clan-repo.js';
import { createUser } from '../../../src/data/repositories/user-repo.js';
import { makeTestDb, seedTwoClans } from '../../helpers/test-db.js';

describe('share-link-repo (usage ledger, analytics, recovery)', () => {
  let cleanup: () => void;

  beforeEach(() => {
    const t = makeTestDb();
    cleanup = t.cleanup;
    seedTwoClans();
    // share_links.created_by FK-references users(id); the first insert into a
    // fresh DB gets id 1, which the createShareLink calls below reference.
    createUser('tester', 'irrelevant-pw-1234', 'admin');
  });

  afterEach(() => cleanup());

  it('creates an active link and reports its token as taken', () => {
    const link = createShareLink(1, 'AAA111', 1);
    expect(link.token).toBe('AAA111');
    expect(link.revokedAt).toBeNull();
    expect(shareLinkTokenExists('AAA111')).toBe(true);
    expect(getActiveShareLink(1)?.token).toBe('AAA111');
  });

  it('records page visits (hit + daily rollup) and API hits', () => {
    createShareLink(1, 'AAA111', 1);
    recordVisit('AAA111');
    recordVisit('AAA111');
    recordApiHit('AAA111');

    const active = getActiveShareLink(1)!;
    expect(active.hitCount).toBe(2);
    expect(active.apiHitCount).toBe(1);
    expect(active.lastUsedAt).toBeTruthy();

    const analytics = getShareLinkAnalytics(1);
    const totalDaily = analytics.daily.reduce((s, d) => s + d.views, 0);
    expect(totalDaily).toBe(2);
  });

  it('recording usage against an unknown token is a silent no-op', () => {
    expect(() => recordVisit('NOPE00')).not.toThrow();
    expect(() => recordApiHit('NOPE00')).not.toThrow();
    expect(() => recordBeacon('NOPE00', { event: 'enter', isReturning: false })).not.toThrow();
  });

  it('folds analytics beacons into the aggregate counters', () => {
    createShareLink(1, 'AAA111', 1);
    recordBeacon('AAA111', { event: 'enter', isReturning: false }); // unique
    recordBeacon('AAA111', { event: 'enter', isReturning: true }); // repeat
    recordBeacon('AAA111', { event: 'leave', durationMs: 30000, changedTimeframe: true });
    recordBeacon('AAA111', { event: 'leave', durationMs: 10000, changedTimeframe: false });

    const a = getActiveShareLink(1)!;
    expect(a.uniqueVisits).toBe(1);
    expect(a.returnVisits).toBe(1);
    expect(a.durationSamples).toBe(2);
    expect(a.durationMsTotal).toBe(40000);
    expect(a.timeframeChanges).toBe(1);
  });

  it('revokes the active link and surfaces it under recent revoked', () => {
    createShareLink(1, 'AAA111', 1);
    setClanPublicShareToken(1, 'AAA111');
    revokeActiveShareLink(1, 'disabled', 1);

    expect(getActiveShareLink(1)).toBeNull();
    const revoked = listRecentRevoked(1);
    expect(revoked.length).toBe(1);
    expect(revoked[0].token).toBe('AAA111');
    expect(revoked[0].revokeReason).toBe('disabled');
  });

  it('recovers a disabled link, restoring it as active and mirroring the clans column', () => {
    createShareLink(1, 'AAA111', 1);
    setClanPublicShareToken(1, 'AAA111');
    revokeActiveShareLink(1, 'disabled', 1);
    setClanPublicShareToken(1, '');

    const revokedId = listRecentRevoked(1)[0].id;
    const res = recoverShareLink(1, revokedId);
    expect(res.ok).toBe(true);
    expect(getActiveShareLink(1)?.token).toBe('AAA111');
    expect(getClanById(1)?.publicShareToken).toBe('AAA111');
  });

  it('recovering swaps out whatever link is currently active', () => {
    // An old link, later disabled.
    createShareLink(1, 'OLD111', 1);
    setClanPublicShareToken(1, 'OLD111');
    revokeActiveShareLink(1, 'disabled', 1);
    setClanPublicShareToken(1, '');
    const oldId = listRecentRevoked(1)[0].id;

    // A newer active link.
    createShareLink(1, 'NEW222', 1);
    setClanPublicShareToken(1, 'NEW222');

    const res = recoverShareLink(1, oldId);
    expect(res.ok).toBe(true);
    expect(getActiveShareLink(1)?.token).toBe('OLD111');
    expect(getClanById(1)?.publicShareToken).toBe('OLD111');
    // The previously-active NEW222 is now revoked (reason 'swapped').
    const revokedTokens = listRecentRevoked(1, 5).map((r) => r.token);
    expect(revokedTokens).toContain('NEW222');
  });

  it('refuses to recover a token that is now live on another clan', () => {
    createShareLink(1, 'DUP111', 1);
    setClanPublicShareToken(1, 'DUP111');
    revokeActiveShareLink(1, 'disabled', 1);
    setClanPublicShareToken(1, '');
    // Another clan somehow holds the same token live.
    setClanPublicShareToken(2, 'DUP111');

    const revokedId = listRecentRevoked(1)[0].id;
    const res = recoverShareLink(1, revokedId);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/elsewhere/i);
  });

  it('deleting a clan cascades its share-link ledger + daily rollup', () => {
    createShareLink(2, 'DELME2', 1);
    recordVisit('DELME2'); // seeds a share_link_daily row too

    const res = deleteClan(2);
    expect(res.ok).toBe(true);
    // Both the ledger row and its daily rollup are gone (no FK violation).
    expect(shareLinkTokenExists('DELME2')).toBe(false);
    expect(getShareLinkAnalytics(2).active).toBeNull();
  });
});
