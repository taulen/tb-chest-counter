import { EmbedBuilder } from 'discord.js';
import type { LeaderboardEntry, ScanStats } from '../models/types.js';
import type { ScanResult } from '../scheduler/loop.js';
import * as chestRepo from '../data/repositories/chest-repo.js';

/**
 * Cap for the rendered table body. The table now ships inside a plain
 * message (not an embed), so the ceiling is Discord's 2000-char message
 * limit; we stop well short to leave room for the title + summary lines
 * above it and a "…and N more" tail.
 */
const TABLE_BODY_MAX = 1700;

/**
 * Maximum characters we'll render for a player name before truncating
 * with "…". Keeps the column alignment stable even when a player has an
 * unusually long name that would otherwise push everything rightward.
 *
 * Roomy (16) because the table renders in a full-width plain-message code
 * block rather than a width-strangled embed — see renderLeaderboardTable.
 */
const NAME_COLUMN_WIDTH = 16;

function padEnd(s: string, width: number): string {
  const truncated = s.length > width ? s.slice(0, width - 1) + '…' : s;
  return truncated + ' '.repeat(Math.max(0, width - truncated.length));
}

function padStart(s: string, width: number): string {
  return ' '.repeat(Math.max(0, width - s.length)) + s;
}

/**
 * Render a rank cell for the monospace leaderboard tables. Ranks 1-3 get
 * a medal emoji (🥇🥈🥉) instead of a number so the podium is visually
 * distinct inside the table without needing a separate header block.
 *
 * Discord renders these three emoji at ~2 monospace cells wide in code
 * blocks, which matches the minimum numeric rank width (" 4", "10"), so
 * we emit the bare emoji with NO trailing padding — the natural emoji
 * width fills the same column space a two-digit rank would.
 */
function formatRankCell(rank: number, width: number): string {
  const medals = ['🥇', '🥈', '🥉'];
  if (rank >= 1 && rank <= 3) {
    return medals[rank - 1];
  }
  return padStart(String(rank), width);
}

interface LeaderboardRow {
  rank: number;
  name: string;
  points: number;
  chests: number;
}

/**
 * Render the shared monospace leaderboard table used by the scan report,
 * the /leaderboard command, and the daily digest.
 *
 * Rendered inside a plain-message code block (NOT an embed). Discord embeds
 * only use ~25% of the channel width and hard-limit code blocks to 40
 * columns, with no operator-facing way to widen them — which is why the
 * table kept wrapping its last column onto its own line on desktop. A code
 * block in a regular message instead uses the full channel width, so the
 * comfortable ~36-char layout below fits desktop with room to spare and
 * matches the width that already rendered cleanly on mobile.
 *
 * Top 3 ranks render as medal emoji, which are ~2 cells wide and line up
 * with the two-digit numeric ranks. Returns the fenced table plus a
 * "…and N more players" tail when the list would blow the message cap.
 */
function renderLeaderboardTable(rows: LeaderboardRow[]): string {
  if (rows.length === 0) return '';

  const maxPoints = Math.max(...rows.map((r) => r.points), 0);
  const maxChests = Math.max(...rows.map((r) => r.chests), 0);
  const maxRank = Math.max(...rows.map((r) => r.rank), 0);
  const pointsWidth = Math.max(6, String(maxPoints).length);
  const chestsWidth = Math.max(6, String(maxChests).length);
  const rankWidth = Math.max(2, String(maxRank).length);

  const header = `${padStart('#', rankWidth)}  ${padEnd('Player', NAME_COLUMN_WIDTH)}  ${padStart('Points', pointsWidth)}  ${padStart('Chests', chestsWidth)}`;
  const separator = '-'.repeat(header.length);
  const FENCE_OVERHEAD = header.length + separator.length + 2 + 10;

  const body: string[] = [];
  let truncated = 0;
  let currentLength = FENCE_OVERHEAD;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const rankCell = formatRankCell(r.rank, rankWidth);
    const row = `${rankCell}  ${padEnd(r.name, NAME_COLUMN_WIDTH)}  ${padStart(String(r.points), pointsWidth)}  ${padStart(String(r.chests), chestsWidth)}`;
    if (currentLength + row.length + 1 > TABLE_BODY_MAX) {
      truncated = rows.length - i;
      break;
    }
    body.push(row);
    currentLength += row.length + 1;
  }

  const tail = truncated > 0 ? `\n…and ${truncated} more player${truncated === 1 ? '' : 's'}` : '';
  return ['```', header, separator, ...body, '```'].join('\n') + tail;
}

