"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SESSION_COOKIE_NAME = void 0;
exports.sessionCookieOptions = sessionCookieOptions;
exports.resolveActiveClanId = resolveActiveClanId;
exports.denyCaching = denyCaching;
exports.requireAuth = requireAuth;
exports.requireClanContext = requireClanContext;
exports.requireAdmin = requireAdmin;
exports.requireSuperAdmin = requireSuperAdmin;
exports.requireClanAccess = requireClanAccess;
exports.requireClanAdmin = requireClanAdmin;
exports.optionalAuth = optionalAuth;
const user_repo_js_1 = require("../../data/repositories/user-repo.js");
const clan_repo_js_1 = require("../../data/repositories/clan-repo.js");
exports.SESSION_COOKIE_NAME = 'tb_session';
/**
 * Cookie flags for the session cookie.
 *
 * `secure` is decided by the REQUEST, not by NODE_ENV. A browser silently
 * discards a Secure cookie delivered over plain http://, so keying it on
 * NODE_ENV=production — which docker-compose sets for every deployment,
 * including one reached at http://<lan-ip>:3011 — produced an install where
 * signing in appeared to work and then didn't: the cookie was dropped, the
 * next /api call answered 401, and lib/api.js hard-navigated to /login. During
 * setup that bounced back to /setup (it is still the active flow) and looked
 * exactly like the wizard spontaneously returning to step one.
 *
 * app.set('trust proxy', 1) means req.secure already reflects
 * X-Forwarded-Proto, so a request through Cloudflare or any TLS terminator
 * still gets the Secure flag; only a genuinely plaintext request goes without,
 * where the alternative is not "more secure" but "cannot log in at all".
 */
function sessionCookieOptions(req) {
    return {
        httpOnly: true,
        sameSite: 'strict',
        secure: req ? req.secure : process.env.NODE_ENV === 'production',
        maxAge: user_repo_js_1.SESSION_TTL_MS,
        path: '/',
    };
}
function getToken(req) {
    const cookies = req.headers.cookie?.split(';').map((c) => c.trim()) ?? [];
    const sessionCookie = cookies.find((c) => c.startsWith(`${exports.SESSION_COOKIE_NAME}=`));
    if (sessionCookie)
        return sessionCookie.split('=')[1];
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer '))
        return auth.slice(7);
    return null;
}
/**
 * Resolve which clan a request should operate against.
 *
 *   - Non-superadmin users are forced to their own user.clanId; ignore any
 *     ?clanId override (defense in depth — even a crafted query string
 *     can't escape their clan).
 *   - Superadmins get the session's active_clan_id (set via
 *     POST /api/clans/:id/activate). If unset, fall back to the first
 *     clan in the table so a fresh login still has a sensible default.
 *
 * Returns null only when the system has no clans at all (boot-time state
 * before the v16 migration has seeded clan #1, or after every clan has
 * been deleted — neither should happen in practice).
 */
function resolveActiveClanId(user, sessionActiveClanId) {
    if (user.role !== 'superadmin') {
        return user.clanId ?? null;
    }
    // A superadmin can be parked on a clan that has since been soft-deleted
    // (the delete clears the pointer, but a session issued before the column
    // existed, or a stale cached id, can still name one). getClanById refuses a
    // deleted clan, so fall through to the first live one rather than scoping
    // the request to something invisible.
    if (sessionActiveClanId !== null && (0, clan_repo_js_1.getClanById)(sessionActiveClanId))
        return sessionActiveClanId;
    const all = (0, clan_repo_js_1.listClans)();
    return all[0]?.id ?? null;
}
/**
 * Mark a response as never storable by any cache, shared or private.
 *
 * Every auth rejection must go through this. A rejection is an answer about
 * the *caller* — "you have no session" — never a property of the URL, so
 * storing one and replaying it to the next visitor is always wrong. Express's
 * `res.redirect()` sets no cache headers at all, which leaves a `302 -> /login`
 * for a path ending in `.js` or `.css` looking exactly like an ordinary
 * cacheable static response to a CDN that keys off the extension.
 *
 * Cloudflare does exactly that, and it turned a four-minute bug into a
 * day-long outage: `lib/mobile-rows.js` was missing from PUBLIC_SHARE_ASSETS,
 * the edge stored the redirect it got back, and every public share link kept
 * rendering blank for eighteen hours after the allowlist fix had shipped and
 * deployed. The origin was correct the whole time; the edge was still
 * answering for it, and no amount of redeploying could change that.
 *
 * Path-versioned asset URLs (see ../asset-versioning.ts) are the other half
 * of the defence — they make a deploy ask for URLs no cache has seen. This
 * half makes sure the mistake is never storable in the first place, so the
 * next allowlist gap costs one broken page load rather than a TTL.
 */
