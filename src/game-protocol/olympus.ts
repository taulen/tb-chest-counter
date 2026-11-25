/**
 * Trials of Olympus as the game runs it: an umbrella event ("TRIALS OF
 * OLYMPUS", type 1032, ~5 days) and five stages, one per game day, each a game
 * event of its own with its own Clan members ranking (38003) — read every scan
 * like any running event. All share the code `multistage`; T44 titles them by
 * `global_tournament.client.value.multistage.stage_<n>.info.title`.
 *
 * A stage's type and run number differ between variants (Nov 2026 names.json:
 * stages 1, 2 and 5 are type 1025 runs 8/9/10, 19/20/21, 26/27/28 or
 * 29/30/31; stages 3 and 4 type 1022 runs 43/45, 57/58, 61/62 or 64/65), so a
 * stage is known by its English title, which every variant shares
 * (olympusStageDay in event-mapping.ts).
 *
 * Not stages: "Pursuit of Lava Oil" (`multistage.stage_catchup`) and "Sealed
 * in Flame" (`multistage.pvp`), also code `multistage`. The umbrella's own
 * 38003 answers every member at 0 points (Nov 24 2026, CWB, while the game's
 * Ranking → Clan members showed 33,000); its Clan members tab is 82003
 * (messages.ts, recorded that day).
 */

export const OLYMPUS_CODE = 'multistage';

/**
 * The umbrella event's type (every run in names.json — 1032,1 … 1032,4 — is
 * "TRIALS OF OLYMPUS"). Its standings are read with 82003, not 38003
 * (scheduler/event-read.ts), plus the clan-vs-clan matchup
 * (scheduler/olympus-read.ts).
 */
export const OLYMPUS_EVENT_TYPE = 1032;

/**
 * Olympus sub-events ranked across the whole matchup, not per clan: their
 * Clan members tab (38003) answers every member at 0, and the game's Ranking
 * tab is 24003 on the rating proxy, scoped to the matchup group (24203 gives
 * `[6, 590]`) — the top 100 players of all three clans. Recorded Nov 25 2026.
 * Known by English title, like the stages.
 */
export const OLYMPUS_MATCHUP_RANKED_TITLES: readonly string[] = ['Sealed in Flame'];

/** A run whose standings are our members' places in the matchup's Ranking tab (OLYMPUS_MATCHUP_RANKED_TITLES). */
export function isMatchupRankedRun(r: { code: string; title: string }): boolean {
  const title = r.title.trim().toLowerCase();
  return r.code === OLYMPUS_CODE && OLYMPUS_MATCHUP_RANKED_TITLES.some((t) => t.toLowerCase() === title);
}

/** The run's days in order: day n is stage n. */
export const OLYMPUS_STAGES: ReadonlyArray<{ day: number; title: string }> = [
  { day: 1, title: 'Trial of the Chimera' },
  { day: 2, title: 'Trial of the Basilisk' },
  { day: 3, title: 'Lava Fountain Trial' },
  { day: 4, title: 'Trial of Tartaros' },
  { day: 5, title: 'Trial of Briareus' },
];
