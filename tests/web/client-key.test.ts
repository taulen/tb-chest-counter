// Rate limits key on the visitor, not on Cloudflare's edge (src/web/client-key.ts).
import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import rateLimit from 'express-rate-limit';
import { clientAddress, clientKey } from '../../src/web/client-key.js';

const req = (headers: Record<string, string>, ip = '172.18.0.5') =>
  ({ headers, ip, socket: { remoteAddress: ip } }) as unknown as Parameters<typeof clientAddress>[0];

describe('clientAddress', () => {
  it("takes Cloudflare's CF-Connecting-IP over the proxy hop", () => {
    expect(clientAddress(req({ 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '203.0.113.7, 162.158.1.1' }, '162.158.1.1'))).toBe('203.0.113.7');
  });

  it('never trusts the leftmost X-Forwarded-For (a client can write it)', () => {
    expect(clientAddress(req({ 'x-forwarded-for': '1.2.3.4, 162.158.1.1' }, '162.158.1.1'))).toBe('162.158.1.1');
  });

  it('falls back to req.ip without Cloudflare', () => {
    expect(clientAddress(req({}, '10.0.0.9'))).toBe('10.0.0.9');
  });
});

describe('a limiter keyed by clientKey', () => {
  it('gives two visitors behind the same Cloudflare edge their own allowance', async () => {
    const app = express();
    app.set('trust proxy', 1);
    app.use(rateLimit({ windowMs: 60_000, max: 2, keyGenerator: clientKey, validate: { xForwardedForHeader: false } }));
    app.get('/x', (_req, res) => { res.json([]); });
    const hit = (visitor: string) => request(app).get('/x')
      .set('X-Forwarded-For', `${visitor}, 162.158.1.1`).set('CF-Connecting-IP', visitor);
    expect((await hit('203.0.113.7')).status).toBe(200);
    expect((await hit('203.0.113.7')).status).toBe(200);
    expect((await hit('203.0.113.7')).status).toBe(429);
    // Same edge, another visitor: not affected.
    expect((await hit('198.51.100.20')).status).toBe(200);
  });
});
