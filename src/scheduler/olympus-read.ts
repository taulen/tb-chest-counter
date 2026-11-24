/**
 * Trials of Olympus' clan-vs-clan matchup, read by the scan right after the
 * umbrella run's members (game-protocol/olympus.ts, recorded Nov 24 2026):
 *
 *   - 82001 → the matchup group; 82000 on the rating proxy → every clan of it
 *     with its rank and score (Ranking → Clan ranking);
 *   - 82002 → the score the clan needs for rewards (Ranking → Clan rewards);
 *   - 74003 → the clan's talents, archived only (not decoded yet);
 *   - once per run and rival: its kingdom from the registration server, then
 *     its headline (15200) on that kingdom's server — what the game does to
 *     show a rival's tag. The rivals' own members' points aren't visible in
 *     the game, and aren't asked for.
 *
 * Read-only requests, the ones the client sends as the Olympus window opens.
 * Each step fails on its own: whatever was read is stored.
 */
import type { GameClient } from '../game-protocol/client.js';
import {
  parseClanSummaries, parseOlympusClanRanking, parseOlympusGroup, parseOlympusRewardMinimum, type OlympusClanScore,
} from '../game-protocol/messages.js';
import { matchupClansWithoutName, saveMatchup, type EventRunKey, type MatchupClan } from '../data/repositories/game-event-repo.js';
import { saveRawSnapshot } from '../data/repositories/game-protocol-repo.js';

export async function readOlympusMatchup(
  clanId: number,
  client: GameClient,
  key: EventRunKey,
  opts: { now: string; gameDate: string; pause?: () => Promise<void>; /** Our clan's game id. */ ownClanId: number },
): Promise<string> {
  const ref = key.eventType * 1000 + key.run;
  const step = async <T>(fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch {
      return null;
    } finally {
      await opts.pause?.();
    }
  };

  const groupId = await step(async () => parseOlympusGroup(await client.olympusGroup(key.eventType, key.run)));
  const ranking: OlympusClanScore[] = groupId === null ? [] : await step(async () => {
    const f = await client.olympusClanRanking(key.eventType, key.run, groupId);
    saveRawSnapshot(clanId, 'olympus_clans', ref, opts.gameDate, f.body, opts.now);
    return parseOlympusClanRanking(f);
  }) ?? [];
  const rewardMinPoints = await step(async () => {
    const f = await client.olympusRewards(key.eventType, key.run);
    saveRawSnapshot(clanId, 'olympus_rewards', ref, opts.gameDate, f.body, opts.now);
    return parseOlympusRewardMinimum(f);
  });
  await step(async () => {
    const f = await client.olympusClanTalents(key.eventType, key.run);
    saveRawSnapshot(clanId, 'olympus_talents', ref, opts.gameDate, f.body, opts.now);
  });
  if (groupId === null && !ranking.length && rewardMinPoints === null) return 'olympus matchup unreadable';
  saveMatchup(clanId, key, { groupId, rewardMinPoints, clans: ranking.map((c) => ({ gameClanId: c.clanId, rank: c.rank, points: c.points })) }, opts.now);

  // Each clan's headline, once per run: ours on our own server, a rival on
  // its kingdom's (the registration server says which).
  const missing = matchupClansWithoutName(clanId, key);
  if (!missing.length) return `olympus: ${ranking.length} clans`;
  const own = opts.ownClanId;
  const rivals = missing.filter((id) => id !== own);
  const kingdoms = new Map<number, number | null>(missing.includes(own) ? [[own, client.realmId]] : []);
  if (rivals.length) {
    const found = await step(() => client.clanKingdoms(rivals));
    rivals.forEach((id, i) => kingdoms.set(id, found?.[i] ?? null));
  }
  const named: Array<Pick<MatchupClan, 'gameClanId' | 'rank' | 'points'> & Partial<MatchupClan>> = [];
  for (const id of missing) {
    const scored = ranking.find((c) => c.clanId === id);
    if (!scored) continue;
    const kingdom = kingdoms.get(id) ?? null;
    const url = kingdom === null ? null : client.kingdomUrl(kingdom);
    const head = url ? (await step(async () => parseClanSummaries(await client.clanSummaries([id], url))))?.find((s) => s.clanId === id) : undefined;
    named.push({
      gameClanId: id, rank: scored.rank, points: scored.points, kingdom,
      tag: head?.tag ?? null, name: head?.name ?? null, members: head?.members ?? null, memberLimit: head?.memberLimit ?? null, might: head?.might ?? null,
    });
  }
  if (named.length) saveMatchup(clanId, key, { groupId, rewardMinPoints, clans: named }, opts.now);
  return `olympus: ${ranking.length} clans, ${named.filter((c) => c.name).length} named`;
}
