# A clan's week

What "Weekly" means is per clan (`clans.week_start`, set on Clans → Week). Every weekly window follows it: Leaderboard, Dashboard, Members, Analytics, Resources, Events, Performance, the public share page, the weekly goal and the Discord bot (slash commands and the weekly digest). The ChestTracker tab is the exception: its weeks are upstream's, always Sunday.

## Shapes

| `week_start` | Week |
|---|---|
| `sunday` (default) | Sunday → Sunday at the rollover |
| `ancients` | Tinman → Tinman, 6 days (normal kingdom only) |
| `ancients-sk` | Tinman → Tinman on the Seasonal Kingdom cadence, 5 days (SK clans only — [seasonal-kingdoms.md](seasonal-kingdoms.md)) |
| `custom:<YYYY-MM-DD>:<days>` | The clan's own: the first game day of any one of its weeks, and how many days each lasts (2–28) |

A Tuesday-evening week is `custom:2026-11-17:7`: game day 2026-11-17 opens at Tuesday 17:00 UTC.

Every shape is one **cadence** — a day some week starts on plus a length (`weekCadence`). The presets are fixed cadences (`sunday` is 7 days from `SUNDAY_ANCHOR`, a Sunday), so the week math has one branch.

## Rules

- **The value is opaque everywhere but the week math.** It passes through the column, `/api/auth/me`, the share page, cache keys and the bot as the same string; only `game-day.ts` (server) and `lib/week-shape.js` + `lib/period.js` (client) read inside it. `tests/config/game-window-parity.test.ts` sweeps presets and custom weeks and fails when the two sides cut a window differently.
- **One spelling per week.** The parser refuses a leading zero, a non-date and an out-of-range length, and the PUT route stores a custom week that IS a preset as the preset (`canonicalWeekStart`: 7 days from a Sunday → `sunday`; 6 days from a Tinman day → `ancients`; 5 from an SK Tinman day → `ancients-sk` for an SK clan). So the Clans page shows the preset and the digest still says "Tinman to Tinman".
- **The first day is any week's first day**, past or future: `custom:2027-03-02:7` is the same week as `custom:2026-11-17:7`.
- **Changing the week re-cuts history.** There is no week-shape timeline: past Weekly views, charts and goal windows are cut by the shape saved now. Goals judging a past window still use the goal of that window's dates (`weeklyGoalForWindow`), and digests already sent stay sent.
- **SQL bucketing binds the cadence** (`getConcentration`): a custom week is clan input, so it is never inlined.
- `lib/week-shape.js` has no imports, so `state.js` can validate a shape without importing `period.js` (which imports `state.js`). It is on the setup wizard's asset list for the same reason.
