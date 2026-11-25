/**
 * One read of one event's standings, shared by the scan (collectEvents in
 * game-protocol-phase.ts) and the between-scans poller (event-poller.ts):
 *
 *   - Rise of the Ancients first: its window header (38000) — summons left and
 *     the Enchanted Figurine's summons — so the read is tagged with its summon;
 *   - then the "Clan members" standings (38003);
 *   - a run ranked across its matchup (Sealed in Flame, olympus.ts): the
 *     Ranking tab (24003, rating proxy) too — each member's place and points
 *     there replace the Clan members tab's zeros (overlayRanking);
 *   - stored: the standings (+ history rows for moved points), one read row
 *     (v123), the raw replies (one per run per game day, the day's latest).
 *
 * Read-only requests, exactly what the client sends when the event window
 * opens. Throws when the standings request fails; returns null when the reply
 * holds no standings (nothing stored).
 */
import type { GameClient } from '../game-protocol/client.js';
import {
  parseEventProgress, parseEventRanking, parseEventStandings, parseOlympusMembers,
  type GameEventEntry, type GameEventProgress, type GameEventStanding,
} from '../game-protocol/messages.js';
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
    /**
     * The run is ranked across its matchup (isMatchupRankedRun): its Ranking
     * tab's scope and group (24203) and our clan's game id. A ranking that
     * can't be read stores nothing — the Clan members tab alone is all zeros.
     */
    ranking?: { scope: number; group: number; gameClanId: number };
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
  let standings = olympus ? parseOlympusMembers(frame) : parseEventStandings(frame);
  if (!standings.length) return null;
  if (opts.ranking) {
    await opts.pause?.();
    const r = opts.ranking;
    const ranked = await client.eventRanking(key.eventType, key.run, r.scope, r.group, r.gameClanId);
    saveRawSnapshot(clanId, 'event_ranking', ref, opts.gameDate, ranked.body, opts.now);
    standings = overlayRanking(standings, parseEventRanking(ranked).rows);
  }

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

/**
 * A matchup-ranked run's standings: the clan's members as its Clan members tab
 * lists them, each with their place and points in the game's Ranking tab
 * (players of every clan of the matchup; only ours are kept). A member who
 * isn't in it — the tab shows the top 100 — has rank 0, "no rank", and 0
 * points.
 */
export function overlayRanking(members: GameEventStanding[], ranking: GameEventStanding[]): GameEventStanding[] {
  const placed = new Map(ranking.map((r) => [r.playerId, r]));
  return members.map((m) => placed.get(m.playerId) ?? { playerId: m.playerId, points: 0, rank: 0 });
}
