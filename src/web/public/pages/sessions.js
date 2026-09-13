// Sessions / Scan History page. List view plus per-session detail
// (linked from the Started column) plus the superadmin Delete action.

import { api, apiDelete } from '../lib/api.js';
import {
  $, esc, formatDate, formatDateShort, formatRelativeTime, formatDuration,
  formatTriggerSource, sessionHash, chestHash, memberLink, notify, confirmDialog,
} from '../lib/ui.js';
import { getCurrentUser } from '../lib/state.js';

const PAGE_SIZE = 25;
let currentPage = 1;

export async function renderSessions(el) {
  const sessions = await api('/sessions?limit=500');
  const isSuperAdmin = getCurrentUser()?.role === 'superadmin';

  const totalSessions = sessions.length;
  const totalPages = Math.max(1, Math.ceil(totalSessions / PAGE_SIZE));
  if (currentPage > totalPages) currentPage = totalPages;
  if (currentPage < 1) currentPage = 1;

  const startIdx = (currentPage - 1) * PAGE_SIZE;
  const pageSessions = sessions.slice(startIdx, startIdx + PAGE_SIZE);

  const paginationControls = totalSessions > PAGE_SIZE
    ? `<div class="pagination">
        <button class="btn btn-tight" data-action="sessions-page-prev" ${currentPage <= 1 ? 'disabled' : ''}>← Prev</button>
        <span class="pagination-info">Page ${currentPage} of ${totalPages} · ${totalSessions} scans</span>
        <button class="btn btn-tight" data-action="sessions-page-next" ${currentPage >= totalPages ? 'disabled' : ''}>Next →</button>
      </div>`
    : '';

  el.innerHTML = `<div class="card"><div class="card-header"><h2>Scan History</h2></div><div class="card-body">
    ${pageSessions.length > 0 ? `<table class="table-responsive"><thead><tr><th>Started</th><th>Duration</th><th>Trigger</th><th>Status</th><th>Chests</th><th>Triumphal</th>${isSuperAdmin ? '<th></th>' : ''}</tr></thead><tbody>
      ${pageSessions.map((s) => {
        // Status tooltip carries everything we used to surface as columns:
        // the screenshot count, plus (for failed scans) the error phase
        // and message. Hover-only so the row stays compact.
        const screenshotsLine = `Screenshots: ${s.screenshotsTaken}`;
        const failureLines = s.errorMessage
          ? (s.errorPhase ? `${s.errorPhase}\n\n${s.errorMessage}` : s.errorMessage)
          : '';
        const tipText = failureLines ? `${screenshotsLine}\n\n${failureLines}` : screenshotsLine;
        const statusTip = ` title="${esc(tipText)}"`;
        const failureBadge = s.errorMessage
          ? ` <span class="failure-phase-badge"${statusTip}>${esc(s.errorPhase || 'see details')}</span>`
          : '';
        return `<tr>
        <td data-label="Started" data-role="primary"><span class="mrow-name"><a class="member-link" href="${sessionHash(s.id)}">${formatDate(s.startedAt)}</a></span><span class="mrow-sub">${formatTriggerSource(s.triggerSource)} · ${formatDuration(s.startedAt, s.completedAt)}</span></td>
        <td data-label="Duration">${formatDuration(s.startedAt, s.completedAt)}</td>
        <td data-label="Trigger">${formatTriggerSource(s.triggerSource)}</td>
        <td data-label="Status"><span class="chest-type ${s.status === 'completed' ? 'uncommon' : 'arena'}"${statusTip}>${s.status}</span>${failureBadge}</td>
        <td data-label="Chests" data-role="metric">${s.chestsFound}</td>
        <td data-label="Triumphal">${s.triumphalChestsFound ?? 0}</td>
        ${isSuperAdmin ? `<td class="col-actions"><button class="btn btn-tight btn-danger" data-action="delete-session" data-session-id="${s.id}" data-session-chests="${s.chestsFound}">Delete</button></td>` : ''}
      </tr>`;
      }).join('')}
    </tbody></table>` : '<div class="empty-state"><p>No scans yet.</p></div>'}
    ${paginationControls}
  </div></div>`;
}

/**
 * Per-session detail view — invoked when the user clicks a row's
 * Started timestamp (which navigates to #session/<id>). Shows scan
 * metadata, every chest captured in that scan, and any triumphal
 * chests scanned at the same time.
 */
