/**
 * Browser-free check of every active clan's saved Total Battle login.
 *
 * The Clans page's "Authenticated" used to mean only "a session file exists":
 * whether it still worked was learned when the next scan hit the logged-out
 * page, so with scans paused a dead login looked fine indefinitely. One GET of
 * the site page with the stored cookies answers it in about a second
 * (client.checkSiteSession), presents no token, and is run every 30 minutes by
 * the scan loop. Definite answers go through session-health.ts — the same path
 * the scan's game capture uses — and 'unknown' (network error, odd page) changes
 * nothing. The same page names the website account the login belongs to, which
 * keys the scan lanes (scan-lanes.ts).
 *
 * The account is learned once and then only CHECKED (Nov 17 2026): a saved
 * login that starts signing in as another account is flagged for a new login,
 * never adopted — SK7's login flipped to SIK's account and two scans read SIK
 * as SK7. Only a login saved through the bridge sets a new account. It also
 * warns when the saved login carries a sign-in token for an account other than
 * its session's: the leftover that made SK7's flip possible.
 */
import fs from 'fs';
import { childLogger } from '../utils/logger.js';
import { resolveEntries } from '../utils/log-buffer.js';
import { listClans } from '../data/repositories/clan-repo.js';
import { clanStorageStatePath } from '../config/clan-paths.js';
import { checkSiteSessionAccount } from '../game-protocol/client.js';
import { getClanScanAccount, setClanScanAccount } from '../data/repositories/scan-account-repo.js';
import { noteSessionHealthy, noteSessionLoggedOut } from './session-health.js';

const log = childLogger('session-check');

/** Keys the "leftover sign-in token" warning so it resolves once a clean login is saved. */
export const staleTokenWarningKey = (clanId: number): string => `stale-auth-token:${clanId}`;

export async function checkClanSessions(): Promise<void> {
  for (const clan of listClans({ activeOnly: true })) {
    const file = clanStorageStatePath(clan.id);
    if (!fs.existsSync(file)) continue;
    const { state, suid, tokenAccounts } = await checkSiteSessionAccount(file);
    if (state === 'logged-out') {
      noteSessionLoggedOut(clan.id, 'saved Total Battle session is logged out (checked without a browser)');
      continue;
    }
    if (state !== 'ok') {
      log.debug(`Clan #${clan.id}: session check inconclusive; leaving the re-auth flag as it is`);
      continue;
    }
    const known = getClanScanAccount(clan.id);
    if (suid && known && suid !== known) {
      noteSessionLoggedOut(clan.id, `the saved login now signs in as ${suid}, not this clan's account ${known} (checked without a browser) — log in again with this clan's account`);
      continue;
    }
    noteSessionHealthy(clan.id, 'the saved session is signed in on totalbattle.com (checked without a browser)');
    // Which account the login is (first time only): clans on one account share a scan lane.
    if (suid && !known && setClanScanAccount(clan.id, suid, null, 'session-check')) {
      log.info(`Clan #${clan.id}: scanner account learned from the saved login (scan lanes updated)`);
    }
    const stale = suid ? [...new Set(tokenAccounts.filter((t) => t !== suid))] : [];
    if (stale.length) {
      log.warn(
        { resolveKey: staleTokenWarningKey(clan.id) },
        `Clan #${clan.id}'s saved login carries a sign-in token for ${stale.join(', ')} next to its session for ${suid}: `
        + `when that session ends, the site may sign in as ${stale.join(', ')} instead. Log in again (Clans → Log in to Total Battle); the new save drops it.`,
      );
    } else {
      resolveEntries(staleTokenWarningKey(clan.id));
    }
  }
}
