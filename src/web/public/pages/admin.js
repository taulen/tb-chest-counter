// Admin — content-management page for admins/superadmins, split into tabs
// (one route each, like Tools): #admin/<tab>.
//
//   review  — only while something needs attention: the OCR-missing-player-name
//             reassignment workflow with hover-preview of the saved debug crops,
//             the review queue (newly-discovered chest names / sources /
//             members, likely renames) and resource rows whose icon couldn't be
//             identified (unresolved-resources.js).
//   members — levels from chat, member rename + delete, player merge rules.
//   chests  — chest-name and chest-source merge rules.
//   points  — the Chest Points board (points-board.js) and Triumphal Chest Points.
//
// Bare #admin lands on Review while it has anything, else on Members. Each tab
// fetches only what it renders. Actions re-render with `rerender()` — no page
// argument — so the router redraws whichever tab is showing.
//
// Per-clan settings (Discord, ChestTracker, login bridge) live on the
// Clans page; instance-wide settings (scan interval, calibration,
// container restart, backups) live on the System page. This page is
// pure data-correction.

import { api, apiPost, apiPut, apiDelete, mustOk } from '../lib/api.js';
import {
  $, esc, formatDate, formatGameDayShort, memberLink, memberHash,
  notify, confirmDialog, contentModal,
} from '../lib/ui.js';
import { getCurrentUser } from '../lib/state.js';
import { t, tn, tGame } from '../lib/i18n.js';
import { mountPointsBoard } from './points-board.js';
import { mountMemberLevels } from './member-levels.js';
import {
  loadUnresolvedResources, unresolvedResourcesSectionHtml, wireUnresolvedResources,
} from './unresolved-resources.js';

/**
 * A `<option>` for a merge / reassign dropdown, suffixed with how many chest
 * records sit behind the value.
 *
 * Without the count these lists are flat alphabetical name soup, and nothing
 * distinguishes a real player or chest from an OCR misread of one — which is
 * exactly what the operator is here to find. Three records next to four
 * thousand is the tell. `0 chests` is spelled out rather than omitted so a
 * name carrying no data at all is just as obvious as a name carrying almost
 * none.
 */
function countedOption(value, count) {
  const n = Number(count) || 0;
  return `<option value="${esc(value)}">${esc(value)} (${tn(n, '{n} chest', '{n} chests')})</option>`;
}

const ADMIN_TABS = ['review', 'members', 'chests', 'points'];

/**
 * Everything the Admin nav dot counts, or null when nav-status failed. The
 * Review tab, its count and the dot all read this one number, so a tab can
 * never claim work the dot doesn't (or the reverse).
 */
function attentionCount(navStatus) {
  const a = navStatus?.admin;
  if (!a) return null;
  return (a.reviewQueueCount ?? 0) + (a.unknownChestsCount ?? 0) + (a.unresolvedResourceCount ?? 0);
}

/**
 * Same segmented bar and link-per-tab routing as Tools. Review is only shown
 * while it has something — or when it is the open tab, so the bar still says
 * where you are after its last item is cleared. A failed count (null) keeps it
 * visible rather than hiding work.
 */
function adminTabsHtml(active, count) {
  const tabs = [];
  if (count !== 0 || active === 'review') {
    tabs.push({
      key: 'review',
      label: count > 0
        ? `${t('Review ({count})', { count })}<span class="nav-dot" aria-hidden="true"></span>`
        : t('Review'),
    });
  }
  tabs.push(
    { key: 'members', label: t('Members') },
    { key: 'chests', label: t('Chests') },
    { key: 'points', label: t('Points') },
  );
  return `<div class="resources-tabs admin-tabs" role="tablist" aria-label="${esc(t('Page sections'))}">${tabs.map(({ key, label }) => {
    const on = key === active;
    // One wrapper so a label that wraps on a phone keeps Review's dot inline
    // after its count instead of becoming a flex item on a line of its own.
    return `<a class="resources-tab${on ? ' is-active' : ''}" href="#admin/${key}" role="tab" aria-selected="${on}"><span>${label}</span></a>`;
  }).join('')}</div>`;
}

/** Log a mount failure unless it is a sign-out or a navigation abort. */
function reportMountError(err) {
  if (err?.name !== 'UnauthenticatedError' && err?.name !== 'AbortError') console.error(err);
}

/**
 * @param {string} requested  the part of the route after `admin/` ('' for bare #admin)
 */
export async function renderAdmin(el, requested = '') {
  const currentUser = getCurrentUser();
  if (currentUser?.role !== 'admin' && currentUser?.role !== 'superadmin') {
    el.innerHTML = `<div class="empty-state"><p>${t('Admin access required.')}</p></div>`;
    return;
  }
  // Chest Points are per clan (the active clan's board); Triumphal Chest Points
  // are one global table. Any admin can view them, but only superadmins can edit.
  const isSuperadmin = currentUser?.role === 'superadmin';

  // nav-status drives the tab bar (whether Review shows, and its count) and the
  // Review tab's unresolved resource-row section. Started first and shared, so
  // an explicit tab never waits on it before fetching its own data. Tolerated as
  // null so a transient failure costs the count, not the page.
  const navStatusP = api('/admin/nav-status').catch(() => null);
  let tab = ADMIN_TABS.includes(requested) ? requested : '';
  if (!tab) tab = attentionCount(await navStatusP) === 0 ? 'members' : 'review';

  let body;
  if (tab === 'review') body = await reviewTab(navStatusP);
  else if (tab === 'members') body = await membersTab();
  else if (tab === 'chests') body = await chestsTab();
  else body = await pointsTab(isSuperadmin);

  el.innerHTML = `${adminTabsHtml(tab, attentionCount(await navStatusP))}${body.html}`;
  body.wire?.(el);
}

