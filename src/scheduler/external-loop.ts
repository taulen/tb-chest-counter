import { childLogger } from '../utils/logger.js';
import { ingestSnapshot } from '../external/ingest.js';
import { computeWeekWindowContaining } from '../external/chesttracker-client.js';
import {
  getConfigValue,
  setConfigValue,
  getLatestSnapshot,
} from '../data/repositories/external-repo.js';
import { listClans, getClanById, type Clan } from '../data/repositories/clan-repo.js';
import { loadConfig } from '../config/index.js';

const log = childLogger('external-loop');

/**
 * Legacy single-tenant ct_config keys. Pre-multi-clan deployments stored
 * the share code, poll interval, and "initial backfill done" flags in
 * chesttracker.db's ct_config table. v16 + the multi-clan refactor moved
 * the share-code/poll-interval/backfill settings onto the clans table
 * (per-clan); only the per-share-code "initial_backfill_done" marker
 * still uses ct_config since it's an upstream API metadata flag, not a
 * user-visible setting.
 */
export const CONFIG_KEYS = {
  SHARE_CODE: 'share_code',
  POLL_INTERVAL_HOURS: 'poll_interval_hours',
  BACKFILL_WEEKS: 'backfill_weeks',
  INITIAL_BACKFILL_DONE: 'initial_backfill_done',
  ENABLED: 'enabled',
} as const;

export const DEFAULTS = {
  POLL_INTERVAL_HOURS: 3,
  BACKFILL_WEEKS: 4,
};

// 5 minutes — keeps us polite to chesttracker's API while still allowing
// short intervals during a "find the upstream update cadence" experiment.
const MIN_POLL_HOURS = 5 / 60;

/** Upper bound on one on-demand backfill run. Matches the 0–52 range the
 *  admin form accepts for the initial backfill. */
export const MAX_BACKFILL_WEEKS = 52;

export interface ExternalLoopSettings {
  enabled: boolean;
  shareCode: string | null;
  pollIntervalHours: number;
  backfillWeeks: number;
  initialBackfillDone: boolean;
}

/** Per-share-code "initial backfill done" marker. Keyed by share_code in
 *  ct_config so historical values survive a clan rename. */
function backfillDoneKey(shareCode: string): string {
  return `${CONFIG_KEYS.INITIAL_BACKFILL_DONE}:${shareCode}`;
}

/**
 * Effective settings for one clan, derived from clans table + per-share
 * ct_config marker.
 */
export function readClanSettings(clan: Clan): ExternalLoopSettings {
  const shareCode = clan.ctShareCode || null;
  const initialBackfillDone = shareCode
    ? getConfigValue(backfillDoneKey(shareCode)) === 'true'
    : true;
  return {
    enabled: !!shareCode,
    shareCode,
    pollIntervalHours: clan.ctPollIntervalHours ?? DEFAULTS.POLL_INTERVAL_HOURS,
    backfillWeeks: clan.ctBackfillWeeks ?? DEFAULTS.BACKFILL_WEEKS,
    initialBackfillDone,
  };
}

/**
 * Legacy per-instance read. Used by HTTP routes that haven't been
 * threaded with clanId yet — falls back to clan #1's settings.
 */
export function readSettings(): ExternalLoopSettings {
  const clan = getClanById(1);
  if (clan) return readClanSettings(clan);
  return {
    enabled: false,
    shareCode: null,
    pollIntervalHours: DEFAULTS.POLL_INTERVAL_HOURS,
    backfillWeeks: DEFAULTS.BACKFILL_WEEKS,
    initialBackfillDone: false,
  };
}

/**
 * Persist legacy single-clan ct_config flags. Multi-clan settings live on
 * the clans table now (PUT /api/clans/:id/chesttracker); this is kept for
 * the per-share-code "initial_backfill_done" marker that ExternalLoop
 * still writes itself, plus any pre-multi-clan call sites.
 */
export function writeSettings(patch: Partial<Omit<ExternalLoopSettings, 'initialBackfillDone'>> & {
  initialBackfillDone?: boolean;
  shareCode?: string | null;
}): void {
  if (patch.enabled !== undefined) {
    setConfigValue(CONFIG_KEYS.ENABLED, patch.enabled ? 'true' : 'false');
  }
  if (patch.shareCode !== undefined) {
    setConfigValue(CONFIG_KEYS.SHARE_CODE, patch.shareCode ?? '');
  }
  if (patch.pollIntervalHours !== undefined) {
    setConfigValue(CONFIG_KEYS.POLL_INTERVAL_HOURS, String(patch.pollIntervalHours));
  }
  if (patch.backfillWeeks !== undefined) {
    setConfigValue(CONFIG_KEYS.BACKFILL_WEEKS, String(patch.backfillWeeks));
  }
  if (patch.initialBackfillDone !== undefined && patch.shareCode) {
    setConfigValue(backfillDoneKey(patch.shareCode), patch.initialBackfillDone ? 'true' : 'false');
  } else if (patch.initialBackfillDone !== undefined) {
    setConfigValue(CONFIG_KEYS.INITIAL_BACKFILL_DONE, patch.initialBackfillDone ? 'true' : 'false');
  }
}

