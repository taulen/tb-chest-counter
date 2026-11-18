"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createCrudRouter = createCrudRouter;
const clan_repo_js_1 = require("../../../data/repositories/clan-repo.js");
const game_clan_repo_js_1 = require("../../../data/repositories/game-clan-repo.js");
const member_repo_js_1 = require("../../../data/repositories/member-repo.js");
const chest_summary_repo_js_1 = require("../../../data/repositories/chest-summary-repo.js");
const game_day_js_1 = require("../../../utils/game-day.js");
const session_repo_js_1 = require("../../../data/repositories/session-repo.js");
const clan_logo_js_1 = require("../../../game-art/clan-logo.js");
const user_repo_js_1 = require("../../../data/repositories/user-repo.js");
const share_link_repo_js_1 = require("../../../data/repositories/share-link-repo.js");
const index_js_1 = require("../../../config/index.js");
const share_token_js_1 = require("../../../utils/share-token.js");
const public_url_js_1 = require("../../../utils/public-url.js");
const db_backup_js_1 = require("../../../utils/db-backup.js");
const auth_js_1 = require("../../middleware/auth.js");
const logger_js_1 = require("../../../utils/logger.js");
const _shared_js_1 = require("./_shared.js");
const log = (0, logger_js_1.childLogger)('clans-route');
/** `:linkId` as a positive integer, or null when the segment isn't one. */
function parseLinkId(raw) {
    const n = Number(Array.isArray(raw) ? raw[0] : raw);
    return Number.isInteger(n) && n > 0 ? n : null;
}
/**
 * Clan CRUD: list, fetch, create, rename, delete, public share-link
 * generate/disable, and the superadmin "switch active clan" route.
 */
