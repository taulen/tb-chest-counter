import type { Router } from 'express';
import {
  listClans,
  getClanById,
  createClan,
  renameClan,
  setClanActive,
  setClanScanIntervalMinutes,
  softDeleteClan,
  restoreDeletedClan,
  listDeletedClans,
  getClanByIdIncludingDeleted,
} from '../../../data/repositories/clan-repo.js';
import { setSessionActiveClan, logAction } from '../../../data/repositories/user-repo.js';
import {
  createShareLink,
  listActiveShareLinks,
  revokeShareLink,
  setShareLinkLabel,
  restoreShareLink,
  deleteShareLink,
  getShareLinkAnalytics,
  normalizeShareLinkLabel,
} from '../../../data/repositories/share-link-repo.js';
import { loadConfig } from '../../../config/index.js';
import { generateUniqueShareToken, validateVanityKey } from '../../../utils/share-token.js';
import { createPreActionBackup } from '../../../utils/db-backup.js';
import { requireAuth, requireClanAdmin, requireSuperAdmin } from '../../middleware/auth.js';
import { childLogger } from '../../../utils/logger.js';
import { createClanSubRouter, deletedClanSummary, publicClan, publicClanWithCounts } from './_shared.js';
import type { OnboardState } from './onboard.js';

const log = childLogger('clans-route');

