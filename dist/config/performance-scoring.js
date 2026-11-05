"use strict";
/**
 * Performance page scoring — every tunable in one place.
 *
 * The Performance page (admins only) ranks members against what the clan
 * expects of them and names the over- and underachievers. How much each signal
 * counts is expected to move as the clan uses it, so nothing about the scoring
 * lives anywhere else: change a number here, run `npm run build` (the guard in
 * tests/config/performance-scoring.test.ts checks the values are coherent), ship.
 *
 * How a score is built (see src/data/performance-score.ts):
 *
 *  - Each SIGNAL is measured per unit: a closed clan week, a finished Tin Man
 *    run, a finished event run. A unit only counts for a member who was in the
 *    clan for the whole of it, so a mid-week joiner is never held to that week.
 *  - A unit becomes a RATIO against its expectation (1.0 = exactly met), capped
 *    at `ratioCap` so one huge week can't hide a string of empty ones.
 *  - A signal's value is the mean of its unit ratios; it only counts once the
 *    member has `minUnits` of it in the window.
 *  - The SCORE is the weighted mean of the signals the member has, the weights
 *    re-normalised over those. 1.0 (shown as 100%) = meeting every expectation.
 *
 * Later, admins may get to set weights per clan. `resolvePerformanceConfig` is
 * the one place that would merge such an override over these defaults (e.g. a
 * JSON column on `clans`, as `ancient_planner_defaults` does); every caller
 * already goes through it, and the page renders the weights from the API
 * response rather than from its own copy, so nothing else would need to change.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_PERFORMANCE_CONFIG = exports.PERFORMANCE_SIGNALS = void 0;
exports.resolvePerformanceConfig = resolvePerformanceConfig;
exports.PERFORMANCE_SIGNALS = ['goalHits', 'goalPoints', 'tinman', 'events'];
exports.DEFAULT_PERFORMANCE_CONFIG = {
    weights: {
        goalHits: 0.3,
        goalPoints: 0.2,
        tinman: 0.3,
        events: 0.2,
    },
    minUnits: {
        goalHits: 2,
        goalPoints: 2,
        tinman: 1,
        events: 2,
    },
    ratioCap: 2,
    overThreshold: 1.2,
    underThreshold: 0.7,
    minPresentDays: 21,
    minPresentDaysMaxShare: 0.75,
    timeframes: [
        { key: 'month', days: 30, minCoverage: 0.75 },
        { key: 'quarter', days: 91, minCoverage: 0.75 },
        { key: 'half', days: 182, minCoverage: 0.75 },
        { key: 'year', days: 365, minCoverage: 0.75 },
        { key: 'all', days: null, minCoverage: 0 },
    ],
    defaultTimeframe: 'month',
    participationEvents: ['ancients', 'ragnarok', 'olympus', 'dark-omens', 'runics'],
    assumedGuardsLevel: 7,
    tinmanMedianFallback: true,
    weeklyGoalScaleByGuards: {},
};
/**
 * The scoring config for one clan. Defaults only, for now — the hook for a
 * per-clan override (see the file header).
 */
function resolvePerformanceConfig(_clanId) {
    return exports.DEFAULT_PERFORMANCE_CONFIG;
}
//# sourceMappingURL=performance-scoring.js.map