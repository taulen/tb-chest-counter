import type { Router } from 'express';
import { getClanById } from '../../../data/repositories/clan-repo.js';
import { getPostableChannels } from '../../../data/repositories/chat-digest-repo.js';
import {
  MAX_REPORT_CHATS, TINMAN_STACK_CHOICES, getReportChats, getTinmanRequiredStacks, reportCounts, setReportChats,
  setTinmanRequiredStacks,
} from '../../../data/repositories/battle-report-repo.js';
import { logAction } from '../../../data/repositories/user-repo.js';
import { requireClanAdmin } from '../../middleware/auth.js';
import { createClanSubRouter } from './_shared.js';

/**
 * Battle reports shared in chat (docs/battle-reports.md): the clan chat and
 * private messages to the scanner account are always read; an admin adds up to
 * MAX_REPORT_CHATS of the account's group chats (a "Tin Man hits" or "citadels"
 * chat). Also the clan's Tin Man rule: hit it while it still has N stacks.
 * Clan admins only. Nothing here sends anything in the game.
 */
export function createBattleReportsRouter(): Router {
  const router = createClanSubRouter();

  router.get('/:clanId/battle-reports', requireClanAdmin, (req, res) => {
    const id = req.parsedClanId!;
    if (!getClanById(id)) {
      res.status(404).json({ error: 'Clan not found' });
      return;
    }
    const groups = getPostableChannels(id);
    const picked = getReportChats(id);
    const pickedUrls = new Set(picked.map((c) => c.url));
    res.json({
      // The account's group chats, picked or not, then picked chats it has left.
      chats: [
        ...groups.map((c) => ({ url: c.url, name: c.name, memberCount: c.memberCount, picked: pickedUrls.has(c.url), member: true })),
        ...picked.filter((p) => !groups.some((g) => g.url === p.url))
          .map((p) => ({ url: p.url, name: p.name, memberCount: 0, picked: true, member: false })),
      ],
      maxChats: MAX_REPORT_CHATS,
      requiredStacks: getTinmanRequiredStacks(id),
      stackChoices: TINMAN_STACK_CHOICES,
      reports: reportCounts(id),
    });
  });

  router.put('/:clanId/battle-reports', requireClanAdmin, (req, res) => {
    const id = req.parsedClanId!;
    if (!getClanById(id)) {
      res.status(404).json({ error: 'Clan not found' });
      return;
    }
    const body = req.body ?? {};
    if (body.chats !== undefined) {
      if (!Array.isArray(body.chats) || body.chats.some((u: unknown) => typeof u !== 'string')) {
        res.status(400).json({ error: 'chats must be a list of chats' });
        return;
      }
      const urls = [...new Set(body.chats as string[])];
      if (urls.length > MAX_REPORT_CHATS) {
        res.status(400).json({ error: `At most ${MAX_REPORT_CHATS} chats` });
        return;
      }
      // A chat must be one of the account's group chats — or one already picked
      // (it may have left it; unticking must still work).
      const groups = getPostableChannels(id);
      const current = getReportChats(id);
      const chosen: Array<{ url: string; name: string }> = [];
      for (const url of urls) {
        const c = groups.find((g) => g.url === url) ?? current.find((p) => p.url === url);
        if (!c) {
          res.status(400).json({ error: 'Pick one of the group chats the scanner account is in' });
          return;
        }
        chosen.push({ url: c.url, name: c.name });
      }
      const saved = setReportChats(id, chosen);
      logAction(req.user!.id, 'clan.battle_report_chats.update', { clanId: id, chats: saved.map((c) => c.name) });
    }
    if (body.requiredStacks !== undefined) {
      const n = body.requiredStacks === null || body.requiredStacks === '' ? null : Number(body.requiredStacks);
      if (n !== null && !(TINMAN_STACK_CHOICES as readonly number[]).includes(n)) {
        res.status(400).json({ error: `requiredStacks must be one of ${TINMAN_STACK_CHOICES.join(', ')} or empty` });
        return;
      }
      setTinmanRequiredStacks(id, n);
      logAction(req.user!.id, 'clan.tinman_rule.update', { clanId: id, requiredStacks: n });
    }
    res.json({ ok: true, chats: getReportChats(id), requiredStacks: getTinmanRequiredStacks(id) });
  });

  return router;
}
