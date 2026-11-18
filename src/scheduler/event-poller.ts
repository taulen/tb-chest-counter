/**
 * Rise of the Ancients between scans: while the event runs, each clan's Tin Man
 * standings are read again every ~10 minutes (every ~5 while a summon is
 * scoring), so the summons a run is split into (data/summon-windows.ts) are
 * not blurred by the scan interval. Two requests per clan per read: the window
 * header (38000, summons left) and the standings (38003) — event-read.ts.
 *
 * It never signs in. It reuses the game session the clan's last scan signed in
 * with (kept in memory by keepGameSession at the end of the scan), the way the
 * chat poller reuses its chat key. When a read fails, or the reply comes back
 * empty, the session is dropped and the clan waits for its next scan (a new
 * login elsewhere — the next scan on the same account, the login bridge, a
 * player — supersedes it). Nothing is kept across a restart.
 *
 * It respects the scan lanes: a clan is never read while its lane (its game
 * account) has a scan queued or running, and the read itself is queued on the
 * lane, so a scan that starts meanwhile waits for it (two requests). While the
 * login bridge has scanning paused, nothing is read and every kept session is
 * dropped (the bridge's own login supersedes them).
 */
import type { GameClient } from '../game-protocol/client.js';
import { ANCIENTS_EVENT_TYPE } from '../game-protocol/ancients.js';
import { listEventReads, liveEventRun } from '../data/repositories/game-event-repo.js';
import { splitSummons } from '../data/summon-windows.js';
import { toSummonReads } from '../data/ancients-game.js';
import { readEventStandings } from './event-read.js';
import { gameDateFor } from '../utils/game-day.js';
import { READ_GAP, requestGap } from '../utils/request-gap.js';
import { childLogger } from '../utils/logger.js';
import { createCoalescedWarner } from '../utils/log-throttle.js';

const log = childLogger('event-poll');
const warner = createCoalescedWarner((m) => log.warn({ noAlert: true }, m), 60 * 60_000);

/** How often the poller looks (it reads only when a clan is due). */
export const POLL_TICK_MS = 60_000;
/** Reads at most this far apart while the event runs. */
export const POLL_IDLE_MS = 10 * 60_000;
/** … and this far apart while a summon is scoring. */
export const POLL_ACTIVE_MS = 5 * 60_000;

/**
 * Whether a clan's next read is due, checked once per tick: a read is made on
 * the last tick before the gap would pass the interval, so with ticks every
 * POLL_TICK_MS two reads are never more than the interval apart. A clan with
 * no read yet is due at once.
 */
export function pollDue(nowMs: number, lastReadMs: number | null, summonLive: boolean): boolean {
  if (lastReadMs === null) return true;
  const interval = summonLive ? POLL_ACTIVE_MS : POLL_IDLE_MS;
  return nowMs - lastReadMs + POLL_TICK_MS > interval;
}

/** What the poller needs from the scan loop. */
export interface PollGate {
  /** Scanning paused (the login bridge is open) or stopped. */
  paused(): boolean;
  /** The clan's lane (its game account) has a scan queued or running. */
  laneBusy(clanId: number): boolean;
  /** Run a job on the clan's lane, after anything queued there. */
  runOnLane<T>(clanId: number, job: () => Promise<T>): Promise<T>;
  rolloverUtcHour(): number;
}

interface Kept {
  client: GameClient;
  keptAt: number;
}
const kept = new Map<number, Kept>();
let gate: PollGate | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

/** After a clan's scan: its game session, for reads until the next scan. */
export function keepGameSession(clanId: number, client: GameClient): void {
  kept.set(clanId, { client, keptAt: Date.now() });
}

/** Forget a clan's session (only that client's, when given: a newer scan's stays). */
export function dropGameSession(clanId: number, client?: GameClient): void {
  const k = kept.get(clanId);
  if (k && (!client || k.client === client)) kept.delete(clanId);
}