function denyCaching(res) {
    res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
}
/**
 * Send the "not signed in" response, as JSON for API/XHR callers and as a
 * redirect to the login page for everything else. Always uncacheable.
 */
function rejectUnauthenticated(req, res, message) {
    denyCaching(res);
    if (req.path.startsWith('/api/') || req.headers.accept?.includes('application/json')) {
        res.status(401).json({ error: message });
    }
    else {
        res.redirect('/login');
    }
}
/**
 * Require any authenticated user. Attaches req.user, req.sessionToken,
 * and req.clanId.
 */
function requireAuth(req, res, next) {
    const token = getToken(req);
    if (!token) {
        rejectUnauthenticated(req, res, 'Authentication required');
        return;
    }
    const result = (0, user_repo_js_1.validateSession)(token);
    if (!result) {
        rejectUnauthenticated(req, res, 'Invalid or expired session');
        return;
    }
    if (result.extended) {
        res.cookie(exports.SESSION_COOKIE_NAME, token, sessionCookieOptions(req));
    }
    req.user = result.user;
    req.sessionToken = token;
    const clanId = resolveActiveClanId(result.user, result.activeClanId);
    if (clanId !== null)
        req.clanId = clanId;
    next();
}
/**
 * Block requests from non-superadmin users whose account isn't attached
 * to a clan. Without this gate, clan-scoped API endpoints fall back to
 * clan #1 (`req.clanId ?? 1`) and the orphaned user silently views (and
 * potentially mutates) clan 1's data — exactly the bug demoting a
 * superadmin used to introduce.
 *
 * Mount after `requireAuth` on routers that require a clan context
 * (the main /api router, /api/external). /api/auth/* is exempt so the
 * orphan can still log in, change password, and see the error in /me.
 * /api/clans is also exempt because the listing route returns an empty
 * array for orphans, which the frontend handles gracefully.
 */
function requireClanContext(req, res, next) {
    if (!req.user) {
        res.status(401).json({ error: 'Authentication required' });
        return;
    }
    if (req.user.role !== 'superadmin' && req.user.clanId === null) {
        res.status(403).json({
            error: 'Your account is not assigned to a clan. Ask a superadmin to reassign it.',
            code: 'orphaned_user',
        });
        return;
    }
    // Soft delete keeps every row, so a member of a deleted clan would otherwise
    // carry on reading it exactly as before — the clan would be hidden from the
    // picker and the scan loop while still fully readable by the people who were
    // in it. getClanById returns null for a deleted clan, which makes this the
    // same gate as the orphan case above and for the same reason: without it
    // `req.clanId ?? 1` quietly hands them clan #1.
    if (req.user.role !== 'superadmin' && req.user.clanId !== null && !(0, clan_repo_js_1.getClanById)(req.user.clanId)) {
        res.status(403).json({
            error: 'Your clan has been removed. Ask a superadmin to restore it or reassign your account.',
            code: 'deleted_clan',
        });
        return;
    }
    next();
}
/**
 * Require admin or superadmin role.
 *
 * Also blocks orphaned admins (role='admin' with clan_id NULL). Without
 * this check an orphan admin would hit GET /api/auth/users and the route
 * passes clanId=null to getAllUsers, which interprets null as the
 * "superadmin sees everyone" mode — a quiet privilege escalation.
 */
function requireAdmin(req, res, next) {
    requireAuth(req, res, () => {
        if (req.user?.role !== 'admin' && req.user?.role !== 'superadmin') {
            res.status(403).json({ error: 'Admin access required' });
            return;
        }
        if (req.user.role === 'admin' && req.user.clanId === null) {
            res.status(403).json({
                error: 'Your account is not assigned to a clan. Ask a superadmin to reassign it.',
                code: 'orphaned_user',
            });
            return;
        }
        next();
    });
}
/**
 * Require superadmin role.
 */
