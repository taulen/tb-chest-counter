# Performance page (over- and underachievers)

Admins only: the nav entry is hidden for members, and `/api/performance` checks `requireAdmin`, which uses the active clan's role. Every active member gets a score over a timeframe (1, 3, 6 or 12 months, or all time). The page lists the overachievers and underachievers, breaks the clan down by guards level, and has a sortable table of everyone.

Code: [performance-scoring.ts](../src/config/performance-scoring.ts) holds the tunables, [performance-score.ts](../src/data/performance-score.ts) the pure maths, and [performance.ts](../src/data/performance.ts) gathers the data. The route is [routes/performance.ts](../src/web/routes/performance.ts) and the page is [pages/performance.js](../src/web/public/pages/performance.js).

## Tuning

**Change the scoring only in `performance-scoring.ts`.** This covers the weights, the minimum units per signal, the ratio cap, the over and under thresholds, the timeframes, the tenure rules and which events count. Then run `npm run build`: `tests/config/performance-scoring.test.ts` checks that the values make sense together, for example that every event key exists and every timeframe has a label on the page. The page reads the weights and thresholds from the API response, so nothing else needs editing.

Per-clan settings are planned but not built. `resolvePerformanceConfig(clanId)` is the hook: merge a per-clan override, such as a JSON column on `clans`, over the defaults there.

## What a score is made of

- **Units.** A unit is a closed clan week (which follows the clan's week start), a finished Tin Man run or a finished event run. A unit is in a timeframe when it **ended** inside it. It counts for a member only if they were in the clan for **all** of it, so a mid-week joiner is never held to that week and no pro-rating is needed.
- **Signals.** Each unit is a ratio against its expectation, capped:
  - `goalHits`: the share of weeks at or above the Leaderboard's weekly goal **that applied that week**. This is the "crypt goal". The goal's history comes from `clan_goal_history` (v93); see [Weekly goal history](#weekly-goal-history). A week that misses the goal but lands in the Leaderboard's amber band earns `goalNearMiss.credit` (half) of a hit, shown as ◐ in the table. The band starts at the clan's own amber percent for that week (66% unless changed).
  - `goalPoints`: weekly points as a share of the weekly goal, capped at `ratioCap` like every unit. This is how overachieving on crypts counts. It weighs the same as `tinman` (0.3 each, `goalHits` 0.2), so beating the goal by half lifts a score as much as beating a Tin Man target by half. Before 2026-11-08 the split was `goalHits` 0.3 / `goalPoints` 0.2. Hits top out at 100%, so a CWB member at 176% of the goal every week scored 117% and could never reach Overachiever; on the Oct 25 backup nobody in CWB could. The page shows the share first ("Goal 142% (3/4 weeks)"), the way it shows Tin Man.
  - `tinman`: the run total against the guards-tier target, using the member's level on the run's day from the estimate's level-ups. An unknown level counts as G7. A run with no targets pasted doesn't count (`tinmanMedianFallback: false`). The median player is far below the clans' targets, about 200k against CWB's 1.11M G7 target, so measuring against it put a third of the clan at the 200% cap.
  - `events`: points in each run against that run's median participant. Sitting a run out counts as 0. Counted: Ancients, Ragnarok, Olympus, Dark Omens, Doomsday, Arachne's Swarm, Hell Forge and Sands of Eternity. Runics is left out at the clan's request. Sands of Eternity is `irregular` in the catalog, so only the runs the feed lists count and none are reconstructed.
- **Score.** The score is the weighted mean of the signals that have at least `minUnits`, with the weights re-normalised over those. A timeframe can override `minUnits` per signal. Tin Man needs 2 runs with targets in a month, 4 in 3 months, 6 in 6 months and 8 in 12 months or all time. If the clan has no goal or no Tin Man pastes, the score is built from the other signals.

## Weekly goal history

The clan's goal is raised now and then, for example from 30,000 to 35,000. Before v93 the clan held a single number, so a raise re-judged every finished week against the new figure. Now every save (Clans → Leaderboard goal) writes a step to `clan_goal_history`: "from the week starting `effective_from`, the goal is N".

- **A change covers the whole week it is saved in** and every week after it. Finished weeks keep their goal. That week is the one the Leaderboard was already colouring with the new goal.
- **A second save in the same week replaces the first.** A step that repeats the previous one is dropped, so toggling the colours off and on leaves nothing behind.
- **Weeks before the first step use the first step's value.**
- **Day, month and year windows** are priced at the day-weighted mean of the steps they span. A month with two weeks at 30,000 and two at 35,000 counts as 32,500 a week.
- **The `enabled` flag is not historical.** With the colours off, there is no goal anywhere, past weeks included, exactly as before.
- **Amber percent (v94).** Amber ("close to goal") starts at `clans.leaderboard_goal_amber_pct` percent of the goal, set beside the goal (1–99; blank = 66). It is stored on each step (`amber_pct`) under the same rules, so moving it never repaints finished weeks. A change to the amber percent alone is a step of its own. Pages read it with `amberRatioForWindow` and pass it to the goal helpers in `lib/leaderboard-render.js`. The Tin Man target colouring keeps the plain 66%.

The lookup rules are in [utils/weekly-goal.ts](../src/utils/weekly-goal.ts). The browser copy is [lib/weekly-goal.js](../src/web/public/lib/weekly-goal.js), and `tests/config/weekly-goal-parity.test.ts` holds the two together. Writes are in [data/goal-history.ts](../src/data/goal-history.ts).

The following pages read the history:
- Leaderboard, share page, Analytics and the profile, through `/api/leaderboard/goal` and the share page's `/clan`, which carry `history`.
- Performance.
- Discord `/me`.

The v93 migration rebuilt the past from the audit log's `clan.leaderboard_goal.update` entries. It reads the clan from the entry's details, not from `audit_log.clan_id`, because that column is the clan the admin was viewing.

## Tenure

Tenure starts at the earliest of `members.first_seen`, the member's first chest day and their first might reading. `first_seen` alone is wrong after a rename: the surviving row is usually the new nick's, while the merge repoints the old nick's chests and readings. Player merges also keep `MIN(first_seen)` from now on (merge-repo).

A member is shown only with enough days in the clan within the timeframe: `requiredPresentDays`. The rest are listed under "Too new to judge".

## Caching

Reports are cached for 5 minutes per clan, timeframe and day under `performance:<clanId>:`. They are dropped by `notifyChestDataChanged`, by every Tin Man write and by `invalidateGuardsCache`. An uncached build of a whole clan takes about 0.3–0.5 s, mostly in event-run rankings, which share `memberEvents:` cache with the member profile.