/** `:linkId` as a positive integer, or null when the segment isn't one. */
function parseLinkId(raw: string | string[] | undefined): number | null {
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Clan CRUD: list, fetch, create, rename, delete, public share-link
 * generate/disable, and the superadmin "switch active clan" route.
 *
 * The DELETE handler also clears the onboard state for the removed
 * clan so the in-memory progress map doesn't grow forever — that's
 * why this router takes the OnboardState bag.
 */
export function createCrudRouter(onboardState: OnboardState): Router {
  const router = createClanSubRouter();

  /**
   * List clans visible to the caller. Superadmin sees all; admin/user sees
   * just their own clan. The frontend uses this to populate the superadmin
   * clan switcher and to render the clan-name header label for everyone.
   */
  router.get('/', requireAuth, (req, res) => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    // Global fallback threshold for the member-inactivity sweep, so the
    // per-clan settings input can show it as its "blank = default" hint.
    const defaultInactivityDays = loadConfig().memberInactivityDays;
    if (req.user.role === 'superadmin') {
      res.json({
        clans: listClans().map((c) => ({ ...publicClanWithCounts(c), shareLinks: listActiveShareLinks(c.id) })),
        activeClanId: req.clanId ?? null,
        defaultInactivityDays,
      });
      return;
    }
    const own = req.user.clanId !== null ? getClanById(req.user.clanId) : null;
    if (!own) {
      res.json({ clans: [], activeClanId: null, defaultInactivityDays });
      return;
    }
    // Plain members can't manage public share links (create/disable is
    // admin-only), so don't hand them the live keys — each one grants
    // anonymous read access they could leak outside the clan. Admins and
    // superadmins get them so the Clans settings page can render the list.
    const shape: Record<string, unknown> = publicClanWithCounts(own);
    if (req.user.role !== 'user') {
      shape.shareLinks = listActiveShareLinks(own.id);
    }
    res.json({ clans: [shape], activeClanId: own.id, defaultInactivityDays });
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
  router.get('/deleted', requireSuperAdmin, (_req, res) => {
    res.json({ clans: listDeletedClans().map(deletedClanSummary) });
  });

  /**
   * Fetch a single clan. Superadmin: any clan. Admin/user: only their own.
   * Used by the per-clan Discord/CT settings pages so they can render the
   * current values for editing.
   */
  router.get('/:clanId', requireAuth, (req, res) => {
    const id = req.parsedClanId!;
    if (req.user!.role !== 'superadmin' && req.user!.clanId !== id) {
      res.status(403).json({ error: 'You do not have access to this clan' });
      return;
    }
    const clan = getClanById(id);
    if (!clan) {
      res.status(404).json({ error: 'Clan not found' });
      return;
    }
    res.json({ clan: publicClan(clan) });
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
  router.post('/', requireSuperAdmin, (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) {
      res.status(400).json({ error: 'Clan name is required' });
      return;
    }
    try {
      const clan = createClan({
        name,
        createdBy: req.user?.id ?? null,
      });
      logAction(req.user!.id, 'clan.create', { clanId: clan.id, name });
      res.status(201).json({ clan: publicClan(clan) });
    } catch (err) {
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
  router.put('/:clanId', requireSuperAdmin, (req, res) => {
    const id = req.parsedClanId!;
    const existing = getClanById(id);
    if (!existing) {
      res.status(404).json({ error: 'Clan not found' });
      return;
    }
    if (typeof req.body?.name === 'string' && req.body.name.trim()) {
      try {
        renameClan(id, req.body.name.trim());
      } catch (err) {
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
      setClanScanIntervalMinutes(id, parsed);
    }
    if ('isActive' in (req.body ?? {})) {
      setClanActive(id, !!req.body.isActive);
    }
    logAction(req.user!.id, 'clan.update', { clanId: id });
    const fresh = getClanById(id);
    res.json({ clan: fresh ? publicClan(fresh) : null });
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
  router.get('/:clanId/share-links', requireClanAdmin, (req, res) => {
    const id = req.parsedClanId!;
    if (!getClanById(id)) {
      res.status(404).json({ error: 'Clan not found' });
      return;
    }
    res.json(getShareLinkAnalytics(id, 8));
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
  router.post('/:clanId/share-links', requireClanAdmin, (req, res) => {
    const id = req.parsedClanId!;
    if (!getClanById(id)) {
      res.status(404).json({ error: 'Clan not found' });
      return;
    }
    const label = normalizeShareLinkLabel(req.body?.label);
    const rawKey = typeof req.body?.key === 'string' ? req.body.key.trim() : '';

    let token: string;
    let isVanity = false;
    if (rawKey) {
      const check = validateVanityKey(rawKey);
      if (!check.ok) {
        res.status(400).json({ error: check.error });
        return;
      }
      token = check.key;
      isVanity = true;
    } else {
      token = generateUniqueShareToken();
    }

    const link = createShareLink(id, token, req.user!.id, { label, isVanity });
    logAction(req.user!.id, 'clan.share_link.create', { clanId: id, linkId: link.id, isVanity });
    res.json({ ok: true, link });
  });

  /**
   * Rename one link. The label is the only editable field — a key is part of
   * a URL people already hold, so changing it in place would silently break
   * those URLs while looking like a rename.
   */
  router.patch('/:clanId/share-links/:linkId', requireClanAdmin, (req, res) => {
    const id = req.parsedClanId!;
    const linkId = parseLinkId(req.params.linkId);
    if (linkId === null) {
      res.status(400).json({ error: 'A valid linkId is required' });
      return;
    }
    if (!setShareLinkLabel(id, linkId, normalizeShareLinkLabel(req.body?.label))) {
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
  router.delete('/:clanId/share-links/:linkId', requireClanAdmin, (req, res) => {
    const id = req.parsedClanId!;
    const linkId = parseLinkId(req.params.linkId);
    if (linkId === null) {
      res.status(400).json({ error: 'A valid linkId is required' });
      return;
    }
    if (!revokeShareLink(id, linkId, 'disabled', req.user!.id)) {
      res.status(404).json({ error: 'Link not found or already disabled' });
      return;
    }
    logAction(req.user!.id, 'clan.share_link.disable', { clanId: id, linkId });
    res.json({ ok: true });
  });

  /**
   * Restore a previously-disabled link. No longer swaps anything out — the
   * clan simply holds one more live link than it did.
   */
  router.post('/:clanId/share-links/:linkId/restore', requireClanAdmin, (req, res) => {
    const id = req.parsedClanId!;
    const linkId = parseLinkId(req.params.linkId);
    if (linkId === null) {
      res.status(400).json({ error: 'A valid linkId is required' });
      return;
    }
    const result = restoreShareLink(id, linkId);
    if (!result.ok) {
      res.status(409).json({ error: result.reason });
      return;
    }
    logAction(req.user!.id, 'clan.share_link.restore', { clanId: id, linkId });
    res.json({ ok: true, token: result.token });
  });

  /**
   * Permanently delete a disabled link, discarding its history. The only
   * reason to do this is to free a vanity key for reuse — a key stays claimed
   * for as long as any row holds it, including a revoked one, so that an old
   * URL can never be repointed at a different clan by accident.
   */
  router.delete('/:clanId/share-links/:linkId/permanent', requireClanAdmin, (req, res) => {
    const id = req.parsedClanId!;
    const linkId = parseLinkId(req.params.linkId);
    if (linkId === null) {
      res.status(400).json({ error: 'A valid linkId is required' });
      return;
    }
    const result = deleteShareLink(id, linkId);
    if (!result.ok) {
      res.status(409).json({ error: result.reason });
      return;
    }
    logAction(req.user!.id, 'clan.share_link.delete', { clanId: id, linkId });
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
  router.delete('/:clanId', requireSuperAdmin, async (req, res) => {
    const id = req.parsedClanId!;
    const target = getClanById(id);
    if (!target) {
      res.status(404).json({ error: 'Clan not found' });
      return;
    }

    await createPreActionBackup(`pre-delete-clan-${target.name}`);

    const result = softDeleteClan(id);
    if (!result.ok) {
      res.status(409).json({ error: result.reason });
      return;
    }
    onboardState.clear(id);
    logAction(req.user!.id, 'clan.delete', { clanId: id, soft: true });
    res.json({ ok: true, soft: true, name: target.name });
  });

  /** Put a soft-deleted clan back. Nothing moved, so this is the flag flip. */
  router.post('/:clanId/restore', requireSuperAdmin, (req, res) => {
    const id = req.parsedClanId!;
    const target = getClanByIdIncludingDeleted(id);
    if (!target) {
      res.status(404).json({ error: 'Clan not found' });
      return;
    }
    const result = restoreDeletedClan(id);
    if (!result.ok) {
      res.status(409).json({ error: result.reason });
      return;
    }
    logAction(req.user!.id, 'clan.restore', { clanId: id });
    res.json({ ok: true, clanId: id, name: target.name });
  });

  /**
   * Switch which clan a superadmin is currently viewing. Persists to the
   * session row so it survives page reloads. Non-superadmins are forced
   * to their own clan and get a 403 here regardless of payload.
   */
  router.post('/:clanId/activate', requireSuperAdmin, (req, res) => {
    const id = req.parsedClanId!;
    const target = getClanById(id);
    if (!target) {
      res.status(404).json({ error: 'Clan not found' });
      return;
    }
    if (!req.sessionToken) {
      res.status(401).json({ error: 'No session' });
      return;
    }
    setSessionActiveClan(req.sessionToken, id);
    res.json({ ok: true, activeClanId: id });
  });

  return router;
}