/** OCR-missing player names, the review queue and unresolved resource rows. */
async function reviewTab(navStatusP) {
  const [reviewQueue, unknownChests, unresolvedResources] = await Promise.all([
    api('/admin/review-queue'),
    api('/admin/unknown-chests'),
    // Rows + resource list only when the count says there is something to resolve.
    navStatusP.then((s) => loadUnresolvedResources(s?.admin?.unresolvedResourceCount)),
  ]);

  // The reassign dropdowns need the roster and its chest counts, which only an
  // unread name calls for — most visits have none, and skip both reads.
  let unknownChestsHtml = '';
  if (Array.isArray(unknownChests) && unknownChests.length > 0) {
    const [members, memberChestCounts] = await Promise.all([
      api('/members?include=inactive'),
      api('/admin/member-chest-counts'),
    ]);
    const { activeMembers, chestCounts } = rosterFor(members, memberChestCounts);
    unknownChestsHtml = renderUnknownChestsSection(unknownChests, activeMembers, chestCounts);
  }

  const html = `${unknownChestsHtml}${renderReviewQueueSection(reviewQueue)}${unresolvedResourcesSectionHtml(unresolvedResources)}`;
  return {
    html: html.trim() ? html : `<div class="empty-state"><p>${t('Nothing needs review right now.')}</p></div>`,
    wire: (el) => wireUnresolvedResources(el),
  };
}

/**
 * Members sorted by name and split active / removed, plus memberId → chest
 * count. Merge-player + rename dropdowns only target active members — merging
 * into a removed identity would silently resurrect them, which isn't what the
 * operator clicked.
 */
function rosterFor(members, memberChestCounts) {
  const sorted = [...(Array.isArray(members) ? members : [])]
    .sort((a, b) => (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase()));
  return {
    activeMembers: sorted.filter((m) => m.isActive !== false),
    removedMembers: sorted.filter((m) => m.isActive === false),
    // From its own admin route (see the comment there). Guarded because an
    // `{ error }` body would otherwise turn every count into NaN rather than
    // the honest 0.
    chestCounts: memberChestCounts && !memberChestCounts.error ? memberChestCounts : {},
  };
}

/** Levels from chat, Edit Members and Merge Player Names. */
async function membersTab() {
  const [members, memberChestCounts, stats, playerRules] = await Promise.all([
    api('/members?include=inactive'),
    api('/admin/member-chest-counts'),
    api('/stats'),
    api('/admin/merge-rules?type=player'),
  ]);
  // Edit Members lists active rows by default; the soft-deleted ones
  // hide behind a "Show removed members" toggle so the table doesn't
  // get cluttered.
  const { activeMembers, removedMembers, chestCounts } = rosterFor(members, memberChestCounts);
  const memberOption = (m) => countedOption(m.name, chestCounts[m.id]);

  const html = `
    <p class="page-section-intro">${t('Edit names, delete duplicates, and merge OCR misreads into the correct player.')}</p>

    <!-- Levels from chat: self-contained, fills itself (pages/member-levels.js). -->
    <div class="card" id="memberLevels"></div>

    <div class="card">
      <div class="card-header"><h2>${t('Edit Members ({count})', { count: activeMembers.length })}</h2></div>
      <div class="card-body card-body-padded">
        <details ${stats.totalSessions === 0 ? 'open' : ''}>
          <summary class="collapse-toggle">${t('Show member list')}</summary>
          <p class="muted-copy mtb-12">${t('Rename or remove members. Removing a player who has chest history keeps their existing records but excludes them from future scans — useful when a player leaves so a new player with a similar name can\'t accidentally be matched into their identity.')}</p>
          <table class="table-responsive">
            <thead><tr><th>${t('Current Name')}</th><th class="col-edit">${t('New Name')}</th><th class="col-actions"></th></tr></thead>
            <tbody>
              ${activeMembers.map((m) => `<tr id="member-row-${m.id}">
                <td data-label="${t('Current')}" data-role="primary"><span class="mrow-name">${memberLink(m.id, m.name)}</span></td>
                <td data-label="${t('New Name')}"><input type="text" class="input input-member" value="${esc(m.name)}" id="member-name-${m.id}"></td>
                <td class="col-actions nowrap">
                  <button class="btn btn-tight" data-action="save-member" data-member-id="${m.id}">${t('Save')}</button>
                  <button class="btn btn-tight btn-danger ml-4" data-action="delete-member" data-member-id="${m.id}" data-member-name="${esc(m.name)}">${t('Remove')}</button>
                </td>
              </tr>`).join('')}
            </tbody>
          </table>
        </details>
        ${removedMembers.length > 0 ? `<details class="mt-12">
          <summary class="collapse-toggle">${t('Show removed members ({count})', { count: removedMembers.length })}</summary>
          <p class="muted-copy mtb-12">${t('Players excluded from scan matching. Their chest history is intact. Restore one if it was removed by mistake or the player rejoined the clan.')}</p>
          <table class="table-responsive">
            <thead><tr><th>${t('Name')}</th><th class="col-date">${t('Last Seen')}</th><th class="col-actions"></th></tr></thead>
            <tbody>
              ${removedMembers.map((m) => `<tr id="member-row-${m.id}">
                <td data-label="${t('Name')}" data-role="primary"><span class="mrow-name">${memberLink(m.id, m.name)}</span></td>
                <td data-label="${t('Last Seen')}" data-role="metric">${formatDate(m.lastSeen)}</td>
                <td class="col-actions nowrap">
                  <button class="btn btn-tight btn-primary" data-action="restore-member" data-member-id="${m.id}" data-member-name="${esc(m.name)}">${t('Restore')}</button>
                </td>
              </tr>`).join('')}
            </tbody>
          </table>
        </details>` : ''}
      </div>
    </div>

    <div class="card">
      <div class="card-header"><h2>${t('Merge Player Names')}</h2></div>
      <div class="card-body card-body-padded">
        <p class="muted-copy mb-12">${t('Fix OCR name variations. Updates existing records and auto-corrects future scans.')}</p>
        <div class="inline-form-row">
          <div>
            <label>${t('OCR Misread')}</label>
            <select id="mergePlayerFrom" class="input">
              <option value="">${t('Select...')}</option>
              ${activeMembers.map(memberOption).join('')}
            </select>
          </div>
          <span class="arrow-sep">→</span>
          <div>
            <label>${t('Correct Name')}</label>
            <select id="mergePlayerTo" class="input">
              ${playerMergeOptionsHtml(activeMembers, chestCounts)}
            </select>
          </div>
          <button class="btn btn-primary" data-action="do-merge-player">${t('Merge')}</button>
        </div>
        ${playerMergeCustomHtml('mergePlayerToCustom', { className: 'mb-16' })}
        ${playerRules.length > 0 ? `<details>
          <summary class="collapse-toggle">${tn(playerRules.length, '{n} active player merge rule', '{n} active player merge rules', { n: playerRules.length })}</summary>
          <table class="table-responsive merge-rules-table">
            <colgroup>
              <col class="col-merge-from">
              <col class="col-merge-to">
              <col class="col-merge-created">
              <col class="col-actions">
            </colgroup>
            <thead><tr><th>${t('From')}</th><th>${t('To')}</th><th>${t('Created')}</th><th></th></tr></thead>
            <tbody>
              ${playerRules.map((r) => `<tr>
                <td data-label="${t('From')}" data-role="primary"><span class="mrow-name">${esc(r.fromValue)}</span><span class="mrow-sub">→ ${esc(r.toValue)}</span></td>
                <td data-label="${t('To')}" data-role="hidden">${esc(r.toValue)}</td>
                <td data-label="${t('Created')}">${formatDate(r.createdAt)}</td>
                <td class="col-actions"><button class="btn btn-tight btn-danger" data-action="delete-rule" data-rule-id="${r.id}">${t('Delete')}</button></td>
              </tr>`).join('')}
            </tbody>
          </table>
        </details>` : `<p class="muted-copy">${t('No active player merge rules.')}</p>`}
      </div>
    </div>
  `;
  return {
    html,
    wire: (el) => {
      const memberLevelsEl = el.querySelector('#memberLevels');
      if (memberLevelsEl) mountMemberLevels(memberLevelsEl).catch(reportMountError);
    },
  };
}

