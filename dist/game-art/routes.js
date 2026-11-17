"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createGameArtRouter = createGameArtRouter;
/**
 * Serving the extracted game art.
 *
 *   GET /game-art/<version>/<name>.png   public, immutable for a year
 *   GET /api/game-art                    { version, base, names, categories, mappings }
 *
 * Public on purpose: static files never sit behind auth (Cloudflare caches by
 * extension whatever the origin says — docs/cloudflare-caching.md), and the
 * URL is versioned by the catalogue hash, so a new game version is a new URL.
 * Only the current and previous versions are served; anything not in that
 * version's index is a 404, and both path segments are matched against strict
 * patterns before they touch the file system.
 */
const path_1 = __importDefault(require("path"));
const express_1 = require("express");
const selection_js_1 = require("./selection.js");
const mappings_js_1 = require("./mappings.js");
const store_js_1 = require("./store.js");
function notFound(res) {
    res.status(404).type('text/plain').send('Not found');
}
function createGameArtRouter(opts = {}) {
    const router = (0, express_1.Router)();
    const dirOf = () => opts.dir ?? (0, store_js_1.gameArtDir)();
    router.get('/game-art/:version/:file', (req, res) => {
        const version = String(req.params.version ?? '');
        const file = String(req.params.file ?? '');
        if (!store_js_1.VERSION_RE.test(version) || !store_js_1.FILE_RE.test(file))
            return notFound(res);
        const dir = dirOf();
        if (!(0, store_js_1.servedVersions)(dir).has(version))
            return notFound(res);
        const img = (0, store_js_1.loadIndex)(dir, version)?.images[file.slice(0, -'.png'.length)];
        if (!img || img.file !== file)
            return notFound(res);
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.type('png');
        res.sendFile(path_1.default.join(dir, version, file), { dotfiles: 'deny' }, (err) => {
            if (err && !res.headersSent)
                notFound(res);
        });
    });
    router.get('/api/game-art', (_req, res) => {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        const index = (0, store_js_1.currentGameArt)(dirOf());
        if (!index) {
            res.json({ version: null, base: null, names: [], categories: {}, mappings: (0, mappings_js_1.emptyMappings)() });
            return;
        }
        const categories = Object.fromEntries(selection_js_1.ART_CATEGORIES.map((c) => [c, []]));
        for (const [name, img] of Object.entries(index.images))
            categories[img.category]?.push(name);
        res.json({
            version: index.version,
            base: `/game-art/${index.version}/`,
            names: Object.keys(index.images),
            categories,
            mappings: index.mappings,
        });
    });
    return router;
}
//# sourceMappingURL=routes.js.map