export async function viewSession(id, navigate) {
  if (window.location.hash !== sessionHash(id)) {
    window.location.hash = sessionHash(id);
    return;
  }
  const data = await api(`/sessions/${id}`);
  if (!data || data.error) {
    // The session belongs to another clan (or was deleted): the API answers
    // 404 { error }. This happens to a superadmin who switches the active
    // clan while sitting on #session/<id> for the previous clan — the reload
    // keeps the hash but the id no longer resolves. Bounce to the main
    // overview rather than rendering a broken view, matching the member and
    // resources pages.
    if (typeof navigate === 'function') navigate('dashboard');
    return;
  }
  renderSessionDetail(data);
}

function renderSessionDetail({ session, chests, triumphalChests }) {
  const content = $('#content');
  const isSuperAdmin = getCurrentUser()?.role === 'superadmin';
  const totalPoints = chests.reduce((sum, c) => sum + (c.pointValue || 0), 0);
  const triumphals = Array.isArray(triumphalChests) ? triumphalChests : [];

  const chestRows = chests.length > 0
    ? `<table class="table-responsive"><thead><tr><th>Player</th><th>Chest</th><th>Type</th><th>Source</th><th>Points</th><th>Received</th></tr></thead><tbody>
        ${chests.map((c) => `<tr>
          <td data-label="Player" data-role="primary"><span class="mrow-name">${memberLink(c.memberId, c.playerName)}</span><span class="mrow-sub">${esc(c.chestName)}</span></td>
          <td data-label="Chest"><a class="member-link" href="${chestHash(c.chestName, 'all')}">${esc(c.chestName)}</a></td>
          <td data-label="Type"><span class="chest-type ${c.chestType}">${c.chestType}</span></td>
          <td data-label="Source">${esc(c.chestSource)}</td>
          <td data-label="Points" data-role="metric">${c.pointValue}</td>
          <td data-label="Received">${formatDate(c.effectiveAt)}</td>
        </tr>`).join('')}
      </tbody></table>`
    : '<div class="empty-state"><p>No chests recorded for this scan.</p></div>';

  const triumphalRows = triumphals.length > 0
    ? `<table class="table-responsive"><thead><tr><th>Player</th><th>Chest</th><th>Source</th><th>Received</th></tr></thead><tbody>
        ${triumphals.map((c) => `<tr>
          <td data-label="Player" data-role="primary"><span class="mrow-name">${memberLink(c.memberId, c.playerName)}</span><span class="mrow-sub">${esc(c.chestName)}</span></td>
          <td data-label="Chest">${esc(c.chestName)}</td>
          <td data-label="Source">${esc(c.chestSource || '')}</td>
          <td data-label="Received" data-role="metric">${formatDate(c.effectiveAt)}</td>
        </tr>`).join('')}
      </tbody></table>`
    : '';

  // Subtle, non-blocking hint: if this scan recorded a healthy batch of chests
  // but none got a real receive-time (all "Received" == scan time), the gift
  // crop is probably clipping the "Time left" countdown. Purely informative —
  // the scan itself is fine (earned_at gracefully falls back to scan time).
  // Only on RECENT scans: pre-earn-time rows also have effectiveAt==capturedAt
  // (earned_at was NULL), and we don't want to nag on months-old history.
  const withEarnTime = chests.filter(
    (c) => c.effectiveAt && c.capturedAt && Date.parse(c.effectiveAt) < Date.parse(c.capturedAt),
  ).length;
  const sessionTs = Date.parse(session.completedAt || session.startedAt || '');
  const isRecentScan = Number.isFinite(sessionTs) && Date.now() - sessionTs < 2 * 24 * 3600 * 1000;
  const earnTimeNote = isRecentScan && chests.length >= 4 && withEarnTime === 0
    ? `<p class="session-earntime-note">⏱ No receive-times captured — "Received" fell back to the scan time. If you want accurate times, check the Gifts <a href="#system">calibration</a> crop includes the "Time left" countdown.</p>`
    : '';

  const hasTriumphals = triumphals.length > 0;
  const chestsCard = hasTriumphals
    ? `<div class="card" id="sessionChestsCard">
        <div class="card-header leaderboard-header">
          <div class="period-selector" id="sessionTabs">
            <button class="btn active" data-session-tab="chests">Chests (${chests.length})</button>
            <button class="btn" data-session-tab="triumphals">Triumphal Chests (${triumphals.length})</button>
          </div>
        </div>
        <div class="card-body">
          ${earnTimeNote}
          <div data-session-panel="chests">${chestRows}</div>
          <div data-session-panel="triumphals" class="is-hidden">${triumphalRows}</div>
        </div>
      </div>`
    : `<div class="card">
        <div class="card-header"><h2>Chests Captured (${chests.length})</h2></div>
        <div class="card-body">
          ${earnTimeNote}
          ${chestRows}
        </div>
      </div>`;

  const errorBanner = session.errorMessage
    ? `<div class="session-error-banner">
         <div class="session-error-phase">${esc(session.errorPhase || 'Scan failed')}</div>
         <pre class="session-error-message">${esc(session.errorMessage)}</pre>
       </div>`
    : '';

  content.innerHTML = `
    <div class="card">
      <div class="card-header member-detail-header">
        <div class="member-detail-title">
          <h2>Scan #${session.id}</h2>
        </div>
        <div class="header-actions">
          ${isSuperAdmin ? `<button class="btn btn-danger" data-action="delete-session" data-session-id="${session.id}" data-session-chests="${session.chestsFound}">Delete Scan</button>` : ''}
          <button class="btn" data-action="member-back">← Back</button>
        </div>
      </div>
      <div class="card-body card-body-padded">
        ${errorBanner}
        <div class="stats-grid">
          <div class="stat-card">
            <div class="label">Status</div>
            <div class="value"><span class="chest-type ${session.status === 'completed' ? 'uncommon' : 'arena'}">${esc(session.status)}</span></div>
          </div>
          <div class="stat-card">
            <div class="label">Chests Recorded</div>
            <div class="value">${(session.chestsFound ?? 0).toLocaleString()}</div>
          </div>
          <div class="stat-card">
            <div class="label">Total Points</div>
            <div class="value">${totalPoints.toLocaleString()}</div>
          </div>
          <div class="stat-card">
            <div class="label">Errors</div>
            <div class="value">${session.errorsEncountered ?? 0}</div>
          </div>
          <div class="stat-card">
            <div class="label">Trigger</div>
            <div class="value value-pill">${formatTriggerSource(session.triggerSource)}</div>
          </div>
          <div class="stat-card">
            <div class="label">Started</div>
            <div class="value member-detail-date">${formatDateShort(session.startedAt)}</div>
            <div class="sub">${session.startedAt ? formatRelativeTime(session.startedAt) : ''}</div>
          </div>
          <div class="stat-card">
            <div class="label">Duration</div>
            <div class="value">${formatDuration(session.startedAt, session.completedAt)}</div>
          </div>
          <div class="stat-card">
            <div class="label">Screenshots</div>
            <div class="value">${session.screenshotsTaken ?? 0}</div>
          </div>
        </div>
      </div>
    </div>

    ${chestsCard}
  `;

  if (hasTriumphals) {
    const tabBar = content.querySelector('#sessionTabs');
    tabBar?.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-session-tab]');
      if (!btn) return;
      const next = btn.dataset.sessionTab;
      tabBar.querySelectorAll('button[data-session-tab]').forEach((b) => {
        b.classList.toggle('active', b.dataset.sessionTab === next);
      });
      content.querySelectorAll('[data-session-panel]').forEach((panel) => {
        panel.classList.toggle('is-hidden', panel.dataset.sessionPanel !== next);
      });
    });
  }
}

/**
 * Delete a scan and its chest records. Superadmin only (the button
 * gating in the renders above ensures the click can only originate
 * from a superadmin's UI). After delete, navigates back to the list.
 */
export async function deleteScanSession(id, chestCount, navigate) {
  if (!Number.isFinite(id) || id <= 0) return;
  const confirmed = await confirmDialog(
    `Delete this scan and its ${chestCount} chest record${chestCount === 1 ? '' : 's'}? This cannot be undone.`,
    { title: 'Delete Scan', confirmLabel: 'Delete', danger: true },
  );
  if (!confirmed) return;
  const result = await apiDelete(`/sessions/${id}`);
  if (result?.error) {
    await notify(result.error, 'Delete failed');
    return;
  }
  await notify(
    `Removed ${result.deletedChests ?? 0} chest record${result.deletedChests === 1 ? '' : 's'} and the scan from history.`,
    'Scan deleted',
  );
  navigate('sessions');
}

export function changeSessionsPage(delta, rerender) {
  currentPage = Math.max(1, currentPage + delta);
  rerender('sessions');
}