export function formatScanReportMessage(result: ScanResult, clanId: number): string {
  // Headline line: status + the actually-inserted count. The raw "found"
  // number includes duplicates the scanner saw but didn't write to the DB,
  // which is noise from a clan-reporting point of view — what matters is
  // what landed in the database and scored points. A green/red embed bar
  // used to carry the success signal; in a plain message an emoji does.
  const statusIcon = result.success ? '✅' : '❌';
  const header = `${statusIcon} **Chest Scan Report** — ${result.success ? 'Success' : 'Failed'} · **${result.newChests}** chest${result.newChests === 1 ? '' : 's'}`;

  // Summarize the actual DB rows for this session. Reading from the DB
  // (rather than the in-memory giftsData) means the summary respects merge
  // rules, canonical name corrections, and real point values — it matches
  // what the dashboard will show for the same scan.
  if (!result.sessionId || !result.success) return header;

  const chests = chestRepo.getChestsBySession(result.sessionId, clanId);
  if (chests.length === 0) return header;

  const perPlayer = new Map<string, { chests: number; points: number }>();
  let totalPoints = 0;
  for (const chest of chests) {
    const key = chest.playerName || 'Unknown';
    const entry = perPlayer.get(key) ?? { chests: 0, points: 0 };
    entry.chests += 1;
    entry.points += chest.pointValue || 0;
    perPlayer.set(key, entry);
    totalPoints += chest.pointValue || 0;
  }

  // Sort by points desc, tie-break by chest count desc, then by name.
  const sorted = Array.from(perPlayer.entries())
    .map(([name, stats]) => ({ name, ...stats }))
    .sort((a, b) => b.points - a.points || b.chests - a.chests || a.name.localeCompare(b.name));

  const summary = `**${totalPoints.toLocaleString()}** points across **${perPlayer.size}** player${perPlayer.size === 1 ? '' : 's'}`;
  const table = renderLeaderboardTable(
    sorted.map((p, i) => ({ rank: i + 1, name: p.name, points: p.points, chests: p.chests })),
  );

  return `${header}\n${summary}\n${table}`;
}

export function formatLeaderboardMessage(
  leaderboard: LeaderboardEntry[],
  period: string,
): string {
  const top = leaderboard.slice(0, 15);
  const title = `🏆 **Leaderboard (${period})**`;

  if (top.length === 0) {
    return `${title}\nNo data yet.`;
  }

  // Single monospace table with medal emoji inline in the rank column for
  // the top 3 — see renderLeaderboardTable.
  const table = renderLeaderboardTable(
    top.map((e) => ({
      rank: e.rank,
      name: e.memberName,
      points: e.totalPoints,
      chests: e.totalChests,
    })),
  );

  return `${title}\n${table}`;
}

export function createStatsEmbed(stats: ScanStats): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle('Chest Counter Stats')
    .setDescription('Current scanner status and totals.')
    .setColor(0x58a6ff)
    .addFields(
      // Three-across summary row for the headline counters.
      { name: 'Total Scans', value: stats.totalSessions.toLocaleString(), inline: true },
      { name: 'Total Chests', value: stats.totalChests.toLocaleString(), inline: true },
      { name: 'Members', value: stats.totalMembers.toLocaleString(), inline: true },
      // Full-width rows below the summary for the less-dense metrics, so
      // the embed has some breathing room instead of cramming five fields
      // onto two rows.
      { name: 'Avg Chests / Scan', value: stats.avgChestsPerScan.toLocaleString(), inline: false },
      { name: 'Last Scan', value: formatLastScanValue(stats.lastScanAt, stats.lastScanChests), inline: false },
    )
    .setTimestamp();
}

/**
 * Format an ISO date as a Discord relative timestamp (`<t:unix:R>`).
 * Discord renders this client-side as "2 hours ago", "just now", etc.
 * and auto-updates the display over time, so the embed stays accurate
 * even when someone scrolls back to it later.
 */
function formatDiscordRelative(iso: string | null): string {
  if (!iso) return 'Never';
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return 'Never';
  return `<t:${Math.floor(ms / 1000)}:R>`;
}

/**
 * Build the Last Scan field value: relative timestamp plus the chest count
 * from that scan when available. Displayed as one line so the embed stays
 * compact — e.g. "2 hours ago · 10 chests".
 */
function formatLastScanValue(iso: string | null, chestCount: number | null): string {
  const when = formatDiscordRelative(iso);
  if (chestCount === null || chestCount === undefined) return when;
  return `${when} · **${chestCount.toLocaleString()}** chest${chestCount === 1 ? '' : 's'}`;
}

/**
 * Daily summary message: posted by the bot once per day at the configured
 * UTC hour. Covers the rolling 24-hour window ending at "now" and shows a
 * top-contributors leaderboard along with the headline counters.
 *
 * Sent as a plain message (not an embed) so the leaderboard table gets the
 * full channel width — see renderLeaderboardTable.
 */
export function formatDailyDigestMessage(
  data: ReturnType<typeof chestRepo.getDailyDigestData>,
  options: { webExternalUrl?: string; gameDayDate?: string } = {},
): string {
  // Game-day key (YYYY-MM-DD) for the leaderboard deep-link. The caller
  // passes the key resolved from the digest's snapped window so the link
  // points at exactly the day the digest covers; the fallback only matters
  // for callers that don't supply one.
  const gameDayDate =
    options.gameDayDate ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const lines: string[] = ['📅 **Daily Digest — Last 24 Hours**'];

  // Deep-link to the daily leaderboard, wrapped in <> so Discord doesn't
  // expand it into a link-preview card below the message.
  if (options.webExternalUrl) {
    const base = options.webExternalUrl.replace(/\/+$/, '');
    lines.push(`<${base}/#leaderboard?period=daily&day=${gameDayDate}>`);
  }

  lines.push(
    `**${data.totalChests.toLocaleString()}** chests · **${data.totalPoints.toLocaleString()}** pts · ` +
      `**${data.activePlayers.toLocaleString()}** players · **${data.scanCount.toLocaleString()}** scans`,
  );

  if (data.topContributors.length === 0) {
    lines.push('_Nothing collected in the past 24 hours._');
    return lines.join('\n');
  }

  // Same monospace table as the scan report — see renderLeaderboardTable.
  const table = renderLeaderboardTable(
    data.topContributors.map((p, i) => ({
      rank: i + 1,
      name: p.memberName,
      points: p.points,
      chests: p.chests,
    })),
  );
  lines.push(table);
  return lines.join('\n');
}