/** Forget every session (the login bridge opened: its login supersedes them all). */
export function dropAllGameSessions(): void {
  kept.clear();
}

/** Clans with a session kept. */
export function keptSessionClans(): number[] {
  return [...kept.keys()];
}

/**
 * Run `job` with the clan's kept game session, queued on its lane like a read —
 * the chat invite replies between scans use it for a chat token (message 414,
 * scheduler/chat-invites.ts). Undefined when there is no session, scanning is
 * paused (the login bridge is open) or the lane is busy: the clan's next scan
 * answers instead. A failure drops the session and is rethrown.
 */
export async function withKeptGameSession<T>(clanId: number, job: (client: GameClient) => Promise<T>): Promise<T | undefined> {
  const g = gate;
  const k = kept.get(clanId);
  if (!g || !k || g.paused() || g.laneBusy(clanId)) return undefined;
  try {
    return await g.runOnLane(clanId, async () => {
      if (g.paused() || kept.get(clanId)?.client !== k.client) return undefined;
      return job(k.client);
    });
  } catch (err) {
    dropGameSession(clanId, k.client);
    throw err;
  }
}

export function startEventPoller(g: PollGate): void {
  gate = g;
  if (timer) return;
  timer = setInterval(() => { void pollTick(); }, POLL_TICK_MS);
  timer.unref?.();
}

export function stopEventPoller(): void {
  if (timer) clearInterval(timer);
  timer = null;
  gate = null;
  kept.clear();
}

/** For tests: install a gate without a timer. */
export function setPollGateForTest(g: PollGate | null): void {
  gate = g;
}

/**
 * One look at every kept clan: read the ones whose running Rise of the
 * Ancients is due. Returns how many were read. Never throws.
 */
export async function pollTick(nowMs = Date.now()): Promise<number> {
  const g = gate;
  if (!g || ticking) return 0;
  if (g.paused()) {
    kept.clear();
    return 0;
  }
  ticking = true;
  let done = 0;
  try {
    for (const [clanId, k] of [...kept]) {
      try {
        const run = liveEventRun(clanId, ANCIENTS_EVENT_TYPE, Math.floor(nowMs / 1000));
        if (!run || g.laneBusy(clanId)) continue;
        const key = { eventType: run.eventType, run: run.run, occurrence: run.occurrence };
        const reads = toSummonReads(listEventReads(clanId, key));
        const split = splitSummons(reads, { now: nowMs, running: true });
        const live = split.groups[split.groups.length - 1]?.live ?? false;
        if (!pollDue(nowMs, reads.length ? reads[reads.length - 1].at : null, live)) continue;

        const got = await g.runOnLane(clanId, async () => {
          // Re-checked on the lane: the bridge may have opened, or a scan kept a newer session.
          if (g.paused() || kept.get(clanId)?.client !== k.client) return undefined;
          const now = new Date().toISOString();
          return readEventStandings(clanId, k.client, key, {
            now,
            gameDate: gameDateFor(Date.parse(now), g.rolloverUtcHour()),
            source: 'poll',
            pause: () => requestGap(READ_GAP[0], READ_GAP[1]),
          });
        });
        if (got === undefined) continue;
        if (got === null) {
          // An empty reply on a live run: treat the session as gone.
          dropGameSession(clanId, k.client);
          warner.warn(`empty:${clanId}`, `Clan #${clanId}: Tin Man standings came back empty between scans — waiting for the next scan`);
          continue;
        }
        done++;
        log.debug(`Clan #${clanId} Tin Man read between scans: ${got.rows} members, ${got.changed} moved, summons left ${got.summonsLeft ?? '?'}`);
      } catch (err) {
        dropGameSession(clanId, k.client);
        warner.warn(`fail:${clanId}`, `Clan #${clanId}: Tin Man reads between scans paused until its next scan: ${String(err)}`);
      }
    }
  } finally {
    ticking = false;
  }
  return done;
}
