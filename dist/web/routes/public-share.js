"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.publicShareTokenHandler = publicShareTokenHandler;
exports.createPublicShareApiRouter = createPublicShareApiRouter;
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const express_1 = require("express");
const clan_repo_js_1 = require("../../data/repositories/clan-repo.js");
const share_link_repo_js_1 = require("../../data/repositories/share-link-repo.js");
const leaderboard_handler_js_1 = require("./leaderboard-handler.js");
const external_repo_js_1 = require("../../data/repositories/external-repo.js");
const share_token_js_1 = require("../../utils/share-token.js");
const index_js_1 = require("../../config/index.js");
const parse_int_js_1 = require("../../utils/parse-int.js");
const asset_versioning_js_1 = require("../asset-versioning.js");
const PUBLIC_DIR = path_1.default.resolve('src/web/public');
// Cache-bust JS/CSS references on each container start so a redeploy
// doesn't get masked by Cloudflare or browser cache.
//
// This used to be a private copy of the authenticated app's rewriter that
// had drifted to the `?v=` query form, and the difference was the whole
// bug: a query string is not part of the base URL an ES module's relative
// import resolves against, so `/public-share.js?v=123` still pulled its
// `lib/*.js` imports from bare, unversioned URLs. Cloudflare pinned a
// `302 -> /login` on one of them for eighteen hours and every share link
// rendered blank long after the fix had deployed. Both callers now share
// versionHtmlAssets() — see the note there.
const BUILD_VERSION = String(Date.now());
function readHtmlWithVersion(filename) {
    const html = fs_1.default.readFileSync(path_1.default.join(PUBLIC_DIR, filename), 'utf8');
    return (0, asset_versioning_js_1.versionHtmlAssets)(html, BUILD_VERSION);
}
/**
 * Friendly 404 for the public share path. Reuses the styled brand header
 * + cards from the rest of the app so a mistyped or revoked link
 * doesn't drop the visitor on a bare "Not found" page. We don't tell
 * the visitor *why* (mistyped vs revoked) since both look the same to
 * us, and we don't want to confirm whether 6-char strings are valid.
 */
function renderShareNotFound() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex, nofollow, noarchive, nosnippet">
  <meta name="referrer" content="no-referrer">
  <title>Link not found</title>
  <link rel="stylesheet" href="/v/${BUILD_VERSION}/style.css">
  <link rel="stylesheet" href="/v/${BUILD_VERSION}/public-share.css">
</head>
<body class="public-share-body">
  <div class="header public-share-header">
    <div class="brand">
      <svg class="brand-logo" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path d="M5 14 C5 8 9 5 16 5 C23 5 27 8 27 14 L27 15 L5 15 Z" fill="#f0c040" stroke="#3d2b0f" stroke-width="1.4" stroke-linejoin="round"/>
        <rect x="5" y="15" width="22" height="12" rx="0.8" fill="#f0c040" stroke="#3d2b0f" stroke-width="1.4" stroke-linejoin="round"/>
        <rect x="5" y="18" width="22" height="2" fill="#3d2b0f"/>
        <rect x="13.5" y="16.8" width="5" height="6.2" rx="0.4" fill="#3d2b0f"/>
        <circle cx="16" cy="19.5" r="0.8" fill="#f0c040"/>
        <rect x="15.65" y="19.5" width="0.7" height="1.6" fill="#f0c040"/>
      </svg>
      <h1>TB Chest Counter</h1>
    </div>
  </div>
  <div class="container">
    <div class="card">
      <div class="card-body card-body-padded" style="text-align:center;padding:48px 24px;">
        <h2 style="margin-top:0">Share link not found</h2>
        <p class="muted-copy" style="max-width:480px;margin:12px auto 0;line-height:1.6;">
          This share link doesn't exist or has been revoked by the clan admin.
          Double-check the URL, or ask whoever sent it to generate a fresh one.
        </p>
      </div>
    </div>
  </div>