function requireSuperAdmin(req, res, next) {
    requireAuth(req, res, () => {
        if (req.user?.role !== 'superadmin') {
            res.status(403).json({ error: 'Super admin access required' });
            return;
        }
        next();
    });
}
/**
 * Block requests that would touch a clan the user doesn't own. Reads the
 * target clan from `:clanId` route param; superadmins always pass.
 *
 * Use this on cross-clan superadmin actions (e.g. PUT /api/clans/:clanId)
 * to fail closed when an admin tries to escalate.
 */
function requireClanAccess(req, res, next) {
    requireAuth(req, res, () => {
        if (!req.user) {
            res.status(401).json({ error: 'Authentication required' });
            return;
        }
        const rawParam = req.params.clanId;
        const clanIdStr = Array.isArray(rawParam) ? rawParam[0] : rawParam ?? '';
        const targetClanId = Number.parseInt(clanIdStr, 10);
        if (!Number.isFinite(targetClanId)) {
            res.status(400).json({ error: 'Missing or invalid clanId' });
            return;
        }
        if (req.user.role === 'superadmin') {
            next();
            return;
        }
        if (req.user.clanId !== targetClanId) {
            res.status(403).json({ error: 'You do not have access to this clan' });
            return;
        }
        next();
    });
}
/**
 * Require an ADMIN (or superadmin) who owns the target clan.
 *
 * This is `requireClanAccess` PLUS an admin-role assertion. Use it for
 * per-clan *configuration / action* routes under /api/clans — Discord
 * settings, ChestTracker share code, onboarding scans, resource toggle,
 * share-link create/disable. Those are administrative actions, not
 * things a plain `user`-role clan member should be able to perform.
 *
 * Why this exists: `/api/clans` is mounted with NO mount-level auth, so
 * each route's inline guard is its only gate. `requireClanAccess` alone
 * checks clan MEMBERSHIP but not ROLE, which let a role='user' member of
 * a clan overwrite that clan's Discord bot token, change the ChestTracker
 * share code, launch headless scans, etc. This middleware closes that
 * gap so those routes match the "Superadmin/admin" tier their own
 * comments claim.
 *
 * Semantics:
 *   - superadmin: always passes (cross-clan operator).
 *   - admin: must own the target clan (req.user.clanId === :clanId).
 *     Orphaned admins (clanId null) never match a numeric :clanId, so
 *     they fail closed with 403.
 *   - user / anonymous: rejected (403 / 401).
 */
function requireClanAdmin(req, res, next) {
    requireAuth(req, res, () => {
        if (!req.user) {
            res.status(401).json({ error: 'Authentication required' });
            return;
        }
        if (req.user.role === 'superadmin') {
            next();
            return;
        }
        if (req.user.role !== 'admin') {
            res.status(403).json({ error: 'Admin access required' });
            return;
        }
        const rawParam = req.params.clanId;
        const clanIdStr = Array.isArray(rawParam) ? rawParam[0] : rawParam ?? '';
        const targetClanId = Number.parseInt(clanIdStr, 10);
        if (!Number.isFinite(targetClanId)) {
            res.status(400).json({ error: 'Missing or invalid clanId' });
            return;
        }
        if (req.user.clanId !== targetClanId) {
            res.status(403).json({ error: 'You do not have access to this clan' });
            return;
        }
        next();
    });
}
/**
 * Middleware that attaches user to request if authenticated, but doesn't block.
 * Used for pages that should redirect to login client-side.
 */
function optionalAuth(req, res, next) {
    const token = getToken(req);
    if (token) {
        const result = (0, user_repo_js_1.validateSession)(token);
        if (result) {
            if (result.extended) {
                res.cookie(exports.SESSION_COOKIE_NAME, token, sessionCookieOptions(req));
            }
            req.user = result.user;
            req.sessionToken = token;
            const clanId = resolveActiveClanId(result.user, result.activeClanId);
            if (clanId !== null)
                req.clanId = clanId;
        }
    }
    next();
}
//# sourceMappingURL=auth.js.map