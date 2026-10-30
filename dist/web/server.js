"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startWebServer = startWebServer;
const http_1 = __importDefault(require("http"));
const os_1 = __importDefault(require("os"));
const express_1 = __importDefault(require("express"));
const helmet_1 = __importDefault(require("helmet"));
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const ws_1 = require("ws");
const api_js_1 = require("./routes/api.js");
const auth_js_1 = require("./routes/auth.js");
const clans_js_1 = require("./routes/clans.js");
const setup_js_1 = require("./routes/setup.js");
const external_js_1 = require("./routes/external.js");
const public_share_js_1 = require("./routes/public-share.js");
const setup_mode_assets_js_1 = require("./setup-mode-assets.js");
const asset_versioning_js_1 = require("./asset-versioning.js");
const frontend_assets_js_1 = require("./frontend-assets.js");
const resources_js_1 = require("./routes/resources.js");
const might_js_1 = require("./routes/might.js");
const guards_js_1 = require("./routes/guards.js");
const tools_js_1 = require("./routes/tools.js");
const tinman_js_1 = require("./routes/tinman.js");
const member_levels_js_1 = require("./routes/member-levels.js");
const auth_js_2 = require("./middleware/auth.js");
const user_repo_js_1 = require("../data/repositories/user-repo.js");
const logger_js_1 = require("../utils/logger.js");
const user_repo_js_2 = require("../data/repositories/user-repo.js");
const login_bridge_js_1 = require("./login-bridge.js");
const link_quality_js_1 = require("./login-bridge/link-quality.js");
const build_info_js_1 = require("../utils/build-info.js");
const db_backup_js_1 = require("../utils/db-backup.js");
const log = (0, logger_js_1.childLogger)('web');
const PUBLIC_DIR = path_1.default.resolve('src/web/public');
// Build identifier for content-versioned static URLs. Prefer the
// fingerprint baked at docker-build time (changes whenever any bundled
// file changes). Falls back to process start time so dev and one-off
// `node dist/index.js` runs still get a unique-per-process value.
const BUILD_VERSION = (build_info_js_1.BUILD_INFO.fingerprint && build_info_js_1.BUILD_INFO.fingerprint !== 'unknown')
    ? build_info_js_1.BUILD_INFO.fingerprint
    : String(Date.now());
/**
 * Rewrites local .js and .css references in an HTML file so they go
 * through a versioned `/v/<BUILD_VERSION>/...` URL.
 *
 * The rewrite itself lives in ./asset-versioning.ts, shared with the
 * public share page — see the note there for why the version goes in the
 * path and not in a query string, and what it cost us the one time the
 * two copies of this disagreed.
 */
function readHtmlWithVersion(filename) {
    const html = fs_1.default.readFileSync(path_1.default.join(PUBLIC_DIR, filename), 'utf8');
    return (0, asset_versioning_js_1.versionHtmlAssets)(html, BUILD_VERSION);
}
function sendHtml(res, filename) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.type('html').send(readHtmlWithVersion(filename));
}
/**
 * Raise the HTTP server's keep-alive timeouts above Node's 5s default.
 *
 * Symptom this fixes: intermittent EMPTY responses on /api/* calls —
 * the browser's fetch() resolves with a zero-length body (surfaced in
 * the dashboard as the "empty response" error / a null page render) —
 * that appear ONLY when the server has been idle, never under load.
 *
 * Root cause: Node's default `server.keepAliveTimeout` is 5000ms, so the
 * origin closes an idle keep-alive socket after 5s. Every proxy in front
 * of us (Cloudflare, and the reverse proxy / tunnel on the host —
 * `trust proxy` is set, so there's at least one hop) keeps its own
 * connection pool to the origin open far longer and reuses those
 * sockets. After an idle gap > 5s the proxy sends a request on a socket
 * Node has just closed, gets a connection reset, and hands the browser
 * back an empty-bodied 502. Under load the sockets are reused within 5s
 * so the race never fires — which is exactly why it only shows up when
 * things are quiet.
 *
 * Fix: make the ORIGIN never be the side that closes an idle connection
 * out from under an in-flight request. keepAliveTimeout is set well
 * above any common proxy idle timeout (ALB 60s, nginx ~75s, cloudflared
 * ~90s). headersTimeout MUST stay larger than keepAliveTimeout or Node
 * can tear the connection down while the request headers are mid-flight.
 */
