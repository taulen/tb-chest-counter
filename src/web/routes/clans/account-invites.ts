import type { Router } from 'express';
import { getDb } from '../../../data/database.js';
import { getClanById } from '../../../data/repositories/clan-repo.js';
import {
  formatCode,
  getInviteSettings,
  isWelcomeMode,
  issueManualCode,
  linksForClan,
  manualCodeBlocker,
  manualCodes,
  memberIdsByPlayer,
  playerKey,
  rosterForCodes,
  recentInviteRequests,
  recentWelcomes,
  setInvitesEnabled,
  setWelcomeMode,
  welcomeProgress,
  welcomeCandidates,
  withdrawManualCode,
  WELCOME_DRY_RUN_LIMIT,
  type ManualCodeBlocker,
} from '../../../data/repositories/account-invite-repo.js';
import { getUserById, logAction } from '../../../data/repositories/user-repo.js';
import { deleteEnvValue, updateEnvValue } from '../../../config/persistent-env.js';
import { chatSendingDisabled } from '../../../game-protocol/chat-send.js';
import { chatPausedUntil, getChatSendState } from '../../../data/repositories/chat-send-state-repo.js';
import { INVITE_KEYWORDS, JOIN_ENTRY_LABEL, defaultSiteNameFor, inviteReplyText, siteNameFor, siteNameOverride, spacedSiteName } from '../../../scheduler/chat-invites.js';
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
    // The scanner account and its player's in-game name (it sends the codes and never gets one).
    const scanner = getDb().prepare(
      `SELECT a.account,
              (SELECT gp.name FROM game_players gp WHERE gp.player_id = a.player_id
                ORDER BY gp.clan_id = a.clan_id DESC, gp.last_seen DESC LIMIT 1) AS name
         FROM clan_scan_accounts a WHERE a.clan_id = ?`,
    ).get(id) as { account: string; name: string | null } | undefined;
    // Each player's member, for the tables' profile links.
    const memberIds = memberIdsByPlayer(id);
    const memberIdOf = (playerId: number | null): number | null => (playerId === null ? null : memberIds.get(playerKey(id, playerId)) ?? null);
    res.json({
      settings: getInviteSettings(id),
      sendingDisabled: chatSendingDisabled(),
      // The game muted the scanner account: nothing goes out until `until` (epoch ms).
      chatPause: (() => {
        const until = chatPausedUntil(id);
        return until === null ? null : { until, mutedAt: getChatSendState(id).mutedAt };
      })(),
      keywords: INVITE_KEYWORDS,
      // Messages carry no link (the game blocks them): the site's name, spaced out.
      siteName: siteNameFor(id),
      siteNameOverride: siteNameOverride(),
      joinEntryLabel: JOIN_ENTRY_LABEL,
      scannerKnown: !!scanner?.account,
      scannerPlayer: scanner?.name ?? null,
      linkedAccounts: linksForClan(id).filter((l) => l.onRoster).length,
      welcomeProgress: welcomeProgress(id),
      // Who asked and what happened — never a code (only its hash is kept).
      recent: recentInviteRequests(id, 15).map((r) => ({
        requestedAt: r.requestedAt,
        player: r.playerId !== null ? names.get(r.playerId) ?? null : null,
        memberId: memberIdOf(r.playerId),
        status: r.status,
        reason: r.reason,
      })),
      // Every code sent so far (a few hundred at most), newest first: a list of
      // only the latest 15 hid most of a scan's batch.
      welcomes: recentWelcomes(id, 1000),
      // Dry run: everyone switching "Send members a code" on would message now,
      // shown at once (no scan needed). Live mode lists its sends above instead.
      wouldGetCode: getInviteSettings(id).welcomeMode === 'dry-run'
        ? welcomeCandidates(id, 0, { backlog: true, live: true, limit: WELCOME_DRY_RUN_LIMIT })
          .map((c) => ({ player: c.name, joinedAt: c.joinedAt, memberId: memberIdOf(c.playerId) }))
        : [],
      // Codes made by hand: who to pick from, and the ones made so far (never a code).
      roster: rosterForCodes(id),
      manualCodes: manualCodes(id),
    });
  });

  /**
   * Codes made by hand (docs/account-invites.md): for when the scanner account
   * can't send one — muted, or the player doesn't read the chat. The code is
   * shown to the admin once, with a ready message (the chat reply's wording:
   * English, no link, so it can go in the game chat too). Nothing is sent.
   */
  const BLOCKED: Record<ManualCodeBlocker, string> = {
    'not-on-roster': 'That player is not in the clan.',
    'has-account': 'That player already has an account. Only the superadmin can make a code that resets its password.',
    superadmin: 'That player is linked to a superadmin account.',
    'too-many': 'Too many unused codes. Withdraw some first.',
  };

  router.post('/:clanId/account-invites/codes', requireClanAdmin, (req, res) => {
    const id = req.parsedClanId!;
    if (!getClanById(id)) {
      res.status(404).json({ error: 'Clan not found' });
      return;
    }
    const playerId = Number(req.body?.playerId);
    if (!Number.isSafeInteger(playerId) || playerId <= 0) {
      res.status(400).json({ error: 'playerId must be a player' });
      return;
    }
    // The account itself, not the session's view of it: only a real superadmin may make a code that resets a password.
    const issuer = getUserById(req.user!.id);
    if (!issuer) {
      res.status(401).json({ error: 'Not signed in' });
      return;
    }
    const blocker = manualCodeBlocker(id, playerId, issuer);
    if (blocker) {
      res.status(blocker === 'not-on-roster' ? 404 : 409).json({ error: BLOCKED[blocker], reason: blocker });
      return;
    }
    const player = rosterForCodes(id).find((p) => p.playerId === playerId);
    const made = issueManualCode(id, playerId, issuer.id);
    logAction(req.user!.id, 'clan.account_invites.manual_code', { clanId: id, playerId, player: player?.name ?? null, replaced: made.replaced });
    res.json({
      ok: true,
      codeId: made.codeId,
      code: formatCode(made.code),
      expiresAt: made.expiresAt,
      player: player?.name ?? null,
      // An existing account: only the superadmin gets here, and the code resets its password.
      account: player?.account ?? null,
      message: inviteReplyText(made.code, siteNameFor(id)),
    });
  });

  router.delete('/:clanId/account-invites/codes/:codeId', requireClanAdmin, (req, res) => {
    const id = req.parsedClanId!;
    const codeId = Number(req.params.codeId);
    const gone = Number.isSafeInteger(codeId) ? withdrawManualCode(id, codeId) : null;
    if (!gone) {
      res.status(404).json({ error: 'No such unused code' });
      return;
    }
    logAction(req.user!.id, 'clan.account_invites.manual_code_withdrawn', { clanId: id, playerId: gone.playerId, player: gone.player });
    res.json({ ok: true });
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