/** Merge Chest Names and Merge Chest Sources. */
async function chestsTab() {
  const [chestRules, sourceRules, chestTypes, chestSources] = await Promise.all([
    api('/admin/merge-rules?type=chest'),
    api('/admin/merge-rules?type=source'),
    api('/admin/unique-chests'),
    api('/admin/unique-sources'),
  ]);

  const html = `
    <div class="card">
      <div class="card-header"><h2>${t('Merge Chest Names')}</h2></div>
      <div class="card-body card-body-padded">
        <p class="muted-copy mb-12">${t('Map OCR misreads to the correct chest name. Applies to existing records and future scans.')}</p>
        <div class="inline-form-row">
          <div>
            <label>${t('OCR Misread')}</label>
            <select id="mergeChestFrom" class="input">
              <option value="">${t('Select...')}</option>
              ${chestTypes.map((c) => countedOption(c.name, c.count)).join('')}
            </select>
          </div>
          <span class="arrow-sep">→</span>
          <div>
            <label>${t('Correct Name')}</label>
            <select id="mergeChestTo" class="input">
              <option value="">${t('Select...')}</option>
              ${chestTypes.map((c) => countedOption(c.name, c.count)).join('')}
            </select>
          </div>
          <button class="btn btn-primary" data-action="do-merge-chest">${t('Merge')}</button>
        </div>
        <div class="merge-custom-row mb-16">
          <label for="mergeChestToCustom">${t('Or type a custom Correct Name (overrides the dropdown above)')}</label>
          <input type="text" id="mergeChestToCustom" class="input" placeholder="${t('Custom name…')}">
        </div>
        ${chestRules.length > 0 ? `<details>
          <summary class="collapse-toggle">${tn(chestRules.length, '{n} active chest merge rule', '{n} active chest merge rules', { n: chestRules.length })}</summary>
          <table class="table-responsive merge-rules-table">
            <colgroup>
              <col class="col-merge-from">
              <col class="col-merge-to">
              <col class="col-merge-created">
              <col class="col-actions">
            </colgroup>
            <thead><tr><th>${t('From')}</th><th>${t('To')}</th><th>${t('Created')}</th><th></th></tr></thead>
            <tbody>
              ${chestRules.map((r) => `<tr>
                <td data-label="${t('From')}" data-role="primary"><span class="mrow-name">${esc(r.fromValue)}</span><span class="mrow-sub">→ ${esc(r.toValue)}</span></td>
                <td data-label="${t('To')}" data-role="hidden">${esc(r.toValue)}</td>
                <td data-label="${t('Created')}">${formatDate(r.createdAt)}</td>
                <td class="col-actions"><button class="btn btn-tight btn-danger" data-action="delete-rule" data-rule-id="${r.id}">${t('Delete')}</button></td>
              </tr>`).join('')}
            </tbody>
          </table>
        </details>` : `<p class="muted-copy">${t('No active chest merge rules.')}</p>`}
      </div>
    </div>

    <div class="card">
      <div class="card-header"><h2>${t('Merge Chest Sources')}</h2></div>
      <div class="card-body card-body-padded">
        <p class="muted-copy mb-12">${t('Map OCR misreads to the correct source string (e.g. "Level 5 Crypt." → "Level 5 Crypt"). Applies to existing records and future scans.')}</p>
        <div class="inline-form-row">
          <div>
            <label>${t('OCR Misread')}</label>
            <select id="mergeSourceFrom" class="input">
              <option value="">${t('Select...')}</option>
              ${chestSources.map((s) => countedOption(s.source, s.count)).join('')}
            </select>
          </div>
          <span class="arrow-sep">→</span>
          <div>
            <label>${t('Correct Source')}</label>
            <select id="mergeSourceTo" class="input">
              <option value="">${t('Select...')}</option>
              ${chestSources.map((s) => countedOption(s.source, s.count)).join('')}
            </select>
          </div>
          <button class="btn btn-primary" data-action="do-merge-source">${t('Merge')}</button>
        </div>
        <div class="merge-custom-row mb-16">
          <label for="mergeSourceToCustom">${t('Or type a custom Correct Source (overrides the dropdown above)')}</label>
          <input type="text" id="mergeSourceToCustom" class="input" placeholder="${t('Custom source…')}">
        </div>
        ${sourceRules.length > 0 ? `<details>
          <summary class="collapse-toggle">${tn(sourceRules.length, '{n} active source merge rule', '{n} active source merge rules', { n: sourceRules.length })}</summary>
          <table class="table-responsive merge-rules-table">
            <colgroup>
              <col class="col-merge-from">
              <col class="col-merge-to">
              <col class="col-merge-created">
              <col class="col-actions">
            </colgroup>
            <thead><tr><th>${t('From')}</th><th>${t('To')}</th><th>${t('Created')}</th><th></th></tr></thead>
            <tbody>
              ${sourceRules.map((r) => `<tr>
                <td data-label="${t('From')}" data-role="primary"><span class="mrow-name">${esc(r.fromValue)}</span><span class="mrow-sub">→ ${esc(r.toValue)}</span></td>
                <td data-label="${t('To')}" data-role="hidden">${esc(r.toValue)}</td>
                <td data-label="${t('Created')}">${formatDate(r.createdAt)}</td>
                <td class="col-actions"><button class="btn btn-tight btn-danger" data-action="delete-rule" data-rule-id="${r.id}">${t('Delete')}</button></td>
              </tr>`).join('')}
            </tbody>
          </table>
        </details>` : `<p class="muted-copy">${t('No active source merge rules.')}</p>`}
      </div>
    </div>
  `;
  return { html };
}

