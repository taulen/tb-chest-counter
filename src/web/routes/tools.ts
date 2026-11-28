/**
 * Tools page data. The calculators themselves run in the browser
 * (web/public/lib/ancient-planner.js); the server supplies what they prefill
 * from and keeps each clan's starting values.
 *
 * Mounted at /api/tools behind requireAuth + requireClanContext. Reads are open
 * to every role; saving the clan's defaults is admin-only and lands on the
 * caller's active clan (req.clanId), so an admin can only ever set their own.
 * Citadel and stack presets belong to the signed-in ACCOUNT (req.user.id), any
 * role, and are never visible to anyone else. GET /report-armies lists the
 * armies of shared battle reports: the account's own players' from every
 * clan's chats, anyone else's only as shared in the active clan.
 */
import { Router } from 'express';
import { REPORT_WINDOW_DAYS, loadCitadels, reportArmiesFor, reportPlayers } from '../../data/report-armies.js';
import { waitingReportCount } from '../../data/repositories/battle-report-repo.js';
import { linksForUser } from '../../data/repositories/account-invite-repo.js';
import { getAncientRoster } from '../../data/ancient-roster.js';
import { getClanAncientDefaults, setClanAncientDefaults } from '../../data/repositories/clan-repo.js';
import {
  deleteCitadelPreset,
  getCitadelLevels,
  listCitadelPresets,
  MAX_PRESETS_PER_USER,
  parseCitadelLevels,
  parseCitadelPreset,
  saveCitadelLevels,
  saveCitadelPreset,
} from '../../data/repositories/citadel-preset-repo.js';
import {
  deleteStackPreset,
  listStackPresets,
  parseStackPreset,
  saveStackPreset,
} from '../../data/repositories/stack-preset-repo.js';
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

  /**
   * Battle-report armies for "fill in from a battle report" (Citadel, Stacks),
   * the last REPORT_WINDOW_DAYS only: the players to pick from — the
   * account's own (every clan's shares) and anyone who fought or posted a
   * readable battle in the active clan — and the battles. By default the
   * account's own players' together (`player` = their id when there's one,
   * 'own' for several, null for none); `?player=<id>` one player's — another
   * player's only as shared in the active clan. `?only=citadels`: citadel
   * battles only (Tools → Citadel).
   */
  router.get('/report-armies', async (req, res) => {
    const clanId = req.clanId!;
    const own = [...new Set(linksForUser(req.user!.id).map((l) => l.playerId))];
    const citadels = req.query.only === 'citadels' ? await loadCitadels() : null;
    const filter = { targets: citadels ? Object.keys(citadels).map(Number) : null };
    const players = reportPlayers(clanId, own, filter);
    const mine = players.filter((p) => p.own).map((p) => p.playerId);
    const picked = players.find((p) => String(p.playerId) === String(req.query.player ?? '')) ?? null;
    const ids = picked ? [picked.playerId] : mine;
    const player: number | 'own' | null = picked ? picked.playerId : mine.length > 1 ? 'own' : mine[0] ?? null;
    const reports = ids.length
      ? await reportArmiesFor(ids, { clanId: picked && !picked.own ? clanId : null, namesClanId: clanId, ...filter })
      : [];
    res.json({
      linked: own.length > 0, players, player, reports, waiting: waitingReportCount(),
      windowDays: REPORT_WINDOW_DAYS, only: citadels ? 'citadels' : null,
    });
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

  /** The caller's unlocked troop tiers (per account; null = any). */
  router.get('/citadel-levels', (req, res) => {
    res.json({ levels: getCitadelLevels(req.user!.id) });
  });

  router.put('/citadel-levels', (req, res) => {
    const parsed = parseCitadelLevels(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.errors.join('; ') });
      return;
    }
    res.json({ ok: true, levels: saveCitadelLevels(req.user!.id, parsed.value) });
  });

  /** The signed-in account's saved stack-calculator armies. */
  router.get('/stack-presets', (req, res) => {
    res.json({ presets: listStackPresets(req.user!.id) });
  });

  /** Save the current troops and settings under a name (the same name overwrites). */
  router.put('/stack-presets', (req, res) => {
    const parsed = parseStackPreset(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.errors.join('; ') });
      return;
    }
    const preset = saveStackPreset(req.user!.id, parsed.value.name, parsed.value.data);
    if (!preset) {
      res.status(409).json({ error: `You can keep at most ${MAX_PRESETS_PER_USER} saved armies. Delete one first.` });
      return;
    }
    res.json({ ok: true, preset, presets: listStackPresets(req.user!.id) });
  });

  router.delete('/stack-presets/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0 || !deleteStackPreset(req.user!.id, id)) {
      res.status(404).json({ error: 'No such saved army.' });
      return;
    }
    res.json({ ok: true, presets: listStackPresets(req.user!.id) });
  });

  return router;
}
