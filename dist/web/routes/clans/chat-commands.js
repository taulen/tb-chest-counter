"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createChatCommandsRouter = createChatCommandsRouter;
const database_js_1 = require("../../../data/database.js");
const clan_repo_js_1 = require("../../../data/repositories/clan-repo.js");
const chat_command_repo_js_1 = require("../../../data/repositories/chat-command-repo.js");
const chat_digest_repo_js_1 = require("../../../data/repositories/chat-digest-repo.js");
const account_invite_repo_js_1 = require("../../../data/repositories/account-invite-repo.js");
const chat_send_state_repo_js_1 = require("../../../data/repositories/chat-send-state-repo.js");
const user_repo_js_1 = require("../../../data/repositories/user-repo.js");
const chat_send_js_1 = require("../../../game-protocol/chat-send.js");
const chat_commands_js_1 = require("../../../scheduler/chat-commands.js");
const auth_js_1 = require("../../middleware/auth.js");
const _shared_js_1 = require("./_shared.js");
/**
 * Chat commands (docs/chat-commands.md): members message the clan's scanner
 * account one word ("me", "top", …) and get their numbers back in that 1:1
 * chat. Off by default; switched by the clan's admins or the superadmin
 * (requireClanAdmin — every reply is a message from the clan's account).
 */
function createChatCommandsRouter() {
    const router = (0, _shared_js_1.createClanSubRouter)();
    router.get('/:clanId/chat-commands', auth_js_1.requireClanAdmin, (req, res) => {
        const id = req.parsedClanId;
        if (!(0, clan_repo_js_1.getClanById)(id)) {
            res.status(404).json({ error: 'Clan not found' });
            return;
        }
        const names = new Map((0, database_js_1.getDb)().prepare('SELECT player_id, name FROM game_players WHERE clan_id = ?').all(id)
            .map((r) => [r.player_id, r.name]));
        const scanner = (0, database_js_1.getDb)().prepare(`SELECT (SELECT gp.name FROM game_players gp WHERE gp.player_id = a.player_id
                ORDER BY gp.clan_id = a.clan_id DESC, gp.last_seen DESC LIMIT 1) AS name
         FROM clan_scan_accounts a WHERE a.clan_id = ?`).get(id);
        const memberIds = (0, account_invite_repo_js_1.memberIdsByPlayer)(id);
        const until = (0, chat_send_state_repo_js_1.chatPausedUntil)(id);
        const digest = (0, chat_digest_repo_js_1.getChatDigestSettings)(id);
        res.json({
            settings: (0, chat_command_repo_js_1.getChatCommandSettings)(id),
            // The group chat commands can also be answered in: the digest's.
            groupChat: digest.channelUrl ? { name: digest.channelName || null } : null,
            sendingDisabled: (0, chat_send_js_1.chatSendingDisabled)(),
            chatPause: until === null ? null : { until, mutedAt: (0, chat_send_state_repo_js_1.getChatSendState)(id).mutedAt },
            scannerPlayer: scanner?.name ?? null,
            commands: chat_commands_js_1.MEMBER_COMMANDS,
            leaderCommands: chat_commands_js_1.LEADER_COMMANDS,
            limits: {
                perRun: chat_commands_js_1.COMMAND_REPLIES_PER_RUN,
                clanPerHour: chat_commands_js_1.CLAN_MAX_PER_HOUR,
                groupPerHour: chat_commands_js_1.GROUP_MAX_PER_HOUR,
                playerPerHour: chat_commands_js_1.PLAYER_MAX_PER_HOUR,
                repeatMinutes: Math.round(chat_commands_js_1.REPEAT_WINDOW_MS / 60_000),
            },
            sentLastDay: (0, chat_command_repo_js_1.commandRepliesSentSince)(id, Date.now() - 24 * 3600_000),
            recent: (0, chat_command_repo_js_1.recentCommandRequests)(id, 25).map((r) => ({
                requestedAt: r.requestedAt,
                player: r.playerId !== null ? names.get(r.playerId) ?? null : null,
                memberId: r.playerId === null ? null : memberIds.get((0, account_invite_repo_js_1.playerKey)(id, r.playerId)) ?? null,
                command: r.command,
                status: r.status,
                reason: r.reason,
            })),
        });
    });
    router.put('/:clanId/chat-commands', auth_js_1.requireClanAdmin, (req, res) => {
        const id = req.parsedClanId;
        if (!(0, clan_repo_js_1.getClanById)(id)) {
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
        let settings = (0, chat_command_repo_js_1.getChatCommandSettings)(id);
        if (enabled !== undefined)
            settings = (0, chat_command_repo_js_1.setChatCommandsEnabled)(id, enabled);
        if (groupEnabled !== undefined)
            settings = (0, chat_command_repo_js_1.setChatCommandsGroupEnabled)(id, groupEnabled);
        (0, user_repo_js_1.logAction)(req.user.id, 'clan.chat_commands.update', { clanId: id, enabled: settings.enabled, groupEnabled: settings.groupEnabled });
        res.json({ ok: true, settings });
    });
    return router;
}
//# sourceMappingURL=chat-commands.js.map