</body>
</html>`;
}
/**
 * Apply the noindex / no-referrer / no-store header set to every response
 * out of this router. The token is unguessable but the URL still leaks
 * through copy-paste and browser history; we want crawlers and analytics
 * referrers not to amplify that leak.
 */
function applyShareHeaders(res) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
}
function paramAsString(p) {
    if (Array.isArray(p))
        return p[0] ?? '';
    return p ?? '';
}
/**
 * Resolve a URL key to the clan behind it, via the share_links ledger — the
 * sole authority since v74. A clan can hold several live keys at once, so the
 * link row (not the clan) is what usage is counted against: that per-key split
 * is the whole reason multiple links exist.
 *
 * Returns null for a key that doesn't resolve OR whose clan has been soft
 * deleted (getClanById filters those), so a revoked link and a deleted clan
 * are indistinguishable from outside.
 */
function resolveShare(token) {
    if (!share_token_js_1.SHARE_TOKEN_REGEX.test(token))
        return null;
    const link = (0, share_link_repo_js_1.resolveActiveShareLink)(token);
    if (!link)
        return null;
    const clan = (0, clan_repo_js_1.getClanById)(link.clanId);
    if (!clan)
        return null;
    // Count the data-API hit (best-effort; never blocks the response). Page
    // loads are counted separately in publicShareTokenHandler.
    (0, share_link_repo_js_1.recordApiHit)(link.id);
    return { clan, linkId: link.id };
}
/** Thin wrapper for the handlers that only need the clan. */
function resolveClan(token) {
    return resolveShare(token)?.clan ?? null;
}
/**
 * Public-side twin of the authenticated router's resolveShareCode: pick
 * which of the clan's trackers a request is reading. Only codes this clan
 * holds snapshots under are accepted, so a share token can't be used to
 * name some other clan's code — anything unrecognised falls back to the
 * clan's current one.
 */
function resolvePublicShareCode(clanId, currentCode, requested) {
    const asked = typeof requested === 'string' ? requested.trim() : '';
    if (!asked || asked === currentCode)
        return currentCode;
    const archived = (0, external_repo_js_1.listClanShareCodes)(clanId);
    return archived.some((a) => a.shareCode === asked) ? asked : currentCode;
}
/**
 * Top-level share-page handler. Mounted in server.ts ahead of the
 * requireAuth middleware. Only acts on paths matching the share-key regex
 * (a single alphanumeric segment, 3-10 chars — wide enough for both a
 * generated token and a vanity key). Anything else — /robots.txt,
 * /css/foo.css, a multi-segment path — falls through via next() to the rest
 * of the routing table, as does any segment in RESERVED_SHARE_KEYS.
 *
 * Express 5's path-to-regexp doesn't support inline regex constraints,
 * so we do the match here in middleware instead of in the route path.
 */
function publicShareTokenHandler(req, res, next) {
    // Only handle GETs of a bare /<key> — let everything else through.
    if (req.method !== 'GET') {
        next();
        return;
    }
    const segs = req.path.split('/').filter(Boolean);
    if (segs.length !== 1 || !share_token_js_1.SHARE_TOKEN_REGEX.test(segs[0])) {
        next();
        return;
    }
    if (share_token_js_1.RESERVED_SHARE_KEYS.has(segs[0].toLowerCase())) {
        // A path the app itself owns can never be a share key (validateVanityKey
        // refuses them), so hand it straight back to the routing table rather
        // than answering "share link not found" for /login or /dashboard.
        next();
        return;
    }
    const link = (0, share_link_repo_js_1.resolveActiveShareLink)(segs[0]);
    const clan = link ? (0, clan_repo_js_1.getClanById)(link.clanId) : null;
    if (!link || !clan) {
        // 404 (not 401) so probing doesn't leak which 6-char strings are valid.
        // Serve a styled page rather than bare text so a mistyped or revoked
        // link lands somewhere readable.
        applyShareHeaders(res);
        res.status(404).type('html').send(renderShareNotFound());
        return;
    }
    // Count this page load against THIS link's counters (best-effort).
    (0, share_link_repo_js_1.recordVisit)(link.id);
    applyShareHeaders(res);
    res.type('html').send(readHtmlWithVersion('public-share.html'));
}
/**
 * /api/public/:token/* — read-only data endpoints used by the public
 * share page. Mounted via app.use('/api/public', ...) in server.ts.
 */
function createPublicShareApiRouter() {
    const router = (0, express_1.Router)();
    router.use((_req, res, next) => {
        applyShareHeaders(res);
        next();
    });
    // GET /:token/clan — minimum needed by the public page to render a
    // header and decide whether to show the ChestTracker tab.
    router.get('/:token/clan', (req, res) => {
        const token = paramAsString(req.params.token);
        const clan = resolveClan(token);
        if (!clan) {
            res.status(404).json({ error: 'Not found' });
            return;
        }
        res.json({
            clanName: clan.name,
            ctEnabled: !!clan.ctShareCode,
            // The frontend mirrors the same period→[from,to) math used by the
            // authenticated app, which depends on the configured day-rollover
            // hour. No PII; same value is exposed by /api/stats.
            gameDayRolloverUtcHour: (0, index_js_1.loadConfig)().gameDayRolloverUtcHour,
            // The clan's weekly points goal, or null when they haven't set one. Rides
            // on this call rather than getting an endpoint of its own because the page
            // already blocks on /clan before its first render — a separate fetch would
            // make the goal line pop in a beat after the table. Same resolver the
            // authenticated /api/leaderboard/goal uses, so a goal that is off or
            // unconfigured reads as null on both surfaces.
            leaderboardWeeklyGoalPoints: (0, leaderboard_handler_js_1.resolveWeeklyGoalPoints)(clan),
        });
    });
    // GET /:token/leaderboard — same query model as the authenticated
    // /api/leaderboard route, scoped to the clan that owns the token.
    // Both endpoints share queryLeaderboard() so the data, filtering and
    // re-ranking semantics stay identical.
    router.get('/:token/leaderboard', (req, res) => {
        const token = paramAsString(req.params.token);
        const clan = resolveClan(token);
        if (!clan) {
            res.status(404).json({ error: 'Not found' });
            return;
        }
        res.json((0, leaderboard_handler_js_1.queryLeaderboard)(clan.id, (0, leaderboard_handler_js_1.parseLeaderboardQuery)(req)));
    });
    // GET /:token/external/latest — full latest-snapshot detail for the
    // ChestTracker tab. Mirrors what the authenticated /api/external/status
    // exposes: snapshot detail (players + categories + settings + previousWeek
    // for week-over-week deltas), share code, and the last-checked
    // timestamp from the poll log so the meta strip can show "Last checked".
    // The snapshot data is already public on chesttracker.com.
    router.get('/:token/external/latest', (req, res) => {
        const token = paramAsString(req.params.token);
        const clan = resolveClan(token);
        if (!clan || !clan.ctShareCode) {
            res.status(404).json({ error: 'Not found' });
            return;
        }
        // Honour ?shareCode= so a shared link can browse the clan's archived
        // trackers too, validated against the codes this clan actually owns
        // rows under (see resolvePublicShareCode).
        const shareCode = resolvePublicShareCode(clan.id, clan.ctShareCode, req.query.shareCode);
        const latest = (0, external_repo_js_1.getLatestSnapshot)({ clanId: clan.id, shareCode });
        if (!latest) {
            res.json({
                snapshot: null,
                shareCode,
                isArchived: shareCode !== clan.ctShareCode,
                lastCheckedAt: (0, external_repo_js_1.getLatestPollAt)({ clanId: clan.id, shareCode }),
            });
            return;
        }
        const detail = (0, external_repo_js_1.getSnapshot)(latest.id);
        res.json({
            snapshot: detail,
            shareCode,
            isArchived: shareCode !== clan.ctShareCode,
            lastCheckedAt: (0, external_repo_js_1.getLatestPollAt)({ clanId: clan.id, shareCode }),
        });
    });
    // GET /:token/external/share-codes — the clan's tracker archive, so the
    // public page can offer the same code picker the authenticated tab has.
    router.get('/:token/external/share-codes', (req, res) => {
        const token = paramAsString(req.params.token);
        const clan = resolveClan(token);
        if (!clan || !clan.ctShareCode) {
            res.status(404).json({ error: 'Not found' });
            return;
        }
        const rows = (0, external_repo_js_1.listClanShareCodes)(clan.id).map((r) => ({
            ...r,
            isCurrent: r.shareCode === clan.ctShareCode,
        }));
        if (!rows.some((r) => r.isCurrent)) {
            rows.unshift({
                shareCode: clan.ctShareCode,
                snapshots: 0,
                weeks: 0,
                firstWindow: '',
                lastWindow: '',
                firstFetch: '',
                lastFetch: '',
                kingdom: null,
                isCurrent: true,
            });
        }
        res.json({ current: clan.ctShareCode, rows });
    });
    // GET /:token/external/snapshots — list snapshots for this clan's share
    // code only. Returns the same shape as the admin
    // /api/external/snapshots endpoint (rows: SnapshotRow[]).
    router.get('/:token/external/snapshots', (req, res) => {
        const token = paramAsString(req.params.token);
        const clan = resolveClan(token);
        if (!clan || !clan.ctShareCode) {
            res.status(404).json({ error: 'Not found' });
            return;
        }
        const limit = (0, parse_int_js_1.parseBoundedInt)(req.query.limit, 20, { min: 1, max: 100 });
        const offset = (0, parse_int_js_1.parseBoundedInt)(req.query.offset, 0, { min: 0, max: 1_000_000 });
        const shareCode = resolvePublicShareCode(clan.id, clan.ctShareCode, req.query.shareCode);
        const result = (0, external_repo_js_1.listSnapshots)({ limit, offset, clanId: clan.id, shareCode });
        res.json({ total: result.total, limit, offset, rows: result.rows });
    });
    // POST /:token/beacon — best-effort analytics beacon from the public
    // page (navigator.sendBeacon). Fire-and-forget: always 204, never leaks
    // whether the token is valid, and never counts as an API hit. The client
    // sends one 'enter' event (classifying new vs returning from its own
    // localStorage) and one 'leave' event on pagehide (visit duration +
    // whether the viewer switched day/week/month). Values are bounded here so
    // a hand-crafted POST can't store absurd numbers.
    router.post('/:token/beacon', (0, express_1.json)({ limit: '1kb' }), (req, res) => {
        const token = paramAsString(req.params.token);
        // Resolve the link WITHOUT going through resolveShare() — the beacon
        // must not inflate the api-hit counter.
        const link = share_token_js_1.SHARE_TOKEN_REGEX.test(token) ? (0, share_link_repo_js_1.resolveActiveShareLink)(token) : null;
        if (link && (0, clan_repo_js_1.getClanById)(link.clanId)) {
            const body = (req.body ?? {});
            const event = body.event === 'leave' ? 'leave' : body.event === 'enter' ? 'enter' : null;
            if (event) {
                const rawMs = Number(body.durationMs);
                const durationMs = Math.min(Math.max(Number.isFinite(rawMs) ? rawMs : 0, 0), 6 * 60 * 60 * 1000);
                (0, share_link_repo_js_1.recordBeacon)(link.id, {
                    event,
                    isReturning: !!body.isReturning,
                    durationMs,
                    changedTimeframe: !!body.changedTimeframe,
                });
            }
        }
        res.status(204).end();
    });
    // GET /:token/external/snapshots/:id — full snapshot detail. Refuses
    // if the snapshot's share code doesn't match the clan's, so a valid
    // public token can't enumerate other clans' snapshots by id.
    router.get('/:token/external/snapshots/:id', (req, res) => {
        const token = paramAsString(req.params.token);
        const clan = resolveClan(token);
        if (!clan || !clan.ctShareCode) {
            res.status(404).json({ error: 'Not found' });
            return;
        }
        const id = Number.parseInt(paramAsString(req.params.id), 10);
        if (!Number.isFinite(id)) {
            res.status(400).json({ error: 'Invalid id' });
            return;
        }
        // Ownership is clan_id, not the clan's live share code — otherwise
        // every snapshot from a tracker the clan has since moved off would
        // 404 here even though the archive picker offers it.
        const detail = (0, external_repo_js_1.getSnapshot)(id);
        if (!detail || detail.clanId !== clan.id) {
            res.status(404).json({ error: 'Not found' });
            return;
        }
        res.json(detail);
    });
    return router;
}
//# sourceMappingURL=public-share.js.map