/**
 * Tools → What's new: what each game patch added, read from the game's own
 * files (src/game-patch/notes.ts). Game data, the same for every clan, so
 * any signed-in member reads it (mounted behind requireAuth).
 *
 *   GET /api/game-updates          every patch noted, newest first (summaries)
 *   GET /api/game-updates/:id      one patch's notes; ?lang=de|es|fr|ru adds
 *                                  that language's texts beside the English
 */
import { Router } from 'express';
import { currentGameArt } from '../../game-art/index.js';
import { patchList, patchNotesView } from '../../game-patch/notes.js';
import { NOTE_LANGS, type NoteLang } from '../../game-patch/notes-diff.js';

const isNoteLang = (v: unknown): v is NoteLang => typeof v === 'string' && (NOTE_LANGS as readonly string[]).includes(v);

export function createGameUpdatesRouter(): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json({ patches: patchList() });
  });

  router.get('/:id', (req, res) => {
    const lang = isNoteLang(req.query.lang) ? req.query.lang : 'en';
    const view = patchNotesView(String(req.params.id), lang, currentGameArt());
    if (!view) {
      res.status(404).json({ error: 'No such patch' });
      return;
    }
    res.json(view);
  });

  return router;
}
