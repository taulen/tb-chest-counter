/**
 * Guards (guardsmen) levels and Gold Pass holders, both as the game reports
 * them: the level is the Guardsmen tier from each member's research
 * (guards-repo.ts), the pass the flag on their game record (gold-pass-repo.ts).
 * Read-only — nothing here is entered by hand any more.
 *
 * Mounted at /api/guards behind requireAuth + requireClanContext, so `req.clanId`
 * is the caller's active clan and every query below is scoped to it.
 */
import { Router } from 'express';
import * as guardsRepo from '../../data/repositories/guards-repo.js';
import * as goldPassRepo from '../../data/repositories/gold-pass-repo.js';
import { getAllMembers, getMemberById } from '../../data/repositories/member-repo.js';
import { getLatestLevelsForMember } from '../../data/repositories/member-levels-repo.js';
import { getGamePlayersByMember } from '../../data/repositories/game-profile-repo.js';
import { loadConfig } from '../../config/index.js';
import { GUARDS_STALE_DAYS } from '../../config/guards-levels.js';
import { currentGameDate } from '../../utils/game-day.js';
import { parseBoundedInt } from '../../utils/parse-int.js';

export function createGuardsRouter(): Router {
  const router = Router();

  /**
   * Everything the roster tables and the Analytics overview need in one call:
   * each member's level and Gold Pass status, plus the clan's make-up. Members
   * with neither are still listed, with nulls, so a table can show the whole
   * roster and mark the gaps.
   */
  router.get('/overview', (req, res) => {
    const clanId = req.clanId!;
    const rolloverHr = loadConfig().gameDayRolloverUtcHour;
    const nowMs = Date.now();
    const today = currentGameDate(rolloverHr);

    const summaries = guardsRepo.getGuardsSummaries(clanId, today);
    const goldPass = goldPassRepo.getGoldPassStatuses(clanId, nowMs, rolloverHr);
    // Shield / burning as the map shows the city (v112) — for the list's marks.
    const players = getGamePlayersByMember(clanId);
    const active = getAllMembers(true, clanId);
    const activeIds = new Set(active.map((m) => m.id));
    const countActive = (ids: Iterable<number>): number => {
      let n = 0;
      for (const id of ids) if (activeIds.has(id)) n++;
      return n;
    };

    // Last cycle only when the game history covers all of it: a part-covered
    // cycle would undercount and read as a real drop.
    const prevCycle = goldPassRepo.triumphalCycle(nowMs, rolloverHr, 1);
    const prevWindow = prevCycle ? goldPassRepo.goldPassForWindow(clanId, prevCycle.from, prevCycle.to) : null;
    const curCycle = goldPassRepo.triumphalCycle(nowMs, rolloverHr, 0);

    res.json({
      rows: active.map((m) => ({
        memberId: m.id,
        name: m.name,
        guards: summaries.get(m.id) ?? null,
        goldPass: goldPass.get(m.id) ?? null,
        shielded: players.get(m.id)?.shielded ?? null,
        burning: players.get(m.id)?.burning ?? null,
      })),
      today,
      staleDays: GUARDS_STALE_DAYS,
      clan: {
        activeMembers: active.length,
        guards: guardsRepo.getClanGuardsOverview(clanId, today),
        goldPass: {
          // Active members only, so the share is "of the clan as it is now".
          current: {
            firstDay: curCycle?.firstDay ?? null,
            lastDay: curCycle?.lastDay ?? null,
            holders: countActive(goldPassRepo.goldPassHoldersNow(clanId)),
          },
          previous: prevCycle && prevWindow?.basis === 'game'
            ? { firstDay: prevCycle.firstDay, lastDay: prevCycle.lastDay, holders: countActive(prevWindow.memberIds) }
            : null,
        },
      },
    });
  });

  /** One member: their level with its level-ups, and what they last posted in chat. */
  router.get('/member/:memberId', (req, res) => {
    const clanId = req.clanId!;
    const memberId = parseBoundedInt(req.params.memberId, 0, { min: 1 });
    const member = memberId ? getMemberById(memberId, clanId) : null;
    if (!member) {
      res.status(404).json({ error: 'Member not found' });
      return;
    }
    const today = currentGameDate(loadConfig().gameDayRolloverUtcHour);
    const guards = guardsRepo.getGuardsLevels(clanId).get(memberId) ?? null;
    res.json({
      memberId,
      name: member.name,
      today,
      staleDays: GUARDS_STALE_DAYS,
      guards,
      summary: guards ? guardsRepo.summarizeGuards(guards, today) : null,
      // What the member last posted in chat (Admin → Levels from chat), every
      // letter; the profile keeps only what research can't tell (Dragon).
      reportedLevels: getLatestLevelsForMember(clanId, memberId),
    });
  });

  return router;
}
