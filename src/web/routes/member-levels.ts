/**
 * Player levels posted in the in-game chat (Admin → Levels from chat). See
 * data/repositories/member-levels-repo.ts.
 *
 * Mounted at /api/member-levels behind requireAuth + requireClanContext.
 * Reading the latest levels is open to every member; previewing and importing
 * a paste are admin-only, and everything is scoped to the caller's clan.
 */
import { Router } from 'express';
import { parseLevelReports } from '../../data/member-levels-parse.js';
import * as levelsRepo from '../../data/repositories/member-levels-repo.js';
import { getGuardsSummaries } from '../../data/repositories/guards-repo.js';
import { logAction } from '../../data/repositories/user-repo.js';
import { requireAdmin } from '../middleware/auth.js';
import { loadConfig } from '../../config/index.js';
import { currentGameDate } from '../../utils/game-day.js';

const MAX_TEXT_LENGTH = 200_000;
const MAX_ENTRIES = 300;

export function createMemberLevelsRouter(): Router {
  const router = Router();
  const today = () => currentGameDate(loadConfig().gameDayRolloverUtcHour);

  /** Each member's latest reported levels, next to the guards estimate. */
  router.get('/', (req, res) => {
    const clanId = req.clanId!;
    const guards = getGuardsSummaries(clanId, today());
    res.json({
      today: today(),
      rows: levelsRepo.getLatestLevels(clanId).map((r) => ({
        ...r,
        guardsEstimate: guards.get(r.memberId)?.level ?? null,
      })),
    });
  });

  /** Parse a chat paste and match its names — nothing is saved. */
  router.post('/preview', requireAdmin, (req, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text : '';
    if (!text.trim() || text.length > MAX_TEXT_LENGTH) {
      res.status(400).json({ error: 'Paste the chat lines first.' });
      return;
    }
    const parsed = parseLevelReports(text);
    if (parsed.players.length === 0) {
      res.status(400).json({
        error: 'No levels found. Expected lines like "taulen: G8/M8/S7/E8/C35/D284".',
        skipped: parsed.skipped.slice(0, 5),
      });
      return;
    }
    res.json({ rows: levelsRepo.previewLevelReports(req.clanId!, parsed.players), skipped: parsed.skipped });
  });

  /**
   * Save reviewed rows: { entries: [{ memberId, levels, raw }] }. Dated the
   * game day it is saved — a chat post is what the player said today.
   */
  router.post('/import', requireAdmin, (req, res) => {
    const clanId = req.clanId!;
    const date = today();
    const entries = Array.isArray(req.body?.entries) ? req.body.entries : null;
    if (!entries || entries.length === 0 || entries.length > MAX_ENTRIES) {
      res.status(400).json({ error: 'Pick at least one player to save.' });
      return;
    }
    const result = levelsRepo.importLevelReports({
      clanId,
      date,
      entries: entries.map((e: { memberId?: unknown; levels?: unknown; raw?: unknown }) => ({
        memberId: Number(e?.memberId),
        levels: levelsRepo.cleanLevels(e?.levels),
        raw: typeof e?.raw === 'string' ? e.raw : '',
      })),
      createdBy: req.user!.username,
      createdByUserId: req.user!.id,
    });
    logAction(req.user!.id, 'member_levels_import', { clanId, date, ...result });
    res.json({ ok: true, result });
  });

  return router;
}