/**
 * One ExternalLoop per clan that has a share code configured. Each loop
 * polls chesttracker.com on its own schedule. The MultiClanExternalLoop
 * manager wraps a Map<clanId, ExternalLoop> and forwards
 * start/stop/restart/getStatus across instances.
 */
export class ExternalLoop {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private inFlight = false;
  private nextFetchAt: number | null = null;
  private lastError: { message: string; at: string } | null = null;
  private lastSuccessAt: string | null = null;
  private clanId: number;
  /** Progress of an on-demand backfill (see startBackfill). Separate from
   *  the initial backfill, which runs once per share code at first enable. */
  private backfill: {
    running: boolean;
    done: number;
    total: number;
    inserted: number;
    empty: number;
    failed: number;
  } = { running: false, done: 0, total: 0, inserted: 0, empty: 0, failed: 0 };

  constructor(clanId: number = 1) {
    this.clanId = clanId;
  }

  getClanId(): number {
    return this.clanId;
  }

  private currentSettings(): ExternalLoopSettings {
    const clan = getClanById(this.clanId);
    if (clan) return readClanSettings(clan);
    return readSettings();
  }

  start(): void {
    if (this.running) return;
    const settings = this.currentSettings();
    if (!settings.enabled || !settings.shareCode) {
      log.info(`External loop (clan #${this.clanId}) not started — disabled or no share code configured`);
      return;
    }
    this.running = true;
    log.debug(
      `External loop started (clan=${this.clanId}, share=${settings.shareCode}, interval=${settings.pollIntervalHours}h)`,
    );

    if (!settings.initialBackfillDone) {
      void this.runInitialBackfill(settings);
    } else {
      const intervalMs = Math.max(MIN_POLL_HOURS, settings.pollIntervalHours) * 60 * 60 * 1000;
      // Scoped to the CURRENT share code on purpose: this defers the next
      // poll based on how fresh our data for *this* tracker is. Widening it
      // to the clan would let a just-repointed clan inherit the old
      // tracker's recent fetch and sit idle for a full interval.
      const latest = settings.shareCode
        ? getLatestSnapshot({ clanId: this.clanId, shareCode: settings.shareCode })
        : null;
      if (latest?.fetchedAt) {
        const elapsedMs = Date.now() - new Date(latest.fetchedAt).getTime();
        if (elapsedMs >= 0 && elapsedMs < intervalMs) {
          const remainingMs = intervalMs - elapsedMs;
          log.info(
            `Clan #${this.clanId}: last fetch ${Math.round(elapsedMs / 60_000)} min ago — deferring next fetch by ${Math.round(remainingMs / 60_000)} min`,
          );
          this.scheduleNext(remainingMs);
          return;
        }
      }
      this.scheduleNext(0);
    }
  }

  stop(): void {
    // Always cancel an in-flight backfill, even when the loop itself was
    // never started. restartClan() stops a loop and then discards it; an
    // orphaned backfill would otherwise keep hitting the upstream from a
    // instance nothing holds a reference to any more.
    this.backfill.running = false;
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.nextFetchAt = null;
    log.info(`External loop stopped (clan #${this.clanId})`);
  }

  restart(): void {
    this.stop();
    this.start();
  }

  getStatus(): {
    running: boolean;
    inFlight: boolean;
    nextFetchAt: number | null;
    lastError: { message: string; at: string } | null;
    lastSuccessAt: string | null;
    clanId: number;
    backfill: { running: boolean; done: number; total: number; inserted: number; empty: number; failed: number };
  } {
    return {
      running: this.running,
      inFlight: this.inFlight,
      nextFetchAt: this.nextFetchAt,
      lastError: this.lastError,
      lastSuccessAt: this.lastSuccessAt,
      clanId: this.clanId,
      backfill: { ...this.backfill },
    };
  }

