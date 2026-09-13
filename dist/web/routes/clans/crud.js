"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createCrudRouter = createCrudRouter;
const clan_repo_js_1 = require("../../../data/repositories/clan-repo.js");
const user_repo_js_1 = require("../../../data/repositories/user-repo.js");
const share_link_repo_js_1 = require("../../../data/repositories/share-link-repo.js");
const index_js_1 = require("../../../config/index.js");
const share_token_js_1 = require("../../../utils/share-token.js");
const db_backup_js_1 = require("../../../utils/db-backup.js");
const auth_js_1 = require("../../middleware/auth.js");
const logger_js_1 = require("../../../utils/logger.js");
const _shared_js_1 = require("./_shared.js");
const log = (0, logger_js_1.childLogger)('clans-route');
/**
 * Clan CRUD: list, fetch, create, rename, delete, share-token
 * generate/disable, and the superadmin "switch active clan" route.
 *
 * The DELETE handler also clears the onboard state for the removed
 * clan so the in-memory progress map doesn't grow forever — that's
 * why this router takes the OnboardState bag.
 */
function createCrudRouter(onboardState) {
    const router = (0, _shared_js_1.createClanSubRouter)();
    /**
     * List clans visible to the caller. Superadmin sees all; admin/user sees
     * just their own clan. The frontend uses this to populate the superadmin
     * clan switcher and to render the clan-name header label for everyone.
     */
    router.get('/', auth_js_1.requireAuth, (req, res) => {
        if (!req.user) {
            res.status(401).json({ error: 'Authentication required' });
            return;
        }
        // Global fallback threshold for the member-inactivity sweep, so the
        // per-clan settings input can show it as its "blank = default" hint.
        const defaultInactivityDays = (0, index_js_1.loadConfig)().memberInactivityDays;
        if (req.user.role === 'superadmin') {
            res.json({ clans: (0, clan_repo_js_1.listClans)().map(_shared_js_1.publicClanWithCounts), activeClanId: req.clanId ?? null, defaultInactivityDays });
            return;
        }
        const own = req.user.clanId !== null ? (0, clan_repo_js_1.getClanById)(req.user.clanId) : null;
        if (!own) {
            res.json({ clans: [], activeClanId: null, defaultInactivityDays });
            return;
        }
        // Plain members can't manage the public share link (generate/disable
        // is admin-only), so don't hand them the live token — it grants
        // anonymous read access they could leak outside the clan. Admins and
        // superadmins keep it so the Clans settings page can render it.
        const shape = (0, _shared_js_1.publicClanWithCounts)(own);
        if (req.user.role === 'user') {
            delete shape.publicShareToken;
        }
        res.json({ clans: [shape], activeClanId: own.id, defaultInactivityDays });
    });
    /**
     * Fetch a single clan. Superadmin: any clan. Admin/user: only their own.
     * Used by the per-clan Discord/CT settings pages so they can render the
     * current values for editing.
     */
    router.get('/:clanId', auth_js_1.requireAuth, (req, res) => {
        const id = req.parsedClanId;
        if (req.user.role !== 'superadmin' && req.user.clanId !== id) {
            res.status(403).json({ error: 'You do not have access to this clan' });
            return;
        }
        const clan = (0, clan_repo_js_1.getClanById)(id);
        if (!clan) {
            res.status(404).json({ error: 'Clan not found' });
            return;
        }
        res.json({ clan: (0, _shared_js_1.publicClan)(clan) });
    });
    /**
     * Create a new clan. Superadmin only. The clan starts empty — adding
     * the in-app login session, calibration, and the initial member list
     * happen via the add-clan onboarding flow.
     *
     * Game URL is intentionally not per-clan: every clan logs into the
     * same Total Battle game (clan switching happens inside the game's
     * own canvas, not via different domains). The clans.game_url column
     * is kept in the schema for forward-compat but seeded from the
     * global config; the UI doesn't expose it.
     */
    router.post('/', auth_js_1.requireSuperAdmin, (req, res) => {
        const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
        if (!name) {
            res.status(400).json({ error: 'Clan name is required' });
            return;
        }
        try {
            const clan = (0, clan_repo_js_1.createClan)({
                name,
                createdBy: req.user?.id ?? null,
            });
            (0, user_repo_js_1.logAction)(req.user.id, 'clan.create', { clanId: clan.id, name });
            res.status(201).json({ clan: (0, _shared_js_1.publicClan)(clan) });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to create clan';
            log.warn({ err }, 'Clan create failed');
            res.status(400).json({ error: message });
        }
    });
    /**
     * Update the clan's display name + slug + game URL + scan interval.
     * Superadmin only. Renames preserve clan_id, so historical data stays
     * attached.
     */
    router.put('/:clanId', auth_js_1.requireSuperAdmin, (req, res) => {
        const id = req.parsedClanId;
        const existing = (0, clan_repo_js_1.getClanById)(id);
        if (!existing) {
            res.status(404).json({ error: 'Clan not found' });
            return;
        }
        if (typeof req.body?.name === 'string' && req.body.name.trim()) {
            try {
                (0, clan_repo_js_1.renameClan)(id, req.body.name.trim());
            }
            catch (err) {
                res.status(400).json({ error: err instanceof Error ? err.message : 'Rename failed' });
                return;
            }
        }
        // gameUrl was per-clan in an early draft; it's now global because
        // every clan logs into the same TB domain (clan-switching happens
        // inside the game's canvas, not via URLs). The PUT silently ignores
        // any gameUrl in the body so callers using older payloads still
        // succeed.
        if ('scanIntervalMinutes' in (req.body ?? {})) {
            const raw = req.body.scanIntervalMinutes;
            const parsed = raw === null || raw === '' ? null : Number(raw);
            if (parsed !== null && (!Number.isFinite(parsed) || parsed < 1)) {
                res.status(400).json({ error: 'scanIntervalMinutes must be null or a positive number' });
                return;
            }
            (0, clan_repo_js_1.setClanScanIntervalMinutes)(id, parsed);
        }
        if ('isActive' in (req.body ?? {})) {
            (0, clan_repo_js_1.setClanActive)(id, !!req.body.isActive);
        }
        (0, user_repo_js_1.logAction)(req.user.id, 'clan.update', { clanId: id });
        const fresh = (0, clan_repo_js_1.getClanById)(id);
        res.json({ clan: fresh ? (0, _shared_js_1.publicClan)(fresh) : null });
    });
    /**
     * Generate (or regenerate) the public read-only share token for a clan.
     * Anyone with the resulting URL `/{token}` can view the clan's
     * leaderboard (and ChestTracker tab if enabled) without logging in.
     * Regenerating overwrites the column, so any prior URL is invalidated
     * immediately. The outgoing token is revoked into the share_links ledger
     * (reason 'regenerated') so its usage history survives. Admin or
     * superadmin only.
     */
    router.post('/:clanId/share-token', auth_js_1.requireClanAdmin, (req, res) => {
        const id = req.parsedClanId;
        const existing = (0, clan_repo_js_1.getClanById)(id);
        if (!existing) {
            res.status(404).json({ error: 'Clan not found' });
            return;
        }
        const token = (0, share_token_js_1.generateUniqueShareToken)();
        if (existing.publicShareToken) {
            (0, share_link_repo_js_1.revokeActiveShareLink)(id, 'regenerated', req.user.id);
        }
        (0, clan_repo_js_1.setClanPublicShareToken)(id, token);
        (0, share_link_repo_js_1.createShareLink)(id, token, req.user.id);
        (0, user_repo_js_1.logAction)(req.user.id, 'clan.share_token.generate', { clanId: id });
        res.json({ ok: true, publicShareToken: token });
    });
    /**
     * Disable public sharing by clearing the live token. The token is revoked
     * (not deleted) in the share_links ledger — reason 'disabled' — so it keeps
     * its usage history and can be recovered from the analytics modal. Admin or
     * superadmin only.
     */
    router.delete('/:clanId/share-token', auth_js_1.requireClanAdmin, (req, res) => {
        const id = req.parsedClanId;
        if (!(0, clan_repo_js_1.getClanById)(id)) {
            res.status(404).json({ error: 'Clan not found' });
            return;
        }
        (0, share_link_repo_js_1.revokeActiveShareLink)(id, 'disabled', req.user.id);
        (0, clan_repo_js_1.setClanPublicShareToken)(id, '');
        (0, user_repo_js_1.logAction)(req.user.id, 'clan.share_token.disable', { clanId: id });
        res.json({ ok: true });
    });
    /**
     * Usage analytics for the clan's public share link, plus the most-recent
     * revoked links for the recovery list. Powers the "analytics & history"
     * modal on the Clans settings page. Admin or superadmin only.
     */
    router.get('/:clanId/share-token/analytics', auth_js_1.requireClanAdmin, (req, res) => {
        const id = req.parsedClanId;
        if (!(0, clan_repo_js_1.getClanById)(id)) {
            res.status(404).json({ error: 'Clan not found' });
            return;
        }
        res.json((0, share_link_repo_js_1.getShareLinkAnalytics)(id, 3));
    });
    /**
     * Recover a previously-disabled share link, making its token live again
     * (swapping out any current active link). Admin or superadmin only.
     */
    router.post('/:clanId/share-token/recover', auth_js_1.requireClanAdmin, (req, res) => {
        const id = req.parsedClanId;
        if (!(0, clan_repo_js_1.getClanById)(id)) {
            res.status(404).json({ error: 'Clan not found' });
            return;
        }
        const linkId = Number(req.body?.linkId);
        if (!Number.isInteger(linkId) || linkId <= 0) {
            res.status(400).json({ error: 'A valid linkId is required' });
            return;
        }
        const result = (0, share_link_repo_js_1.recoverShareLink)(id, linkId);
        if (!result.ok) {
            res.status(409).json({ error: result.reason });
            return;
        }
        (0, user_repo_js_1.logAction)(req.user.id, 'clan.share_token.recover', { clanId: id, linkId });
        res.json({ ok: true, publicShareToken: result.token });
    });
    /**
     * Delete a clan and all its data. Superadmin only. Refuses if it's the
     * last remaining clan or if any users are still attached. The
     * superadmin needs to reassign or delete those users first.
     */
    router.delete('/:clanId', auth_js_1.requireSuperAdmin, async (req, res) => {
        const id = req.parsedClanId;
        const target = (0, clan_repo_js_1.getClanById)(id);
        if (!target) {
            res.status(404).json({ error: 'Clan not found' });
            return;
        }
        // Snapshot the live DB before nuking the clan and all its data.
        // If the backup fails the throw bubbles to the JSON error
        // middleware and the delete is skipped — that's the point.
        await (0, db_backup_js_1.createPreActionBackup)(`pre-delete-clan-${target.name}`);
        const result = (0, clan_repo_js_1.deleteClan)(id);
        if (!result.ok) {
            res.status(409).json({ error: result.reason });
            return;
        }
        onboardState.clear(id);
        (0, user_repo_js_1.logAction)(req.user.id, 'clan.delete', { clanId: id });
        res.json({ ok: true });
    });
    /**
     * Switch which clan a superadmin is currently viewing. Persists to the
     * session row so it survives page reloads. Non-superadmins are forced
     * to their own clan and get a 403 here regardless of payload.
     */
    router.post('/:clanId/activate', auth_js_1.requireSuperAdmin, (req, res) => {
        const id = req.parsedClanId;
        const target = (0, clan_repo_js_1.getClanById)(id);
        if (!target) {
            res.status(404).json({ error: 'Clan not found' });
            return;
        }
        if (!req.sessionToken) {
            res.status(401).json({ error: 'No session' });
            return;
        }
        (0, user_repo_js_1.setSessionActiveClan)(req.sessionToken, id);
        res.json({ ok: true, activeClanId: id });
    });
    return router;
}
//# sourceMappingURL=crud.js.map