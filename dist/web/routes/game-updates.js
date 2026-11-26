"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createGameUpdatesRouter = createGameUpdatesRouter;
/**
 * Tools → What's new: what each game patch added, read from the game's own
 * files (src/game-patch/notes.ts). Game data, the same for every clan, so
 * any signed-in member reads it (mounted behind requireAuth).
 *
 *   GET /api/game-updates          every patch noted, newest first (summaries)
 *   GET /api/game-updates/:id      one patch's notes; ?lang=de|es|fr|ru adds
 *                                  that language's texts beside the English
 */
const express_1 = require("express");
const index_js_1 = require("../../game-art/index.js");
const notes_js_1 = require("../../game-patch/notes.js");
const notes_diff_js_1 = require("../../game-patch/notes-diff.js");
const isNoteLang = (v) => typeof v === 'string' && notes_diff_js_1.NOTE_LANGS.includes(v);
function createGameUpdatesRouter() {
    const router = (0, express_1.Router)();
    router.get('/', (_req, res) => {
        res.json({ patches: (0, notes_js_1.patchList)() });
    });
    router.get('/:id', (req, res) => {
        const lang = isNoteLang(req.query.lang) ? req.query.lang : 'en';
        const view = (0, notes_js_1.patchNotesView)(String(req.params.id), lang, (0, index_js_1.currentGameArt)());
        if (!view) {
            res.status(404).json({ error: 'No such patch' });
            return;
        }
        res.json(view);
    });
    return router;
}
//# sourceMappingURL=game-updates.js.map