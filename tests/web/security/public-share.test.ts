// Security coverage for the PUBLIC share surface — the only endpoints
// reachable with NO session. Mirrors how server.ts wires them:
//   app.use('/api/public', createPublicShareApiRouter())
//   app.use(publicShareTokenHandler)          // top-level token page
// Both are mounted AHEAD of requireAuth, so anyone with the URL hits
// them. This file locks down the guarantees the audit relied on:
//   1. every route validates the share key and resolves it through the
//      share_links ledger to exactly one clan; a bad/absent/revoked key is
//      404 (never a default clan). A clan may hold several live keys.
//   2. the acting clan is pinned by the TOKEN, never by client input — a
//      ?clanId query can't pivot to another clan's data.
//   3. only safe read-only aggregates are exposed; no secrets/PII.
//   4. the external snapshot detail route refuses cross-clan ids.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';

import {
  createPublicShareApiRouter,
  publicShareTokenHandler,
} from '../../../src/web/routes/public-share.js';
import { setClanChestTrackerSettings } from '../../../src/data/repositories/clan-repo.js';
import {
  createShareLink,
  revokeShareLink,
  getShareLink,
} from '../../../src/data/repositories/share-link-repo.js';
import { insertSnapshot } from '../../../src/data/repositories/external-repo.js';
import { makeTestDb, seedTwoClans, seedChestData } from '../../helpers/test-db.js';

const TOKEN_A = 'aAaA11'; // clan 1 — a generated token, case-sensitive
const VANITY_A = 'family'; // clan 1's second live link, an admin-chosen key
let linkIdA = 0;
const CODE_A = 'CTCODEA';
const CODE_B = 'CTCODEB';

function seedSnapshot(clanId: number, shareCode: string, playerName: string): number {
  return insertSnapshot({
    clanId,
    fetchedAt: '2026-07-10T18:00:00.000Z',
    shareCode,
    windowStart: '2026-07-04T17:00:00.000Z',
    windowEnd: '2026-07-11T17:00:00.000Z',
    durationDays: 7,
    trigger: 'scheduled',
    etag: null,
    settingsJson: null,
    players: [{ name: playerName, guardsLevel: 0, points: 100, chests: 5, categories: {} }],
    definitions: [],
  });
}