/** The Chest Points board and Triumphal Chest Points. */
async function pointsTab(isSuperadmin) {
  const triumphalPoints = await api('/admin/triumphal-points');
  const html = `
    <!-- Chest Points: self-contained, fills itself (pages/points-board.js). -->
    <div class="card pb-card" id="pointsBoard"></div>

    ${renderTriumphalPointsSection(triumphalPoints, isSuperadmin)}
  `;
  return {
    html,
    wire: (el) => {
      // Not awaited: the board loads its own data, so the rest of the tab is
      // usable while it does.
      const pointsBoardEl = el.querySelector('#pointsBoard');
      if (pointsBoardEl) mountPointsBoard(pointsBoardEl, { isSuperadmin }).catch(reportMountError);
    },
  };
}

// ─── Action handlers ───
//
// Re-renders go through the `rerender` callback the dispatcher injects (the
// router's loadPage) so this module never has to import it from app.js (would
// be a circular dep). Called with no page, it redraws the current route — the
// Admin tab the action was taken on.

// ─── Player merge: one form, two hosts ───
// The Merge Player Names card here and the Merge dialog on the Members page
// render the same pieces and submit through submitPlayerMerge, so a change
// below lands on both.

/** Dropdown options for a merge target: every active member with their chest count. */
function playerMergeOptionsHtml(members, counts, exclude = null) {
  return `<option value="">${t('Select...')}</option>${members
    .filter((m) => m.name !== exclude)
    .map((m) => countedOption(m.name, counts[m.id]))
    .join('')}`;
}

function playerMergeCustomHtml(id, { className = '', inputClass = 'input', value = '' } = {}) {
  return `<div class="merge-custom-row ${className}">
    <label for="${id}">${t('Or type a custom Correct Name (overrides the dropdown above)')}</label>
    <input type="text" id="${id}" class="${inputClass}" placeholder="${t('Custom name…')}" value="${esc(value)}">
  </div>`;
}

/**
 * Picking a player copies the name into the text field, so the field always
 * shows the name that will be used and typing over it is the override its
 * label promises. The dropdown used to win silently over anything typed.
 */
export function syncPlayerMergeCustom(select, custom) {
  if (select?.value && custom) custom.value = select.value;
}

function playerMergeTarget(select, custom) {
  return (custom?.value || '').trim() || select?.value || '';
}

/** Validate, merge, run `afterMerge` (the rerender), then report. True on success. */
async function submitPlayerMerge(fromName, toName, afterMerge) {
  if (!fromName || !toName) { notify(t('Select both players'), t('Cannot merge')); return false; }
  if (fromName === toName) { notify(t('Cannot merge a player with itself'), t('Cannot merge')); return false; }
  const result = await apiPost('/admin/merge-players', { fromName, toName });
  if (result?.error) { notify(result.error, t('Merge failed')); return false; }
  await afterMerge?.();
  // `note` is set when an existing rule already covered this spelling, so the rules
  // list won't have grown. Say so — silently not adding the row is what left admins
  // writing the same rule four times over.
  notify(
    `${t('Merged "{from}" into "{to}".', { from: fromName, to: toName })}${result?.note ? ` ${result.note}` : ''}`,
    t('Merge complete'),
  );
  return true;
}

export async function doMergePlayer(rerender) {
  const scrollY = window.scrollY;
  await submitPlayerMerge(
    $('#mergePlayerFrom').value,
    playerMergeTarget($('#mergePlayerTo'), $('#mergePlayerToCustom')),
    async () => {
      if (typeof rerender === 'function') await rerender();
      window.scrollTo(0, scrollY);
    },
  );
}

export async function doMergeChest(rerender) {
  const from = $('#mergeChestFrom').value;
  const to = $('#mergeChestTo').value || ($('#mergeChestToCustom')?.value || '').trim();
  if (!from || !to) return notify(t('Select both chest names'), t('Cannot merge'));
  if (from === to) return notify(t('Cannot merge a chest with itself'), t('Cannot merge'));
  const scrollY = window.scrollY;
  const result = await apiPost('/admin/merge-rules', { type: 'chest', fromValue: from, toValue: to });
  if (result?.error) return notify(result.error, t('Merge failed'));
  if (typeof rerender === 'function') await rerender();
  window.scrollTo(0, scrollY);
  notify(t('Merged "{from}" into "{to}".', { from, to }), t('Merge complete'));
}

export async function doMergeSource(rerender) {
  const from = $('#mergeSourceFrom').value;
  const to = $('#mergeSourceTo').value || ($('#mergeSourceToCustom')?.value || '').trim();
  if (!from || !to) return notify(t('Select both source values'), t('Cannot merge'));
  if (from === to) return notify(t('Cannot merge a source with itself'), t('Cannot merge'));
  const scrollY = window.scrollY;
  const result = await apiPost('/admin/merge-rules', { type: 'source', fromValue: from, toValue: to });
  if (result?.error) return notify(result.error, t('Merge failed'));
  if (typeof rerender === 'function') await rerender();
  window.scrollTo(0, scrollY);
  notify(t('Merged "{from}" into "{to}".', { from, to }), t('Merge complete'));
}