function configureKeepAliveTimeouts(server) {
    server.keepAliveTimeout = 120_000;
    server.headersTimeout = 125_000;
}
/**
 * Stand-alone mount for the in-app Total Battle login bridge during
 * setup. The wizard embeds the same panel/canvas that the Clans page
 * uses, so it needs the start/save/cancel endpoints reachable without
 * the `ensureSetupCompleted` gate the rest of /api/* lives behind. The
 * full /api admin router replaces this in normal mode (it adds scan-
 * loop coordination + extra logging that's pointless during setup).
 */
/**
 * Auth for the bridge routes while the wizard owns the server.
 *
 * The wizard's own step issues a session cookie, but the bridge must not
 * DEPEND on one. A cookie can fail to stick for reasons that have nothing to
 * do with the operator — it did exactly that on a plain-HTTP LAN deployment,
 * where NODE_ENV=production marked the cookie Secure and the browser dropped
 * it — and the failure lands as a 401 that lib/api.js turns into a hard
 * navigation to /login, which setup mode bounces straight back to /setup. The
 * operator sees the wizard restart itself and no error anywhere.
 *
 * So: while isSetupFlowActive(), act as the superadmin the wizard created and
 * skip the session check. That grants nothing new — the same unauthenticated
 * window already lets anyone reachable CREATE that superadmin (or restore a
 * whole database), and it closes the instant setup finishes, when the real
 * /api router with real auth replaces these routes.
 *
 * Before the account exists there is nobody to act as, so it falls through to
 * requireAdmin and answers 401 as usual.
 */
function setupBridgeAuth(req, res, next) {
    if ((0, setup_js_1.isSetupFlowActive)()) {
        const actor = (0, user_repo_js_1.firstSuperadmin)();
        if (actor) {
            req.user = actor;
            next();
            return;
        }
    }
    (0, auth_js_2.requireAdmin)(req, res, next);
}
function mountSetupModeLoginBridge(app) {
    app.post('/api/admin/login-session/start', setupBridgeAuth, async (req, res) => {
        if (login_bridge_js_1.loginBridge.isActive()) {
            const status = login_bridge_js_1.loginBridge.status();
            return res.json({ ok: true, alreadyActive: true, ...status, width: 1280, height: 800 });
        }
        // Setup always operates on clan #1 (the seeded clan). Ignore any
        // body.clanId so a misbehaving client can't redirect the bridge
        // at a clan that doesn't exist yet.
        try {
            const dims = await login_bridge_js_1.loginBridge.start(1);
            (0, user_repo_js_1.logAction)(req.user.id, 'login_session_start', { clanId: 1, fromSetup: true });
            return res.json({ ok: true, clanId: 1, ...dims });
        }
        catch (err) {
            return res.status(500).json({ error: String(err instanceof Error ? err.message : err) });
        }
    });
    app.post('/api/admin/login-session/save', setupBridgeAuth, async (req, res) => {
        if (!login_bridge_js_1.loginBridge.isActive()) {
            return res.status(409).json({ error: 'No active login session.' });
        }
        try {
            const result = await login_bridge_js_1.loginBridge.save(req.user.id);
            return res.json({
                ok: true,
                cookies: result.cookies,
                hasTbAuth: result.hasTbAuth,
                message: result.hasTbAuth
                    ? `Session captured (${result.cookies} cookies, Total Battle auth detected).`
                    : `Session captured (${result.cookies} cookies), but no Total Battle auth was detected — finish login and try again.`,
            });
        }
        catch (err) {
            return res.status(500).json({ error: String(err instanceof Error ? err.message : err) });
        }
    });
    app.post('/api/admin/login-session/cancel', setupBridgeAuth, async (_req, res) => {
        if (!login_bridge_js_1.loginBridge.isActive()) {
            return res.json({ ok: true, alreadyClosed: true });
        }
        try {
            await login_bridge_js_1.loginBridge.cancel();
            return res.json({ ok: true });
        }
        catch (err) {
            return res.status(500).json({ error: String(err instanceof Error ? err.message : err) });
        }
    });
}
/**
 * Validate the session cookie on a WebSocket upgrade request for the
 * login bridge. Returns true when the caller is admin/superadmin AND
 * (when they're not superadmin) the active bridge belongs to their
 * clan. False results in a 401/403 response written to the raw socket.
 */
