import type { Router } from 'express';
import { getDb } from '../../../data/database.js';
import { getClanById } from '../../../data/repositories/clan-repo.js';
import {
  dragonCoinEntries,
  dragonCoinsSentSince,
  getDragonCoinReturnSettings,
  listDragonCoinReturns,
  recentDragonCoinReturns,
  setDragonCoinReturnsEnabled,
} from '../../../data/repositories/dragon-coin-return-repo.js';
import { memberIdsByPlayer, playerKey } from '../../../data/repositories/account-invite-repo.js';
import { logAction } from '../../../data/repositories/user-repo.js';
import { MAX_ATTEMPTS, planDragonCoinReturns, UNCONFIRMED_AFTER_MS } from '../../../game-protocol/dragon-coin-returns.js';
import { dragonCoinReturnsDisabled, SENDS_PER_RUN, TREASURY_RANKS } from '../../../scheduler/dragon-coin-returns.js';
import { requireClanAdmin } from '../../middleware/auth.js';
import { createClanSubRouter } from './_shared.js';

/**
 * Dragon Coins back to members (docs/dragon-coin-returns.md): the clan's
 * scanner account sends each member the Dragon Coins they brought into the
 * treasury. Off by default; switched by the clan's admins or the superadmin
 * (requireClanAdmin — every send pays out of the clan's treasury).
 */
export function createDragonCoinReturnsRouter(): Router {
  const router = createClanSubRouter();

  router.get('/:clanId/dragon-coin-returns', requireClanAdmin, (req, res) => {
    const id = req.parsedClanId!;
    if (!getClanById(id)) {
      res.status(404).json({ error: 'Clan not found' });
      return;
    }
    const db = getDb();
    const players = db.prepare('SELECT player_id, name, role, in_clan FROM game_players WHERE clan_id = ?')
      .all(id) as Array<{ player_id: number; name: string; role: number | null; in_clan: number }>;
    const byId = new Map(players.map((p) => [p.player_id, p]));
    const memberIds = memberIdsByPlayer(id);
    const who = (playerId: number) => ({
      player: byId.get(playerId)?.name ?? null,
      memberId: memberIds.get(playerKey(id, playerId)) ?? null,
    });

    const scannerId = (db.prepare('SELECT player_id FROM clan_scan_accounts WHERE clan_id = ?').get(id) as { player_id: number | null } | undefined)?.player_id ?? null;
    const scannerRow = scannerId !== null ? byId.get(scannerId) : undefined;
    const scanner = scannerId !== null
      ? { name: scannerRow?.name ?? null, rank: scannerRow?.in_clan ? scannerRow.role ?? null : null }
      : null;

    const settings = getDragonCoinReturnSettings(id);
    const now = Date.now();
    // What the next scan would send (the same plan the scan makes, from the stored ledger).
    const plan = settings.enabled && settings.enabledAt !== null
      ? planDragonCoinReturns({
        enabledAt: settings.enabledAt,
        entries: dragonCoinEntries(id, settings.enabledAt),
        returns: listDragonCoinReturns(id),
        now,
        onRoster: (playerId) => byId.get(playerId)?.in_clan === 1,
      })
      : null;

    res.json({
      settings,
      sendingDisabled: dragonCoinReturnsDisabled(),
      scanner,
      rankOk: scanner?.rank != null && TREASURY_RANKS.has(scanner.rank),
      waiting: (plan?.sends ?? []).map((s) => ({ ...who(s.playerId), amount: s.amount, entries: s.donationEntryIds.length, since: s.since * 1000 })),
      held: (plan?.held ?? []).slice(-25).reverse().map((h) => ({ ...who(h.playerId), amount: h.amount, at: h.occurredAt * 1000, reason: h.reason })),
      recent: recentDragonCoinReturns(id, 25).map((r) => ({
        ...who(r.playerId), amount: r.amount, at: r.createdAt, status: r.status, confirmed: r.ledgerEntryId !== null, reason: r.reason,
      })),
      sentLastWeek: dragonCoinsSentSince(id, now - 7 * 24 * 3600_000),
      limits: { perRun: SENDS_PER_RUN, maxAttempts: MAX_ATTEMPTS, unconfirmedMinutes: Math.round(UNCONFIRMED_AFTER_MS / 60_000) },
    });
  });

  router.put('/:clanId/dragon-coin-returns', requireClanAdmin, (req, res) => {
    const id = req.parsedClanId!;
    if (!getClanById(id)) {
      res.status(404).json({ error: 'Clan not found' });
      return;
    }
    const { enabled } = req.body ?? {};
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled must be true or false' });
      return;
    }
    const settings = setDragonCoinReturnsEnabled(id, enabled);
    logAction(req.user!.id, 'clan.dragon_coin_returns.update', { clanId: id, enabled: settings.enabled });
    res.json({ ok: true, settings });
  });

  return router;
}