// Triumphal Chest Points — global, superadmin-managed scoring for the
// Bank Gifts tab (the per-chest sibling of the Chest Points card). `rows` come from
// GET /admin/triumphal-points: every configured chest plus any chest
// observed in scans but not yet valued (flagged `isNew`, sorted first).
function renderTriumphalPointsSection(rows, isSuperadmin) {
  const list = rows || [];
  const hasNew = list.some((row) => row.isNew);
  return `
    <div class="card">
      <div class="card-header"><h2>${t('Triumphal Chest Points')}</h2></div>
      <div class="card-body card-body-padded">
        <p class="muted-copy mb-12">${t('One <strong>global scoring table</strong> for the <strong>Bank Gifts</strong> tab, tracked separately from the main leaderboard. Each value is the <strong>package price</strong> (a full 3-of-a-kind set); a single chest is worth one third of it, rounded — so three of a kind sum back to exactly the package value. Rows tagged {new} have been seen in scans but have <strong>no value yet</strong> (they score 0) — set a value to score them.', { new: `<span class="chest-type epic">${t('New')}</span>` })} ${isSuperadmin ? t('Managed here by superadmins; values apply to every clan.') : t('<strong>Read-only</strong> — only a superadmin can change these values.')}</p>
        ${list.length > 0 ? `
          <details${hasNew ? ' open' : ''}>
            <summary class="collapse-toggle">${t('Show triumphal chest values ({count})', { count: list.length })}</summary>
            <table class="table-responsive mt-12">
              <thead><tr><th>${t('Chest')}</th><th>${t('Chests Seen')}</th><th>${t('Per Chest')}</th><th>${t('Package (3-of-a-kind)')}</th></tr></thead>
              <tbody>
                ${list.map((row) => `<tr${row.isNew ? ' class="row-needs-attention"' : ''}>
                  <td data-label="${t('Chest')}" data-role="primary"><span class="mrow-name">${esc(tGame(row.chestName))}${row.isNew ? ` <span class="chest-type epic" title="${t('Seen in scans but has no point value yet — it currently scores 0. Set a package value to score it.')}">${t('New')}</span>` : ''}</span><span class="mrow-sub">${tn(row.observedCount, '{n} seen', '{n} seen', { n: row.observedCount })}</span></td>
                  <td data-label="${t('Chests Seen')}" data-role="hidden">${row.observedCount}</td>
                  <td data-label="${t('Per Chest')}" data-role="metric">${row.perChestPoints ?? '—'}</td>
                  <td data-label="${t('Package (3-of-a-kind)')}">
                    <input type="number" class="input input-narrow triumphal-points-input" min="0" step="1" value="${row.packagePoints ?? ''}" placeholder="0" data-chest-name="${esc(row.chestName)}" data-original-package="${row.packagePoints ?? ''}"${isSuperadmin ? '' : ' disabled'}>
                  </td>
                </tr>`).join('')}
              </tbody>
            </table>
            ${isSuperadmin ? `<div class="inline-form-row mt-16">
              <button class="btn btn-primary" data-action="save-all-triumphal-points">${t('Save All Changes')}</button>
            </div>
            <p class="muted-copy mt-8">${t('Saves every chest whose package value changed. Clear an input to remove that chest\'s value — it reverts to "new" and scores 0 until set again. Points are presentation-only, so no historical backfill is needed.')}</p>` : ''}
          </details>
        ` : `<p class="muted-copy mt-12">${t('No triumphal chest data yet.')}</p>`}
      </div>
    </div>
  `;
}

export async function saveAllTriumphalPoints(rerender) {
  const inputs = document.querySelectorAll('input.triumphal-points-input');
  if (inputs.length === 0) return;

  // Changed rows only. Empty value with a previous value = clear (DELETE,
  // reverts the chest to "new"). Filled value different from original =
  // set it (PUT).
  const toSet = [];
  const toDelete = [];
  for (const input of inputs) {
    const chestName = input.dataset.chestName;
    const original = input.dataset.originalPackage || '';
    const current = input.value.trim();
    if (current === original) continue;
    if (current === '') {
      toDelete.push({ chestName });
    } else {
      const packagePoints = Number.parseInt(current, 10);
      if (!Number.isFinite(packagePoints) || packagePoints < 0) {
        return notify(t('"{chest}" must be a non-negative integer', { chest: tGame(chestName) }), t('Save failed'));
      }
      toSet.push({ chestName, packagePoints });
    }
  }

  if (toSet.length === 0 && toDelete.length === 0) {
    return notify(t('No changes to save.'), t('Nothing to do'));
  }

  const scrollY = window.scrollY;
  const errors = [];
  for (const entry of toSet) {
    const result = await apiPut('/admin/triumphal-points', { chestName: entry.chestName, packagePoints: entry.packagePoints });
    if (result?.error) errors.push(`${entry.chestName}: ${result.error}`);
  }
  for (const entry of toDelete) {
    const result = await apiDelete(`/admin/triumphal-points?chestName=${encodeURIComponent(entry.chestName)}`);
    if (result?.error) errors.push(`${entry.chestName}: ${result.error}`);
  }

  if (typeof rerender === 'function') await rerender();
  window.scrollTo(0, scrollY);

  if (errors.length > 0) {
    notify(t('Some changes failed:\n{errors}', { errors: errors.join('\n') }), t('Partial save'));
  } else {
    notify(tn(toSet.length + toDelete.length, 'Saved {n} change.', 'Saved {n} changes.', { n: toSet.length + toDelete.length }), t('Saved'));
  }
}

