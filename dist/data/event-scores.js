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
exports.SCORE_EVENT_KEYS = void 0;
exports.isScoreEventKey = isScoreEventKey;
exports.eventScoreDates = eventScoreDates;
exports.getEventScores = getEventScores;
/**
 * An event run's own scores — Tin Man per summon, Olympus / Ragnarök / Dark
 * Omens per day — in one place, for every reader: Events → Ancients and the
 * Scores tabs (routes/tinman.ts), Tools → Rewards (through that route), the
 * member profile's Events card (member-events.ts) and the Performance page's
 * Tin Man signal (performance.ts).
 *
 * The game is the source: ancients-game.ts, olympus-game.ts and
 * day-event-game.ts build each run's table from the standings every scan
 * reads. Standings were pasted by hand until Nov 2026; pasting is gone, and a
 * run the game never read (pasted before Nov 17 2026) shows its pasted table,
 * read-only (tinman-repo.ts). A run with both is the game's — except an Ancients
 * run read before reads were kept (v123), whose game table has totals only,
 * which keeps its pasted per-summon table; and Olympus runs from before its
 * game read (Nov 24 2026), whose pasted days stand.
 */
const index_js_1 = require("../config/index.js");
const ancients_js_1 = require("../game-protocol/ancients.js");
const game_event_repo_js_1 = require("./repositories/game-event-repo.js");
const tinmanRepo = __importStar(require("./repositories/tinman-repo.js"));
const ancients_game_js_1 = require("./ancients-game.js");
const olympus_game_js_1 = require("./olympus-game.js");
const day_event_game_js_1 = require("./day-event-game.js");
exports.SCORE_EVENT_KEYS = ['ancients', 'olympus', 'ragnarok', 'dark-omens'];
function isScoreEventKey(key) {
    return exports.SCORE_EVENT_KEYS.includes(key);
}
const rollover = () => (0, index_js_1.loadConfig)().gameDayRolloverUtcHour;
/** Days of the runs the game has standings for, newest first (Ancients: Tinman days). */
function gameRunDates(clanId, key) {
    const r = rollover();
    if (key === 'ancients') {
        return [...new Set((0, game_event_repo_js_1.listRunsOfType)(clanId, ancients_js_1.ANCIENTS_EVENT_TYPE)
                .map((run) => (0, ancients_game_js_1.tinmanDayOfRun)(run, r))
                .filter((d) => d !== null))];
    }
    if (key === 'olympus')
        return (0, olympus_game_js_1.olympusGameRunDates)(clanId, r);
    return (0, day_event_game_js_1.dayEventGameRunDates)(clanId, key, r);
}
/** Days of the runs with scores — from the game or pasted — newest first. */
function eventScoreDates(clanId, key, limit = 30) {
    return [...new Set([...tinmanRepo.listTinmanDates(clanId, limit, key), ...gameRunDates(clanId, key)])]
        .sort().reverse().slice(0, limit);
}
/** The game's table for the run filed under `date`, or null. */
function gameTable(clanId, key, date, pastedRounds, nowMs) {
    const r = rollover();
    if (key === 'ancients') {
        const run = (0, ancients_game_js_1.ancientsRunForDay)(clanId, date, r);
        const table = run ? (0, ancients_game_js_1.buildGameTinman)(clanId, run, nowMs) : null;
        // A run read before reads were kept has totals only: a pasted per-summon table beats it.
        return table && (table.reads > 0 || !pastedRounds) ? table : null;
    }
    if (pastedRounds)
        return null;
    return key === 'olympus' ? (0, olympus_game_js_1.buildGameOlympus)(clanId, date, r, nowMs) : (0, day_event_game_js_1.buildGameDayEvent)(clanId, key, date, r, nowMs);
}
/** One run's scores (see the file header for which source wins). */
function getEventScores(clanId, key, date, nowMs = Date.now()) {
    const pasted = tinmanRepo.getTinmanStandings(clanId, date, key);
    const game = gameTable(clanId, key, date, pasted.summons.length, nowMs);
    if (!game)
        return { date, summons: pasted.summons, players: pasted.players, game: null };
    const { players, ...meta } = game;
    return { date, summons: [], players, game: meta };
}
//# sourceMappingURL=event-scores.js.map