/**
 * Plain-text version of the daily digest leaderboard for in-game chat.
 * The Discord embed table only looks aligned inside Discord's monospace
 * code fence — the moment a player copy-pastes it into the variable-width
 * in-game chat, the column padding turns to mush and the medal emoji and
 * dashed separator come along as noise. This format drops perfect
 * alignment in favor of dot leaders that look tidy in the chat font.
 *
 * Capped at top 20: the desktop in-game chat fits the message
 * comfortably, and the visual-width heuristic we tried for tighter
 * mobile alignment turned out to misjudge the mobile chat font in
 * the opposite direction. Char-count-based dot padding is the
 * version that read best on both clients during testing.
 */
const DM_MESSAGE_MAX = 1900;
const SHARE_TEXT_TOP_N = 20;

/**
 * Format a YYYY-MM-DD game-day key as "19 May" / "1 June" — day +
 * full month, no year. Matches the chat-friendly style the user
 * asked for, while the caller keeps passing the canonical key
 * (which is what the site's daily leaderboard URL also uses).
 */
function formatGameDayLabel(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return key;
  const date = new Date(Date.UTC(y, m - 1, d));
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(date);
}

export function formatDailyDigestShareText(
  data: ReturnType<typeof chestRepo.getDailyDigestData>,
  options: { gameDayDate?: string } = {},
): string {
  // Day + month label (e.g. "19 May") so the recipient can cross-
  // reference the DM with the site's daily leaderboard for the same
  // game day. Year intentionally omitted to keep the title compact.
  const dateLabel = options.gameDayDate ? ` — ${formatGameDayLabel(options.gameDayDate)}` : '';

  if (data.topContributors.length === 0) {
    return `Daily Digest${dateLabel}\nNo chests collected in the past 24 hours.`;
  }

  // Trim to the top N before rendering. The in-game chat character
  // cap is shorter than Discord's, and a full digest gets truncated
  // mid-line when pasted there.
  const contributors = data.topContributors.slice(0, SHARE_TEXT_TOP_N);

  // Two-line header: date on its own line, then the "Our top N crypters"
  // tagline. Mirrors the format the team has been pasting manually.
  const header = `Daily Digest${dateLabel}`;
  const subheader = `Our top ${contributors.length} crypters`;
  const lines: string[] = [header, subheader];
  let totalLen = header.length + subheader.length + 2;

  // Left-pad rank to the width of the largest rank with a plain
  // ASCII space. We previously used FIGURE SPACE (U+2007, digit-
  // width) for tighter alignment in variable-width fonts, but the
  // in-game chat font lacks a glyph for it and rendered a blank
  // box. Plain space is universally available; the slight shift
  // between single- and double-digit rows is absorbed by the dot
  // leaders below.
  //
  // Use `N)` instead of `N.` because Discord auto-renders `1. `,
  // `2. `, … as a Markdown ordered list — the rendered numbers
  // become non-selectable so a copy-paste loses the ranks. `N)`
  // is plain text and survives copy intact.
  const rankWidth = String(contributors.length).length;

  // Two-pass layout: compute the widest "rank) name" prefix so each
  // row gets dot leaders out to the same character column. Middle
  // dot (U+00B7) is in Latin-1 Supplement and rendered by every
  // common font, including the in-game chat one.
  const prefixes = contributors.map((p, idx) => {
    const r = String(idx + 1).padStart(rankWidth, ' ');
    return `${r}) ${p.memberName}`;
  });
  const maxPrefixLen = Math.max(...prefixes.map((s) => s.length));
  const LEADER = '·';

  for (let i = 0; i < contributors.length; i++) {
    const p = contributors[i];
    const chestsLabel = p.chests === 1 ? 'chest' : 'chests';
    const prefix = prefixes[i];
    // 2-char buffer so even the longest name still gets a couple of
    // dots after it; shorter names get more, all ending at the same
    // character column.
    const dotCount = Math.max(2, maxPrefixLen - prefix.length + 2);
    const leaders = LEADER.repeat(dotCount);
    const line = `${prefix} ${leaders} ${p.chests} ${chestsLabel} (${p.points.toLocaleString('en-US')} pts)`;
    if (totalLen + line.length + 1 > DM_MESSAGE_MAX) break;
    lines.push(line);
    totalLen += line.length + 1;
  }

  return lines.join('\n');
}
