import fs from 'fs';
import { Router } from 'express';
import {
  getMemberCount,
} from '../../../data/repositories/member-repo.js';
import { getScanSessionCount } from '../../../data/repositories/session-repo.js';
import { getTotalChestCount } from '../../../data/repositories/chest-repo.js';
import { clanStorageStatePath } from '../../../config/clan-paths.js';
import type { Clan } from '../../../data/repositories/clan-repo.js';
import { parseClanIdParam } from '../../middleware/parse-clan-id.js';

/**
 * Public-facing clan shape — strips the Discord token (a secret) before
 * sending to the client. Tokens are only ever set by the superadmin via
 * the dedicated PUT endpoint and never round-tripped to the browser.
 */
export function publicClan(c: Clan): Omit<Clan, 'discordToken'> & { discordTokenSet: boolean } {
  const { discordToken, ...rest } = c;
  return { ...rest, discordTokenSet: discordToken.length > 0 };
}

/**
 * Enriches the public clan with onboarding-state counts so the frontend
 * can hide the "Capture members" / "Run first scan" buttons once the
 * clan has any members or any scan history. `authenticated` is a quick
 * "has the operator ever signed this clan into Total Battle" indicator —
 * purely a presence check on the storage-state file. The `needsReauth`
 * flag, on the other hand, reflects the most recent scan attempt: the
 * auth-check phase flips it on when the saved cookies stop loading the
 * canvas and off again as soon as they load it, and the login bridge also
 * clears it when the operator saves a fresh session. So
 * `authenticated && !needsReauth` is the combined "everything's fine"
 * state the UI cares about.
 *
 * That the auth-check phase clears it is load-bearing, not a nicety: while
 * only the login bridge could, one transient failure (a canvas timing out
 * under memory pressure) pinned a clan to "Needs re-authentication" until
 * an operator manually re-signed in, no matter how many scans succeeded
 * afterwards.
 */
export function publicClanWithCounts(c: Clan) {
  return {
    ...publicClan(c),
    memberCount: getMemberCount(c.id),
    scanCount: getScanSessionCount(c.id),
    authenticated: fs.existsSync(clanStorageStatePath(c.id)),
  };
}

/**
 * A soft-deleted clan, as the System page's restore list shows it.
 *
 * The counts are the point of the row rather than decoration: the whole claim
 * soft delete makes is that nothing was destroyed, and a number the operator
 * can compare against what they remember is the only way that claim is
 * checkable from the UI. All three read the same tables the live clan used —
 * the rows never moved, so nothing here is a special deleted-clan query.
 */
export function deletedClanSummary(c: Clan) {
  return {
    id: c.id,
    name: c.name,
    slug: c.slug,
    deletedAt: c.deletedAt,
    memberCount: getMemberCount(c.id),
    scanCount: getScanSessionCount(c.id),
    chestCount: getTotalChestCount(c.id),
  };
}

/**
 * Build a sub-router with the `:clanId` param handler pre-installed.
 * Express `router.param()` doesn't propagate from parent to mounted
 * sub-routers, so each sub-router that uses `:clanId` paths needs its
 * own. This helper centralises that one-liner.
 */
export function createClanSubRouter(): Router {
  const router = Router();
  router.param('clanId', parseClanIdParam);
  return router;
}
