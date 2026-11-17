/**
 * Read API for what the game protocol collects about players: the profile
 * header (role, joined, city level, VIP, Gold Pass, hero), research and hero
 * talents with their change history, and per-member hero avatars for lists.
 *
 * Mounted at /api/game behind requireAuth + requireClanContext, so `req.clanId`
 * is the caller's active clan and every query is scoped to it. A member that is
 * not linked to a game player yet answers `{ linked: false }`, not an error.
 */
import { Router } from 'express';
import { getMemberById } from '../../data/repositories/member-repo.js';
import {
  gamePlayerIdForMember,
  getGamePlayer,
  getGamePlayersByMember,
  getLatestCity,
  getPlayerTechChanges,
  getPlayerTechs,
} from '../../data/repositories/game-profile-repo.js';
import { getMemberTiers } from '../../data/member-tiers.js';
import { loadTechTrees } from '../../game-protocol/tech-trees.js';

const CHANGES_DAYS = 90;

export function createGameRouter(): Router {
  const router = Router();

  /** Profile header data for one member. */
  router.get('/members/:memberId', (req, res) => {
    const clanId = req.clanId!;
    const memberId = Number.parseInt(String(req.params.memberId), 10);
    if (!Number.isFinite(memberId) || !getMemberById(memberId, clanId)) {
      res.status(404).json({ error: 'Member not found' });
      return;
    }
    const playerId = gamePlayerIdForMember(memberId, clanId);
    if (playerId === null) {
      res.json({ linked: false });
      return;
    }
    res.json({
      linked: true,
      player: getGamePlayer(clanId, playerId),
      city: getLatestCity(clanId, playerId),
      // G/S/E/M tiers and crypt level from the member's research (null until read).
      tiers: getMemberTiers(clanId).get(memberId) ?? null,
    });
  });

  /** Research + hero talent levels for one member, and their recent changes. */
  router.get('/members/:memberId/techs', (req, res) => {
    const clanId = req.clanId!;
    const memberId = Number.parseInt(String(req.params.memberId), 10);
    if (!Number.isFinite(memberId) || !getMemberById(memberId, clanId)) {
      res.status(404).json({ error: 'Member not found' });
      return;
    }
    const playerId = gamePlayerIdForMember(memberId, clanId);
    if (playerId === null) {
      res.json({ linked: false, levels: {}, readAt: null, changes: [] });
      return;
    }
    const { levels, readAt } = getPlayerTechs(clanId, playerId);
    const since = new Date(Date.now() - CHANGES_DAYS * 86_400_000).toISOString();
    res.json({ linked: true, levels, readAt, changes: getPlayerTechChanges(clanId, playerId, since) });
  });

  /** memberId → hero avatar id and a few headline game facts, for avatars in lists. */
  router.get('/roster', (req, res) => {
    const clanId = req.clanId!;
    const tiers = getMemberTiers(clanId);
    const out: Record<number, object> = {};
    for (const [memberId, p] of getGamePlayersByMember(clanId)) {
      out[memberId] = {
        heroAvatar: p.heroAvatar, heroLevel: p.heroLevel, role: p.role, goldPass: p.goldPass, vip: p.vip, cityLevel: p.cityLevel,
        tiers: tiers.get(memberId)?.tiers ?? null,
      };
    }
    res.json({ members: out });
  });

  /**
   * The game's research and talent trees (names, layout, prerequisites), for
   * drawing a member's levels. The same for every clan; the client caches it by
   * `version`.
   */
  router.get('/tech-trees', async (_req, res) => {
    try {
      res.json(await loadTechTrees());
    } catch {
      res.status(503).json({ error: 'Research trees are not available yet' });
    }
  });

  return router;
}