function attachLoginBridgeUpgradeHandler(httpServer, setupMode) {
    const wss = new ws_1.WebSocketServer({ noServer: true });
    httpServer.on('upgrade', (req, socket, head) => {
        if (req.url !== '/api/admin/login-session/ws') {
            socket.destroy();
            return;
        }
        const cookieHeader = req.headers.cookie ?? '';
        const cookies = cookieHeader.split(';').map((c) => c.trim());
        const sessionCookie = cookies.find((c) => c.startsWith(`${auth_js_2.SESSION_COOKIE_NAME}=`));
        const token = sessionCookie ? sessionCookie.split('=')[1] : null;
        const result = token ? (0, user_repo_js_2.validateSession)(token) : null;
        // Same exemption as setupBridgeAuth, and it has to be here too: the HTTP
        // routes and this socket are one feature, so a cookie that fails for the
        // POST fails for the upgrade as well and the panel would open to a frame
        // that never paints.
        const duringSetup = setupMode && (0, setup_js_1.isSetupFlowActive)();
        if (!result && duringSetup) {
            const clientAddress = (0, link_quality_js_1.clientAddressFor)(req.socket.remoteAddress, req.headers['x-forwarded-for']);
            wss.handleUpgrade(req, socket, head, (ws) => {
                void login_bridge_js_1.loginBridge.attachSocket(ws, clientAddress);
            });
            return;
        }
        if (!result || (result.user.role !== 'superadmin' && result.user.role !== 'admin')) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
        }
        if (result.user.role !== 'superadmin') {
            const bridgeClan = login_bridge_js_1.loginBridge.getActiveClanId();
            if (bridgeClan !== null && bridgeClan !== result.user.clanId) {
                socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
                socket.destroy();
                return;
            }
        }
        // Resolve who's actually watching so the bridge can pick its streaming
        // profile: LAN clients get a smoother, higher-quality screencast, and
        // clients over the internet keep the bandwidth-saving one. Behind a
        // reverse proxy the socket peer is the proxy, so X-Forwarded-For wins.
        const clientAddress = (0, link_quality_js_1.clientAddressFor)(req.socket.remoteAddress, req.headers['x-forwarded-for']);
        wss.handleUpgrade(req, socket, head, (ws) => {
            void login_bridge_js_1.loginBridge.attachSocket(ws, clientAddress);
        });
    });
}
function startWebServer(port, scanLoop, options = {}) {
    const app = (0, express_1.default)();
    app.set('trust proxy', 1);
    app.disable('x-powered-by');
    const setupMode = options.setupMode === true;
    app.use((0, helmet_1.default)({
        /**
         * CSP, finally on. It was disabled outright, which left the cheap
         * directives off with it — a strict script policy is the hard part, and
         * nothing about that difficulty argues for allowing framing, arbitrary
         * form targets or a rewritten <base>.
         *
         * script-src keeps 'unsafe-inline' because each HTML shell carries one
         * small inline script: the theme bootstrap that reads localStorage and
         * stamps data-theme BEFORE first paint, which is what stops every page
         * flashing the wrong palette. Moving it out to a file would trade that
         * flash back for a marginally stronger policy, so the honest position is
         * to allow inline script and take the rest of the protection now.
         *
         * connect-src includes ws:/wss: for the login bridge's screencast, and
         * img-src allows data:/blob: because the bridge paints frames into a
         * canvas and several pages build images client-side.
         */
        contentSecurityPolicy: {
            useDefaults: true,
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'", "'unsafe-inline'"],
                styleSrc: ["'self'", "'unsafe-inline'"],
                imgSrc: ["'self'", 'data:', 'blob:'],
                connectSrc: ["'self'", 'ws:', 'wss:'],
                fontSrc: ["'self'", 'data:'],
                objectSrc: ["'none'"],
                baseUri: ["'self'"],
                formAction: ["'self'"],
                frameAncestors: ["'none'"],
                upgradeInsecureRequests: null,
            },
        },
        crossOriginEmbedderPolicy: false,
    }));
    // Body limits, scoped.
    //
    // Everything gets 1MB, which is generous for the largest ordinary payload
    // here (a list of overrides). Database restores need no exception: they
    // upload raw application/octet-stream slices (backup-upload.ts), which the
    // JSON parser never reads, and stream them to disk themselves.
    //
    // Any exception is registered BEFORE the global parser deliberately:
    // body-parser marks a request as parsed and later parsers skip it, so the
    // first matching limit is the one that applies.
    //
    // Resource screenshots arrive as an array of base64 images, each allowed up
    // to ~27MB encoded (see MAX_UPLOAD_BASE64_BYTES) and several per upload. The
    // route enforces the per-image size itself; this only has to be roomy enough
    // that a legitimate batch is not rejected before that check runs.
    app.use('/api/resources/upload', express_1.default.json({ limit: '110mb' }));
    app.use(express_1.default.json({ limit: '1mb' }));
    /**
     * A general ceiling on API traffic, per IP.
     *
     * Deliberately loose: the dashboard polls /api/status on a timer and several
     * people share one clan, so a tight limit would break normal use long before
     * it inconvenienced anyone. This is a runaway/abuse backstop, not a quota —
     * the login route keeps its own much stricter limiter (20 per 15 min).
     *
     * trust proxy is set above, so the key is the forwarded client IP rather than
     * the proxy's.
     */
    app.use('/api', (0, express_rate_limit_1.default)({
        windowMs: 60_000,
        max: 600,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Too many requests. Slow down and try again shortly.' },
        validate: { xForwardedForHeader: false },
    }));
    if (setupMode) {
        app.use('/api/setup', (0, setup_js_1.createSetupRouter)());
        const ensureSetupCompleted = (req, res, next) => {
            if ((0, setup_js_1.isSetupFlowActive)()) {
                if (req.path.startsWith('/api/')) {
                    res.status(409).json({ error: 'Setup still in progress.' });
                }
                else {
                    res.redirect('/setup');
                }
                return;
            }
            next();
        };
        app.get('/setup', (_req, res) => {
            if (!(0, setup_js_1.isSetupFlowActive)()) {
                (0, auth_js_2.denyCaching)(res);
                return res.redirect('/login');
            }
            sendHtml(res, 'setup.html');
        });
        // Setup-mode static assets: the wizard's own files plus every module its
        // `import` chain pulls in, served before the operator has an account (the
        // protected /v/:buildVersion/lib/* route below would redirect them, and a
        // single redirected import kills the whole module graph — see
        // src/web/setup-mode-assets.ts). Both the bare path and the versioned
        // `/v/<hash>/<file>` form are accepted, since the HTML is rewritten.
        for (const asset of setup_mode_assets_js_1.SETUP_MODE_ASSETS) {
            app.get([`/${asset}`, `/v/:buildVersion/${asset}`], (_req, res) => {
                res.setHeader('Cache-Control', 'no-store');
                res.sendFile(path_1.default.join(PUBLIC_DIR, asset));
            });
        }
        // Auth API needs to be reachable during setup so the cookie issued
        // by /api/setup/complete can be validated by /api/admin/login-session/*
        // (those routes call requireAdmin, which calls /api/auth/me path
        // logic via the same middleware). The ensureSetupCompleted gate on
        // /api/auth made sense before the wizard auto-issued a session;
        // now that it does, the gate would just lock the bridge out.
        app.use('/api/auth', (0, auth_js_1.createAuthRouter)());
        // Login bridge HTTP routes (gated on admin auth — the wizard's auto-
        // login from /api/setup/complete makes this pass). Mounting here, NOT
        // under the ensureSetupCompleted-guarded `/api` block below, is what
        // lets the wizard's embedded bridge talk to /api/admin/login-session/*.
        mountSetupModeLoginBridge(app);
        // Normal app routes become available automatically after setup completes.
        app.get('/login', ensureSetupCompleted, (_req, res) => {
            sendHtml(res, 'login.html');
        });
        app.get(['/login.js', '/v/:buildVersion/login.js'], ensureSetupCompleted, (_req, res) => {
            res.sendFile(path_1.default.join(PUBLIC_DIR, 'login.js'));
        });
        app.get(['/login.css', '/v/:buildVersion/login.css'], ensureSetupCompleted, (_req, res) => {
            res.sendFile(path_1.default.join(PUBLIC_DIR, 'login.css'));
        });
        app.use('/api', ensureSetupCompleted, auth_js_2.requireAuth, auth_js_2.requireClanContext, (0, api_js_1.createApiRouter)(scanLoop));
        app.use(ensureSetupCompleted, auth_js_2.requireAuth, express_1.default.static(PUBLIC_DIR, { index: false }));
        app.get('/{*path}', (_req, res) => {
            // Uncacheable for the same reason every other auth rejection is: this
            // catch-all answers for asset paths too, and a CDN that stores one
            // keeps serving it after setup completes.
            (0, auth_js_2.denyCaching)(res);
            if ((0, setup_js_1.isSetupFlowActive)()) {
                return res.redirect('/setup');
            }
            return res.redirect('/login');
        });
        const setupHttp = http_1.default.createServer(app);
        configureKeepAliveTimeouts(setupHttp);
        attachLoginBridgeUpgradeHandler(setupHttp, true);
        return setupHttp.listen(port, () => {
            log.info(`Setup wizard running at http://localhost:${port}/setup`);
        });
    }
    // Public routes (no auth)
    app.get('/login', (_req, res) => {
        sendHtml(res, 'login.html');
    });
    // Every script, stylesheet and image the pages load, to anyone. Never put
    // one behind requireAuth: Cloudflare stores the redirect against the asset
    // URL whatever our headers say — see ./frontend-assets.ts for the outage.
    app.use((0, frontend_assets_js_1.createFrontendAssetRouter)(PUBLIC_DIR, path_1.default.resolve('assets')));
    // robots.txt — disallow the public-share API namespace. The /<token>
    // page itself is short-form and unenumerable, so it relies on the
    // X-Robots-Tag header set by publicShareTokenHandler instead of a
    // path-prefix Disallow rule (we can't list a prefix that's unique to
    // tokens without leaking how to find them).
    app.get('/robots.txt', (_req, res) => {
        res.type('text/plain').send('User-agent: *\nDisallow: /api/public/\n');
    });
    // Build / version probe. Public (no auth) so external uptime monitors
    // can hit it without a session. Returns the build timestamp + a short
    // fingerprint of dist/index.js — together they answer "did the
    // running container actually pick up the latest commit?". See
    // src/utils/build-info.ts for the rationale (Portainer's git deploys
    // don't ship .git, so a real commit SHA isn't available at build
    // time).
    app.get('/api/health', (_req, res) => {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.json({
            ok: true,
            builtAt: build_info_js_1.BUILD_INFO.builtAt,
            fingerprint: build_info_js_1.BUILD_INFO.fingerprint,
        });
    });
    // Disable caching on all API responses. The dashboard reads stats and
    // tables that change frequently; a stale cached response makes it look
    // like writes silently failed.
    app.use('/api', (_req, res, next) => {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        next();
    });
    // Stash the per-clan ChestTracker poller on app.locals so the per-clan
    // settings save handler in /api/clans/:id/chesttracker can call
    // restartClan(id) without taking a hard import dep on the scheduler.
    if (options.externalLoop) {
        app.set('externalLoop', options.externalLoop);
    }
    // Public share API (no auth). Mounted before /api/auth so the
    // /api-wide cache-control middleware doesn't strip our private,no-store
    // header — the public-share router applies its own headers per response.
    app.use('/api/public', (0, public_share_js_1.createPublicShareApiRouter)());
    // Public share top-level key handler. Acts only on single-segment paths
    // that match the share-key regex (3-10 alphanumerics — a generated token or
    // an admin-chosen vanity key) and aren't in RESERVED_SHARE_KEYS; everything
    // else falls through to the rest of the routing table. Must be registered
    // *before* requireAuth so anonymous visitors with the URL don't get
    // redirected to /login — and *after* /login and the frontend asset router,
    // which is why those names are reserved against vanity keys.
    app.use(public_share_js_1.publicShareTokenHandler);
    // Auth API (login/logout - partially public)
    app.use('/api/auth', (0, auth_js_1.createAuthRouter)());
    // Multi-clan management. Superadmin CRUD + clan switcher (activate
    // endpoint) live here. Mounted before the catch-all /api router so
    // /api/clans doesn't collide with anything in api.ts.
    app.use('/api/clans', (0, clans_js_1.createClansRouter)(scanLoop));
    // The login bridge pauses the scan loop while it's open (a second headed
    // Chromium would fight the scanner for RAM). Wire its teardown hook so the
    // scanner resumes whenever the bridge ends — crucially including the
    // internal idle-teardown / max-session paths that never hit the
    // save/cancel routes. Without this, an abandoned login session left the
    // scanner paused indefinitely (dashboard stuck on "Next scan: now").
    if (scanLoop) {
        login_bridge_js_1.loginBridge.setTeardownHook(() => scanLoop.resume());
    }
    // Protected API routes (require auth + a clan context — non-superadmin
    // users with no clan_id are blocked here so they can't silently default
    // to clan 1 when an orphaned account was created by a bug).
    app.use('/api', auth_js_2.requireAuth, auth_js_2.requireClanContext, (0, api_js_1.createApiRouter)(scanLoop));
    // Chesttracker.com ingest routes (standard user login is enough — the
    // underlying data is already public on chesttracker.com itself).
    if (options.externalLoop) {
        app.use('/api/external', auth_js_2.requireAuth, auth_js_2.requireClanContext, (0, external_js_1.createExternalRouter)(options.externalLoop));
    }
    // Resource tracking: read-only data is visible to any authenticated clan
    // member; mutating routes (upload / edit / delete) enforce requireAdmin
    // individually inside the router.
    app.use('/api/resources', auth_js_2.requireAuth, auth_js_2.requireClanContext, (0, resources_js_1.createResourcesDataRouter)(scanLoop));
    // Member might (power level) history. All reads are clan-scoped clan data,
    // visible to any authenticated member; the on/off toggle inside the router
    // guards with requireSuperAdmin. Kept as its own mount so the feature can be
    // disabled or removed without touching the chest-data routes.
    app.use('/api/might', auth_js_2.requireAuth, auth_js_2.requireClanContext, (0, might_js_1.createMightRouter)(scanLoop));
    // Guards levels and Gold Pass holders — both inferred from resource and chest
    // data, so the reads are visible to any clan member; the one write (an admin
    // entering a member's level) guards with requireAdmin inside the router.
    app.use('/api/guards', auth_js_2.requireAuth, auth_js_2.requireClanContext, (0, guards_js_1.createGuardsRouter)());
    // Tools page (calculators). Read-only and open to every role — the tools run
    // in the browser, and this only supplies the caller's own clan roster.
    app.use('/api/tools', auth_js_2.requireAuth, auth_js_2.requireClanContext, (0, tools_js_1.createToolsRouter)());
    // Rise of the Ancients standings pasted after each summon (Events → Ancients).
    // Reads for any member; uploads and name assignment are admin-only inside.
    app.use('/api/tinman', auth_js_2.requireAuth, auth_js_2.requireClanContext, (0, tinman_js_1.createTinmanRouter)());
    // Player levels posted in chat (Admin → Levels from chat). Reads for any
    // member; preview and import are admin-only inside.
    app.use('/api/member-levels', auth_js_2.requireAuth, auth_js_2.requireClanContext, (0, member_levels_js_1.createMemberLevelsRouter)());
    // The rest of assets/ (OCR models, reference crops) stays behind a session —
    // nothing a page loads lives there. resource-icons/ and calibration-examples/
    // are served publicly by the frontend asset router above.
    app.use('/assets', auth_js_2.requireAuth, express_1.default.static(path_1.default.resolve('assets'), { maxAge: '86400000' }));
    // SPA fallback - protected. Serves a freshly-rewritten index.html with
    // ?v=BUILD_VERSION on JS/CSS references.
    app.get('/{*path}', auth_js_2.requireAuth, (_req, res) => {
        sendHtml(res, 'index.html');
    });
    // JSON error handler for /api routes. Express's default error handler
    // returns `text/html`, which makes the dashboard's `res.json()` calls
    // throw "JSON.parse: unexpected character" instead of surfacing the
    // real error to the user. Catch anything thrown (sync or async, since
    // express 5 forwards async rejections automatically) and respond with
    // a stable JSON shape so client error UI can render a useful message.
    app.use((err, req, res, next) => {
        if (res.headersSent) {
            return next(err);
        }
        if (req.path.startsWith('/api/')) {
            // Log the detail; return a reference, not the message.
            //
            // An unhandled error's message is written for a developer and routinely
            // carries a filesystem path, a SQL fragment or a library's internals.
            // The operator has the logs — and now a token to find the exact line
            // with, which is more useful to them than a message they would have had
            // to copy out of a browser anyway.
            const ref = Math.random().toString(36).slice(2, 10);
            log.error(`Unhandled error [${ref}] on ${req.method} ${req.path}: ${err.message}`);
            log.debug(err.stack ?? '(no stack)');
            return res.status(500).json({
                error: `Something went wrong. Reference ${ref} — the details are in the server log.`,
            });
        }
        return next(err);
    });
    const httpServer = http_1.default.createServer(app);
    configureKeepAliveTimeouts(httpServer);
    // WebSocket upgrade for the admin "remote login" bridge. The same
    // handler is reused in setup mode so the wizard's embedded bridge can
    // open a stream before the operator ever sees the main app.
    attachLoginBridgeUpgradeHandler(httpServer, setupMode);
    // Kick off the daily DB backup rotation. Skipped in setup mode
    // because the DB doesn't exist yet during the wizard.
    if (!setupMode) {
        (0, db_backup_js_1.startDailyBackupSchedule)();
    }
    return httpServer.listen(port, () => {
        const external = options.externalUrl?.trim();
        // Prefer the operator-configured public URL — that's the one
        // they'll paste into a browser. Without it, list every IPv4
        // address the container can actually see so the operator on a
        // fresh setup-wizard install isn't left guessing which URL to
        // open. On bare-metal / host-network Docker these are the real
        // LAN addresses; on bridge-mode Docker they're container-internal
        // IPs that won't work from outside the host — the trailing
        // WEB_EXTERNAL_URL hint nudges the operator to lock in a real
        // URL once they know what it is.
        if (external) {
            log.info(`Web dashboard running at ${external} (listening on :${port})`);
        }
        else {
            const urls = listReachableUrls(port);
            log.info(`Web dashboard available at ${urls.join(' or ')} (set WEB_EXTERNAL_URL to advertise a public URL)`);
        }
    });
}
/**
 * Collect every IPv4 URL the dashboard is reachable on from this
 * host's perspective: localhost plus every non-internal network
 * interface. Used at startup when WEB_EXTERNAL_URL is unset so the
 * operator gets a concrete "open this in your browser" hint instead
 * of a generic localhost line that's wrong inside a container.
 *
 * Addresses in the Docker bridge range (172.16.0.0/12) are masked to
 * `172.x.x.x` — they aren't reachable from outside the container
 * anyway so the precise host bits don't help the operator, and
 * printing them in operator logs would expose internal subnet
 * structure. LAN ranges (192.168.x.x, 10.x.x.x), Tailscale (100.64+),
 * and public IPs stay verbatim because the operator actually opens
 * those in a browser.
 */
function listReachableUrls(port) {
    const hosts = ['localhost'];
    for (const addrs of Object.values(os_1.default.networkInterfaces())) {
        for (const addr of addrs ?? []) {
            if (addr.family === 'IPv4' && !addr.internal) {
                const display = maskDockerBridge(addr.address);
                if (!hosts.includes(display)) {
                    hosts.push(display);
                }
            }
        }
    }
    return hosts.map((h) => `http://${h}:${port}`);
}
function maskDockerBridge(addr) {
    const octets = addr.split('.').map((n) => Number.parseInt(n, 10));
    if (octets.length !== 4 || octets.some((n) => !Number.isFinite(n)))
        return addr;
    // 172.16.0.0/12 — Docker default bridge plus every user-defined
    // bridge network unless the operator pinned a custom range.
    if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) {
        return '172.x.x.x';
    }
    return addr;
}
//# sourceMappingURL=server.js.map