function renderReviewQueueSection(queue) {
  if (!queue) return '';
  const groups = [
    { key: 'chest_name', label: t('New Chest Names'), entries: queue.chestNames?.entries || [], ack: queue.chestNames?.acknowledgedAt || null, valueHeader: t('Chest Name') },
    { key: 'chest_source', label: t('New Chest Sources'), entries: queue.chestSources?.entries || [], ack: queue.chestSources?.acknowledgedAt || null, valueHeader: t('Source') },
    { key: 'member', label: t('New Members'), entries: queue.members?.entries || [], ack: queue.members?.acknowledgedAt || null, valueHeader: t('Member') },
    // Triumphal (Bank) chests with no configured value. No Acknowledge —
    // resolved by a superadmin assigning a package value in the Triumphal
    // Chest Points card on the Points tab (which removes them from this list).
    { key: 'triumphal', label: t('New Triumphal Chests'), entries: queue.triumphalChests?.entries || [], ack: null, valueHeader: t('Chest Name'), noAck: true },
  ];
  const activeGroups = groups.filter((g) => g.entries.length > 0);
  const renames = queue.renames?.entries || [];
  const totalNew = activeGroups.reduce((sum, g) => sum + g.entries.length, 0) + renames.length;
  if (totalNew === 0) return '';

  return `
    <h2 class="page-section-title">${t('Review Queue')} <span class="chest-type epic">${tn(totalNew, '{n} new', '{n} new', { n: totalNew })}</span></h2>
    <p class="page-section-intro">${t('Recently-discovered chest names, sources, and members. Skim for OCR misspellings or unknown source types that need a point value. Click <strong>Acknowledge</strong> once reviewed to clear the list.')}</p>
    ${renderRenameSuggestions(renames)}
    ${activeGroups.map((g) => `
      <div class="card">
        <div class="card-header">
          <h2>${g.label} (${g.entries.length})</h2>
        </div>
        <div class="card-body card-body-padded">
          <details open>
            <summary class="collapse-toggle">${tn(g.entries.length, 'Show {n} new entry', 'Show {n} new entries', { n: g.entries.length })}</summary>
            <table class="table-responsive mt-12">
              <thead><tr>
                <th>${g.valueHeader}</th><th>${t('First Seen')}</th><th>${t('Chests')}</th>
                ${g.key === 'member' ? `<th>${t('Row')}</th>` : ''}
              </tr></thead>
              <tbody>
                ${g.entries.map((e) => `<tr>
                  <td data-label="${g.valueHeader}" data-role="primary"><span class="mrow-name">${esc(e.value)}</span></td>
                  <td data-label="${t('First Seen')}" class="muted-copy">${formatDate(e.firstSeen)}</td>
                  <td data-label="${t('Chests')}" data-role="metric">${e.count}</td>
                  ${g.key === 'member' ? `<td data-label="${t('Row')}">${e.hasCrop && e.memberId
                    ? `<span class="unknown-crop-hover" data-crop-url="/api/admin/members/${e.memberId}/crop" data-crop-wide tabindex="0" role="button" title="${t('Hover to preview the screenshot this member was first seen in — click to enlarge')}">🖼️</span>`
                    : '<span class="muted-copy">—</span>'}</td>` : ''}
                </tr>`).join('')}
              </tbody>
            </table>
          </details>
          ${g.noAck
            ? `<p class="muted-copy mt-12">${t('Assign each a package value under {link} on the Points tab — that scores them and clears them from this list.', { link: `<a href="#admin/points">${t('Triumphal Chest Points')}</a>` })}</p>`
            : `<div class="inline-form-row mt-12">
            <button class="btn" data-action="acknowledge-review" data-review-category="${g.key}">${t('Acknowledge')}</button>
          </div>
          <p class="muted-copy mt-8">${g.ack ? t('Last acknowledged: {date}', { date: formatDate(g.ack) }) : t('Never acknowledged — all entries are shown.')}</p>`}
        </div>
      </div>
    `).join('')}
  `;
}

/**
 * Likely in-game renames: one member's might readings stop and another's start the
 * next day, under the same name with a tag added or dropped or at the same level and
 * might (rename-suggestions-repo.ts). Each pair is
 * resolved on its own — merged, or marked as two different players — so there is no
 * Acknowledge here.
 */