function createCrudRouter() {
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
        // The public URL a clan without its own domain links with, so the
        // per-clan input can show it as its "blank = default" hint.
        const defaultPublicUrl = (0, clan_repo_js_1.clanPublicUrl)(null, (0, index_js_1.loadConfig)().webExternalUrl);
        if (req.user.role === 'superadmin') {
            res.json({
                clans: (0, clan_repo_js_1.listClans)().map((c) => ({
                    ...(0, _shared_js_1.publicClanWithCounts)(c),
                    shareLinks: (0, share_link_repo_js_1.listActiveShareLinks)(c.id),
                    goalHistory: (0, clan_repo_js_1.listGoalHistory)(c.id),
                })),
                activeClanId: req.clanId ?? null,
                defaultPublicUrl,
            });
            return;
        }
        // Everyone else: their home clan plus any extra clans they were granted
        // (the header switcher lists these). Usually just the one.
        const clans = [];
        for (const access of (0, user_repo_js_1.listSwitchableClans)(req.user.id)) {
            const clan = (0, clan_repo_js_1.getClanById)(access.clanId);
            if (!clan)
                continue;
            // Plain members can't manage public share links (create/disable is
            // admin-only), so don't hand them the live keys — each one grants
            // anonymous read access they could leak outside the clan. Admins get
            // them so the Clans settings page can render the list. Judged per clan:
            // an admin at home may be a plain member of a clan they're a guest in.
            const shape = (0, _shared_js_1.publicClanWithCounts)(clan);
            if (access.role === 'admin') {
                shape.shareLinks = (0, share_link_repo_js_1.listActiveShareLinks)(clan.id);
                // The Leaderboard goal settings list the goal's earlier values.
                shape.goalHistory = (0, clan_repo_js_1.listGoalHistory)(clan.id);
            }
            clans.push(shape);
        }
        const activeClanId = req.clanId !== undefined && clans.some((c) => c.id === req.clanId)
            ? req.clanId
            : clans[0]?.id ?? null;
        res.json({ clans, activeClanId, defaultPublicUrl });
    });
    /**
     * The shell's clan switcher: every clan the caller may switch to, with what
     * the switcher shows for each — logo, kingdom, last completed scan, whether
     * it is in the scan rotation. Deliberately light (no share keys, no goal
     * history, no file checks), because every page load asks for it.
     *
     * `needsReauth` is operator information, like the scan errors /api/status
     * hides from members: it is sent only for clans the caller administers (a
     * superadmin administers every clan), and left out — not false — elsewhere.
     *
     * MUST stay above `GET /:clanId` (see the deleted-clans route below).
     */
    router.get('/switcher', auth_js_1.requireAuth, (req, res) => {
        if (!req.user) {
            res.status(401).json({ error: 'Authentication required' });
            return;
        }
        const entries = req.user.role === 'superadmin'
            ? (0, clan_repo_js_1.listClans)().map((clan) => ({ clan, admin: true }))
            : (0, user_repo_js_1.listSwitchableClans)(req.user.id).flatMap((access) => {
                const clan = (0, clan_repo_js_1.getClanById)(access.clanId);
                return clan ? [{ clan, admin: access.role === 'admin' }] : [];
            });
        const clans = entries.map(({ clan, admin }) => {
            const info = (0, game_clan_repo_js_1.getClanInfo)(clan.id);
            return {
                id: clan.id,
                name: clan.name,
                shortCode: clan.shortCode,
                kingdom: info?.realm ?? null,
                logoUrl: (0, clan_logo_js_1.clanLogoUrl)(info?.logo ?? null),
                lastScanAt: (0, session_repo_js_1.getLastCompletedSession)(clan.id)?.completedAt ?? null,
                isActive: clan.isActive,
                ...(admin ? { needsReauth: clan.needsReauth } : {}),
            };
        });
        const activeClanId = req.clanId !== undefined && clans.some((c) => c.id === req.clanId)
            ? req.clanId
            : clans[0]?.id ?? null;
        res.json({ clans, activeClanId });
    });
    /**
     * Home's "Clans" tile (superadmin): what every clan collected this game day
     * and how many members it has, keyed by clan id. The rest of the tile (logo,
     * kingdom, last scan, status) comes from /switcher. Superadmin only: it is
     * the one view that spans every clan's numbers.
     *
     * MUST stay above `GET /:clanId`.
     */
    router.get('/overview', auth_js_1.requireSuperAdmin, (_req, res) => {
        const today = (0, game_day_js_1.gameDateFor)(Date.now(), (0, index_js_1.loadConfig)().gameDayRolloverUtcHour);
        const clans = (0, clan_repo_js_1.listClans)().map((clan) => {
            const totals = (0, chest_summary_repo_js_1.getWindowTotals)(clan.id, today, today);
            return {
                id: clan.id,
                gameDate: today,
                chestsToday: totals.chests,
                pointsToday: totals.points,
                members: (0, member_repo_js_1.getMemberCount)(clan.id),
            };
        });
        res.json({ clans });
    });
    /**
     * Clans that have been soft-deleted, with the row counts they still hold —
     * the restore list on the System page. Superadmin only; `getClanById` hides
     * these from every other surface, which is the whole point.
     *
     * MUST stay above `GET /:clanId`. Express matches in registration order and
     * `router.param('clanId')` answers 400 for a non-numeric segment, so
     * registering this later makes /api/clans/deleted a confident
     * "Invalid clanId" instead of a listing.
     */
    router.get('/deleted', auth_js_1.requireSuperAdmin, (_req, res) => {
        res.json({ clans: (0, clan_repo_js_1.listDeletedClans)().map(_shared_js_1.deletedClanSummary) });
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
     * Create a new clan. Superadmin only. The clan starts empty: once an
     * admin signs it in through the login bridge, the next scan reads its
     * members and gifts from the game.
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
        const shortCode = (0, clan_repo_js_1.normalizeShortCode)(req.body?.shortCode);
        if (shortCode === null) {
            res.status(400).json({ error: 'Short code: 1–8 letters or digits' });
            return;
        }
        try {
            const clan = (0, clan_repo_js_1.createClan)({
                name,
                shortCode,
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
        const hasName = typeof req.body?.name === 'string' && req.body.name.trim();
        const hasCode = 'shortCode' in (req.body ?? {});
        if (hasName || hasCode) {
            const shortCode = hasCode ? (0, clan_repo_js_1.normalizeShortCode)(req.body.shortCode) : existing.shortCode;
            if (shortCode === null) {
                res.status(400).json({ error: 'Short code: 1–8 letters or digits' });
                return;
            }
            try {
                (0, clan_repo_js_1.renameClan)(id, hasName ? req.body.name.trim() : existing.baseName, shortCode);
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
        if ('publicUrl' in (req.body ?? {})) {
            const url = (0, public_url_js_1.normalizePublicUrl)(req.body.publicUrl);
            if (url === null) {
                res.status(400).json({ error: 'Public URL must be a web address like https://sinful.day, or blank' });
                return;
            }
            (0, clan_repo_js_1.setClanPublicUrl)(id, url);
        }
        if ('isActive' in (req.body ?? {})) {
            (0, clan_repo_js_1.setClanActive)(id, !!req.body.isActive);
        }
        (0, user_repo_js_1.logAction)(req.user.id, 'clan.update', { clanId: id });
        const fresh = (0, clan_repo_js_1.getClanById)(id);
        res.json({ clan: fresh ? (0, _shared_js_1.publicClan)(fresh) : null });
    });
    /**
     * Every public share link a clan holds — live ones with their own 30-day
     * visit series, plus recently disabled ones for the recovery list. Powers
     * the "analytics & history" modal on the Clans settings page. Admin or
     * superadmin only.
     *
     * A clan may hold any number of live links; each carries its own counters,
     * which is the point — "which link is people actually using" is only
     * answerable if the Discord link and the forum link are separate rows.
     */
    router.get('/:clanId/share-links', auth_js_1.requireClanAdmin, (req, res) => {
        const id = req.parsedClanId;
        if (!(0, clan_repo_js_1.getClanById)(id)) {
            res.status(404).json({ error: 'Clan not found' });
            return;
        }
        res.json((0, share_link_repo_js_1.getShareLinkAnalytics)(id, 8));
    });
    /**
     * Create another public read-only share link for a clan. Anyone with the
     * resulting URL `/{key}` can view the clan's leaderboard (and ChestTracker
     * tab if enabled) without logging in.
     *
     * `key` is optional: omit it for a generated 6-char token, or supply a
     * vanity key (3-10 chars, a-z0-9) to choose the URL. `label` is a note for
     * the admin's own benefit and never leaves the admin UI. Existing links are
     * untouched — rotating a link is now "add the new one, disable the old one
     * once it has stopped being used", which no longer breaks anyone mid-flight.
     */
    router.post('/:clanId/share-links', auth_js_1.requireClanAdmin, (req, res) => {
        const id = req.parsedClanId;
        if (!(0, clan_repo_js_1.getClanById)(id)) {
            res.status(404).json({ error: 'Clan not found' });
            return;
        }
        const label = (0, share_link_repo_js_1.normalizeShareLinkLabel)(req.body?.label);
        const rawKey = typeof req.body?.key === 'string' ? req.body.key.trim() : '';
        let token;
        let isVanity = false;
        if (rawKey) {
            const check = (0, share_token_js_1.validateVanityKey)(rawKey);
            if (!check.ok) {
                res.status(400).json({ error: check.error });
                return;
            }
            token = check.key;
            isVanity = true;
        }
        else {
            token = (0, share_token_js_1.generateUniqueShareToken)();
        }
        const link = (0, share_link_repo_js_1.createShareLink)(id, token, req.user.id, { label, isVanity });
        (0, user_repo_js_1.logAction)(req.user.id, 'clan.share_link.create', { clanId: id, linkId: link.id, isVanity });
        res.json({ ok: true, link });
    });
    /**
     * Rename one link. The label is the only editable field — a key is part of
     * a URL people already hold, so changing it in place would silently break
     * those URLs while looking like a rename.
     */
    router.patch('/:clanId/share-links/:linkId', auth_js_1.requireClanAdmin, (req, res) => {
        const id = req.parsedClanId;
        const linkId = parseLinkId(req.params.linkId);
        if (linkId === null) {
            res.status(400).json({ error: 'A valid linkId is required' });
            return;
        }
        if (!(0, share_link_repo_js_1.setShareLinkLabel)(id, linkId, (0, share_link_repo_js_1.normalizeShareLinkLabel)(req.body?.label))) {
            res.status(404).json({ error: 'Link not found' });
            return;
        }
        res.json({ ok: true });
    });
    /**
     * Disable one link. The row is revoked (not deleted) so it keeps its usage
     * history and can be restored from the analytics modal. The clan's other
     * links keep working. Admin or superadmin only.
     */
    router.delete('/:clanId/share-links/:linkId', auth_js_1.requireClanAdmin, (req, res) => {
        const id = req.parsedClanId;
        const linkId = parseLinkId(req.params.linkId);
        if (linkId === null) {
            res.status(400).json({ error: 'A valid linkId is required' });
            return;
        }
        if (!(0, share_link_repo_js_1.revokeShareLink)(id, linkId, 'disabled', req.user.id)) {
            res.status(404).json({ error: 'Link not found or already disabled' });
            return;
        }
        (0, user_repo_js_1.logAction)(req.user.id, 'clan.share_link.disable', { clanId: id, linkId });
        res.json({ ok: true });
    });
    /**
     * Restore a previously-disabled link. No longer swaps anything out — the
     * clan simply holds one more live link than it did.
     */
    router.post('/:clanId/share-links/:linkId/restore', auth_js_1.requireClanAdmin, (req, res) => {
        const id = req.parsedClanId;
        const linkId = parseLinkId(req.params.linkId);
        if (linkId === null) {
            res.status(400).json({ error: 'A valid linkId is required' });
            return;
        }
        const result = (0, share_link_repo_js_1.restoreShareLink)(id, linkId);
        if (!result.ok) {
            res.status(409).json({ error: result.reason });
            return;
        }
        (0, user_repo_js_1.logAction)(req.user.id, 'clan.share_link.restore', { clanId: id, linkId });
        res.json({ ok: true, token: result.token });
    });
    /**
     * Permanently delete a disabled link, discarding its history. The only
     * reason to do this is to free a vanity key for reuse — a key stays claimed
     * for as long as any row holds it, including a revoked one, so that an old
     * URL can never be repointed at a different clan by accident.
     */
    router.delete('/:clanId/share-links/:linkId/permanent', auth_js_1.requireClanAdmin, (req, res) => {
        const id = req.parsedClanId;
        const linkId = parseLinkId(req.params.linkId);
        if (linkId === null) {
            res.status(400).json({ error: 'A valid linkId is required' });
            return;
        }
        const result = (0, share_link_repo_js_1.deleteShareLink)(id, linkId);
        if (!result.ok) {
            res.status(409).json({ error: result.reason });
            return;
        }
        (0, user_repo_js_1.logAction)(req.user.id, 'clan.share_link.delete', { clanId: id, linkId });
        res.json({ ok: true });
    });
    /**
     * Remove a clan. Superadmin only. Refuses only if it's the last one left.
     *
     * This is a SOFT delete: the clan and every row it owns stay in the database
     * and the clan is marked instead, so the operation is reversible from the
     * System page. It used to be a cascade across ~20 tables whose only safety
     * net was the snapshot taken on the line above — and in September that net
     * held by luck, not design.
     *
     * The old "detach the users first" refusal is gone with it. Nothing is
     * destroyed now, so there is nothing to protect the users from; keeping the
     * guard would only recreate the trap where making the reversible operation
     * possible required nine irreversible ones first.
     *
     * The snapshot stays anyway. It costs one gzip (debounced to at most one per
     * ten minutes) and it is the difference between "undo the flag" and "undo
     * whatever else went wrong at the same time".
     */
    router.delete('/:clanId', auth_js_1.requireSuperAdmin, async (req, res) => {
        const id = req.parsedClanId;
        const target = (0, clan_repo_js_1.getClanById)(id);
        if (!target) {
            res.status(404).json({ error: 'Clan not found' });
            return;
        }
        await (0, db_backup_js_1.createPreActionBackup)(`pre-delete-clan-${target.name}`);
        const result = (0, clan_repo_js_1.softDeleteClan)(id);
        if (!result.ok) {
            res.status(409).json({ error: result.reason });
            return;
        }
        (0, user_repo_js_1.logAction)(req.user.id, 'clan.delete', { clanId: id, soft: true });
        res.json({ ok: true, soft: true, name: target.name });
    });
    /** Put a soft-deleted clan back. Nothing moved, so this is the flag flip. */
    router.post('/:clanId/restore', auth_js_1.requireSuperAdmin, (req, res) => {
        const id = req.parsedClanId;
        const target = (0, clan_repo_js_1.getClanByIdIncludingDeleted)(id);
        if (!target) {
            res.status(404).json({ error: 'Clan not found' });
            return;
        }
        const result = (0, clan_repo_js_1.restoreDeletedClan)(id);
        if (!result.ok) {
            res.status(409).json({ error: result.reason });
            return;
        }
        (0, user_repo_js_1.logAction)(req.user.id, 'clan.restore', { clanId: id });
        res.json({ ok: true, clanId: id, name: target.name });
    });
    /**
     * Switch which clan the caller is currently viewing. Persists to the
     * session row so it survives page reloads. A superadmin may pick any clan;
     * anyone else only their home clan or an extra clan they were granted —
     * and the session pointer is re-checked against the grant on every request
     * (validateSession), so this route is a convenience, not the gate.
     */
    router.post('/:clanId/activate', auth_js_1.requireAuth, (req, res) => {
        const id = req.parsedClanId;
        const target = (0, clan_repo_js_1.getClanById)(id);
        if (!target) {
            res.status(404).json({ error: 'Clan not found' });
            return;
        }
        if (req.user.role !== 'superadmin'
            && !(0, user_repo_js_1.listSwitchableClans)(req.user.id).some((c) => c.clanId === id)) {
            res.status(403).json({ error: 'You do not have access to this clan' });
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