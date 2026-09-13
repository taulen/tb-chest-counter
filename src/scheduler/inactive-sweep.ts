import { childLogger } from '../utils/logger.js';
import { listClans } from '../data/repositories/clan-repo.js';
import { deactivateStaleMembers } from '../data/repositories/member-repo.js';
import { getLastCompletedSession } from '../data/repositories/session-repo.js';
import { logSystemAction } from '../data/repositories/user-repo.js';

const log = childLogger('inactive-sweep');

/**
 * Daily "inactivity sweep": soft-removes members that haven't been seen
 * in a scan for their clan's threshold (is_active = 0). Non-destructive —
 * the member row and chest history stay, and the next scan that OCRs the
 * name reactivates it via memberRepo.upsertMember. This is the batch
 * counterpart to the manual Admin → Remove member action.
 *
 * "Seen" has two sources, and the second matters here. A chest or gift scan
 * refreshes last_seen for whoever earned something — but a player can go a week
 * without earning a chest while plainly still being in the clan, and this sweep
 * used to remove them for it. The daily might capture also reads the in-game
 * member list, which IS the authoritative roster, and marks everyone on it as seen
 * (memberRepo.markMembersSeen). So with might tracking enabled this sweep now only
 * removes members the game itself has stopped listing, which is what it always
 * meant to do.
 *
 * Each clan has an on/off toggle (clan.inactivitySweepEnabled) and a
 * threshold resolved per clan: clan.inactivityDays when a clan admin has set
 * one, otherwise the global MEMBER_INACTIVITY_DAYS default.
 *
 * Scheduling mirrors the Discord digest: a single self-rearming
 * setTimeout aligned to the game-day rollover hour (so it lands right
 * after the day it's judging closes), plus one immediate run at boot.
 * The boot run makes downtime a non-issue without any persisted catch-up
 * state — the sweep is idempotent and its cutoff is purely time-based, so
 * running it late (or twice) always yields the correct set of members.
 */

let timer: ReturnType<typeof setTimeout> | null = null;
let rolloverUtcHour = 17;
let defaultInactivityDays = 7;

function cutoffIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** Sweep every active clan once. Safe to call any time; logs per clan. */
export function runInactiveSweep(): void {
  let total = 0;
  for (const clan of listClans({ activeOnly: true })) {
    try {
      // Per-clan on/off toggle, then the threshold (clan override or the
      // global default). A non-positive default is treated as "off" too, so
      // MEMBER_INACTIVITY_DAYS=0 still works as a global kill switch.
      if (!clan.inactivitySweepEnabled) continue;
      const days = clan.inactivityDays ?? defaultInactivityDays;
      if (days <= 0) continue;
      const cutoff = cutoffIso(days);

      // Scanner-outage guard: a member's last_seen can only advance when a
      // scan succeeds, so if this clan hasn't completed a scan since the
      // cutoff, EVERY member looks stale purely because scanning was down —
      // not because they left. Skip the clan in that case; the next
      // successful scan refreshes last_seen and a later sweep judges fairly.
      const lastScanAt = getLastCompletedSession(clan.id)?.completedAt;
      if (!lastScanAt || lastScanAt < cutoff) {
        log.warn(
          `Clan #${clan.id}: skipping inactivity sweep — no successful scan since the ` +
          `${days}-day cutoff (last completed scan: ${lastScanAt ?? 'never'})`,
        );
        continue;
      }

      const removed = deactivateStaleMembers(clan.id, cutoff);
      if (removed.length > 0) {
        total += removed.length;
        log.info(`Clan #${clan.id}: marked ${removed.length} member(s) inactive (unseen ${days}+ days)`);
        // Clan-scoped audit entry so clan admins + superadmins can see
        // exactly who the sweep removed and why, in the Users → Audit Log.
        logSystemAction(clan.id, 'member.auto_deactivate', {
          clanId: clan.id,
          days,
          count: removed.length,
          members: removed.map((m) => m.name),
        });
      }
    } catch (err) {
      log.error(`Clan #${clan.id}: inactivity sweep failed: ${String(err)}`);
    }
  }
  if (total === 0) {
    log.debug('Inactivity sweep: no members past their clan threshold');
  }
}

function scheduleNext(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }

  const now = new Date();
  const target = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    rolloverUtcHour, 0, 0, 0,
  ));
  if (target.getTime() <= now.getTime()) {
    target.setUTCDate(target.getUTCDate() + 1);
  }
  const delayMs = target.getTime() - now.getTime();
  log.debug(`Next inactivity sweep scheduled for ${target.toISOString()} (in ~${Math.round(delayMs / 60_000)} min)`);

  timer = setTimeout(() => {
    timer = null;
    runInactiveSweep();
    scheduleNext();
  }, delayMs);
}

/**
 * Start the daily inactivity sweep. Runs once immediately (covering any
 * rollover missed while the container was down) then re-arms for the next
 * rollover hour. `defaultDays` is the global fallback for clans that
 * haven't set their own threshold; a clan (or the default) resolving to 0
 * disables the sweep for that clan. The scheduler always runs so a clan
 * can opt in via its own override even when the global default is 0.
 */
export function startInactiveSweep(rolloverHour: number, defaultDays: number): void {
  rolloverUtcHour = rolloverHour;
  defaultInactivityDays = defaultDays;
  log.info(
    `Inactivity sweep started (default ${defaultDays} day(s), per-clan overridable) — ` +
    `runs daily at ${rolloverUtcHour}:00 UTC`,
  );
  runInactiveSweep();
  scheduleNext();
}

export function stopInactiveSweep(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
