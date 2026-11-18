import type { Router } from 'express';
import { getDb } from '../../../data/database.js';
import { getClanById } from '../../../data/repositories/clan-repo.js';
import {
  getInviteSettings,
  isWelcomeMode,
  linksForClan,
  recentInviteRequests,
  recentWelcomes,
  setInvitesEnabled,
  setWelcomeMode,
  welcomeProgress,
} from '../../../data/repositories/account-invite-repo.js';
import { logAction } from '../../../data/repositories/user-repo.js';
import { deleteEnvValue, updateEnvValue } from '../../../config/persistent-env.js';
import { chatSendingDisabled } from '../../../game-protocol/chat-send.js';
import { INVITE_KEYWORDS, JOIN_ENTRY_LABEL, defaultSiteNameFor, siteNameFor, siteNameOverride, spacedSiteName } from '../../../scheduler/chat-invites.js';
import { requireClanAdmin, requireSuperAdmin } from '../../middleware/auth.js';
import { createClanSubRouter } from './_shared.js';

/**
 * Account invites via the in-game chat (docs/account-invites.md): players DM
 * the clan's scanner account a keyword and get a join code back; separately,
 * members can be sent one unprompted (welcome mode off / dry-run / on: the
 * first switch-on sends to every current member without an account, then to
 * each player who joins). Both off by default; switched by the clan's admins
 * or the superadmin (requireClanAdmin — a plain member must not be able to
 * make the account message anyone). How messages name the site is one
 * instance-wide setting, superadmin only.
 */
export function createAccountInvitesRouter(): Router {
  const router = createClanSubRouter();

  router.get('/:clanId/account-invites', requireClanAdmin, (req, res) => {
    const id = req.parsedClanId!;
    if (!getClanById(id)) {
      res.status(404).json({ error: 'Clan not found' });
      return;
    }
    const names = new Map((getDb().prepare('SELECT player_id, name FROM game_players WHERE clan_id = ?').all(id) as Array<{ player_id: number; name: string }>)
      .map((r) => [r.player_id, r.name]));
    const scanner = getDb().prepare('SELECT account FROM clan_scan_accounts WHERE clan_id = ?').get(id) as { account: string } | undefined;
    res.json({
      settings: getInviteSettings(id),
      sendingDisabled: chatSendingDisabled(),
      keywords: INVITE_KEYWORDS,
      // Messages carry no link (the game blocks them): the site's name, spaced out.
      siteName: siteNameFor(id),
      siteNameOverride: siteNameOverride(),
      joinEntryLabel: JOIN_ENTRY_LABEL,
      scannerKnown: !!scanner?.account,
      linkedAccounts: linksForClan(id).filter((l) => l.onRoster).length,
      welcomeProgress: welcomeProgress(id),
      // Who asked and what happened — never a code (only its hash is kept).
      recent: recentInviteRequests(id, 15).map((r) => ({
        requestedAt: r.requestedAt,
        player: r.playerId !== null ? names.get(r.playerId) ?? null : null,
        status: r.status,
        reason: r.reason,
      })),
      welcomes: recentWelcomes(id, 15),
    });
  });

  router.put('/:clanId/account-invites', requireClanAdmin, (req, res) => {
    const id = req.parsedClanId!;
    if (!getClanById(id)) {
      res.status(404).json({ error: 'Clan not found' });
      return;
    }
    const body = req.body ?? {};
    if (body.enabled === undefined && body.welcomeMode === undefined) {
      res.status(400).json({ error: 'Nothing to change' });
      return;
    }
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled must be true or false' });
      return;
    }
    if (body.welcomeMode !== undefined && !isWelcomeMode(body.welcomeMode)) {
      res.status(400).json({ error: 'welcomeMode must be off, dry-run or on' });
      return;
    }
    let settings = getInviteSettings(id);
    if (body.enabled !== undefined) settings = setInvitesEnabled(id, body.enabled);
    if (body.welcomeMode !== undefined) settings = setWelcomeMode(id, body.welcomeMode);
    logAction(req.user!.id, 'clan.account_invites.update', { clanId: id, enabled: settings.enabled, welcomeMode: settings.welcomeMode });
    res.json({ ok: true, settings });
  });

  /**
   * How messages name the site, for every clan (app.env INVITE_SITE_NAME):
   * "cwb.fyi" is stored and written as "cwb . fyi"; empty = the host of the
   * public address. Superadmin only — it is the whole instance's.
   */
  router.put('/:clanId/account-invites/site-name', requireSuperAdmin, (req, res) => {
    const raw = String(req.body?.siteName ?? '').trim();
    if (raw.length > 80) {
      res.status(400).json({ error: 'Too long' });
      return;
    }
    if (raw && !spacedSiteName(raw)) {
      res.status(400).json({ error: 'Not a site name' });
      return;
    }
    // The box is pre-filled with the name in use, so saving it unchanged — or
    // typing the public address's own host — keeps following that address
    // instead of freezing it as an override.
    const custom = raw && spacedSiteName(raw) !== defaultSiteNameFor(req.parsedClanId!) ? spacedSiteName(raw) : '';
    if (custom) updateEnvValue('INVITE_SITE_NAME', custom.replace(/ \. /g, '.'));
    else deleteEnvValue('INVITE_SITE_NAME');
    logAction(req.user!.id, 'update_invite_site_name', { siteName: custom });
    res.json({ ok: true, siteName: siteNameFor(req.parsedClanId!) });
  });

  return router;
}
