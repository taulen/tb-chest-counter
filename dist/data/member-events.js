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
exports.getMemberEventsOverview = getMemberEventsOverview;
/**
 * One member's event record, for the Events card on their profile: their
 * Tin Man standings over the last few Rise of the Ancients runs, and for every
 * event in the catalog their points and clan rank in each recent run.
 *
 * A run here is exactly the window the Events page shows for it — a calendar
 * occurrence, a Triumphal 30-day cycle, or a plain game week for the
 * schedule-less events (Citadels, Heroics) — and the rank is the Events page's
 * canonical one (countable points, then countable chests, then name). So a
 * number on the profile always matches the table its link opens.
 *
 * Recent runs only, never all-time: an all-time breakdown is ~0.5 s for the
 * biggest event on a 160k-row clan, against ~10 ms for one run. Each run's
 * ranking is cached per clan, not per member, so paging through profiles pays
 * for it once; a chest write drops the cache (notifyChestDataChanged).
 */
const event_catalog_js_1 = require("../config/event-catalog.js");
const eventRepo = __importStar(require("./repositories/event-repo.js"));
const tinmanRepo = __importStar(require("./repositories/tinman-repo.js"));
const guards_repo_js_1 = require("./repositories/guards-repo.js");
const clan_repo_js_1 = require("./repositories/clan-repo.js");
const event_calendar_js_1 = require("../external/event-calendar.js");
const ttl_cache_js_1 = require("../utils/ttl-cache.js");
const game_day_js_1 = require("../utils/game-day.js");
const RUNS_PER_EVENT = 5;
const WEEKS_PER_FIXED_EVENT = 4;
const TINMAN_RUNS = 5;
/** Unknown guards level is held against the G7 target, as on the Tin Man table. */
const ASSUMED_TIER = 'g7';
const RUN_CACHE_TTL_MS = 10 * 60 * 1000;
/** Dropped by notifyChestDataChanged (chest-summary-repo.ts) under this same literal. */
const MEMBER_EVENTS_CACHE_PREFIX = 'memberEvents:';
function rankedRun(key, clanId, from, to) {
    return (0, ttl_cache_js_1.cached)(`${MEMBER_EVENTS_CACHE_PREFIX}${clanId}:${key}:${from}:${to}`, RUN_CACHE_TTL_MS, () => {
        const players = [...(eventRepo.getEventBreakdown(key, clanId, from, to)?.players ?? [])];
        players.sort((a, b) => (b.countablePoints - a.countablePoints)
            || (b.countableChests - a.countableChests)
            || a.memberName.localeCompare(b.memberName));
        const byMember = new Map();
        players.forEach((p, i) => {
            if (p.memberId !== null) {
                byMember.set(p.memberId, { rank: i + 1, points: p.countablePoints, chests: p.countableChests });
            }
        });
        return { byMember, participants: players.length };
    });
}
async function runWindows(key, clanId, rollover) {
    const def = (0, event_catalog_js_1.getEventDef)(key);
    if (def?.cycle || def?.calendarNames?.length) {
        const occurrences = await (0, event_calendar_js_1.getEventOccurrences)(key, clanId).catch(() => []);
        if (occurrences.length) {
            return {
                mode: def.cycle ? 'cycle' : 'occurrences',
                windows: occurrences.slice(0, RUNS_PER_EVENT).map((o) => ({
                    label: o.label,
                    from: o.from,
                    to: o.to,
                    runDay: (0, game_day_js_1.gameDateFor)(Date.parse(o.from), rollover),
                    isCurrent: o.isCurrent,
                    estimated: o.estimated,
                })),
            };
        }
    }
    // No schedule (or the feed is down): the Events page falls back to game
    // weeks, so this does too.
    const weekStart = (0, clan_repo_js_1.getClanWeekStart)(clanId);
    const windows = [];
    for (let i = 0; i < WEEKS_PER_FIXED_EVENT; i++) {
        const w = (0, game_day_js_1.gameWindow)('weekly', i, rollover, weekStart);
        windows.push({
            label: null,
            from: w.from,
            to: w.to,
            runDay: (0, game_day_js_1.gameDateFor)(Date.parse(w.from), rollover),
            isCurrent: i === 0,
            estimated: false,
        });
    }
    return { mode: 'weekly', windows };
}
function tinmanOverview(clanId, memberId, today) {
    const dates = tinmanRepo.listTinmanDates(clanId, TINMAN_RUNS);
    if (!dates.length)
        return null;
    const level = (0, guards_repo_js_1.getGuardsSummaries)(clanId, today).get(memberId)?.level ?? null;
    const tier = level ? `g${level}` : ASSUMED_TIER;
    const runs = dates.map((date) => {
        const standings = tinmanRepo.getTinmanStandings(clanId, date);
        const i = standings.players.findIndex((p) => p.memberId === memberId);
        const p = i >= 0 ? standings.players[i] : null;
        const target = tinmanRepo.getTinmanTargets(clanId, date)?.tiers[tier];
        return {
            date,
            points: p?.total ?? 0,
            rank: p ? i + 1 : null,
            players: standings.players.length,
            played: p?.played ?? 0,
            summons: standings.summons.length,
            target: target ?? null,
        };
    });
    return { tier, tierAssumed: level === null, runs };
}
async function getMemberEventsOverview(clanId, memberId, rollover) {
    const today = (0, game_day_js_1.gameDateFor)(Date.now(), rollover);
    const events = await Promise.all((0, event_catalog_js_1.getEventCatalogSummary)().map(async (e) => {
        const { mode, windows } = await runWindows(e.key, clanId, rollover);
        const runs = windows.map((w) => {
            const ranked = rankedRun(e.key, clanId, w.from, w.to);
            const mine = ranked.byMember.get(memberId);
            return {
                ...w,
                points: mine?.points ?? 0,
                chests: mine?.chests ?? 0,
                rank: mine?.rank ?? null,
                participants: ranked.participants,
            };
        });
        return { key: e.key, name: e.name, mode, runs };
    }));
    return { tinman: tinmanOverview(clanId, memberId, today), events };
}
//# sourceMappingURL=member-events.js.map