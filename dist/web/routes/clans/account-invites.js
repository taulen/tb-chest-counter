"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAccountInvitesRouter = createAccountInvitesRouter;
const database_js_1 = require("../../../data/database.js");
const clan_repo_js_1 = require("../../../data/repositories/clan-repo.js");
const account_invite_repo_js_1 = require("../../../data/repositories/account-invite-repo.js");
const user_repo_js_1 = require("../../../data/repositories/user-repo.js");
const persistent_env_js_1 = require("../../../config/persistent-env.js");
const chat_send_js_1 = require("../../../game-protocol/chat-send.js");
const chat_send_state_repo_js_1 = require("../../../data/repositories/chat-send-state-repo.js");
const chat_invites_js_1 = require("../../../scheduler/chat-invites.js");
const auth_js_1 = require("../../middleware/auth.js");
const _shared_js_1 = require("./_shared.js");
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
function createAccountInvitesRouter() {
    const router = (0, _shared_js_1.createClanSubRouter)();
    router.get('/:clanId/account-invites', auth_js_1.requireClanAdmin, (req, res) => {
        const id = req.parsedClanId;
        if (!(0, clan_repo_js_1.getClanById)(id)) {
            res.status(404).json({ error: 'Clan not found' });
            return;
        }
        const names = new Map((0, database_js_1.getDb)().prepare('SELECT player_id, name FROM game_players WHERE clan_id = ?').all(id)
            .map((r) => [r.player_id, r.name]));
        const scanner = (0, database_js_1.getDb)().prepare('SELECT account FROM clan_scan_accounts WHERE clan_id = ?').get(id);
        // Each player's member, for the tables' profile links.
        const memberIds = (0, account_invite_repo_js_1.memberIdsByPlayer)(id);
        const memberIdOf = (playerId) => (playerId === null ? null : memberIds.get((0, account_invite_repo_js_1.playerKey)(id, playerId)) ?? null);
        res.json({
            settings: (0, account_invite_repo_js_1.getInviteSettings)(id),
            sendingDisabled: (0, chat_send_js_1.chatSendingDisabled)(),
            // The game muted the scanner account: nothing goes out until `until` (epoch ms).
            chatPause: (() => {
                const until = (0, chat_send_state_repo_js_1.chatPausedUntil)(id);
                return until === null ? null : { until, mutedAt: (0, chat_send_state_repo_js_1.getChatSendState)(id).mutedAt };
            })(),
            keywords: chat_invites_js_1.INVITE_KEYWORDS,
            // Messages carry no link (the game blocks them): the site's name, spaced out.
            siteName: (0, chat_invites_js_1.siteNameFor)(id),
            siteNameOverride: (0, chat_invites_js_1.siteNameOverride)(),
            joinEntryLabel: chat_invites_js_1.JOIN_ENTRY_LABEL,
            scannerKnown: !!scanner?.account,
            linkedAccounts: (0, account_invite_repo_js_1.linksForClan)(id).filter((l) => l.onRoster).length,
            welcomeProgress: (0, account_invite_repo_js_1.welcomeProgress)(id),
            // Who asked and what happened — never a code (only its hash is kept).
            recent: (0, account_invite_repo_js_1.recentInviteRequests)(id, 15).map((r) => ({
                requestedAt: r.requestedAt,
                player: r.playerId !== null ? names.get(r.playerId) ?? null : null,
                memberId: memberIdOf(r.playerId),
                status: r.status,
                reason: r.reason,
            })),
            // Every code sent so far (a few hundred at most), newest first: a list of
            // only the latest 15 hid most of a scan's batch.
            welcomes: (0, account_invite_repo_js_1.recentWelcomes)(id, 1000),
            // Dry run: everyone switching "Send members a code" on would message now,
            // shown at once (no scan needed). Live mode lists its sends above instead.
            wouldGetCode: (0, account_invite_repo_js_1.getInviteSettings)(id).welcomeMode === 'dry-run'
                ? (0, account_invite_repo_js_1.welcomeCandidates)(id, 0, { backlog: true, live: true, limit: account_invite_repo_js_1.WELCOME_DRY_RUN_LIMIT })
                    .map((c) => ({ player: c.name, joinedAt: c.joinedAt, memberId: memberIdOf(c.playerId) }))
                : [],
        });
    });
    router.put('/:clanId/account-invites', auth_js_1.requireClanAdmin, (req, res) => {
        const id = req.parsedClanId;
        if (!(0, clan_repo_js_1.getClanById)(id)) {
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
        if (body.welcomeMode !== undefined && !(0, account_invite_repo_js_1.isWelcomeMode)(body.welcomeMode)) {
            res.status(400).json({ error: 'welcomeMode must be off, dry-run or on' });
            return;
        }
        let settings = (0, account_invite_repo_js_1.getInviteSettings)(id);
        if (body.enabled !== undefined)
            settings = (0, account_invite_repo_js_1.setInvitesEnabled)(id, body.enabled);
        if (body.welcomeMode !== undefined)
            settings = (0, account_invite_repo_js_1.setWelcomeMode)(id, body.welcomeMode);
        (0, user_repo_js_1.logAction)(req.user.id, 'clan.account_invites.update', { clanId: id, enabled: settings.enabled, welcomeMode: settings.welcomeMode });
        res.json({ ok: true, settings });
    });
    /**
     * How messages name the site, for every clan (app.env INVITE_SITE_NAME):
     * "cwb.fyi" is stored and written as "cwb . fyi"; empty = the host of the
     * public address. Superadmin only — it is the whole instance's.
     */
    router.put('/:clanId/account-invites/site-name', auth_js_1.requireSuperAdmin, (req, res) => {
        const raw = String(req.body?.siteName ?? '').trim();
        if (raw.length > 80) {
            res.status(400).json({ error: 'Too long' });
            return;
        }
        if (raw && !(0, chat_invites_js_1.spacedSiteName)(raw)) {
            res.status(400).json({ error: 'Not a site name' });
            return;
        }
        // The box is pre-filled with the name in use, so saving it unchanged — or
        // typing the public address's own host — keeps following that address
        // instead of freezing it as an override.
        const custom = raw && (0, chat_invites_js_1.spacedSiteName)(raw) !== (0, chat_invites_js_1.defaultSiteNameFor)(req.parsedClanId) ? (0, chat_invites_js_1.spacedSiteName)(raw) : '';
        if (custom)
            (0, persistent_env_js_1.updateEnvValue)('INVITE_SITE_NAME', custom.replace(/ \. /g, '.'));
        else
            (0, persistent_env_js_1.deleteEnvValue)('INVITE_SITE_NAME');
        (0, user_repo_js_1.logAction)(req.user.id, 'update_invite_site_name', { siteName: custom });
        res.json({ ok: true, siteName: (0, chat_invites_js_1.siteNameFor)(req.parsedClanId) });
    });
    return router;
}
//# sourceMappingURL=account-invites.js.map