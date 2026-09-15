import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createShareLink,
  listActiveShareLinks,
  resolveActiveShareLink,
  revokeShareLink,
  restoreShareLink,
  deleteShareLink,
  setShareLinkLabel,
  shareLinkTokenExists,
  getShareLink,
  recordVisit,
  recordApiHit,
  recordBeacon,
  listRecentRevoked,
  getShareLinkAnalytics,
} from '../../../src/data/repositories/share-link-repo.js';
import { deleteClan } from '../../../src/data/repositories/clan-repo.js';
import { createUser } from '../../../src/data/repositories/user-repo.js';
import { makeTestDb, seedTwoClans } from '../../helpers/test-db.js';

describe('share-link-repo (multi-link ledger, analytics, recovery)', () => {
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
    expect(shareLinkTokenExists('ZZZ999')).toBe(false);
    expect(resolveActiveShareLink('AAA111')?.id).toBe(link.id);
  });

  it('holds several live links for one clan, each counting separately', () => {
    const a = createShareLink(1, 'AAA111', 1, { label: 'Discord' });
    const b = createShareLink(1, 'bbb222', 1, { label: 'Forum', isVanity: true });

    expect(listActiveShareLinks(1).map((l) => l.token).sort()).toEqual(['AAA111', 'bbb222']);

    recordVisit(a.id);
    recordVisit(a.id);
    recordVisit(b.id);
    recordApiHit(b.id);

    const byId = new Map(listActiveShareLinks(1).map((l) => [l.id, l]));
    expect(byId.get(a.id)!.hitCount).toBe(2);
    expect(byId.get(a.id)!.apiHitCount).toBe(0);
    expect(byId.get(b.id)!.hitCount).toBe(1);
    expect(byId.get(b.id)!.apiHitCount).toBe(1);
    expect(byId.get(b.id)!.label).toBe('Forum');
    expect(byId.get(b.id)!.isVanity).toBe(true);

    // Each link's sparkline series is its own.
    const analytics = getShareLinkAnalytics(1);
    expect(analytics.links.length).toBe(2);
    const seriesA = analytics.links.find((l) => l.id === a.id)!.daily;
    expect(seriesA.reduce((s, d) => s + d.views, 0)).toBe(2);
  });

  it('resolves a vanity key case-insensitively but a generated token exactly', () => {
    createShareLink(1, 'family', 1, { isVanity: true });
    createShareLink(1, 'AbCd12', 1);

    expect(resolveActiveShareLink('family')?.token).toBe('family');
    expect(resolveActiveShareLink('FAMILY')?.token).toBe('family');
    expect(resolveActiveShareLink('Family')?.token).toBe('family');

    expect(resolveActiveShareLink('AbCd12')?.token).toBe('AbCd12');
    expect(resolveActiveShareLink('abcd12')).toBeNull();
  });

  it('treats a key as taken regardless of case, so a vanity cannot shadow a token', () => {
    createShareLink(1, 'AbCd12', 1);
    expect(shareLinkTokenExists('abcd12')).toBe(true);
    expect(shareLinkTokenExists('ABCD12')).toBe(true);
  });

  it('records beacon aggregates against the link they belong to', () => {
    const link = createShareLink(1, 'AAA111', 1);
    recordBeacon(link.id, { event: 'enter', isReturning: false }); // unique
    recordBeacon(link.id, { event: 'enter', isReturning: true }); // repeat
    recordBeacon(link.id, { event: 'leave', durationMs: 30000, changedTimeframe: true });
    recordBeacon(link.id, { event: 'leave', durationMs: 10000, changedTimeframe: false });

    const a = getShareLink(1, link.id)!;
    expect(a.uniqueVisits).toBe(1);
    expect(a.returnVisits).toBe(1);
    expect(a.durationSamples).toBe(2);
    expect(a.durationMsTotal).toBe(40000);
    expect(a.timeframeChanges).toBe(1);
  });

  it('ignores counters for a link id that does not exist', () => {
    expect(() => recordVisit(9999)).not.toThrow();
    expect(() => recordApiHit(9999)).not.toThrow();
    expect(() => recordBeacon(9999, { event: 'enter', isReturning: false })).not.toThrow();
  });

  it('revokes one link and leaves the clan’s others live', () => {
    const a = createShareLink(1, 'AAA111', 1);
    const b = createShareLink(1, 'BBB222', 1);

    expect(revokeShareLink(1, a.id, 'disabled', 1)).toBe(true);
    expect(listActiveShareLinks(1).map((l) => l.token)).toEqual(['BBB222']);
    expect(resolveActiveShareLink('AAA111')).toBeNull();
    expect(resolveActiveShareLink('BBB222')?.id).toBe(b.id);

    const revoked = listRecentRevoked(1);
    expect(revoked.length).toBe(1);
    expect(revoked[0].token).toBe('AAA111');
    expect(revoked[0].revokeReason).toBe('disabled');
  });

  it('refuses to revoke a link belonging to another clan', () => {
    const a = createShareLink(2, 'CCC333', 1);
    expect(revokeShareLink(1, a.id, 'disabled', 1)).toBe(false);
    expect(resolveActiveShareLink('CCC333')).not.toBeNull();
  });

  it('restores a revoked link without touching the live ones', () => {
    const a = createShareLink(1, 'AAA111', 1);
    createShareLink(1, 'BBB222', 1);
    revokeShareLink(1, a.id, 'disabled', 1);

    const res = restoreShareLink(1, a.id);
    expect(res.ok).toBe(true);
    expect(listActiveShareLinks(1).map((l) => l.token).sort()).toEqual(['AAA111', 'BBB222']);
    expect(listRecentRevoked(1)).toEqual([]);

    // Restoring an already-live link is a no-op refusal, not a silent success.
    expect(restoreShareLink(1, a.id).ok).toBe(false);
  });

  it('renames a link without disturbing its key', () => {
    const a = createShareLink(1, 'AAA111', 1);
    expect(setShareLinkLabel(1, a.id, '  Discord  ')).toBe(true);
    expect(getShareLink(1, a.id)!.label).toBe('Discord');
    expect(getShareLink(1, a.id)!.token).toBe('AAA111');
  });

  it('permanently deletes only a disabled link, and frees its key', () => {
    const a = createShareLink(1, 'family', 1, { isVanity: true });
    recordVisit(a.id); // seeds a share_link_daily row too

    // A live link cannot be deleted — disabling comes first.
    expect(deleteShareLink(1, a.id).ok).toBe(false);

    revokeShareLink(1, a.id, 'disabled', 1);
    expect(deleteShareLink(1, a.id).ok).toBe(true);
    expect(shareLinkTokenExists('family')).toBe(false);
    expect(listRecentRevoked(1)).toEqual([]);
  });

  it('keeps a revoked key claimed until it is deleted', () => {
    const a = createShareLink(1, 'family', 1, { isVanity: true });
    revokeShareLink(1, a.id, 'disabled', 1);
    // Still taken: the URL is recoverable, so handing the key to another clan
    // would silently repoint links people already hold.
    expect(shareLinkTokenExists('family')).toBe(true);
  });

  it('deleting a clan cascades its share-link ledger + daily rollup', () => {
    const link = createShareLink(2, 'DELME2', 1);
    recordVisit(link.id); // seeds a share_link_daily row too

    const res = deleteClan(2);
    expect(res.ok).toBe(true);
    // Both the ledger row and its daily rollup are gone (no FK violation).
    expect(shareLinkTokenExists('DELME2')).toBe(false);
    expect(getShareLinkAnalytics(2).links).toEqual([]);
  });
});
