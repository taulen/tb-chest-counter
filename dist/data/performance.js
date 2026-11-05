"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPerformanceReport = getPerformanceReport;
/**
 * The Performance page's report: every active member scored against what the
 * clan expects of them over a timeframe, so admins can see who overachieves
 * and who falls short.
 *
 * Signals, scoring and every threshold are in src/config/performance-scoring.ts
 * (the tunables) and src/data/performance-score.ts (the pure maths). This file
 * only gathers the units:
 *
 *  - Weeks: the clan's closed game weeks (its own week start, Sunday or Tinman
 *    to Tinman), each member's earned points against the Leaderboard's weekly
 *    goal. Same numbers as the Leaderboard: chest_daily_summary's earned
 *    points, clan rewards out.
 *  - Tin Man runs: the pasted standings' run total against the run's target for
 *    the member's guards tier — their level on that run's day, from the guards
 *    estimate's level-ups; unknown = the configured assumed level.
 *  - Event runs: each finished run of the configured events, ranked the Events
 *    page's way, against the run's median participant. Sitting a run out is 0.
 *
 * A unit is "in" a timeframe when it ENDED inside it, and counts for a member
 * only if they were in the clan for the whole of it — so a member who joined
 * mid-week is never held to that week, and the windows need no pro-rating.
 *
 * Tenure ("in the clan since") is the earliest of `members.first_seen`, their
 * first chest and their first might reading. `first_seen` alone is the
 * SURVIVING row's date after a player merge, i.e. the new nick's; the chests
 * and readings a merge repoints keep the old nick's history.
 */
const database_js_1 = require("./database.js");
const performance_scoring_js_1 = require("../config/performance-scoring.js");
const event_catalog_js_1 = require("../config/event-catalog.js");
const chest_summary_repo_js_1 = require("./repositories/chest-summary-repo.js");
const guards_repo_js_1 = require("./repositories/guards-repo.js");
const tinmanRepo = __importStar(require("./repositories/tinman-repo.js"));
const member_events_js_1 = require("./member-events.js");
const event_calendar_js_1 = require("../external/event-calendar.js");
const game_day_js_1 = require("../utils/game-day.js");
const ttl_cache_js_1 = require("../utils/ttl-cache.js");
const performance_score_js_1 = require("./performance-score.js");
/**
 * Dropped under this same literal by notifyChestDataChanged (chest-summary-repo),
 * every Tin Man write (tinman-repo) and invalidateGuardsCache (guards-repo).
 */
