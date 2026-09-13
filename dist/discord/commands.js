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
exports.commands = void 0;
exports.handleCommand = handleCommand;
exports.autocompleteMembers = autocompleteMembers;
const discord_js_1 = require("discord.js");
const chestRepo = __importStar(require("../data/repositories/chest-repo.js"));
const sessionRepo = __importStar(require("../data/repositories/session-repo.js"));
const embeds_js_1 = require("./embeds.js");
const game_day_js_1 = require("../utils/game-day.js");
const index_js_1 = require("../config/index.js");
const memberRepo = __importStar(require("../data/repositories/member-repo.js"));
const clan_repo_js_1 = require("../data/repositories/clan-repo.js");
const discord_link_repo_js_1 = require("../data/repositories/discord-link-repo.js");
const leaderboard_handler_js_1 = require("../web/routes/leaderboard-handler.js");
exports.commands = [
    new discord_js_1.SlashCommandBuilder()
        .setName('leaderboard')
        .setDescription('Show leaderboard')
        .addStringOption((opt) => opt.setName('period').setDescription('Time period').addChoices({ name: 'Daily', value: 'daily' }, { name: 'Weekly', value: 'weekly' }, { name: 'Monthly', value: 'monthly' }, { name: 'All Time', value: 'all' })),
    new discord_js_1.SlashCommandBuilder()
        .setName('me')
        .setDescription('Your own progress, privately')
        .addStringOption((opt) => opt.setName('player')
        .setDescription('Your in-game name (only needed the first time)')
        .setAutocomplete(true))
        .addStringOption((opt) => opt.setName('period').setDescription('Time period').addChoices({ name: 'Daily', value: 'daily' }, { name: 'Weekly', value: 'weekly' }, { name: 'Monthly', value: 'monthly' }, { name: 'All Time', value: 'all' })),
    new discord_js_1.SlashCommandBuilder()
        .setName('status')
        .setDescription('Show scanner status'),
];
async function handleCommand(interaction, allowedChannelId, clanId) {
    // Hard-gate all commands to the configured scan-report channel so the
    // clan's general chat doesn't fill up with stats queries. If the operator
    // hasn't configured a channel at all (allowedChannelId empty), fall
    // through and allow anywhere — otherwise they'd have a dead bot with no
    // way to test it. The denial is ephemeral (flag 1 << 6) so only the
    // invoking user sees it — no embarrassing "wrong channel" call-outs in
    // public.
    if (allowedChannelId && interaction.channelId !== allowedChannelId) {
        await interaction.reply({
            content: `This command can only be used in <#${allowedChannelId}>.`,
            flags: discord_js_1.MessageFlags.Ephemeral,
        });
        return;
    }
    switch (interaction.commandName) {
        case 'leaderboard': {
            const period = interaction.options.getString('period') || 'weekly';
            // GAME periods, the same ones the site draws. This used to subtract a
            // fixed number of milliseconds from now — a rolling 168 hours for
            // "weekly" — so the bot answered with a different board from the one
            // anybody comparing it against the website was looking at, and the
            // difference moved every hour.
            const window = (0, game_day_js_1.gameWindow)(period, 0, (0, index_js_1.loadConfig)().gameDayRolloverUtcHour);
            const leaderboard = chestRepo.getLeaderboard(clanId, window?.from, window?.to, { limit: 25 });
            const message = (0, embeds_js_1.formatLeaderboardMessage)(leaderboard, period);
            await interaction.reply({ content: message });
            break;
        }
        case 'me': {
            // Ephemeral throughout. The whole point is that somebody can check
            // whether they are behind without doing it in front of the clan.
            const period = interaction.options.getString('period') || 'weekly';
            const named = interaction.options.getString('player');
            let memberId = named
                ? memberRepo.findMemberByName(named, clanId)?.id ?? null
                : (0, discord_link_repo_js_1.getLinkedMemberId)(clanId, interaction.user.id);
            if (named && memberId === null) {
                await interaction.reply({
                    content: `I can't find a player called **${named}** in this clan. Start typing and pick from the list — the name has to match what the scanner reads in-game.`,
                    flags: discord_js_1.MessageFlags.Ephemeral,
                });
                return;
            }
            if (memberId === null) {
                await interaction.reply({
                    content: 'I don\'t know who you are yet. Run `/me player:<your in-game name>` once and I\'ll remember it.',
                    flags: discord_js_1.MessageFlags.Ephemeral,
                });
                return;
            }
            // Only remember it once it has actually resolved, so a typo never
            // overwrites a good link.
            if (named)
                (0, discord_link_repo_js_1.linkDiscordUser)(clanId, interaction.user.id, memberId);
            const rollover = (0, index_js_1.loadConfig)().gameDayRolloverUtcHour;
            const win = (0, game_day_js_1.gameWindow)(period, 0, rollover);
            const board = chestRepo.getLeaderboard(clanId, win?.from, win?.to, {
                includeAllMembers: true,
            });
            const idx = board.findIndex((e) => e.memberId === memberId);
            const me = idx >= 0 ? board[idx] : null;
            const name = me?.memberName ?? memberRepo.getMemberById(memberId, clanId)?.name ?? 'You';
            const clan = (0, clan_repo_js_1.getClanById)(clanId);
            const weeklyGoal = (0, leaderboard_handler_js_1.resolveWeeklyGoalPoints)(clan);
            await interaction.reply({
                content: formatMeMessage({
                    name,
                    period,
                    rank: idx >= 0 ? idx + 1 : null,
                    total: board.length,
                    points: me?.totalPoints ?? 0,
                    chests: me?.totalChests ?? 0,
                    above: idx > 0 ? board[idx - 1] : null,
                    below: idx >= 0 && idx < board.length - 1 ? board[idx + 1] : null,
                    weeklyGoal,
                }),
                flags: discord_js_1.MessageFlags.Ephemeral,
            });
            break;
        }
        case 'status': {
            const stats = sessionRepo.getScanStats(clanId);
            const embed = (0, embeds_js_1.createStatsEmbed)(stats);
            await interaction.reply({ embeds: [embed] });
            break;
        }
    }
}
/** Days the scaled goal is priced at, mirroring lib/leaderboard-render.js. */
const GOAL_DAYS_BY_PERIOD = {
    daily: 1, weekly: 7, monthly: 30, yearly: 365,
};
/**
 * Autocomplete for /me's `player` option.
 *
 * Off the active roster, prefix-then-substring matched, and hard-capped at 25 —
 * Discord rejects the whole response above that, so a clan with a long roster
 * would get an autocomplete that silently does nothing rather than a short list.
 */
