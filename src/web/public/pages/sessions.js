// Sessions / Scan History page. List view plus per-session detail
// (linked from the Started column) plus the superadmin Delete action.

import { api, apiDelete } from '../lib/api.js';
import {
  $, esc, formatDate, formatDateShort, formatRelativeTime, formatDuration,
  formatTriggerSource, sessionHash, chestHash, sourceLink, memberLink, notify, confirmDialog,
} from '../lib/ui.js';
import { getCurrentUser } from '../lib/state.js';
import { t, tn, tGame } from '../lib/i18n.js';
import { loadGameArt, chestLabelHtml } from '../lib/game-art.js';
import { plainNumber, rewardTotalChip } from '../lib/reward-format.js';
import { segHtml, tileHtml, emptyHtml, errorStateHtml, refusalText, wireRetry, setPageActions } from '../lib/ui-kit.js';

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

/** A scan's outcome: a glyph AND words, never colour alone. */
function statusHtml(status, title = '') {
  const kind = status === 'completed' ? ['is-ok', '✓']
    : status === 'failed' ? ['is-bad', '✕']
      : status === 'processing' ? ['is-busy', '◐']
        : ['is-wait', '…'];
  return `<span class="sess-status ${kind[0]}"${title ? ` title="${esc(title)}"` : ''}><span aria-hidden="true">${kind[1]}</span> ${esc(STATUS_LABELS[status] ?? status)}</span>`;
}

/**
 * What a scan gathered: one small tile + amount per resource, in the game's
 * order so a resource keeps its place down the column. The exact amount (and
 * the part that came as packs) is each one's tooltip and label. Empty for a
 * scan that opened nothing (before Nov 17 2026, or a quiet cycle).
 */
function resourcesCellHtml(resources, items) {
  const list = Array.isArray(resources) ? resources : [];
  if (!list.length) return '';
  return `<span class="sess-res">${list.map((r) => rewardTotalChip({ ...r, unit: 'amount' }, items, { size: 22, layout: 'inline' })).join('')}</span>`;
}

