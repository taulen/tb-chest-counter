// Sessions / Scan History page. List view plus per-session detail
// (linked from the Started column) plus the superadmin Delete action.

import { api, apiDelete } from '../lib/api.js';
import {
  $, esc, formatDate, formatDateShort, formatRelativeTime, formatDuration,
  formatTriggerSource, sessionHash, chestHash, memberLink, notify, confirmDialog,
} from '../lib/ui.js';
import { getCurrentUser } from '../lib/state.js';
import { t, tn, tGame } from '../lib/i18n.js';

const CHEST_TYPE_LABELS = {
  common: t('common'),
  uncommon: t('uncommon'),
  rare: t('rare'),
  epic: t('epic'),
  legendary: t('legendary'),
  arena: t('arena'),
  event: t('event'),
  unknown: t('unknown'),
};

const STATUS_LABELS = {
  pending: t('pending'),
  processing: t('processing'),
  completed: t('completed'),
  failed: t('failed'),
};

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
        <button class="btn btn-tight" data-action="sessions-page-prev" ${currentPage <= 1 ? 'disabled' : ''}>${t('← Prev')}</button>
        <span class="pagination-info">${tn(totalSessions, 'Page {page} of {pages} · {n} scan', 'Page {page} of {pages} · {n} scans', { page: currentPage, pages: totalPages, n: totalSessions })}</span>
        <button class="btn btn-tight" data-action="sessions-page-next" ${currentPage >= totalPages ? 'disabled' : ''}>${t('Next →')}</button>
      </div>`
    : '';

  el.innerHTML = `<div class="card"><div class="card-header"><h2>${t('Scan History')}</h2></div><div class="card-body">
    ${pageSessions.length > 0 ? `<table class="table-responsive"><thead><tr><th>${t('Started')}</th><th>${t('Duration')}</th><th>${t('Trigger')}</th><th>${t('Status')}</th><th>${t('Chests')}</th><th>${t('Triumphal')}</th>${isSuperAdmin ? '<th></th>' : ''}</tr></thead><tbody>
      ${pageSessions.map((s) => {
        // Status tooltip carries everything we used to surface as columns:
        // the screenshot count, plus (for failed scans) the error phase
        // and message. Hover-only so the row stays compact.
        const screenshotsLine = t('Screenshots: {count}', { count: s.screenshotsTaken });
        const failureLines = s.errorMessage
          ? (s.errorPhase ? `${s.errorPhase}\n\n${s.errorMessage}` : s.errorMessage)
          : '';
        const tipText = failureLines ? `${screenshotsLine}\n\n${failureLines}` : screenshotsLine;
        const statusTip = ` title="${esc(tipText)}"`;
        const failureBadge = s.errorMessage
          ? ` <span class="failure-phase-badge"${statusTip}>${esc(s.errorPhase || t('see details'))}</span>`
          : '';
        return `<tr>
        <td data-label="${t('Started')}" data-role="primary"><span class="mrow-name"><a class="member-link" href="${sessionHash(s.id)}">${formatDate(s.startedAt)}</a></span><span class="mrow-sub">${formatTriggerSource(s.triggerSource)} · ${formatDuration(s.startedAt, s.completedAt)}</span></td>
        <td data-label="${t('Duration')}">${formatDuration(s.startedAt, s.completedAt)}</td>
        <td data-label="${t('Trigger')}">${formatTriggerSource(s.triggerSource)}</td>
        <td data-label="${t('Status')}"><span class="chest-type ${s.status === 'completed' ? 'uncommon' : 'arena'}"${statusTip}>${STATUS_LABELS[s.status] ?? s.status}</span>${failureBadge}</td>
        <td data-label="${t('Chests')}" data-role="metric">${s.chestsFound}</td>
        <td data-label="${t('Triumphal')}">${s.triumphalChestsFound ?? 0}</td>
        ${isSuperAdmin ? `<td class="col-actions"><button class="btn btn-tight btn-danger" data-action="delete-session" data-session-id="${s.id}" data-session-chests="${s.chestsFound}">${t('Delete')}</button></td>` : ''}
      </tr>`;
      }).join('')}
    </tbody></table>` : `<div class="empty-state"><p>${t('No scans yet.')}</p></div>`}
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
    ? `<table class="table-responsive"><thead><tr><th>${t('Player')}</th><th>${t('Chest')}</th><th>${t('Type')}</th><th>${t('Source')}</th><th>${t('Points')}</th><th>${t('Received')}</th></tr></thead><tbody>
        ${chests.map((c) => `<tr>
          <td data-label="${t('Player')}" data-role="primary"><span class="mrow-name">${memberLink(c.memberId, c.playerName)}</span><span class="mrow-sub">${esc(tGame(c.chestName))}</span></td>
          <td data-label="${t('Chest')}"><a class="member-link" href="${chestHash(c.chestName, 'all')}">${esc(tGame(c.chestName))}</a></td>
          <td data-label="${t('Type')}"><span class="chest-type ${c.chestType}">${CHEST_TYPE_LABELS[c.chestType] ?? c.chestType}</span></td>
          <td data-label="${t('Source')}">${esc(tGame(c.chestSource))}</td>
          <td data-label="${t('Points')}" data-role="metric">${c.pointValue}</td>
          <td data-label="${t('Received')}">${formatDate(c.effectiveAt)}</td>
        </tr>`).join('')}
      </tbody></table>`
    : `<div class="empty-state"><p>${t('No chests recorded for this scan.')}</p></div>`;

  const triumphalRows = triumphals.length > 0
    ? `<table class="table-responsive"><thead><tr><th>${t('Player')}</th><th>${t('Chest')}</th><th>${t('Source')}</th><th>${t('Received')}</th></tr></thead><tbody>
        ${triumphals.map((c) => `<tr>
          <td data-label="${t('Player')}" data-role="primary"><span class="mrow-name">${memberLink(c.memberId, c.playerName)}</span><span class="mrow-sub">${esc(tGame(c.chestName))}</span></td>
          <td data-label="${t('Chest')}">${esc(tGame(c.chestName))}</td>
          <td data-label="${t('Source')}">${esc(tGame(c.chestSource || ''))}</td>
          <td data-label="${t('Received')}" data-role="metric">${formatDate(c.effectiveAt)}</td>
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
    ? `<p class="session-earntime-note">${t('⏱ No receive-times captured — "Received" fell back to the scan time. If you want accurate times, check the Gifts {calibration} crop includes the "Time left" countdown.', { calibration: `<a href="#system">${t('calibration')}</a>` })}</p>`
    : '';

  const hasTriumphals = triumphals.length > 0;
  const chestsCard = hasTriumphals
    ? `<div class="card" id="sessionChestsCard">
        <div class="card-header leaderboard-header">
          <div class="period-selector" id="sessionTabs">
            <button class="btn active" data-session-tab="chests">${t('Chests ({count})', { count: chests.length })}</button>
            <button class="btn" data-session-tab="triumphals">${t('Triumphal Chests ({count})', { count: triumphals.length })}</button>
          </div>
        </div>
        <div class="card-body">
          ${earnTimeNote}
          <div data-session-panel="chests">${chestRows}</div>
          <div data-session-panel="triumphals" class="is-hidden">${triumphalRows}</div>
        </div>
      </div>`
    : `<div class="card">
        <div class="card-header"><h2>${t('Chests Captured ({count})', { count: chests.length })}</h2></div>
        <div class="card-body">
          ${earnTimeNote}
          ${chestRows}
        </div>
      </div>`;

  const errorBanner = session.errorMessage
    ? `<div class="session-error-banner">
         <div class="session-error-phase">${esc(session.errorPhase || t('Scan failed'))}</div>
         <pre class="session-error-message">${esc(session.errorMessage)}</pre>
       </div>`
    : '';

  content.innerHTML = `
    <div class="card">
      <div class="card-header member-detail-header">
        <div class="member-detail-title">
          <h2>${t('Scan #{id}', { id: session.id })}</h2>
        </div>
        <div class="header-actions">
          ${isSuperAdmin ? `<button class="btn btn-danger" data-action="delete-session" data-session-id="${session.id}" data-session-chests="${session.chestsFound}">${t('Delete Scan')}</button>` : ''}
          <button class="btn" data-action="member-back">${t('← Back')}</button>
        </div>
      </div>
      <div class="card-body card-body-padded">
        ${errorBanner}
        <div class="stats-grid">
          <div class="stat-card">
            <div class="label">${t('Status')}</div>
            <div class="value"><span class="chest-type ${session.status === 'completed' ? 'uncommon' : 'arena'}">${esc(STATUS_LABELS[session.status] ?? session.status)}</span></div>
          </div>
          <div class="stat-card">
            <div class="label">${t('Chests Recorded')}</div>
            <div class="value">${(session.chestsFound ?? 0).toLocaleString()}</div>
          </div>
          <div class="stat-card">
            <div class="label">${t('Total Points')}</div>
            <div class="value">${totalPoints.toLocaleString()}</div>
          </div>
          <div class="stat-card">
            <div class="label">${t('Errors')}</div>
            <div class="value">${session.errorsEncountered ?? 0}</div>
          </div>
          <div class="stat-card">
            <div class="label">${t('Trigger')}</div>
            <div class="value value-pill">${formatTriggerSource(session.triggerSource)}</div>
          </div>
          <div class="stat-card">
            <div class="label">${t('Started')}</div>
            <div class="value member-detail-date">${formatDateShort(session.startedAt)}</div>
            <div class="sub">${session.startedAt ? formatRelativeTime(session.startedAt) : ''}</div>
          </div>
          <div class="stat-card">
            <div class="label">${t('Duration')}</div>
            <div class="value">${formatDuration(session.startedAt, session.completedAt)}</div>
          </div>
          <div class="stat-card">
            <div class="label">${t('Screenshots')}</div>
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
    tn(chestCount, 'Delete this scan and its {n} chest record? This cannot be undone.', 'Delete this scan and its {n} chest records? This cannot be undone.', { n: chestCount }),
    { title: t('Delete Scan'), confirmLabel: t('Delete'), danger: true },
  );
  if (!confirmed) return;
  const result = await apiDelete(`/sessions/${id}`);
  if (result?.error) {
    await notify(result.error, t('Delete failed'));
    return;
  }
  await notify(
    tn(result.deletedChests ?? 0, 'Removed {n} chest record and the scan from history.', 'Removed {n} chest records and the scan from history.', { n: result.deletedChests ?? 0 }),
    t('Scan deleted'),
  );
  navigate('sessions');
}

export function changeSessionsPage(delta, rerender) {
  currentPage = Math.max(1, currentPage + delta);
  rerender('sessions');
}
