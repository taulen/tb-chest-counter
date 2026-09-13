// Dashboard — landing page after login. Big stats grid, weekly top
// contributors leaderboard, recent chests list, and superadmin
// "Scan this clan" / "Scan all clans" buttons.

import { api } from '../lib/api.js';
import {
  esc, formatRelativeTime, memberLink, chestHash,
} from '../lib/ui.js';
import { computeGameWindow } from '../lib/period.js';
import { getCurrentUser } from '../lib/state.js';

export async function renderDashboard(el, refreshStatus) {
  // Fetch stats first so the cached gameDayRolloverUtcHour from /stats
  // is populated before we compute the weekly window — otherwise we'd
  // use the 17-default on the very first render and potentially fetch
  // the wrong week if the clan's configured rollover is different.
  const stats = await api('/stats');
  const weeklyWindow = computeGameWindow('weekly', 0);
  const weeklyQuery = weeklyWindow
    ? `/leaderboard?from=${encodeURIComponent(weeklyWindow.from)}&to=${encodeURIComponent(weeklyWindow.to)}`
    : '/leaderboard';
  // Clan Records joins the same batch. It must stay BELOW the serial
  // `await api('/stats')` above, not be hoisted into it: /stats is what
  // populates the cached rollover hour in state.js, and the weekly window
  // computed from it is what the leaderboard query in this batch is keyed on.
  const [recent, leaderboard, records] = await Promise.all([
    api('/chests?limit=10'),
    api(weeklyQuery),
    api('/analytics/single-day-records'),
  ]);
  const isSuperAdmin = getCurrentUser()?.role === 'superadmin';
  // Superadmins get two buttons: scan only the clan currently selected
  // in the dropdown (the common case), or kick off a full rotation
  // across every active clan. Regular admins don't see manual-scan
  // controls at all today; that's unchanged.
  const actionButtons = isSuperAdmin
    ? [
        '<button class="btn btn-primary" data-action="trigger-scan" data-scope="clan">Scan This Clan</button>',
        '<button class="btn" data-action="trigger-scan" data-scope="all">Scan All Clans</button>',
      ].join(' ')
    : '';

  // Refresh status so the manual scan button is immediately disabled
  // if a scan is running. The caller passes this in so we don't
  // import from app.js (would be circular).
  if (typeof refreshStatus === 'function') {
    setTimeout(refreshStatus, 0);
  }

  const lastScanValue = stats.lastScanChests !== null ? stats.lastScanChests.toLocaleString() : '-';
  const lastScanSub = stats.lastScanCompletedAt
    ? formatRelativeTime(stats.lastScanCompletedAt)
    : 'never';

  el.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card"><div class="label">Total Chests</div><div class="value">${stats.totalChests.toLocaleString()}</div></div>
      <div class="stat-card"><div class="label">Clan Members</div><div class="value">${stats.totalMembers.toLocaleString()}</div></div>
      <div class="stat-card"><div class="label">Total Scans</div><div class="value">${stats.totalSessions.toLocaleString()}</div></div>
      <div class="stat-card"><div class="label">Avg Chests/Scan</div><div class="value">${Number(stats.avgChestsPerScan).toLocaleString()}</div></div>
      <div class="stat-card"><div class="label">Last Scan</div><div class="value">${lastScanValue}</div><div class="sub">${lastScanSub}</div></div>
    </div>
    <div class="two-col-grid">
      <div class="card">
        <div class="card-header"><h2>Weekly Top Contributors</h2></div>
        <div class="card-body">
          ${leaderboard.length > 0 ? `<table class="table-responsive leaderboard-table dashboard-weekly-table"><colgroup>
            <col class="col-rank">
            <col class="col-player">
            <col class="col-num">
            <col class="col-num">
          </colgroup><thead><tr><th>Rank</th><th>Player</th><th class="num">Chests</th><th class="num">Points</th></tr></thead><tbody>
            ${leaderboard.slice(0, 15).map((e) => `<tr>
              <td data-label="Rank" data-role="lead"><span class="rank rank-${e.rank}">#${e.rank}</span></td>
              <td data-label="Player" data-role="primary"><span class="mrow-name">${memberLink(e.memberId, e.memberName)}</span><span class="mrow-sub">${e.totalChests.toLocaleString()} chests</span></td>
              <td data-label="Chests" class="num" data-role="hidden">${e.totalChests.toLocaleString()}</td>
              <td data-label="Points" class="num" data-role="metric">${e.totalPoints.toLocaleString()}</td>
            </tr>`).join('')}
          </tbody></table>` : '<div class="empty-state"><p>No data yet.</p></div>'}
        </div>
      </div>
      <div class="card">
        <div class="card-header"><h2>Recent Chests</h2></div>
        <div class="card-body">
          ${recent.length > 0 ? `<table class="table-responsive"><thead><tr><th>Player</th><th>Chest</th><th>Type</th></tr></thead><tbody>
            ${recent.map((c) => `<tr>
              <td data-label="Player" data-role="primary"><span class="mrow-name">${memberLink(c.memberId, c.playerName)}</span><span class="mrow-sub">${esc(c.chestName)}</span></td>
              <td data-label="Chest"><div class="cell-stacked"><a class="member-link cell-stacked-primary" href="${chestHash(c.chestName, 'all')}">${esc(c.chestName)}</a><span class="cell-stacked-sub">${esc(c.chestSource)}</span></div></td>
              <td data-label="Type"><span class="chest-type ${c.chestType}">${c.chestType}</span></td>
            </tr>`).join('')}
          </tbody></table>` : '<div class="empty-state"><p>No chests yet.</p></div>'}
        </div>
      </div>
    </div>
    ${renderClanRecordsCard(records)}
    ${actionButtons ? `<div class="actions">${actionButtons}</div>` : ''}`;
}

/**
 * "Clan Records — Best Single Day" card. Two 🥇🥈🥉 podiums side by
 * side: best single-day chest hauls and best single-day point hauls.
 * Each podium row links to the member's profile.
 *
 * Lives on the Dashboard, which is the page that is *about* all-time
 * standing. It used to render on Analytics as well, which stopped making
 * sense the moment Analytics grew a timeframe: an all-time record card sitting
 * under a "Weekly" selector either has to ignore the selector or stop being a
 * record. Module-local now — the Dashboard is its only caller.
 */
function renderClanRecordsCard(records) {
  const medals = ['🥇', '🥈', '🥉'];

  const renderPodium = (label, entries, unit) => {
    if (!entries || entries.length === 0) {
      return `<div class="records-podium">
        <h3 class="records-podium-title">${label}</h3>
        <p class="muted-copy">No data yet.</p>
      </div>`;
    }
    const rows = entries.map((entry, i) => `
      <div class="records-podium-row">
        <span class="records-podium-medal">${medals[i]}</span>
        <div class="records-podium-body">
          <div class="records-podium-name">${memberLink(entry.memberId, entry.memberName)}</div>
          <div class="records-podium-meta">${entry.value.toLocaleString()} ${unit} · ${esc(entry.date || '')}</div>
        </div>
      </div>
    `).join('');
    return `<div class="records-podium">
      <h3 class="records-podium-title">${label}</h3>
      ${rows}
    </div>`;
  };

  return `
    <div class="card">
      <div class="card-header"><h2>Clan Records — Best Single Day</h2></div>
      <div class="card-body card-body-padded">
        <p class="muted-copy mb-12">All-time personal best days across the whole clan. Each member only appears once per podium (their own record day). Excludes end-of-event clan rewards — the placement prize the game drops on one account for the whole clan.</p>
        <div class="records-podium-grid">
          ${renderPodium('Most Chests in a Day', records?.byChests || [], 'chests')}
          ${renderPodium('Most Points in a Day', records?.byPoints || [], 'pts')}
        </div>
      </div>
    </div>
  `;
}
