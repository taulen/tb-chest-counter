import type { Router } from 'express';
import { getDb } from '../../../data/database.js';
import { getClanById } from '../../../data/repositories/clan-repo.js';
import {
  commandRepliesSentSince,
  getChatCommandSettings,
  recentCommandRequests,
  setChatCommandsEnabled,
  setChatCommandsGroupEnabled,
} from '../../../data/repositories/chat-command-repo.js';
import { getChatDigestSettings } from '../../../data/repositories/chat-digest-repo.js';
import { memberIdsByPlayer, playerKey } from '../../../data/repositories/account-invite-repo.js';
import { chatPausedUntil, getChatSendState } from '../../../data/repositories/chat-send-state-repo.js';
import { logAction } from '../../../data/repositories/user-repo.js';
import { chatSendingDisabled } from '../../../game-protocol/chat-send.js';
import {
  CLAN_MAX_PER_HOUR,
  COMMAND_REPLIES_PER_RUN,
  GROUP_MAX_PER_HOUR,
  LEADER_COMMANDS,
  MEMBER_COMMANDS,
  PLAYER_MAX_PER_HOUR,
  REPEAT_WINDOW_MS,
} from '../../../scheduler/chat-commands.js';
import { requireClanAdmin } from '../../middleware/auth.js';
import { createClanSubRouter } from './_shared.js';

/**
 * Chat commands (docs/chat-commands.md): members message the clan's scanner
 * account one word ("me", "top", …) and get their numbers back in that 1:1
 * chat. Off by default; switched by the clan's admins or the superadmin
 * (requireClanAdmin — every reply is a message from the clan's account).
 */
export function createChatCommandsRouter(): Router {
  const router = createClanSubRouter();

  router.get('/:clanId/chat-commands', requireClanAdmin, (req, res) => {
    const id = req.parsedClanId!;
    if (!getClanById(id)) {
      res.status(404).json({ error: 'Clan not found' });
      return;
    }
    const names = new Map((getDb().prepare('SELECT player_id, name FROM game_players WHERE clan_id = ?').all(id) as Array<{ player_id: number; name: string }>)
      .map((r) => [r.player_id, r.name]));
    const scanner = getDb().prepare(
      `SELECT (SELECT gp.name FROM game_players gp WHERE gp.player_id = a.player_id
                ORDER BY gp.clan_id = a.clan_id DESC, gp.last_seen DESC LIMIT 1) AS name
         FROM clan_scan_accounts a WHERE a.clan_id = ?`,
    ).get(id) as { name: string | null } | undefined;
    const memberIds = memberIdsByPlayer(id);
    const until = chatPausedUntil(id);
    const digest = getChatDigestSettings(id);
    res.json({
      settings: getChatCommandSettings(id),
      // The group chat commands can also be answered in: the digest's.
      groupChat: digest.channelUrl ? { name: digest.channelName || null } : null,
      sendingDisabled: chatSendingDisabled(),
      chatPause: until === null ? null : { until, mutedAt: getChatSendState(id).mutedAt },
      scannerPlayer: scanner?.name ?? null,
      commands: MEMBER_COMMANDS,
      leaderCommands: LEADER_COMMANDS,
      limits: {
        perRun: COMMAND_REPLIES_PER_RUN,
        clanPerHour: CLAN_MAX_PER_HOUR,
        groupPerHour: GROUP_MAX_PER_HOUR,
        playerPerHour: PLAYER_MAX_PER_HOUR,
        repeatMinutes: Math.round(REPEAT_WINDOW_MS / 60_000),
      },
      sentLastDay: commandRepliesSentSince(id, Date.now() - 24 * 3600_000),
      recent: recentCommandRequests(id, 25).map((r) => ({
        requestedAt: r.requestedAt,
        player: r.playerId !== null ? names.get(r.playerId) ?? null : null,
        memberId: r.playerId === null ? null : memberIds.get(playerKey(id, r.playerId)) ?? null,
        command: r.command,
        status: r.status,
        reason: r.reason,
      })),
    });
  });

  router.put('/:clanId/chat-commands', requireClanAdmin, (req, res) => {
    const id = req.parsedClanId!;
    if (!getClanById(id)) {
      res.status(404).json({ error: 'Clan not found' });
      return;
    }
    const { enabled, groupEnabled } = req.body ?? {};
    if (enabled === undefined && groupEnabled === undefined) {
      res.status(400).json({ error: 'Nothing to change' });
      return;
    }
    if ((enabled !== undefined && typeof enabled !== 'boolean') || (groupEnabled !== undefined && typeof groupEnabled !== 'boolean')) {
      res.status(400).json({ error: 'enabled and groupEnabled must be true or false' });
      return;
    }
    let settings = getChatCommandSettings(id);
    if (enabled !== undefined) settings = setChatCommandsEnabled(id, enabled);
    if (groupEnabled !== undefined) settings = setChatCommandsGroupEnabled(id, groupEnabled);
    logAction(req.user!.id, 'clan.chat_commands.update', { clanId: id, enabled: settings.enabled, groupEnabled: settings.groupEnabled });
    res.json({ ok: true, settings });
  });

  return router;
}
