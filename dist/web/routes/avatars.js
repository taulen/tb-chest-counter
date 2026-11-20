"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAvatarRouter = createAvatarRouter;
/**
 * Account photos: GET /api/avatars/<sha256> — signed-in viewers only.
 *
 * These are photos of real people, so they sit behind the login. That is safe
 * with Cloudflare only because the URL has NO file extension and lives under
 * /api: Cloudflare caches by extension (docs/cloudflare-caching.md), so an
 * extensionless /api response is passed through (DYNAMIC) and never stored at
 * the edge — neither the photo nor a rejection. The browser still keeps its
 * own copy: the path is the photo's content hash, so the bytes behind a URL
 * never change (`private, max-age=…, immutable`).
 *
 * The old public path /avatars/<sha256>.<ext> (Nov 18 2026, a few hours) is
 * answered with a plain 404 for good — never the auth-gated SPA fallback and
 * its redirect, which Cloudflare would store against an image URL.
 */
const express_1 = require("express");
const avatar_repo_js_1 = require("../../data/repositories/avatar-repo.js");
const auth_js_1 = require("../middleware/auth.js");
const HASH_RE = /^[0-9a-f]{64}$/;
function notFound(res) {
    res.status(404).type('text/plain').send('Not found');
}
function createAvatarRouter() {
    const router = (0, express_1.Router)();
    router.get('/api/avatars/:hash', auth_js_1.requireAuth, (req, res) => {
        const hash = String(req.params.hash ?? '');
        if (!HASH_RE.test(hash))
            return notFound(res);
        const found = (0, avatar_repo_js_1.getAvatarBytes)(hash);
        if (!found)
            return notFound(res);
        res.setHeader('Content-Type', found.mime);
        res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        // An image is all this ever is: nothing in it may run, even opened directly.
        // default-src 'none' already refuses every script, frame and fetch. No
        // `sandbox`: opened in its own tab ("Open image in new tab") it made the
        // photo an opaque-origin, download-blocked document, so saving it from
        // there failed — the save went out without the SameSite=Strict session
        // cookie and got the 401 (Nov 20 2026). Saving from the page worked.
        res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
        res.setHeader('Content-Length', String(found.bytes.length));
        res.end(found.bytes);
    });
    // The retired public path, the folder itself and anything deeper: a plain
    // 404, never a listing and never the SPA's sign-in redirect.
    router.all(['/avatars', '/avatars/', '/avatars/{*rest}'], (_req, res) => notFound(res));
    return router;
}
//# sourceMappingURL=avatars.js.map