function autocompleteMembers(clanId, typed) {
    const needle = typed.trim().toLowerCase();
    const roster = memberRepo.getAllMembers(true, clanId);
    const matches = needle
        ? roster.filter((m) => m.name.toLowerCase().includes(needle))
            // Names that START with what was typed are what the user meant; the rest
            // are a fallback for someone searching a fragment.
            .sort((a, b) => {
            const aStarts = a.name.toLowerCase().startsWith(needle) ? 0 : 1;
            const bStarts = b.name.toLowerCase().startsWith(needle) ? 0 : 1;
            return aStarts - bStarts || a.name.localeCompare(b.name);
        })
        : [...roster].sort((a, b) => a.name.localeCompare(b.name));
    return matches.slice(0, 25).map((m) => ({ name: m.name, value: m.name }));
}
/**
 * The /me reply. A plain code block, not an embed: embeds render at roughly a
 * quarter width with a 40-column cap on code, which is not enough for an
 * aligned figure and a name on the same line.
 */
function formatMeMessage(o) {
    const periodLabel = o.period === 'all' ? 'all time' : `this ${{ daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year' }[o.period] ?? o.period}`;
    const lines = [
        `${o.name} — ${periodLabel}`,
        '',
        `Points   ${o.points.toLocaleString()}`,
        `Chests   ${o.chests.toLocaleString()}`,
    ];
    if (o.rank !== null)
        lines.push(`Rank     #${o.rank} of ${o.total}`);
    // The gap, not the rank. "#9 of 47" changes nobody's evening; "340 behind
    // Karnak" is a knowable number of chests.
    if (o.above) {
        lines.push(`         ${(o.above.totalPoints - o.points).toLocaleString()} behind ${o.above.memberName}`);
    }
    if (o.below && o.points > o.below.totalPoints) {
        lines.push(`         ${(o.points - o.below.totalPoints).toLocaleString()} ahead of ${o.below.memberName}`);
    }
    // All Time gets no goal: there is no period length to scale the target by,
    // so any number painted against it would be arbitrary.
    const days = GOAL_DAYS_BY_PERIOD[o.period];
    if (o.weeklyGoal && days) {
        const target = Math.round((o.weeklyGoal / 7) * days);
        const short = target - o.points;
        lines.push('');
        lines.push(short > 0
            ? `Goal     ${target.toLocaleString()} — ${short.toLocaleString()} to go`
            : `Goal     ${target.toLocaleString()} — met`);
    }
    return ['```', ...lines, '```'].join('\n');
}
//# sourceMappingURL=commands.js.map