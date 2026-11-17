"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createGameTextsRouter = createGameTextsRouter;
/**
 * GET /api/game-texts/:lang — the game's own names in one site language
 * (de, es, fr, ru), for tGame() in lib/i18n.js: `{ version, lang, format,
 * builtAt, texts: { English: localized } }`, keys with {n} being patterns.
 *
 * Public: the login page and the public share page translate names too, and
 * this is the game's public data. Served from the texts-<lang>.json the names
 * build writes (src/game-protocol/game-texts.ts) — a request never downloads
 * anything. When there are none yet it answers 404, and the site shows names
 * in English.
 *
 * Caching: an /api path with no file extension, so Cloudflare passes it
 * through (docs/cloudflare-caching.md); the browser keeps it ten minutes, then
 * revalidates by ETag (a 304 while the game data is unchanged).
 */
const express_1 = require("express");
const static_data_js_1 = require("../../game-protocol/static-data.js");
const game_texts_js_1 = require("../../game-protocol/game-texts.js");
const logger_js_1 = require("../../utils/logger.js");
const log = (0, logger_js_1.childLogger)('game-texts');
/** How often a request may make the server check the game for a new version (cheap when nothing changed). */
const REFRESH_MS = 10 * 60_000;
function createGameTextsRouter(opts = {}) {
    const router = (0, express_1.Router)();
    const refresh = opts.refresh ?? static_data_js_1.loadGameNames;
    let lastRefresh = 0;
    let refreshing = null;
    /** In the background, at most every REFRESH_MS: pick up a game patch (or build the first texts). */
    const maybeRefresh = () => {
        if (refreshing || Date.now() - lastRefresh < REFRESH_MS)
            return;
        lastRefresh = Date.now();
        refreshing = refresh()
            .catch((err) => log.warn({ noAlert: true }, `Game texts refresh failed: ${String(err)}`))
            .finally(() => {
            refreshing = null;
        });
    };
    router.get('/api/game-texts/:lang', (req, res) => {
        const lang = String(req.params.lang ?? '');
        if (!(0, game_texts_js_1.isGameTextLanguage)(lang)) {
            res.setHeader('Cache-Control', 'no-store');
            res.status(404).json({ error: 'Unknown language' });
            return;
        }
        maybeRefresh();
        const texts = (0, game_texts_js_1.gameTextsResponse)(lang);
        if (!texts) {
            res.setHeader('Cache-Control', 'no-store');
            res.status(404).json({ error: 'No game texts yet' });
            return;
        }
        res.setHeader('Cache-Control', 'private, max-age=600');
        res.setHeader('ETag', texts.etag);
        if (req.fresh) {
            res.status(304).end();
            return;
        }
        res.type('application/json').send(texts.body);
    });
    return router;
}
//# sourceMappingURL=game-texts.js.map