export async function renderSessions(el) {
  setPageActions('');
  // The resources' tiles in the table (loadGameArt never rejects).
  const [answer] = await Promise.all([api('/sessions?limit=500'), loadGameArt()]);
  const isSuperAdmin = getCurrentUser()?.role === 'superadmin';

  // The list is the page: a refusal (an object without the list) is said, with Try again.
  if (!Array.isArray(answer?.sessions)) {
    el.innerHTML = `<div class="sess-page">${errorStateHtml(t('The scan history could not be loaded.'), refusalText(answer))}</div>`;
    wireRetry(el, () => renderSessions(el));
    return;
  }
  const { sessions } = answer;
  const items = answer.items ?? {};

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

  const rows = pageSessions.map((s) => {
    // The status's title carries what used to be columns: the screenshot
    // count of scans recorded by the retired screenshot reader, plus (for a
    // failed scan) the phase and message. The badge names the phase.
    const screenshotsLine = s.screenshotsTaken > 0 ? t('Screenshots: {count}', { count: s.screenshotsTaken }) : '';
    const failureLines = s.errorMessage
      ? (s.errorPhase ? `${s.errorPhase}\n\n${s.errorMessage}` : s.errorMessage)
      : '';
    const tipText = [screenshotsLine, failureLines].filter(Boolean).join('\n\n');
    const failureBadge = s.errorMessage
      ? ` <span class="failure-phase-badge" title="${esc(tipText)}">${esc(s.errorPhase || t('see details'))}</span>`
      : '';
    // Trigger and duration ride under the start time (desktop too): a protocol
    // scan takes seconds, and the room goes to what the scan gathered.
    return `<tr>
        <td data-label="${t('Started')}" data-role="primary"><span class="mrow-name"><a class="member-link" href="${sessionHash(s.id)}">${formatDate(s.startedAt)}</a></span><span class="mrow-sub">${formatTriggerSource(s.triggerSource)} · ${formatDuration(s.startedAt, s.completedAt)}</span></td>
        <td data-label="${t('Status')}">${statusHtml(s.status, tipText)}${failureBadge}</td>
        <td data-label="${t('Chests')}" class="num" data-role="metric">${(s.chestsFound ?? 0).toLocaleString()}</td>
        <td data-label="${t('Triumphal')}" class="num">${(s.triumphalChestsFound ?? 0).toLocaleString()}</td>
        <td data-label="${t('Resources')}">${resourcesCellHtml(s.resources, items)}</td>
        ${isSuperAdmin ? `<td class="col-actions"><button class="btn btn-tight btn-danger" data-action="delete-session" data-session-id="${s.id}" data-session-chests="${s.chestsFound}">${t('Delete')}</button></td>` : ''}
      </tr>`;
  }).join('');

  el.innerHTML = `<div class="sess-page">
      ${pageSessions.length > 0 ? `
      <p class="ui-sub">${tn(totalSessions, '{n} scan', '{n} scans', { n: totalSessions.toLocaleString() })}</p>
      <div class="ui-table-card">
        <table class="table-responsive ui-table sess-table">
          <colgroup><col class="col-started"><col class="col-status"><col class="col-chests"><col class="col-triumphal"><col class="col-resources">${isSuperAdmin ? '<col class="col-actions">' : ''}</colgroup>
          <thead><tr><th>${t('Started')}</th><th>${t('Status')}</th><th class="num">${t('Chests')}</th><th class="num">${t('Triumphal')}</th><th>${t('Resources')}</th>${isSuperAdmin ? '<th></th>' : ''}</tr></thead>
          <tbody>${rows}</tbody>
        </table>
        ${paginationControls}
      </div>` : emptyHtml(t('No scans yet.'))}
    </div>`;
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
  // The chests' pictures in the tables (loadGameArt never rejects).
  const [data] = await Promise.all([api(`/sessions/${id}`), loadGameArt()]);
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

/**
 * Everything opening this scan's chests paid out, the way Resources → Chest
 * rewards shows a period: resources, speedup time, item counts — each its own
 * group, each total in its own unit. Empty for a scan that opened nothing.
 */
function rewardsTileHtml(rewards, items) {
  if (!rewards?.chests || !Array.isArray(rewards.totals)) return '';
  const groups = [
    { unit: 'amount', title: t('Resources'), hint: t('Each in its own unit · packs count as the resource they hold') },
    { unit: 'time', title: t('Speedups'), hint: t('Total time') },
    { unit: 'count', title: t('Items'), hint: t('How many of each') },
  ];
  const sections = groups.map(({ unit, title, hint }) => {
    const list = rewards.totals.filter((tot) => tot.unit === unit);
    if (!list.length) return '';
    return `
      <section class="chest-rewards-group">
        <div class="chest-rewards-group-head"><h3>${title}</h3><span class="ui-sub">${hint}</span></div>
        <div class="reward-grid">${list.map((tot) => rewardTotalChip(tot, items)).join('')}</div>
      </section>`;
  }).join('');
  const sub = `${tn(rewards.chests, '{n} chest opened by this scan', '{n} chests opened by this scan', { n: plainNumber(rewards.chests) })} · ${t('Hover a reward for the exact total')}`;
  return tileHtml('sess-rewards', t('Rewards'), `<p class="ui-sub">${sub}</p><div class="chest-rewards-groups">${sections}</div>`, { span: 12 });
}

function renderSessionDetail({ session, chests: chestList, triumphalChests, rewards, items }) {
  const content = $('#content');
  const isSuperAdmin = getCurrentUser()?.role === 'superadmin';
  const chests = Array.isArray(chestList) ? chestList : [];
  const totalPoints = chests.reduce((sum, c) => sum + (c.pointValue || 0), 0);
  const triumphals = Array.isArray(triumphalChests) ? triumphalChests : [];

  // Back and (superadmin) Delete: in the page, where app.js's #content click
  // delegation hears their data-action (the shell's #pageActions is outside it).
  setPageActions('');
  const actions = `<div class="ui-toolbar sess-actions">
      <button class="btn" data-action="member-back">${t('← Back')}</button>
      ${isSuperAdmin ? `<button class="btn btn-danger" data-action="delete-session" data-session-id="${session.id}" data-session-chests="${session.chestsFound}">${t('Delete Scan')}</button>` : ''}
    </div>`;

  const chestRows = chests.length > 0
    ? `<div class="ui-table-card"><table class="table-responsive ui-table sess-chests-table">
        <colgroup><col class="col-player"><col class="col-chest"><col class="col-type"><col class="col-source"><col class="col-points"><col class="col-received"></colgroup>
        <thead><tr><th>${t('Player')}</th><th>${t('Chest')}</th><th>${t('Type')}</th><th>${t('Source')}</th><th class="num">${t('Points')}</th><th>${t('Received')}</th></tr></thead><tbody>
        ${chests.map((c) => `<tr>
          <td data-label="${t('Player')}" data-role="primary"><span class="mrow-name">${memberLink(c.memberId, c.playerName)}</span><span class="mrow-sub">${chestLabelHtml(c.chestName, esc(tGame(c.chestName)), { size: 16 })}</span></td>
          <td data-label="${t('Chest')}">${chestLabelHtml(c.chestName, `<a class="member-link" href="${chestHash(c.chestName, 'all')}">${esc(tGame(c.chestName))}</a>`)}</td>
          <td data-label="${t('Type')}"><span class="chest-type ${c.chestType}">${CHEST_TYPE_LABELS[c.chestType] ?? c.chestType}</span></td>
          <td data-label="${t('Source')}">${sourceLink(c.chestSource)}</td>
          <td data-label="${t('Points')}" class="num" data-role="metric">${c.pointValue}</td>
          <td data-label="${t('Received')}">${formatDate(c.effectiveAt)}</td>
        </tr>`).join('')}
      </tbody></table></div>`
    : emptyHtml(t('No chests recorded for this scan.'));

  const triumphalRows = triumphals.length > 0
    ? `<div class="ui-table-card"><table class="table-responsive ui-table sess-triumphal-table">
        <colgroup><col class="col-player"><col class="col-chest"><col class="col-source"><col class="col-received"></colgroup>
        <thead><tr><th>${t('Player')}</th><th>${t('Chest')}</th><th>${t('Source')}</th><th>${t('Received')}</th></tr></thead><tbody>
        ${triumphals.map((c) => `<tr>
          <td data-label="${t('Player')}" data-role="primary"><span class="mrow-name">${memberLink(c.memberId, c.playerName)}</span><span class="mrow-sub">${chestLabelHtml(c.chestName, esc(tGame(c.chestName)), { size: 16 })}</span></td>
          <td data-label="${t('Chest')}">${chestLabelHtml(c.chestName, esc(tGame(c.chestName)))}</td>
          <td data-label="${t('Source')}">${esc(tGame(c.chestSource || ''))}</td>
          <td data-label="${t('Received')}" data-role="metric">${formatDate(c.effectiveAt)}</td>
        </tr>`).join('')}
      </tbody></table></div>`
    : '';

  const hasTriumphals = triumphals.length > 0;
  // Chests | Triumphal Chests: the kit's segmented control, one table at a time.
  const chestsBlock = hasTriumphals
    ? `<div class="sess-chests">
        ${segHtml({
          label: t('Chests captured'),
          items: [
            { value: 'chests', label: t('Chests ({count})', { count: chests.length }) },
            { value: 'triumphals', label: t('Triumphal Chests ({count})', { count: triumphals.length }) },
          ],
          current: 'chests',
          attr: 'session-tab',
        })}
        <div data-session-panel="chests">${chestRows}</div>
        <div data-session-panel="triumphals" class="is-hidden">${triumphalRows}</div>
      </div>`
    : `<div class="sess-chests">
        <h2 class="sess-h">${t('Chests Captured ({count})', { count: chests.length })}</h2>
        ${chestRows}
      </div>`;

  // A failed scan's own words: what happened, plainly.
  const errorBanner = session.errorMessage
    ? `<div class="session-error-banner">
         <div class="session-error-phase">${esc(session.errorPhase || t('Scan failed'))}</div>
         <pre class="session-error-message">${esc(session.errorMessage)}</pre>
       </div>`
    : '';

  const stat = (label, valueHtml, sub = '') => `<div class="ui-stat">
      <div class="ui-stat-label">${label}</div>
      <div class="ui-big sess-stat-value">${valueHtml}</div>
      ${sub ? `<div class="ui-sub">${sub}</div>` : ''}
    </div>`;
  const stats = `<div class="ui-big-row sess-stats">
      ${stat(t('Status'), statusHtml(session.status))}
      ${stat(t('Chests Recorded'), (session.chestsFound ?? 0).toLocaleString())}
      ${stat(t('Total Points'), totalPoints.toLocaleString())}
      ${stat(t('Errors'), String(session.errorsEncountered ?? 0))}
      ${stat(t('Trigger'), formatTriggerSource(session.triggerSource))}
      ${stat(t('Started'), esc(formatDateShort(session.startedAt)), session.startedAt ? esc(formatRelativeTime(session.startedAt)) : '')}
      ${stat(t('Duration'), esc(formatDuration(session.startedAt, session.completedAt)))}
      ${(session.screenshotsTaken ?? 0) > 0 ? stat(t('Screenshots'), String(session.screenshotsTaken)) : ''}
    </div>`;

  content.innerHTML = `<div class="sess-page">
      ${actions}
      <div class="ui-grid">
        ${tileHtml('sess-scan', t('Scan #{id}', { id: session.id }), `${errorBanner}${stats}`, { span: 12 })}
        ${rewardsTileHtml(rewards, items ?? {})}
      </div>
      ${chestsBlock}
    </div>`;

  if (hasTriumphals) {
    const box = content.querySelector('.sess-chests');
    box?.addEventListener('click', (ev) => {
      const btn = ev.target instanceof Element ? ev.target.closest('button[data-session-tab]') : null;
      if (!btn) return;
      const next = btn.dataset.sessionTab;
      box.querySelectorAll('button[data-session-tab]').forEach((b) => {
        const on = b.dataset.sessionTab === next;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-pressed', String(on));
      });
      box.querySelectorAll('[data-session-panel]').forEach((panel) => {
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
