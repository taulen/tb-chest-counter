/**
 * One read of one event's standings, shared by the scan (collectEvents in
 * game-protocol-phase.ts) and the between-scans poller (event-poller.ts):
 *
 *   - Rise of the Ancients first: its window header (38000) — summons left and
 *     the Enchanted Figurine's summons — so the read is tagged with its summon;
 *   - then the "Clan members" standings (38003);
 *   - stored: the standings (+ history rows for moved points), one read row
 *     (v123), the raw replies (one per run per game day, the day's latest).
 *
 * Read-only requests, exactly what the client sends when the event window
 * opens. Throws when the standings request fails; returns null when the reply
 * holds no standings (nothing stored).
 */
import type { GameClient } from '../game-protocol/client.js';
import { parseEventProgress, parseEventStandings, parseOlympusMembers, type GameEventEntry, type GameEventProgress } from '../game-protocol/messages.js';
import { ANCIENTS_EVENT_TYPE, figurineSummons } from '../game-protocol/ancients.js';
import { OLYMPUS_EVENT_TYPE } from '../game-protocol/olympus.js';
import { saveEventRead, saveEventRun, saveEventStandings, touchEventRun, type EventRunKey } from '../data/repositories/game-event-repo.js';
import { saveRawSnapshot } from '../data/repositories/game-protocol-repo.js';

export interface EventReadResult {
  rows: number;
  moved: number;
  changed: number;
  summonsLeft: number | null;
  summonsMax: number | null;
}

export async function readEventStandings(
  clanId: number,
  client: GameClient,
  key: EventRunKey,
  opts: {
    now: string;
    gameDate: string;
    source: 'scan' | 'poll';
    /** The list entry and its title (a scan): the run row is written. A poll only moves its last-read time. */
    entry?: { e: GameEventEntry; code: string; title: string };
    /** A short varied gap between the two requests. */
    pause?: () => Promise<void>;
  },
): Promise<EventReadResult | null> {
  const ref = key.eventType * 1000 + key.run;
  let progress: GameEventProgress | null = null;
  if (key.eventType === ANCIENTS_EVENT_TYPE) {
    try {
      const head = await client.eventProgress(key.eventType, key.run);
      progress = parseEventProgress(head);
      saveRawSnapshot(clanId, 'event_progress', ref, opts.gameDate, head.body, opts.now);
    } catch {
      // The standings still count; the read just has no summon tag.
    }
    // A header from another occurrence (the run rolled over) says nothing about this one.
    if (progress?.occurrence !== null && progress?.occurrence !== undefined && progress.occurrence !== key.occurrence) progress = null;
    await opts.pause?.();
  }

  // Trials of Olympus answers 38003 with every member at 0: its Clan members
  // tab is 82003 (game-protocol/olympus.ts).
  const olympus = key.eventType === OLYMPUS_EVENT_TYPE;
  const frame = olympus ? await client.olympusMembers(key.eventType, key.run) : await client.eventStandings(key.eventType, key.run);
  const standings = olympus ? parseOlympusMembers(frame) : parseEventStandings(frame);
  if (!standings.length) return null;

  if (opts.entry) saveEventRun(clanId, opts.entry.e, { code: opts.entry.code, title: opts.entry.title }, opts.now);
  else touchEventRun(clanId, key, opts.now);
  const saved = saveEventStandings(clanId, key, standings, opts.now);
  const summonsLeft = progress?.summonsLeft ?? null;
  const figurine = figurineSummons(progress);
  saveEventRead(clanId, key, {
    readAt: opts.now,
    source: opts.source,
    members: standings.length,
    totalPoints: standings.reduce((s, r) => s + r.points, 0),
    changed: saved.changed,
    summonsLeft,
    summonsMax: figurine,
    summonsUsed: summonsLeft === null ? null : Math.max(figurine ?? 0, summonsLeft) - summonsLeft,
    bossId: progress?.bossId ?? null,
  });
  saveRawSnapshot(clanId, 'event', ref, opts.gameDate, frame.body, opts.now);
  return { rows: standings.length, moved: saved.moved, changed: saved.changed, summonsLeft, summonsMax: figurine };
}