  /**
   * Kick off an on-demand backfill of the last N game weeks.
   *
   * The `backfillWeeks` setting only ever fires once, at first enable, and
   * is gated by a per-share-code marker — so picking too small a number
   * there used to leave no way back except clicking "Fetch a past week…"
   * once per week. This is that loop, on demand, for any code the clan is
   * currently pointed at.
   *
   * Returns immediately; the run happens in the background and its
   * progress shows up in getStatus().backfill. Re-fetching a week already
   * stored is safe — ingest is insert-only and the UI collapses each week
   * to its most recent snapshot.
   */
  startBackfill(weeks: number): { started: boolean; reason?: string; total?: number } {
    if (this.backfill.running) {
      return {
        started: false,
        reason: `A backfill is already running (${this.backfill.done}/${this.backfill.total} weeks done).`,
      };
    }
    const settings = this.currentSettings();
    if (!settings.shareCode) {
      return { started: false, reason: 'No share code configured for this clan.' };
    }
    const total = Math.max(1, Math.min(Math.floor(weeks) || 0, MAX_BACKFILL_WEEKS));
    this.backfill = { running: true, done: 0, total, inserted: 0, empty: 0, failed: 0 };
    void this.runBackfill(settings.shareCode, total);
    return { started: true, total };
  }

  private async runBackfill(shareCode: string, weeks: number): Promise<void> {
    const rolloverHour = loadConfig().gameDayRolloverUtcHour;
    // Hold inFlight for the whole run so a scheduled poll can't interleave
    // and double up on the upstream — runCycle() defers by a minute when
    // it sees this, exactly as it does during the initial backfill.
    this.inFlight = true;
    try {
      log.info(`Clan #${this.clanId}: on-demand backfill of ${weeks} prior week(s) started (${shareCode})`);
      for (let w = 1; w <= weeks; w++) {
        // stop() clears this, so a settings save mid-run aborts cleanly
        // instead of letting a discarded loop finish the whole range.
        if (!this.backfill.running) {
          log.info(`Clan #${this.clanId}: backfill cancelled after ${this.backfill.done}/${weeks} week(s)`);
          break;
        }
        const anchorMs = Date.now() - w * 7 * 24 * 60 * 60 * 1000;
        const window = computeWeekWindowContaining(anchorMs, rolloverHour);
        try {
          const result = await ingestSnapshot({
            clanId: this.clanId,
            shareCode,
            start: window.start,
            end: window.end,
            durationDays: 7,
            trigger: 'backfill',
          });
          // A week from before the tracker existed comes back with no
          // players. Counted separately so the operator can tell "we
          // reached back past the start of history" from "it worked".
          if (result.playerCount === 0) this.backfill.empty++;
          else this.backfill.inserted++;
          this.lastSuccessAt = new Date().toISOString();
          this.lastError = null;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.backfill.failed++;
          this.lastError = { message: msg, at: new Date().toISOString() };
          // One bad week doesn't abort the range — same policy as the
          // initial backfill. lastError carries it to the admin card.
          log.info({ err }, `Clan #${this.clanId}: backfill week ${w} failed (${window.start} → ${window.end}): ${msg}`);
        }
        this.backfill.done = w;
      }
      const { done, inserted, empty, failed } = this.backfill;
      log.info(
        `Clan #${this.clanId}: on-demand backfill finished — ${done} week(s) processed, ${inserted} with data, ${empty} empty, ${failed} failed`,
      );
    } finally {
      this.backfill.running = false;
      this.inFlight = false;
      if (this.running) this.scheduleNext(0);
    }
  }

  private async runInitialBackfill(settings: ExternalLoopSettings): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;

    if (!settings.shareCode) {
      this.inFlight = false;
      return;
    }

    const rolloverHour = loadConfig().gameDayRolloverUtcHour;
    const weeks = Math.max(0, settings.backfillWeeks);