const CACHE_PREFIX = 'performance:';
const CACHE_TTL_MS = 5 * 60 * 1000;
/** Far more closed weeks than any clan has; only a guard on the walk back. */
const MAX_WEEKS = 600;
function addDays(day, n) {
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}
const minDay = (...days) => days.filter((d) => !!d).sort()[0] ?? null;
function activeMembers(clanId, rollover, today) {
    const db = (0, database_js_1.getDb)();
    const rows = db.prepare('SELECT id, name, first_seen AS firstSeen FROM members WHERE clan_id = ? AND is_active = 1').all(clanId);
    const firstSnapshot = new Map(db.prepare(`
      SELECT member_id AS memberId, MIN(game_date) AS d FROM member_snapshots
      WHERE clan_id = ? AND game_date != '' GROUP BY member_id
    `).all(clanId).map((r) => [r.memberId, r.d]));
    const firstChest = (0, chest_summary_repo_js_1.getMemberFirstChestDays)(clanId);
    return rows.map((r) => {
        const seenMs = Date.parse(r.firstSeen);
        const seenDay = Number.isNaN(seenMs) ? null : (0, game_day_js_1.gameDateFor)(seenMs, rollover);
        return {
            id: r.id,
            name: r.name,
            tenureStart: minDay(seenDay, firstChest.get(r.id), firstSnapshot.get(r.id)) ?? today,
        };
    });
}
function levelOn(est, day) {
    return est ? (0, performance_score_js_1.guardsLevelOn)(day, est.level, est.levelUps) : null;
}
/** Closed weeks that ended in [windowFrom, today) and lie wholly inside the data. */
function closedWeeks(input, nowMs, windowFrom, dataStart) {
    const weeks = [];
    for (let offset = 1; offset <= MAX_WEEKS; offset++) {
        const w = (0, game_day_js_1.gameWindow)('weekly', offset, input.rolloverUtcHour, input.weekStart, nowMs);
        if (!w)
            break;
        const firstDay = (0, game_day_js_1.gameDateFor)(Date.parse(w.from), input.rolloverUtcHour);
        const lastDay = (0, game_day_js_1.gameDateFor)(Date.parse(w.to) - 1, input.rolloverUtcHour);
        if (lastDay < windowFrom || firstDay < dataStart)
            break;
        weeks.push({ firstDay, lastDay });
    }
    return weeks;
}
function weekUnits(input, config, weeks, members, guards) {
    const out = new Map();
    if (!input.weeklyGoal || weeks.length === 0)
        return out;
    const dayToWeek = new Map();
    weeks.forEach((w, i) => {
        for (let d = w.firstDay; d <= w.lastDay; d = addDays(d, 1))
            dayToWeek.set(d, i);
    });
    const points = new Map();
    const oldest = weeks[weeks.length - 1].firstDay;
    for (const r of (0, chest_summary_repo_js_1.getClanDailyEarnedPoints)(input.clanId, oldest, weeks[0].lastDay)) {
        const i = dayToWeek.get(r.day);
        if (i === undefined)
            continue;
        let list = points.get(r.memberId);
        if (!list)
            points.set(r.memberId, (list = new Array(weeks.length).fill(0)));
        list[i] += r.points;
    }
    for (const m of members) {
        const units = [];
        weeks.forEach((w, i) => {
            if (m.tenureStart > w.firstDay)
                return;
            const level = levelOn(guards.get(m.id), w.firstDay) ?? config.assumedGuardsLevel;
            const goal = input.weeklyGoal * (config.weeklyGoalScaleByGuards[level] ?? 1);
            if (!(goal > 0))
                return;
            const actual = points.get(m.id)?.[i] ?? 0;
            const hit = actual >= goal;
            const near = !hit && !!config.goalNearMiss && actual >= goal * config.goalNearMiss.from;
            units.push({
                ratio: (0, performance_score_js_1.unitRatio)(actual, goal, config.ratioCap),
                hit,
                credit: hit ? 1 : near ? config.goalNearMiss.credit : 0,
            });
        });
        out.set(m.id, units);
    }
    return out;
}
function tinmanUnits(clanId, config, today, windowFrom, members, guards) {
    const units = new Map(members.map((m) => [m.id, []]));
    const medianRuns = new Map();
    let runs = 0;
    let runsWithTargets = 0;
    // A run is in the window when its Tinman day (its last day) is, and only once
    // it's over: mid-run everyone simply reads as not there yet.
    const dates = tinmanRepo.listTinmanDates(clanId, 10_000, 'ancients')
        .filter((d) => d < today && d >= windowFrom);
    for (const date of dates) {
        const standings = tinmanRepo.getTinmanStandings(clanId, date, 'ancients');
        if (standings.summons.length === 0)
            continue;
        const totals = new Map();
        for (const p of standings.players)
            if (p.memberId !== null)
                totals.set(p.memberId, p.total);
        const tiers = tinmanRepo.getTinmanTargets(clanId, date)?.tiers ?? {};
        const hasTargets = Object.keys(tiers).length > 0;
        let fallback = null;
        if (!hasTargets) {
            if (!config.tinmanMedianFallback)
                continue;
            fallback = (0, performance_score_js_1.median)([...totals.values()].filter((v) => v > 0));
            if (!fallback)
                continue;
        }
        runs++;
        if (hasTargets)
            runsWithTargets++;
        // Day 1 is Ancients' Treasure, the Tinman day is day 2.
        const runFirstDay = addDays(date, -1);
        for (const m of members) {
            if (m.tenureStart > runFirstDay)
                continue;
            let expected = fallback;
            if (hasTargets) {
                const level = levelOn(guards.get(m.id), date) ?? config.assumedGuardsLevel;
                expected = tiers[`g${level}`];
            }
            if (!expected || !(expected > 0))
                continue;
            const actual = totals.get(m.id) ?? 0;
            units.get(m.id).push({ ratio: (0, performance_score_js_1.unitRatio)(actual, expected, config.ratioCap), hit: actual >= expected });
            if (!hasTargets)
                medianRuns.set(m.id, (medianRuns.get(m.id) ?? 0) + 1);
        }
    }
    return { units, medianRuns, runs, runsWithTargets };
}
async function eventUnits(input, config, today, windowFrom, dataStart, members) {
    const units = new Map(members.map((m) => [m.id, []]));
    const perEvent = [];
    const rollover = input.rolloverUtcHour;
    for (const key of config.participationEvents) {
        const def = (0, event_catalog_js_1.getEventDef)(key);
        if (!def)
            continue;
        const occurrences = await (0, event_calendar_js_1.getEventOccurrences)(key, input.clanId).catch(() => []);
        let runs = 0;
        for (const o of occurrences) {
            if (o.isCurrent)
                continue;
            const firstDay = (0, game_day_js_1.gameDateFor)(Date.parse(o.from), rollover);
            const lastDay = (0, game_day_js_1.gameDateFor)(Date.parse(o.resetAt) - 1, rollover);
            if (lastDay >= today || lastDay < windowFrom || firstDay < dataStart)
                continue;
            const ranked = (0, member_events_js_1.rankedRun)(key, input.clanId, o.from, o.to);
            const typical = (0, performance_score_js_1.median)([...ranked.byMember.values()].map((v) => v.points).filter((p) => p > 0));
            // Nobody scored: the run can't be measured against (or the event's chests
            // weren't recognised yet), so it counts for no one.
            if (!typical)
                continue;
            runs++;
            for (const m of members) {
                if (m.tenureStart > firstDay)
                    continue;
                const actual = ranked.byMember.get(m.id)?.points ?? 0;
                units.get(m.id).push({ ratio: (0, performance_score_js_1.unitRatio)(actual, typical, config.ratioCap), hit: actual > 0 });
            }
        }
        perEvent.push({ key, name: def.name, runs });
    }
    return { units, perEvent };
}
async function buildReport(input, nowMs) {
    const clanConfig = (0, performance_scoring_js_1.resolvePerformanceConfig)(input.clanId);
    const tf = clanConfig.timeframes.find((t) => t.key === input.timeframe)
        ?? clanConfig.timeframes.find((t) => t.key === clanConfig.defaultTimeframe);
    // The timeframe's own minimums win: a year needs more Tin Man runs than a month.
    const config = { ...clanConfig, minUnits: { ...clanConfig.minUnits, ...tf.minUnits } };
    const today = (0, game_day_js_1.gameDateFor)(nowMs, input.rolloverUtcHour);
    const dataStart = (0, chest_summary_repo_js_1.getClanDataStartDay)(input.clanId);
    const base = {
        timeframe: tf.key,
        timeframes: config.timeframes.map((t) => ({ key: t.key, days: t.days })),
        today,
        windowFrom: null,
        windowTo: null,
        dataStart,
        windowDays: 0,
        requiredDays: 0,
        weeklyGoal: input.weeklyGoal,
        weekStart: input.weekStart,
        units: { weeks: 0, tinmanRuns: 0, tinmanRunsWithTargets: 0, eventRuns: 0 },
        events: [],
        scoring: {
            weights: config.weights,
            minUnits: config.minUnits,
            ratioCap: config.ratioCap,
            overThreshold: config.overThreshold,
            underThreshold: config.underThreshold,
            assumedGuardsLevel: config.assumedGuardsLevel,
            goalNearMiss: config.goalNearMiss,
            tinmanMedianFallback: config.tinmanMedianFallback,
        },
        members: [],
        tooNew: [],
    };
    if (!dataStart || dataStart >= today)
        return base;
    const rawFrom = tf.days === null ? dataStart : addDays(today, -tf.days);
    const windowFrom = rawFrom < dataStart ? dataStart : rawFrom;
    const windowDays = (0, game_day_js_1.daysBetweenGameDates)(windowFrom, today) ?? 0;
    const requiredDays = (0, performance_score_js_1.requiredPresentDays)(windowDays, tf.minCoverage, config);
    const everyone = activeMembers(input.clanId, input.rolloverUtcHour, today);
    const eligible = [];
    const tooNew = [];
    for (const m of everyone) {
        const from = m.tenureStart > windowFrom ? m.tenureStart : windowFrom;
        const presentDays = Math.max(0, (0, game_day_js_1.daysBetweenGameDates)(from, today) ?? 0);
        if (presentDays >= requiredDays && presentDays > 0)
            eligible.push({ ...m, presentDays });
        else
            tooNew.push({ memberId: m.id, name: m.name, tenureStart: m.tenureStart, presentDays });
    }
    const guards = (0, guards_repo_js_1.getGuardsEstimates)(input.clanId);
    const weeks = input.weeklyGoal ? closedWeeks(input, nowMs, windowFrom, dataStart) : [];
    const weekly = weekUnits(input, config, weeks, eligible, guards);
    const tinman = tinmanUnits(input.clanId, config, today, windowFrom, eligible, guards);
    const events = await eventUnits(input, config, today, windowFrom, dataStart, eligible);
    const members = eligible.map((m) => {
        const signals = (0, performance_score_js_1.summarizeSignals)({
            weeks: weekly.get(m.id) ?? [],
            tinman: tinman.units.get(m.id) ?? [],
            events: events.units.get(m.id) ?? [],
        }, config);
        const score = (0, performance_score_js_1.compositeScore)(signals, config);
        return {
            memberId: m.id,
            name: m.name,
            guardsLevel: guards.get(m.id)?.level ?? null,
            tenureStart: m.tenureStart,
            presentDays: m.presentDays,
            score,
            status: (0, performance_score_js_1.statusFor)(score, config),
            signals,
            tinmanMedianRuns: tinman.medianRuns.get(m.id) ?? 0,
        };
    });
    members.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.name.localeCompare(b.name));
    tooNew.sort((a, b) => b.tenureStart.localeCompare(a.tenureStart) || a.name.localeCompare(b.name));
    return {
        ...base,
        windowFrom,
        windowTo: addDays(today, -1),
        windowDays,
        requiredDays,
        units: {
            weeks: weeks.length,
            tinmanRuns: tinman.runs,
            tinmanRunsWithTargets: tinman.runsWithTargets,
            eventRuns: events.perEvent.reduce((s, e) => s + e.runs, 0),
        },
        events: events.perEvent,
        members,
        tooNew,
    };
}
/**
 * The report for one clan and timeframe, cached for a few minutes and dropped
 * whenever the chests, Tin Man pastes or guards estimates behind it change.
 */
function getPerformanceReport(input) {
    const nowMs = input.nowMs ?? Date.now();
    const today = (0, game_day_js_1.gameDateFor)(nowMs, input.rolloverUtcHour);
    const key = `${CACHE_PREFIX}${input.clanId}:${input.timeframe}:${today}:${input.weeklyGoal ?? 0}:${input.weekStart}`;
    if (input.nowMs !== undefined)
        return buildReport(input, nowMs);
    const pending = (0, ttl_cache_js_1.cached)(key, CACHE_TTL_MS, () => buildReport(input, nowMs));
    // A failed build must not be served from the cache for the next five minutes.
    pending.catch(() => (0, ttl_cache_js_1.invalidate)(key));
    return pending;
}
//# sourceMappingURL=performance.js.map