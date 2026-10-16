"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createFrontendAssetRouter = createFrontendAssetRouter;
const path_1 = __importDefault(require("path"));
const express_1 = __importStar(require("express"));
/**
 * The frontend's static files — every script, stylesheet and image a page
 * loads — served to anyone, session or not.
 *
 * They used to sit behind requireAuth, and that gate is what left the app
 * blank on a phone for the length of a holiday (Oct 2026) while the same
 * account worked on a desktop at home. Cloudflare caches by file extension and
 * overrides the origin's Cache-Control, so ONE logged-out request for
 * `/v/<build>/app.js` stores the `302 -> /login` at that edge location for
 * ~22 hours. `denyCaching()`'s `private, no-store` does not stop it: a
 * throwaway probe URL came back `cf-cache-status: HIT` on its second request.
 * From then on every visitor routed through that location gets the redirect
 * in place of a module, one failed import aborts the whole graph, and a
 * perfectly good login lands on an empty shell. Each Cloudflare location
 * caches on its own, which is why it read as a mobile bug: the desktop's
 * location held the real file, the phone's held the redirect.
 *
 * The gate never protected anything. The repository is public, so is every
 * file here, and the edge was already handing its cached 200 to anyone who
 * asked. All it could add was that failure — and the hand-kept allowlist the
 * public share page needed to get around it, whose one missing entry once cost
 * every share link 18 hours. The auth boundary is /api, where the data is.
 *
 * HTML is the exception: the shells go through the version rewriter and the
 * SPA fallback, so a `.html` path falls through to the routes after this one,
 * as does anything that isn't a file here (a directory, a missing path).
 */
/** The /assets subdirectories the frontend references (resource-format.js, system.js). */
const PUBLIC_ASSET_DIRS = ['resource-icons', 'calibration-examples'];
function skipHtml(handler) {
    return (req, res, next) => (path_1.default.extname(req.path).toLowerCase() === '.html' ? next() : handler(req, res, next));
}
function createFrontendAssetRouter(publicDir, assetsDir) {
    const router = (0, express_1.Router)();
    // Chart.js from the dependency that is already installed, rather than a CDN.
    //
    // It was loaded from jsdelivr, which makes a self-hosted tool depend on a
    // third party being up and on whatever that third party serves — and would
    // force the CSP to allow an external script origin. It is in package.json
    // and therefore in the image; serve it from there.
    router.get(['/vendor/chart.umd.js', '/v/:buildVersion/vendor/chart.umd.js'], (_req, res) => {
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.type('application/javascript');
        res.sendFile(path_1.default.resolve('node_modules/chart.js/dist/chart.umd.js'));
    });
    // Versioned: the HTML rewrite (./asset-versioning.ts) prefixes every
    // entry-point reference with `/v/<BUILD_VERSION>/`, and relative imports
    // inherit it. The URL is unique per build, so immutable + a year is always
    // correct for it.
    router.use('/v/:buildVersion', skipHtml((_req, res, next) => {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        next();
    }), skipHtml(express_1.default.static(publicDir, { index: false, redirect: false })));
    // Bare, un-versioned paths: kept for any URL a browser cached before the
    // version prefix existed. no-store, because an ES module's relative imports
    // resolve against the importer's own URL — a stale bare copy would mix with
    // fresh ones and break on a "does not provide an export named X".
    router.use(skipHtml(express_1.default.static(publicDir, {
        index: false,
        redirect: false,
        setHeaders: (res) => {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        },
    })));
    for (const dir of PUBLIC_ASSET_DIRS) {
        router.use(`/assets/${dir}`, express_1.default.static(path_1.default.join(assetsDir, dir), {
            maxAge: 86_400_000,
            redirect: false,
        }));
    }
    return router;
}
//# sourceMappingURL=frontend-assets.js.map