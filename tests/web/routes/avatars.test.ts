// Account photos: the upload/remove routes (real auth, real sessions), the
// moderation gate, and the public /avatars/<sha256>.<ext> serving.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../../src/utils/db-backup.js', () => ({
  createPreActionBackup: vi.fn(async () => '/tmp/fake-backup.db.gz'),
  startDailyBackupSchedule: vi.fn(),
  listServerBackups: vi.fn(() => []),
}));

import { createAuthRouter } from '../../../src/web/routes/auth.js';
import { createAvatarRouter } from '../../../src/web/routes/avatars.js';
import { requireAuth, SESSION_COOKIE_NAME } from '../../../src/web/middleware/auth.js';
import * as userRepo from '../../../src/data/repositories/user-repo.js';
import { AVATAR_MAX_BYTES } from '../../../src/data/repositories/avatar-repo.js';
import { getDb } from '../../../src/data/database.js';
import { makeTestDb, seedTwoClans } from '../../helpers/test-db.js';
import { jpegBytes, pngBytes, webpLossyBytes } from '../../helpers/image-bytes.js';

type Persona = 'super' | 'admin1' | 'admin2' | 'user1' | 'user2';

describe('account photos', () => {
  let app: express.Express;
  let cleanup: () => void;
  let ids: Record<Persona, { userId: number; cookie: string }>;

  beforeEach(() => {
    cleanup = makeTestDb().cleanup;
    seedTwoClans();
    const mk = (userId: number) => `${SESSION_COOKIE_NAME}=${userRepo.createSession(userId)}`;
    const su = userRepo.createUser('su', 'Test1234!aA', 'superadmin');
    const a1 = userRepo.createUser('a1', 'Test1234!aA', 'admin', su.id, 1);
    const a2 = userRepo.createUser('a2', 'Test1234!aA', 'admin', su.id, 2);
    const u1 = userRepo.createUser('u1', 'Test1234!aA', 'user', su.id, 1);
    const u2 = userRepo.createUser('u2', 'Test1234!aA', 'user', su.id, 2);
    ids = {
      super: { userId: su.id, cookie: mk(su.id) },
      admin1: { userId: a1.id, cookie: mk(a1.id) },
      admin2: { userId: a2.id, cookie: mk(a2.id) },
      user1: { userId: u1.id, cookie: mk(u1.id) },
      user2: { userId: u2.id, cookie: mk(u2.id) },
    };
    app = express();
    // As server.ts: the avatar router is public and ahead of everything gated,
    // and the global JSON parser runs before the auth routes.
    app.use(createAvatarRouter());
    app.use(express.json({ limit: '1mb' }));
    app.use('/api/auth', createAuthRouter());
    // The SPA fallback is behind auth: nothing under /avatars may reach it.
    app.get('/{*path}', requireAuth, (_req, res) => { res.send('spa'); });
  });
  afterEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  const upload = (who: Persona, body: Buffer | string, type: string) =>
    request(app).put('/api/auth/avatar').set('Accept', 'application/json')
      .set('Cookie', ids[who].cookie).set('Content-Type', type).send(body);

  const photoRows = (userId: number) =>
    (getDb().prepare('SELECT COUNT(*) c FROM user_avatars WHERE user_id = ?').get(userId) as { c: number }).c;

  describe('upload', () => {
    it('needs a session', async () => {
      const res = await request(app).put('/api/auth/avatar').set('Accept', 'application/json')
        .set('Content-Type', 'image/png').send(pngBytes(512, 512));
      expect(res.status).toBe(401);
    });

    it('stores your own photo and answers with what you now show', async () => {
      const res = await upload('user1', pngBytes(512, 512), 'image/png');
      expect(res.status).toBe(200);
      expect(res.body.avatar.kind).toBe('photo');
      expect(res.body.avatar.url).toMatch(/^\/avatars\/[0-9a-f]{64}\.png$/);
      expect(photoRows(ids.user1.userId)).toBe(1);
      const me = await request(app).get('/api/auth/me').set('Cookie', ids.user1.cookie);
      expect(me.body.user.avatar).toEqual(res.body.avatar);
    });

    it('takes the format from the bytes, not the claimed Content-Type', async () => {
      const res = await upload('user1', webpLossyBytes(512, 512), 'image/png');
      expect(res.status).toBe(200);
      expect(res.body.avatar.url).toMatch(/\.webp$/);
    });

    it('refuses a non-image renamed .png, a GIF, and a JSON body', async () => {
      expect((await upload('user1', Buffer.from('<html>hello</html>'), 'image/png')).status).toBe(400);
      expect((await upload('user1', Buffer.from('GIF89a\x00\x02\x00\x02', 'latin1'), 'image/png')).status).toBe(400);
      const json = await request(app).put('/api/auth/avatar').set('Accept', 'application/json')
        .set('Cookie', ids.user1.cookie).send({ image: 'x' });
      expect(json.status).toBe(415);
      expect(photoRows(ids.user1.userId)).toBe(0);
    });

    it('refuses images that are not square, too small or too big', async () => {
      expect((await upload('user1', jpegBytes(640, 480), 'image/jpeg')).body.error).toMatch(/square/);
      expect((await upload('user1', pngBytes(32, 32), 'image/png')).body.error).toMatch(/at least/);
      expect((await upload('user1', pngBytes(2048, 2048), 'image/png')).body.error).toMatch(/at most/);
      expect(photoRows(ids.user1.userId)).toBe(0);
    });

    it('refuses a body over the limit with JSON, not a 500', async () => {
      const res = await upload('user1', pngBytes(512, 512, AVATAR_MAX_BYTES), 'image/png');
      expect(res.status).toBe(413);
      expect(res.body.error).toMatch(/2 MB/);
    });

    it('replacing a photo drops the old bytes and its URL stops resolving', async () => {
      const first = await upload('user1', pngBytes(512, 512), 'image/png');
      const second = await upload('user1', jpegBytes(512, 512), 'image/jpeg');
      expect(second.body.avatar.url).not.toBe(first.body.avatar.url);
      expect(photoRows(ids.user1.userId)).toBe(1);
      expect((await request(app).get(first.body.avatar.url)).status).toBe(404);
      expect((await request(app).get(second.body.avatar.url)).status).toBe(200);
    });

    it('removing your photo brings the default back', async () => {
      const up = await upload('user1', pngBytes(512, 512), 'image/png');
      const res = await request(app).delete('/api/auth/avatar').set('Accept', 'application/json').set('Cookie', ids.user1.cookie);
      expect(res.status).toBe(200);
      expect(res.body.avatar).toEqual({ kind: 'initial', url: null, initial: 'U' });
      expect((await request(app).get(up.body.avatar.url)).status).toBe(404);
    });
  });

  describe('serving /avatars/<sha256>.<ext>', () => {
    it('serves the bytes publicly, immutable, with the stored type and nosniff', async () => {
      const bytes = pngBytes(512, 512, 100);
      const { body } = await upload('user1', bytes, 'image/png');
      const res = await request(app).get(body.avatar.url).buffer(true).parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-security-policy']).toContain('sandbox');
      expect(Buffer.compare(res.body as Buffer, bytes)).toBe(0);
    });

    it('answers every other /avatars path with a plain 404 — never the auth redirect', async () => {
      const { body } = await upload('user1', pngBytes(512, 512), 'image/png');
      const hash = body.avatar.url.slice('/avatars/'.length, -'.png'.length);
      for (const path of [
        `/avatars/${hash}.jpg`, // wrong extension for the stored type
        `/avatars/${'0'.repeat(64)}.png`, // unknown hash
        '/avatars/not-a-hash.png',
        `/avatars/${hash.toUpperCase()}.png`,
        '/avatars/', '/avatars', `/avatars/${hash}.png/extra`,
      ]) {
        const res = await request(app).get(path);
        expect(res.status, path).toBe(404);
      }
    });
  });

  describe('taking down someone else\'s photo', () => {
    const takeDown = (who: Persona, target: Persona) =>
      request(app).delete(`/api/auth/users/${ids[target].userId}/avatar`)
        .set('Accept', 'application/json').set('Cookie', ids[who].cookie);

    beforeEach(async () => {
      for (const p of ['super', 'admin1', 'user1', 'user2'] as Persona[]) await upload(p, pngBytes(512, 512), 'image/png');
    });

    it('a clan admin can, for their own clan\'s accounts — and it is audit-logged', async () => {
      const res = await takeDown('admin1', 'user1');
      expect(res.status).toBe(200);
      expect(res.body.removed).toBe(true);
      expect(photoRows(ids.user1.userId)).toBe(0);
      const audit = getDb().prepare("SELECT user_id, details FROM audit_log WHERE action = 'remove_user_avatar'").get() as
        { user_id: number; details: string };
      expect(audit.user_id).toBe(ids.admin1.userId);
      expect(JSON.parse(audit.details).username).toBe('u1');
    });

    it('a clan admin cannot reach another clan\'s accounts, nor a superadmin', async () => {
      expect((await takeDown('admin2', 'user1')).status).toBe(403);
      expect((await takeDown('admin1', 'user2')).status).toBe(403);
      expect((await takeDown('admin1', 'super')).status).toBe(403);
      expect(photoRows(ids.user1.userId)).toBe(1);
      expect(photoRows(ids.super.userId)).toBe(1);
    });

    it('a clan admin can for a guest of their clan', async () => {
      getDb().prepare("INSERT INTO user_clan_access (user_id, clan_id, role, created_at) VALUES (?, 2, 'user', ?)")
        .run(ids.user1.userId, new Date().toISOString());
      expect((await takeDown('admin2', 'user1')).status).toBe(200);
      expect(photoRows(ids.user1.userId)).toBe(0);
    });

    it('a plain member cannot, even in their own clan', async () => {
      expect((await takeDown('user1', 'admin1')).status).toBe(403);
      expect(photoRows(ids.admin1.userId)).toBe(1);
    });

    it('the superadmin can, for anyone', async () => {
      expect((await takeDown('super', 'user2')).status).toBe(200);
      expect((await takeDown('super', 'admin1')).status).toBe(200);
      expect(photoRows(ids.user2.userId)).toBe(0);
    });

    it('the Users listing carries each account\'s picture', async () => {
      const res = await request(app).get('/api/auth/users').set('Accept', 'application/json').set('Cookie', ids.admin1.cookie);
      expect(res.status).toBe(200);
      const byName = Object.fromEntries((res.body as Array<{ username: string; avatar: { kind: string } }>).map((u) => [u.username, u.avatar.kind]));
      expect(byName).toEqual({ a1: 'photo', u1: 'photo' });
    });
  });
});
