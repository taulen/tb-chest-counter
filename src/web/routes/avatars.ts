/**
 * Account photos: GET /avatars/<sha256>.<png|jpg|webp>
 *
 * Public on purpose, like every image the pages load: Cloudflare caches by
 * extension and stores a redirect against the URL whatever our headers say, so
 * a static file must never answer with an auth rejection
 * (docs/cloudflare-caching.md). The path is the photo's content hash — a new
 * photo is a new URL, so the bytes behind a URL never change and can be cached
 * for good. Every /avatars/ path is answered here (a 404 for anything unknown),
 * so none can fall through to the auth-gated SPA fallback and its redirect.
 *
 * A removed photo stops being served at once by this origin; an edge copy
 * Cloudflare already holds lives until it expires. The URL is unguessable and
 * nothing references it any more.
 */
import { Router, type Response } from 'express';
import { getAvatarBytes } from '../../data/repositories/avatar-repo.js';

const FILE_RE = /^([0-9a-f]{64})\.(png|jpg|webp)$/;

function notFound(res: Response): void {
  res.status(404).type('text/plain').send('Not found');
}

export function createAvatarRouter(): Router {
  const router = Router();

  router.get('/avatars/:file', (req, res) => {
    const m = FILE_RE.exec(String(req.params.file ?? ''));
    if (!m) return notFound(res);
    const found = getAvatarBytes(m[1], m[2]);
    if (!found) return notFound(res);
    res.setHeader('Content-Type', found.mime);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // An image is all this ever is: nothing in it may run, even opened directly.
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    res.setHeader('Content-Length', String(found.bytes.length));
    res.end(found.bytes);
  });

  // The folder itself and anything deeper: never a listing, never the SPA.
  router.all(['/avatars', '/avatars/', '/avatars/{*rest}'], (_req, res) => notFound(res));

  return router;
}
