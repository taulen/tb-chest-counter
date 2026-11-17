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
 */
import fs from 'fs';
import { childLogger } from '../utils/logger.js';
import { listClans } from '../data/repositories/clan-repo.js';
import { clanStorageStatePath } from '../config/clan-paths.js';
import { checkSiteSessionAccount } from '../game-protocol/client.js';
import { setClanScanAccount } from '../data/repositories/scan-account-repo.js';
import { noteSessionHealthy, noteSessionLoggedOut } from './session-health.js';

const log = childLogger('session-check');

export async function checkClanSessions(): Promise<void> {
  for (const clan of listClans({ activeOnly: true })) {
    const file = clanStorageStatePath(clan.id);
    if (!fs.existsSync(file)) continue;
    const { state, suid } = await checkSiteSessionAccount(file);
    if (state === 'ok') noteSessionHealthy(clan.id, 'the saved session is signed in on totalbattle.com (checked without a browser)');
    // Which account the login is: clans on the same account share a scan lane.
    if (state === 'ok' && suid && setClanScanAccount(clan.id, suid, null, 'session-check')) {
      log.info(`Clan #${clan.id}: scanner account learned from the saved login (scan lanes updated)`);
    }
    else if (state === 'logged-out') noteSessionLoggedOut(clan.id, 'saved Total Battle session is logged out (checked without a browser)');
    else log.debug(`Clan #${clan.id}: session check inconclusive; leaving the re-auth flag as it is`);
  }
}