    try {
      log.info(`Clan #${this.clanId}: running initial backfill: ${weeks} prior week(s)`);
      for (let w = 1; w <= weeks; w++) {
        if (!this.running) break;
        const anchorMs = Date.now() - w * 7 * 24 * 60 * 60 * 1000;
        const window = computeWeekWindowContaining(anchorMs, rolloverHour);
        try {
          await ingestSnapshot({
            clanId: this.clanId,
            shareCode: settings.shareCode,
            start: window.start,
            end: window.end,
            durationDays: 7,
            trigger: 'backfill',
          });
          this.lastSuccessAt = new Date().toISOString();
          this.lastError = null;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.lastError = { message: msg, at: new Date().toISOString() };
          // Single-week failure during backfill is recoverable — the
          // outer loop continues with the remaining weeks. The
          // operator-facing surface is `lastError` on the loop's
          // status, exposed via /api/external/status.
          log.info({ err }, `Clan #${this.clanId}: backfill week ${w} failed (${window.start} → ${window.end}): ${msg}`);
        }
      }
      writeSettings({ shareCode: settings.shareCode, initialBackfillDone: true });
      log.info(`Clan #${this.clanId}: initial backfill complete`);
    } finally {
      this.inFlight = false;
      if (this.running) this.scheduleNext(0);
    }
  }

  private scheduleNext(delayMs: number | null = null): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);

    const settings = this.currentSettings();
    const interval = Math.max(MIN_POLL_HOURS, settings.pollIntervalHours) * 60 * 60 * 1000;
    const effectiveDelay = delayMs ?? interval;
    this.nextFetchAt = Date.now() + effectiveDelay;

    this.timer = setTimeout(() => void this.runCycle(), effectiveDelay);
  }

  private nextFetchMinutes(): number {
    const settings = this.currentSettings();
    return Math.round(Math.max(MIN_POLL_HOURS, settings.pollIntervalHours) * 60);
  }

  private async runCycle(): Promise<void> {
    if (!this.running) return;
    if (this.inFlight) {
      this.scheduleNext(60_000);
      return;
    }

    const settings = this.currentSettings();
    if (!settings.enabled || !settings.shareCode) {
      log.info(`Clan #${this.clanId}: external loop paused — disabled or share code cleared`);
      this.stop();
      return;
    }

    this.inFlight = true;
    try {
      const result = await ingestSnapshot({
        clanId: this.clanId,
        shareCode: settings.shareCode,
        trigger: 'scheduled',
      });
      this.lastSuccessAt = new Date().toISOString();
      this.lastError = null;
      const summary = result.status === 'inserted'
        ? `snapshot #${result.snapshotId}: ${result.playerCount} players, ${result.totalChests} chests, ${result.totalPoints} points`
        : result.status === 'not_modified'
          ? 'no change (304)'
          : 'empty snapshot';
      // Only log "new data" outcomes at info — the 304/empty cases
      // are the steady state on a quiet poll cycle (every 15 min by
      // default), so logging them at info filled the operator log
      // with rows that just said "nothing happened".
      if (result.status === 'inserted') {
        log.info(`Clan #${this.clanId}: ${summary} — next fetch in ${this.nextFetchMinutes()} min`);
      } else {
        log.debug(`Clan #${this.clanId}: ${summary} — next fetch in ${this.nextFetchMinutes()} min`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = { message: msg, at: new Date().toISOString() };
      // External fetch failures are retried at the next interval and
      // tracked in `lastError` (visible on the External admin card).
      // Operators see persistent failures via that surface; the log
      // line is just informational scrollback.
      log.info({ err }, `Clan #${this.clanId}: external fetch failed — will retry in ${this.nextFetchMinutes()} min: ${msg}`);
    } finally {
      this.inFlight = false;
    }

    this.scheduleNext();
  }
}

/**
 * Holds one ExternalLoop per clan and forwards start/stop/restart across
 * them. The web server treats this exactly like the old single-instance
 * ExternalLoop — same `start()` / `stop()` / `restart()` surface — so the
 * existing call sites in src/index.ts and src/web/server.ts compile
 * unchanged.
 */
export class MultiClanExternalLoop {
  private loops = new Map<number, ExternalLoop>();

  start(): void {
    for (const clan of listClans({ activeOnly: true })) {
      if (!clan.ctShareCode) continue;
      let loop = this.loops.get(clan.id);
      if (!loop) {
        loop = new ExternalLoop(clan.id);
        this.loops.set(clan.id, loop);
      }
      loop.start();
    }
  }

  stop(): void {
    for (const loop of this.loops.values()) {
      loop.stop();
    }
  }

  /** Restart every clan's loop. Used after a settings save when we don't
   *  know which clan changed (or many changed at once). */
  restart(): void {
    this.stop();
    this.start();
  }

  /** Restart only the named clan's loop after a per-clan settings change. */
  restartClan(clanId: number): void {
    const loop = this.loops.get(clanId);
    if (loop) {
      loop.stop();
      this.loops.delete(clanId);
    }
    const clan = getClanById(clanId);
    if (clan?.ctShareCode) {
      const next = new ExternalLoop(clanId);
      this.loops.set(clanId, next);
      next.start();
    }
  }

  getStatus(): ReturnType<ExternalLoop['getStatus']>[] {
    return Array.from(this.loops.values()).map((l) => l.getStatus());
  }

  /** Start an on-demand backfill for one clan. Creates the loop lazily so
   *  a clan configured since startup can still be backfilled without a
   *  restart — the loop itself doesn't need to be polling for this. */
  startBackfillForClan(clanId: number, weeks: number): ReturnType<ExternalLoop['startBackfill']> {
    let loop = this.loops.get(clanId);
    if (!loop) {
      const clan = getClanById(clanId);
      if (!clan?.ctShareCode) {
        return { started: false, reason: 'No share code configured for this clan.' };
      }
      loop = new ExternalLoop(clanId);
      this.loops.set(clanId, loop);
    }
    return loop.startBackfill(weeks);
  }
}
