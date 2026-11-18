/**
 * Who a request comes from, for rate limiting.
 *
 * Prod is Cloudflare → a reverse proxy → this app, so `X-Forwarded-For`
 * arrives as "client, cloudflare-edge" and `trust proxy = 1` makes `req.ip`
 * the CLOUDFLARE EDGE, not the visitor. Keyed on that, every visitor routed
 * through the same Cloudflare location shared one allowance: with each open
 * tab polling /api/status ~28×/min, a handful of tabs exhausted the /api
 * limit together and members got 429s — the Members board crashed on one
 * (Nov 18 2026). The login and join limits were shared the same way.
 *
 * `CF-Connecting-IP` is set by Cloudflare to the visitor's address and
 * replaces anything the client sent, so it is the key when present. Never
 * the leftmost `X-Forwarded-For`: Cloudflare appends to a client-sent one,
 * so its first entry is whatever the client wrote. Without Cloudflare (a
 * local run, tests) `req.ip` is right. IPv6 addresses are keyed by their /56
 * (ipKeyGenerator), so one household can't dodge a limit by rotating
 * addresses inside its prefix.
 */
import type { Request } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';

export function clientAddress(req: Pick<Request, 'headers' | 'ip' | 'socket'>): string {
  const cf = req.headers['cf-connecting-ip'];
  const fromCloudflare = (Array.isArray(cf) ? cf[0] : cf)?.trim();
  return fromCloudflare || req.ip || req.socket?.remoteAddress || 'unknown';
}

/** keyGenerator for every express-rate-limit limiter in the app. */
export function clientKey(req: Request): string {
  return ipKeyGenerator(clientAddress(req));
}
