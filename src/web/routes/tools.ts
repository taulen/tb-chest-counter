/**
 * Tools page data. The calculators themselves run in the browser
 * (web/public/lib/ancient-planner.js); the server supplies what they prefill
 * from and keeps each clan's starting values.
 *
 * Mounted at /api/tools behind requireAuth + requireClanContext. Reads are open
 * to every role; saving the clan's defaults is admin-only and lands on the
 * caller's active clan (req.clanId), so an admin can only ever set their own.
 * Citadel presets belong to the signed-in ACCOUNT (req.user.id), any role, and
 * are never visible to anyone else.
 */
import { Router } from 'express';
import { getAncientRoster } from '../../data/ancient-roster.js';
import { getClanAncientDefaults, setClanAncientDefaults } from '../../data/repositories/clan-repo.js';
import {
  deleteCitadelPreset,
  listCitadelPresets,
  MAX_PRESETS_PER_USER,
  parseCitadelPreset,
  saveCitadelPreset,
} from '../../data/repositories/citadel-preset-repo.js';
import { logAction } from '../../data/repositories/user-repo.js';
import { BUILT_IN_ANCIENT_DEFAULTS, parseAncientSettings } from '../../config/ancient-planner-defaults.js';
import { requireAdmin } from '../middleware/auth.js';
import { loadConfig } from '../../config/index.js';
import { currentGameDate } from '../../utils/game-day.js';

function ancientDefaults(clanId: number) {
  const saved = getClanAncientDefaults(clanId);
  return saved
    ? { source: 'clan' as const, ...saved }
    : { source: 'built-in' as const, settings: { ...BUILT_IN_ANCIENT_DEFAULTS }, savedAt: null, savedBy: null };
}

export function createToolsRouter(): Router {
  const router = Router();

  /**
   * Members per guards level for the Ancient planner (see data/ancient-roster.ts),
   * plus the values the page opens on.
   */
  router.get('/ancient-roster', (req, res) => {
    const clanId = req.clanId!;
    const today = currentGameDate(loadConfig().gameDayRolloverUtcHour);
    res.json({ today, ...getAncientRoster(clanId, today), defaults: ancientDefaults(clanId) });
  });

  /** Save the current planner settings as this clan's starting values. */
  router.put('/ancient-defaults', requireAdmin, (req, res) => {
    const clanId = req.clanId!;
    const parsed = parseAncientSettings(req.body?.settings);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.errors.join('; ') });
      return;
    }
    setClanAncientDefaults(clanId, {
      settings: parsed.settings,
      savedAt: new Date().toISOString(),
      savedBy: req.user!.username,
    });
    logAction(req.user!.id, 'ancient_defaults_save', { clanId, ...parsed.settings });
    res.json({ ok: true, defaults: ancientDefaults(clanId) });
  });

  /** The signed-in account's saved citadel armies. */
  router.get('/citadel-presets', (req, res) => {
    res.json({ presets: listCitadelPresets(req.user!.id) });
  });

  /** Save the current army under a name (the same name overwrites). */
  router.put('/citadel-presets', (req, res) => {
    const parsed = parseCitadelPreset(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.errors.join('; ') });
      return;
    }
    const preset = saveCitadelPreset(req.user!.id, parsed.value.name, parsed.value.data);
    if (!preset) {
      res.status(409).json({ error: `You can keep at most ${MAX_PRESETS_PER_USER} saved armies. Delete one first.` });
      return;
    }
    res.json({ ok: true, preset, presets: listCitadelPresets(req.user!.id) });
  });

  router.delete('/citadel-presets/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0 || !deleteCitadelPreset(req.user!.id, id)) {
      res.status(404).json({ error: 'No such saved army.' });
      return;
    }
    res.json({ ok: true, presets: listCitadelPresets(req.user!.id) });
  });

  return router;
}
