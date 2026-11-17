/**
 * One place that decides what a clan's saved Total Battle login is worth.
 *
 * Two independent observers report into it:
 *   - the scan's game capture (game-protocol-phase.ts), which signs in to the
 *     game with the stored session;
 *   - the session check (session-check.ts), one GET of the site page with the
 *     stored cookies, every 30 minutes.
 *
 * Both must behave identically: a definite "logged out" flips the clan to
 * "Needs re-authentication" (System warning keyed for auto-resolve, one
 * Discord ping per streak); a definite "logged in" clears it and announces the
 * recovery once. Anything ambiguous (network error, odd page) must go through
 * neither.
 */
import { childLogger } from '../utils/logger.js';
import { clearClanNeedsReauth, markClanNeedsReauth, reauthWarningKey } from '../data/repositories/clan-repo.js';
import { postReauthRequiredNotice, postReauthResolvedNotice } from '../discord/bot.js';

const log = childLogger('session-health');

/**
 * The saved session demonstrably works. Only the 1 → 0 transition reports, so
 * the healthy path is silent (and write-free).
 */
export function noteSessionHealthy(clanId: number, how: string): void {
  const { recovered } = clearClanNeedsReauth(clanId);
  if (!recovered) return;
  log.info(`Clan #${clanId} no longer needs re-authentication — ${how}. Clearing the flag.`);
  // Balances the earlier "login expired" ping.
  void postReauthResolvedNotice(clanId).catch(() => {});
}

/**
 * The saved session is demonstrably unusable. The Discord notice fires once
 * per failure streak (markClanNeedsReauth reports only the 0 → 1 transition).
 */
export function noteSessionLoggedOut(clanId: number, cause: string): void {
  const { firstTime } = markClanNeedsReauth(clanId);
  const reason = `Clan #${clanId} needs re-authentication — ${cause}. Open Clans → Refresh login.`;
  // Keyed so the System page retires it once the flag clears.
  log.error({ resolveKey: reauthWarningKey(clanId) }, reason);
  if (firstTime) void postReauthRequiredNotice(clanId).catch(() => {});
}