function renderRenameSuggestions(entries) {
  if (entries.length === 0) return '';
  // One decimal of millions is what the comparison needs (488.2M → 490.4M); the
  // exact readings sit in the tooltip.
  const might = (side) => `<span class="nowrap" title="${Number(side.power).toLocaleString()}">${t('Lv {level}', { level: side.level })} · ${(side.power / 1e6).toFixed(1)}M</span>`;
  // No bulk merge: each pair is merged on its own, by a person. A "Merge all" here
  // once folded 41 hand-set names into misread twins (Nov 2026) — a merge keeps the
  // NEW name, and a batch of near-identical pairs is as likely a read defect as a
  // rename.
  return `
    <div class="card">
      <div class="card-header">
        <h2>${t('Likely Renames')} (${entries.length})</h2>
      </div>
      <div class="card-body card-body-padded">
        <p class="muted-copy mb-12">${t('One name stopped being read the day before a new one appeared: the same name with a tag added or dropped, or a different name at the same level and might. That is usually an in-game rename, which splits a player\'s chest history across two names. Merge to fold the old name into the new one.')}</p>
        <table class="table-responsive">
          <thead><tr>
            <th>${t('Old Name')}</th><th>${t('New Name')}</th><th>${t('Switched')}</th><th>${t('Might (last → first)')}</th><th>${t('Chests')}</th><th class="col-actions"></th>
          </tr></thead>
          <tbody>
            ${entries.map((r) => `<tr>
              <td data-label="${t('Old Name')}" data-role="primary"><span class="mrow-name">${memberLink(r.from.memberId, r.from.name)}</span><span class="mrow-sub">→ ${memberLink(r.to.memberId, r.to.name)}</span></td>
              <td data-label="${t('New Name')}" data-role="hidden">${memberLink(r.to.memberId, r.to.name)}</td>
              <td data-label="${t('Switched')}" class="muted-copy nowrap">${formatGameDayShort(r.from.gameDate)} → ${formatGameDayShort(r.to.gameDate)}</td>
              <td data-label="${t('Might (last → first)')}" class="muted-copy"><span>${might(r.from)} → ${might(r.to)} <span class="nowrap">(${r.powerChangePct >= 0 ? '+' : ''}${r.powerChangePct}%)</span></span></td>
              <td data-label="${t('Chests')}" data-role="metric" class="nowrap">${r.from.chests} + ${r.to.chests}</td>
              <td class="col-actions nowrap">
                <button class="btn btn-tight btn-primary" data-action="merge-rename" data-from-name="${esc(r.from.name)}" data-to-name="${esc(r.to.name)}" data-from-chests="${r.from.chests}">${t('Merge')}</button>
                <button class="btn btn-tight ml-4" data-action="dismiss-rename" data-from-id="${r.from.memberId}" data-to-id="${r.to.memberId}">${t('Not the same player')}</button>
              </td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

export async function mergeRenameSuggestion(fromName, toName, fromChests, rerender) {
  const ok = await confirmDialog(
    tn(fromChests, 'Merge "{from}" into "{to}"? Its {n} chest, might history and resources move to "{to}", and future scans that read "{from}" count for "{to}".', 'Merge "{from}" into "{to}"? Its {n} chests, might history and resources move to "{to}", and future scans that read "{from}" count for "{to}".', { from: esc(fromName), to: esc(toName), n: fromChests }),
    { title: t('Merge renamed player'), confirmLabel: t('Merge') },
  );
  if (!ok) return;
  const scrollY = window.scrollY;
  await submitPlayerMerge(fromName, toName, async () => {
    if (typeof rerender === 'function') await rerender();
    window.scrollTo(0, scrollY);
  });
}

export async function dismissRenameSuggestion(fromMemberId, toMemberId, rerender) {
  if (!await mustOk(apiPost('/admin/rename-suggestions/dismiss', { fromMemberId, toMemberId }), t('Dismiss failed'))) return;
  const scrollY = window.scrollY;
  if (typeof rerender === 'function') await rerender();
  window.scrollTo(0, scrollY);
}

export async function acknowledgeReviewQueue(category, rerender) {
  const result = await apiPost('/admin/review-queue/acknowledge', { category });
  if (result?.error) return notify(result.error, t('Acknowledge failed'));
  const scrollY = window.scrollY;
  if (typeof rerender === 'function') await rerender();
  window.scrollTo(0, scrollY);
}

function renderUnknownChestsSection(chests, members, chestCounts) {
  if (!Array.isArray(chests) || chests.length === 0) return '';

  // Group by session so the operator can correlate with the debug crop
  // screenshots saved to data/screenshots/ocr_missing_name/ (file names
  // include the session id).
  const bySession = new Map();
  for (const c of chests) {
    if (!bySession.has(c.sessionId)) bySession.set(c.sessionId, []);
    bySession.get(c.sessionId).push(c);
  }
  const sessionIds = [...bySession.keys()].sort((a, b) => b - a);

  const counts = chestCounts || {};
  const memberOptions = members
    .map((m) => countedOption(m.name, counts[m.id]))
    .join('');

  const sections = sessionIds.map((sid) => {
    const rows = bySession.get(sid);
    return `
      <div class="card">
        <div class="card-header">
          <h2>${t('Session #{id}', { id: sid })} <span class="chest-type epic">${tn(rows.length, '{n} row', '{n} rows', { n: rows.length })}</span></h2>
        </div>
        <div class="card-body card-body-padded">
          <p class="muted-copy mb-12">${t('Debug crops for this session were saved to {dir} — filenames contain {file}. Open them to see which player each row belongs to, then reassign below.', { dir: '<code>data/screenshots/ocr_missing_name/</code>', file: `<code>s${sid}</code>` })}</p>
          <div class="inline-form-row mb-12">
            <div>
              <label>${t('Reassign ALL rows in this session to')}</label>
              <select class="input" id="unknownBulkMember-${sid}">
                <option value="">${t('Select member...')}</option>
                ${memberOptions}
              </select>
            </div>
            <button class="btn" data-action="reassign-unknown-bulk" data-session-id="${sid}">${t('Reassign All')}</button>
          </div>
          <table class="table-responsive">
            <thead><tr><th>${t('Received')}</th><th>${t('Chest')}</th><th>${t('Source')}</th><th>${t('Pts')}</th><th>${t('Crop')}</th><th class="col-edit">${t('Reassign To')}</th><th class="col-actions"></th></tr></thead>
            <tbody>
              ${rows.map((r) => `<tr id="unknown-row-${r.id}">
                <td data-label="${t('Received')}" class="muted-copy">${formatDate(r.effectiveAt)}</td>
                <td data-label="${t('Chest')}" data-role="primary"><span class="mrow-name">${esc(tGame(r.chestName))}</span><span class="mrow-sub">${formatDate(r.effectiveAt)}</span></td>
                <td data-label="${t('Source')}" class="muted-copy">${esc(tGame(r.chestSource))}</td>
                <td data-label="${t('Pts')}" data-role="metric">${r.pointValue}</td>
                <td data-label="${t('Crop')}">${r.hasCrop
                  ? `<span class="unknown-crop-hover" data-crop-url="/api/admin/unknown-chests/${r.id}/crop" tabindex="0" role="button" title="${t('Hover to preview — click to open a zoomable full-size view')}">🖼️ ${t('view')}</span>`
                  : `<span class="muted-copy">—</span>`}</td>
                <td data-label="${t('Reassign To')}">
                  <select class="input" id="unknownMember-${r.id}">
                    <option value="">${t('Select member...')}</option>
                    ${memberOptions}
                  </select>
                </td>
                <td class="col-actions nowrap">
                  <button class="btn btn-tight" data-action="reassign-unknown-row" data-chest-id="${r.id}">${t('Save')}</button>
                </td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }).join('');

  return `
    <h2 class="page-section-title">${t('OCR Missing Player Name')} <span class="chest-type epic">${tn(chests.length, '{n} row', '{n} rows', { n: chests.length })}</span></h2>
    <p class="page-section-intro">${t('These rows were saved with an empty or {unknown} player name because OCR couldn\'t read the name region. Reassign each row to the correct player — the row\'s <strong>Captured</strong> timestamp and the debug crop saved under {dir} for the matching session should tell you which player it belongs to.', { unknown: '<code>[Unknown]</code>', dir: '<code>data/screenshots/ocr_missing_name/</code>' })}</p>
    ${sections}
  `;
}

export async function reassignUnknownRow(chestId, rerender) {
  const select = document.getElementById(`unknownMember-${chestId}`);
  const memberName = (select?.value || '').trim();
  if (!memberName) return notify(t('Select a member from the dropdown first'), t('No member selected'));
  const result = await apiPost('/admin/unknown-chests/reassign', { chestIds: [chestId], memberName });
  if (result?.error) return notify(result.error, t('Reassign failed'));
  const scrollY = window.scrollY;
  if (typeof rerender === 'function') await rerender();
  window.scrollTo(0, scrollY);
}

export async function reassignUnknownBulk(sessionId, rerender) {
  const select = document.getElementById(`unknownBulkMember-${sessionId}`);
  const memberName = (select?.value || '').trim();
  if (!memberName) return notify(t('Select a member from the dropdown first'), t('No member selected'));
  // Scope to the card containing the clicked dropdown so we only grab
  // chest ids for this session, not every unknown row on the page.
  const card = select.closest('.card');
  const chestIds = [...(card?.querySelectorAll(`[data-action="reassign-unknown-row"]`) || [])]
    .map((btn) => Number.parseInt(btn.dataset.chestId || '0', 10))
    .filter((n) => n > 0);
  if (chestIds.length === 0) return notify(t('No rows found to reassign'), t('Nothing to do'));
  const ok = await confirmDialog(tn(chestIds.length, 'Reassign all {n} row in session #{session} to "{member}"?', 'Reassign all {n} rows in session #{session} to "{member}"?', { n: chestIds.length, session: sessionId, member: memberName }), {
    title: t('Confirm bulk reassign'),
    confirmLabel: t('Reassign'),
  });
  if (!ok) return;
  const result = await apiPost('/admin/unknown-chests/reassign', { chestIds, memberName });
  if (result?.error) return notify(result.error, t('Reassign failed'));
  const scrollY = window.scrollY;
  if (typeof rerender === 'function') await rerender();
  window.scrollTo(0, scrollY);
}

export async function deleteRule(id, rerender) {
  const ok = await confirmDialog(
    t('Delete this merge rule? Existing records that were already rewritten by this rule are not reverted, but future scans will stop auto-applying it.'),
    { title: t('Delete merge rule'), confirmLabel: t('Delete'), cancelLabel: t('Cancel'), danger: true },
  );
  if (!ok) return;
  if (!await mustOk(apiDelete(`/admin/merge-rules/${id}`), t('Delete rule failed'))) return;
  if (typeof rerender === 'function') rerender();
}

export async function saveMemberName(id) {
  const input = $(`#member-name-${id}`);
  if (!input) return;
  if (!await mustOk(apiPut(`/members/${id}`, { name: input.value }), t('Rename failed'))) return;
  // Update the display name in the row without full reload
  const row = $(`#member-row-${id}`);
  if (row) {
    const cell = row.querySelector('td');
    if (!cell) return;
    const anchor = document.createElement('a');
    anchor.className = 'member-link';
    anchor.href = memberHash(id);
    anchor.textContent = input.value || '';
    cell.replaceChildren(anchor);
  }
}

export async function deleteMemberById(id, name, rerender) {
  const label = name ? `"${name}"` : t('this member');
  const ok = await confirmDialog(
    t('Remove {member}? Their chest history stays intact, but they\'ll be excluded from future scans so a new player with a similar name can\'t get matched into their identity. You can restore them later under Admin → Members → "Show removed members".', { member: label }),
    { title: t('Remove member'), confirmLabel: t('Remove'), cancelLabel: t('Cancel'), danger: true },
  );
  if (!ok) return;
  if (!await mustOk(apiDelete(`/members/${id}`), t('Remove member failed'))) return;
  // Rerender so the row moves into the "Show removed members"
  // collapsible (always soft-deleted now, so it's always recoverable).
  if (rerender) rerender();
  else {
    const row = $(`#member-row-${id}`);
    if (row) row.remove();
  }
}

export async function restoreMemberById(id, name, rerender) {
  const label = name ? `"${name}"` : t('this member');
  const ok = await confirmDialog(
    t('Restore {member}? They\'ll be eligible for matching in future scans again.', { member: label }),
    { title: t('Restore member'), confirmLabel: t('Restore'), cancelLabel: t('Cancel') },
  );
  if (!ok) return;
  if (!await mustOk(apiPost(`/members/${id}/restore`, {}), t('Restore member failed'))) return;
  if (rerender) rerender();
}

/**
 * The Members page's Merge button: the Merge Player Names form in a dialog,
 * with the misread fixed to the row it was opened from. Like the card, the
 * text field starts on the misread so a casing fix is an edit, not a retype.
 */
export async function promptMergePlayerById(id, rerender) {
  const [members, counts] = await Promise.all([api('/members'), api('/admin/member-chest-counts')]);
  if (!Array.isArray(members)) return;
  const member = members.find((m) => m.id === id);
  if (!member?.name) return;
  const sorted = [...members].sort((a, b) => (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase()));

  const modal = contentModal({
    title: t('Merge Player'),
    html: `
      <p class="modal-body">${t('Merge "{name}" into which player name?', { name: esc(member.name) })}</p>
      <div class="modal-form">
        <label class="modal-form-label" for="mergeDialogTo">${t('Correct Name')}</label>
        <select id="mergeDialogTo" class="input modal-input">
          ${playerMergeOptionsHtml(sorted, counts && !counts.error ? counts : {}, member.name)}
        </select>
        ${playerMergeCustomHtml('mergeDialogToCustom', { inputClass: 'input modal-input', value: member.name })}
        <p class="modal-form-hint">${t('Fix OCR name variations. Updates existing records and auto-corrects future scans.')}</p>
      </div>
      <div class="modal-actions">
        <button class="btn" type="button" data-merge-dialog="cancel">${t('Cancel')}</button>
        <button class="btn btn-primary" type="button" data-merge-dialog="merge">${t('Merge')}</button>
      </div>`,
  });
  if (!modal) return;
  const root = modal.content;
  const select = root.querySelector('#mergeDialogTo');
  const custom = root.querySelector('#mergeDialogToCustom');
  const merge = async () => {
    const ok = await submitPlayerMerge(member.name, playerMergeTarget(select, custom), async () => {
      modal.close();
      if (typeof rerender === 'function') await rerender('members');
    });
    if (!ok) custom.focus();
  };
  select.addEventListener('change', () => syncPlayerMergeCustom(select, custom));
  custom.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); merge(); }
  });
  root.querySelector('[data-merge-dialog="cancel"]').addEventListener('click', () => modal.close());
  root.querySelector('[data-merge-dialog="merge"]').addEventListener('click', merge);
}