describe('public share surface (anonymous, token-gated)', () => {
  let app: express.Express;
  let cleanup: () => void;

  beforeEach(() => {
    const t = makeTestDb();
    cleanup = t.cleanup;
    seedTwoClans();
    // Distinct members per clan so we can prove the leaderboard is scoped
    // to the token's clan (Alice/Bob exist in both, but points differ by
    // clan and clan 2's rows must never surface through clan 1's token).
    seedChestData(1);
    seedChestData(2);
    // Only clan 1 gets public share links; clan 2 stays private. It holds
    // two at once, which is the point: both must resolve to the same clan.
    linkIdA = createShareLink(1, TOKEN_A, null).id;
    createShareLink(1, VANITY_A, null, { isVanity: true });

    app = express();
    app.use(express.json());
    app.use('/api/public', createPublicShareApiRouter());
    app.use(publicShareTokenHandler);
    // Stand-in for "everything else" so a non-token path has somewhere to
    // fall through to (proves publicShareTokenHandler calls next()).
    app.use((_req, res) => res.status(418).send('fell-through'));
  });

  afterEach(() => cleanup());

  // ── token validation ────────────────────────────────────────────
  describe('token validation', () => {
    const API_ROUTES = [
      '/api/public/__TOK__/clan',
      '/api/public/__TOK__/leaderboard',
      '/api/public/__TOK__/external/latest',
      '/api/public/__TOK__/external/snapshots',
    ];

    it('valid token resolves for /clan and /leaderboard', async () => {
      expect((await request(app).get('/api/public/aAaA11/clan')).status).toBe(200);
      expect((await request(app).get('/api/public/aAaA11/leaderboard')).status).toBe(200);
    });

    it('unassigned but well-formed token → 404 on every API route', async () => {
      for (const tmpl of API_ROUTES) {
        const path = tmpl.replace('__TOK__', 'ZZ9zz9'); // valid format, nobody owns it
        const r = await request(app).get(path);
        expect(r.status, `${path} → ${r.status}`).toBe(404);
      }
    });

    it('malformed token (wrong length / chars) never resolves', async () => {
      // Too long and with symbols — fails SHARE_TOKEN_REGEX, so resolveShare
      // returns null before any DB hit.
      for (const bad of ['waytoolongkey', 'ab_12$', 'ab']) {
        const r = await request(app).get(`/api/public/${bad}/clan`);
        expect([400, 404], `${bad} → ${r.status}`).toContain(r.status);
      }
    });

    it('revoking one link stops it resolving and leaves the other live', async () => {
      revokeShareLink(1, linkIdA, 'disabled', null);
      expect((await request(app).get('/api/public/aAaA11/clan')).status).toBe(404);
      expect((await request(app).get(`/api/public/${VANITY_A}/clan`)).status).toBe(200);
    });

    it('a vanity key resolves in any case; a generated token only exactly', async () => {
      expect((await request(app).get('/api/public/FAMILY/clan')).status).toBe(200);
      expect((await request(app).get('/api/public/Family/clan')).status).toBe(200);
      // Lower-casing a generated token must NOT resolve — its 62^6 entropy
      // lives in the case, and a case-fold would throw most of it away.
      expect((await request(app).get('/api/public/aaaa11/clan')).status).toBe(404);
    });

    it('a reserved path is never claimed as a share key', async () => {
      // publicShareTokenHandler sits ahead of the whole routing table, so a
      // segment the app owns has to fall through rather than 404 as a bad key.
      const r = await request(app).get('/login');
      expect(r.status).toBe(418); // hit the fall-through sentinel
    });

    it('token page: valid → 200 HTML, bad → 404 HTML, non-token path falls through', async () => {
      const ok = await request(app).get('/aAaA11');
      expect(ok.status).toBe(200);
      expect(ok.text).toContain('<!DOCTYPE html>');
      expect(ok.headers['x-robots-tag']).toContain('noindex');

      const bad = await request(app).get('/ZZ9zz9'); // valid format, unowned
      expect(bad.status).toBe(404);

      const vanity = await request(app).get(`/${VANITY_A}`);
      expect(vanity.status).toBe(200);

      const notToken = await request(app).get('/some/deeper/path');
      expect(notToken.status).toBe(418); // hit the fall-through sentinel
    });
  });

  // ── analytics beacon: fire-and-forget, no leak, not an API hit ───
  describe('analytics beacon', () => {
    it('always 204s and never leaks whether the token is valid', async () => {
      const ok = await request(app)
        .post('/api/public/aAaA11/beacon')
        .send({ event: 'enter', isReturning: false });
      expect(ok.status).toBe(204);
      // Unowned but well-formed token → same 204, so probing can't tell
      // a live link from a dead one.
      const unowned = await request(app)
        .post('/api/public/ZZ9zz9/beacon')
        .send({ event: 'enter', isReturning: false });
      expect(unowned.status).toBe(204);
    });

    it('folds counters into the link it was fired from, not an API hit', async () => {
      await request(app)
        .post('/api/public/aAaA11/beacon')
        .send({ event: 'enter', isReturning: false });
      await request(app)
        .post('/api/public/aAaA11/beacon')
        .send({ event: 'leave', durationMs: 5000, changedTimeframe: true });

      const link = getShareLink(1, linkIdA)!;
      expect(link.uniqueVisits).toBe(1);
      expect(link.durationSamples).toBe(1);
      expect(link.timeframeChanges).toBe(1);
      // The beacon bypasses resolveShare(), so it must NOT bump apiHitCount.
      expect(link.apiHitCount).toBe(0);
    });
  });

  // ── clan-pinning: the token, not client input, picks the clan ────
  describe('clan is pinned by the token, not by query params', () => {
    it('leaderboard returns only the token clan; ?clanId cannot pivot', async () => {
      const pinned = await request(app).get('/api/public/aAaA11/leaderboard');
      const spoofed = await request(app).get('/api/public/aAaA11/leaderboard?clanId=2');
      expect(pinned.status).toBe(200);
      expect(spoofed.status).toBe(200);
      // Identical payload regardless of the injected clanId — proves the
      // handler ignores it and uses clan.id from the token.
      expect(spoofed.body).toEqual(pinned.body);
      // Sanity: it actually returned clan-1 rows (Alice/Bob seeded there).
      const names = (pinned.body as Array<{ memberName: string }>).map((e) => e.memberName);
      expect(names).toContain('Alice');
    });
  });

  // ── no secret / PII leakage ──────────────────────────────────────
  describe('responses expose no secrets', () => {
    it('/clan returns only display fields, never the token or discord secret', async () => {
      setClanChestTrackerSettings(1, { shareCode: CODE_A, pollIntervalHours: 24, backfillWeeks: 0 });
      const r = await request(app).get('/api/public/aAaA11/clan');
      expect(r.status).toBe(200);
      // Exact key set, not a subset: this assertion is the allow-list. A field
      // added to the /clan payload has to be looked at and added here before it
      // can reach an anonymous visitor.
      expect(Object.keys(r.body).sort()).toEqual([
        'clanName', 'ctEnabled', 'gameDayRolloverUtcHour', 'leaderboardWeeklyGoalPoints',
      ]);
      const raw = JSON.stringify(r.body);
      expect(raw).not.toContain('aAaA11'); // the share key is not echoed
      expect(raw).not.toContain(CODE_A); // raw ct share code downgraded to boolean
      expect(r.body.ctEnabled).toBe(true);
    });
  });

  // ── external snapshot routes: gated on ct share code + no IDOR ────
  describe('external snapshot routes', () => {
    it('404 while the clan has no ChestTracker share code', async () => {
      expect((await request(app).get('/api/public/aAaA11/external/latest')).status).toBe(404);
      expect((await request(app).get('/api/public/aAaA11/external/snapshots')).status).toBe(404);
    });

    it('serves only this clan\'s snapshots and refuses another clan\'s id', async () => {
      setClanChestTrackerSettings(1, { shareCode: CODE_A, pollIntervalHours: 24, backfillWeeks: 0 });
      setClanChestTrackerSettings(2, { shareCode: CODE_B, pollIntervalHours: 24, backfillWeeks: 0 });
      seedSnapshot(1, CODE_A, 'AlicePublic');
      const foreignId = seedSnapshot(2, CODE_B, 'SecretClan2Player');

      const list = await request(app).get('/api/public/aAaA11/external/snapshots');
      expect(list.status).toBe(200);
      expect(list.body.total).toBe(1); // only clan 1's snapshot

      // Guessing clan 2's snapshot id through clan 1's token must 404 —
      // the handler compares detail.shareCode to the token clan's code.
      const idor = await request(app).get(`/api/public/aAaA11/external/snapshots/${foreignId}`);
      expect(idor.status).toBe(404);
      expect(JSON.stringify(idor.body)).not.toContain('SecretClan2Player');
    });
  });
});
