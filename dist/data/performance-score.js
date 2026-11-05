"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.unitRatio = unitRatio;
exports.median = median;
exports.summarizeSignals = summarizeSignals;
exports.compositeScore = compositeScore;
exports.statusFor = statusFor;
exports.requiredPresentDays = requiredPresentDays;
exports.guardsLevelOn = guardsLevelOn;
/**
 * Pure scoring for the Performance page: unit ratios → signal values → one
 * score and a status. No database, no clock, so the tests drive it directly.
 * The tunables live in src/config/performance-scoring.ts; the data that feeds
 * this is gathered in src/data/performance.ts.
 */
const performance_scoring_js_1 = require("../config/performance-scoring.js");
/**
 * actual / expected, capped at `cap`. Never negative. An expectation of zero or
 * less can't be measured against and must be filtered out by the caller.
 */
function unitRatio(actual, expected, cap) {
    if (!(expected > 0))
        throw new Error(`unitRatio: expected must be > 0, got ${expected}`);
    return Math.min(Math.max(actual, 0) / expected, cap);
}
/** Median of a list, or null when it is empty. */
function median(values) {
    if (values.length === 0)
        return null;
    const s = [...values].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function summarize(units, value, minUnits) {
    const hits = units.filter((u) => u.hit).length;
    return {
        units: units.length,
        hits,
        value: units.length ? value(units) : null,
        counted: units.length >= minUnits && units.length > 0,
    };
}
const meanRatio = (units) => units.reduce((s, u) => s + u.ratio, 0) / units.length;
const hitShare = (units) => units.filter((u) => u.hit).length / units.length;
/**
 * Every signal for one member from their units. Weeks feed two signals: how
 * often the goal was reached (goalHits) and by how much (goalPoints).
 */
function summarizeSignals(units, config) {
    return {
        goalHits: summarize(units.weeks, hitShare, config.minUnits.goalHits),
        goalPoints: summarize(units.weeks, meanRatio, config.minUnits.goalPoints),
        tinman: summarize(units.tinman, meanRatio, config.minUnits.tinman),
        events: summarize(units.events, meanRatio, config.minUnits.events),
    };
}
/**
 * Weighted mean of the counted signals, the weights re-normalised over them.
 * Null when no signal counts (or every counted signal weighs 0).
 */
function compositeScore(signals, config) {
    let sum = 0;
    let weight = 0;
    for (const key of performance_scoring_js_1.PERFORMANCE_SIGNALS) {
        const s = signals[key];
        const w = config.weights[key];
        if (!s.counted || s.value === null || !(w > 0))
            continue;
        sum += s.value * w;
        weight += w;
    }
    return weight > 0 ? sum / weight : null;
}
function statusFor(score, config) {
    if (score === null)
        return 'unscored';
    if (score >= config.overThreshold)
        return 'over';
    if (score < config.underThreshold)
        return 'under';
    return 'on-track';
}
/**
 * Days a member must have been in the clan to be shown for a window of
 * `windowDays`: the timeframe's share of the window, and at least the absolute
 * floor — the floor itself capped at the same share of the window, so a clan
 * tracked for only a couple of weeks still gets a page.
 */
function requiredPresentDays(windowDays, minCoverage, config) {
    if (windowDays <= 0)
        return 0;
    const share = Math.ceil(windowDays * minCoverage);
    const floor = Math.min(config.minPresentDays, Math.ceil(windowDays * config.minPresentDaysMaxShare));
    return Math.max(share, floor);
}
/**
 * Guards level on `day`, from the estimate's current level and its level-ups:
 * before a level-up was first seen, the member was still at the old level.
 */
function guardsLevelOn(day, current, levelUps) {
    let level = current;
    for (let i = levelUps.length - 1; i >= 0; i--) {
        if (day < levelUps[i].by)
            level = levelUps[i].from;
    }
    return level;
}
//# sourceMappingURL=performance-score.js.map