# Performance page (over- and underachievers)

Admins only: the nav entry is hidden for members, and `/api/performance` checks `requireAdmin`, which uses the active clan's role. Every active member gets a score over a timeframe (1, 3, 6 or 12 months, or all time). The page lists the overachievers and underachievers, breaks the clan down by guards level, and has a sortable table of everyone.

Code: [performance-scoring.ts](../src/config/performance-scoring.ts) holds the tunables, [performance-score.ts](../src/data/performance-score.ts) the pure maths, and [performance.ts](../src/data/performance.ts) gathers the data. The route is [routes/performance.ts](../src/web/routes/performance.ts) and the page is [pages/performance.js](../src/web/public/pages/performance.js).

## Tuning

**Change the scoring only in `performance-scoring.ts`.** This covers the weights, the minimum units per signal, the ratio cap, the over and under thresholds, the timeframes, the tenure rules and which events count. Then run `npm run build`: `tests/config/performance-scoring.test.ts` checks that the values make sense together, for example that every event key exists and every timeframe has a label on the page. The page reads the weights and thresholds from the API response, so nothing else needs editing.

Per-clan settings are planned but not built. `resolvePerformanceConfig(clanId)` is the hook: merge a per-clan override, such as a JSON column on `clans`, over the defaults there.

## What a score is made of

- **Units.** A unit is a closed clan week (which follows the clan's week start), a finished Tin Man run or a finished event run. A unit is in a timeframe when it **ended** inside it. It counts for a member only if they were in the clan for **all** of it, so a mid-week joiner is never held to that week and no pro-rating is needed.
- **Signals.** Each unit is a ratio against its expectation, capped:
  - `goalHits`: the share of weeks at or above the Leaderboard's weekly goal (`resolveWeeklyGoalPoints`). This is the "crypt goal".
  - `goalPoints`: weekly points as a share of the weekly goal.
  - `tinman`: the run total against the guards-tier target, using the member's level on the run's day from the estimate's level-ups. An unknown level counts as G7. A run with no targets pasted is measured against the median player.
  - `events`: points in each run against that run's median participant. Sitting a run out counts as 0.
- **Score.** The score is the weighted mean of the signals that have at least `minUnits`, with the weights re-normalised over those. If the clan has no goal or no Tin Man pastes, the score is built from the other signals.

## Tenure

Tenure starts at the earliest of `members.first_seen`, the member's first chest day and their first might reading. `first_seen` alone is wrong after a rename: the surviving row is usually the new nick's, while the merge repoints the old nick's chests and readings. Player merges also keep `MIN(first_seen)` from now on (merge-repo).

A member is shown only with enough days in the clan within the timeframe: `requiredPresentDays`. The rest are listed under "Too new to judge".

## Caching

Reports are cached for 5 minutes per clan, timeframe and day under `performance:<clanId>:`. They are dropped by `notifyChestDataChanged`, by every Tin Man write and by `invalidateGuardsCache`. An uncached build of a whole clan takes about 0.3–0.5 s, mostly in event-run rankings, which share `memberEvents:` cache with the member profile.
