import { SlashCommandBuilder, MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import * as chestRepo from '../data/repositories/chest-repo.js';
import * as sessionRepo from '../data/repositories/session-repo.js';
import { formatLeaderboardMessage, createStatsEmbed } from './embeds.js';
import { gameWindow } from '../utils/game-day.js';
import { loadConfig } from '../config/index.js';
import * as memberRepo from '../data/repositories/member-repo.js';
import { getClanById } from '../data/repositories/clan-repo.js';
import { getLinkedMemberId, linkDiscordUser } from '../data/repositories/discord-link-repo.js';
import { resolveWeeklyGoalPoints } from '../web/routes/leaderboard-handler.js';

export const commands = [
  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Show leaderboard')
    .addStringOption((opt) =>
      opt.setName('period').setDescription('Time period').addChoices(
        { name: 'Daily', value: 'daily' },
        { name: 'Weekly', value: 'weekly' },
        { name: 'Monthly', value: 'monthly' },
        { name: 'All Time', value: 'all' },
      ),
    ),

  new SlashCommandBuilder()
    .setName('me')
    .setDescription('Your own progress, privately')
    .addStringOption((opt) =>
      opt.setName('player')
        .setDescription('Your in-game name (only needed the first time)')
        .setAutocomplete(true),
    )
    .addStringOption((opt) =>
      opt.setName('period').setDescription('Time period').addChoices(
        { name: 'Daily', value: 'daily' },
        { name: 'Weekly', value: 'weekly' },
        { name: 'Monthly', value: 'monthly' },
        { name: 'All Time', value: 'all' },
      ),
    ),

  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show scanner status'),
];

export async function handleCommand(
  interaction: ChatInputCommandInteraction,
  allowedChannelId: string,
  clanId: number,
): Promise<void> {
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
      flags: MessageFlags.Ephemeral,
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
      const window = gameWindow(period, 0, loadConfig().gameDayRolloverUtcHour);
      const leaderboard = chestRepo.getLeaderboard(
        clanId, window?.from, window?.to, { limit: 25 },
      );
      const message = formatLeaderboardMessage(leaderboard, period);
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
        : getLinkedMemberId(clanId, interaction.user.id);

      if (named && memberId === null) {
        await interaction.reply({
          content: `I can't find a player called **${named}** in this clan. Start typing and pick from the list — the name has to match what the scanner reads in-game.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (memberId === null) {
        await interaction.reply({
          content: 'I don\'t know who you are yet. Run `/me player:<your in-game name>` once and I\'ll remember it.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      // Only remember it once it has actually resolved, so a typo never
      // overwrites a good link.
      if (named) linkDiscordUser(clanId, interaction.user.id, memberId);

      const rollover = loadConfig().gameDayRolloverUtcHour;
      const win = gameWindow(period, 0, rollover);
      const board = chestRepo.getLeaderboard(clanId, win?.from, win?.to, {
        includeAllMembers: true,
      });
      const idx = board.findIndex((e) => e.memberId === memberId);
      const me = idx >= 0 ? board[idx] : null;
      const name = me?.memberName ?? memberRepo.getMemberById(memberId, clanId)?.name ?? 'You';

      const clan = getClanById(clanId);
      const weeklyGoal = resolveWeeklyGoalPoints(clan);
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
        flags: MessageFlags.Ephemeral,
      });
      break;
    }

    case 'status': {
      const stats = sessionRepo.getScanStats(clanId);
      const embed = createStatsEmbed(stats);
      await interaction.reply({ embeds: [embed] });
      break;
    }
  }
}

/** Days the scaled goal is priced at, mirroring lib/leaderboard-render.js. */
const GOAL_DAYS_BY_PERIOD: Record<string, number> = {
  daily: 1, weekly: 7, monthly: 30, yearly: 365,
};

/**
 * Autocomplete for /me's `player` option.
 *
 * Off the active roster, prefix-then-substring matched, and hard-capped at 25 —
 * Discord rejects the whole response above that, so a clan with a long roster
 * would get an autocomplete that silently does nothing rather than a short list.
 */
export function autocompleteMembers(clanId: number, typed: string): Array<{ name: string; value: string }> {
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
function formatMeMessage(o: {
  name: string;
  period: string;
  rank: number | null;
  total: number;
  points: number;
  chests: number;
  above: { memberName: string; totalPoints: number } | null;
  below: { memberName: string; totalPoints: number } | null;
  weeklyGoal: number | null;
}): string {
  const periodLabel = o.period === 'all' ? 'all time' : `this ${
    { daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year' }[o.period] ?? o.period}`;

  const lines: string[] = [
    `${o.name} — ${periodLabel}`,
    '',
    `Points   ${o.points.toLocaleString()}`,
    `Chests   ${o.chests.toLocaleString()}`,
  ];

  if (o.rank !== null) lines.push(`Rank     #${o.rank} of ${o.total}`);

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
