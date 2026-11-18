// Admin — content-management page for admins/superadmins, split into tabs
// (one route each, like Tools): #admin/<tab>.
//
//   review  — only while something needs attention: triumphal chests without a
//             package value (the OCR-era sections were retired in Nov 2026).
//   members — member rename + delete, player merge rules.
//   chests  — chest-name and chest-source merge rules.
//   points  — the Chest Points board (points-board.js) and Triumphal Chest Points.
//
// Bare #admin lands on Review while it has anything, else on Members. Each tab
// fetches only what it renders. Actions re-render with `rerender()` — no page
// argument — so the router redraws whichever tab is showing.
//
// Per-clan settings (Discord, ChestTracker, login bridge) live on the
// Clans page; instance-wide settings (scan interval, event dates,
// container restart, backups) live on the System page. This page is
// pure data-correction.

import { api, apiPost, apiPut, apiDelete, mustOk } from '../lib/api.js';
import {
  $, esc, formatDate, memberLink, memberHash,
  notify, confirmDialog, contentModal,
} from '../lib/ui.js';
import { getCurrentUser } from '../lib/state.js';
import { t, tn, tGame } from '../lib/i18n.js';
import { loadGameArt, chestLabelHtml } from '../lib/game-art.js';
import { mountPointsBoard } from './points-board.js';
import { subTabsHtml, asList, errorStateHtml, refusalText, wireRetry } from '../lib/ui-kit.js';

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
  return a.reviewQueueCount ?? 0;
}

/**
 * The kit's sub-tab bar (links to #admin/<tab>). Review is only shown while it
 * has something — or when it is the open tab, so the bar still says where you
 * are after its last item is cleared — and carries its count. A failed count
 * (null) keeps it visible rather than hiding work.
 */
function adminTabsHtml(active, count) {
  const items = [];
  if (count !== 0 || active === 'review') {
    items.push({ key: 'review', label: t('Review'), href: '#admin/review', count: count > 0 ? count : null });
  }
  items.push(
    { key: 'members', label: t('Members'), href: '#admin/members' },
    { key: 'chests', label: t('Chests'), href: '#admin/chests' },
    { key: 'points', label: t('Points'), href: '#admin/points' },
  );
  return subTabsHtml({ label: t('Page sections'), items, current: active });
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
  if (tab === 'review') body = await reviewTab();
  else if (tab === 'members') body = await membersTab();
  else if (tab === 'chests') body = await chestsTab();
  else body = await pointsTab(isSuperadmin);

  el.innerHTML = `${adminTabsHtml(tab, attentionCount(await navStatusP))}${body.html}`;
  body.wire?.(el);
}

/**
 * What still needs a person: triumphal chests without a package value. The
 * OCR-era sections (unread player names, unresolved resource rows, new names
 * to acknowledge) were retired in Nov 2026 — the scan reads the game itself.
 */
async function reviewTab() {
  const [reviewQueue] = await Promise.all([
    api('/admin/review-queue'),
    // The chests' pictures (never rejects).
    loadGameArt(),
  ]);
  const html = renderReviewQueueSection(reviewQueue);
  return {
    html: html.trim() ? html : `<div class="empty-state"><p>${t('Nothing needs review right now.')}</p></div>`,
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

/** Edit Members and Merge Player Names. */
async function membersTab() {
  const [members, memberChestCounts, stats, playerRulesRaw] = await Promise.all([
    api('/members?include=inactive'),
    api('/admin/member-chest-counts'),
    api('/stats'),
    api('/admin/merge-rules?type=player'),
  ]);
  // The tab's main list: a refusal (429, a 500's { error, ref }) is an object,
  // not a member list — say so with Try again instead of drawing an empty tab.
  if (!Array.isArray(members)) {
    return {
      html: errorStateHtml(t('The member list could not be loaded.'), refusalText(members)),
      wire: (el) => wireRetry(el, () => renderAdmin(el, 'members')),
    };
  }
  // Edit Members lists active rows by default; the soft-deleted ones
  // hide behind a "Show removed members" toggle so the table doesn't
  // get cluttered.
  const playerRules = asList(playerRulesRaw);
  const { activeMembers, removedMembers, chestCounts } = rosterFor(members, memberChestCounts);
  const memberOption = (m) => countedOption(m.name, chestCounts[m.id]);

  const html = `
    <p class="page-section-intro">${t('Edit names, remove duplicates, and merge two names that belong to the same player.')}</p>

    <div class="card">
      <div class="card-header"><h2>${t('Edit Members ({count})', { count: activeMembers.length })}</h2></div>
      <div class="card-body card-body-padded">
        <details ${stats.totalSessions === 0 ? 'open' : ''}>
          <summary class="collapse-toggle">${t('Show member list')}</summary>
          <p class="muted-copy mtb-12">${t('Rename or remove members. Removing a player who has chest history keeps their existing records but excludes them from future scans — useful when a player leaves so a new player with a similar name can\'t accidentally be matched into their identity.')}</p>
          <table class="ui-table table-responsive">
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
          <table class="ui-table table-responsive">
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
        <p class="muted-copy mb-12">${t('Join two spellings of one player into one. Updates existing records and every future scan.')}</p>
        <div class="inline-form-row">
          <div>
            <label>${t('Wrong name')}</label>
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
          <table class="ui-table table-responsive merge-rules-table">
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
  return { html };
}

/** Merge Chest Names and Merge Chest Sources. */
async function chestsTab() {
  const [chestRulesRaw, sourceRulesRaw, chestTypesRaw, chestSourcesRaw] = await Promise.all([
    api('/admin/merge-rules?type=chest'),
    api('/admin/merge-rules?type=source'),
    api('/admin/unique-chests'),
    api('/admin/unique-sources'),
  ]);
  // asList: a refusal answers with an object, never a list to map over.
  const [chestRules, sourceRules, chestTypes, chestSources] = [chestRulesRaw, sourceRulesRaw, chestTypesRaw, chestSourcesRaw].map(asList);

  const html = `
    <div class="card">
      <div class="card-header"><h2>${t('Merge Chest Names')}</h2></div>
      <div class="card-body card-body-padded">
        <p class="muted-copy mb-12">${t('Map an old or misspelled chest name to the correct one. Applies to existing records and future scans.')}</p>
        <div class="inline-form-row">
          <div>
            <label>${t('Wrong name')}</label>
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
          <table class="ui-table table-responsive merge-rules-table">
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
        <p class="muted-copy mb-12">${t('Map an old or misspelled source to the correct one (e.g. "Level 5 Crypt." → "Level 5 Crypt"). Applies to existing records and future scans.')}</p>
        <div class="inline-form-row">
          <div>
            <label>${t('Wrong name')}</label>
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
          <table class="ui-table table-responsive merge-rules-table">
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
  // The chests' pictures here and on the board (loadGameArt never rejects).
  const [triumphalPoints] = await Promise.all([api('/admin/triumphal-points'), loadGameArt()]);
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
  const list = asList(rows);
  const hasNew = list.some((row) => row.isNew);
  return `
    <div class="card">
      <div class="card-header"><h2>${t('Triumphal Chest Points')}</h2></div>
      <div class="card-body card-body-padded">
        <p class="muted-copy mb-12">${t('One <strong>global scoring table</strong> for the <strong>Bank Gifts</strong> tab, tracked separately from the main leaderboard. Each value is the <strong>package price</strong> (a full 3-of-a-kind set); a single chest is worth one third of it, rounded — so three of a kind sum back to exactly the package value. Rows tagged {new} have been seen in scans but have <strong>no value yet</strong> (they score 0) — set a value to score them.', { new: `<span class="chest-type epic">${t('New')}</span>` })} ${isSuperadmin ? t('Managed here by superadmins; values apply to every clan.') : t('<strong>Read-only</strong> — only a superadmin can change these values.')}</p>
        ${list.length > 0 ? `
          <details${hasNew ? ' open' : ''}>
            <summary class="collapse-toggle">${t('Show triumphal chest values ({count})', { count: list.length })}</summary>
            <table class="ui-table table-responsive mt-12">
              <thead><tr><th>${t('Chest')}</th><th>${t('Chests Seen')}</th><th>${t('Per Chest')}</th><th>${t('Package (3-of-a-kind)')}</th></tr></thead>
              <tbody>
                ${list.map((row) => `<tr${row.isNew ? ' class="row-needs-attention"' : ''}>
                  <td data-label="${t('Chest')}" data-role="primary"><span class="mrow-name">${chestLabelHtml(row.chestName, esc(tGame(row.chestName)))}${row.isNew ? ` <span class="chest-type epic" title="${t('Seen in scans but has no point value yet — it currently scores 0. Set a package value to score it.')}">${t('New')}</span>` : ''}</span><span class="mrow-sub">${tn(row.observedCount, '{n} seen', '{n} seen', { n: row.observedCount })}</span></td>
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

/**
 * Triumphal (Bank) chests the clan received that have no package value yet —
 * they score 0 until a superadmin sets one in the Triumphal Chest Points card
 * on the Points tab (which also clears them from here). The OCR-era "new
 * chest names / sources / members" lists to acknowledge are gone: names come
 * from the game itself now (Nov 2026).
 */
function renderReviewQueueSection(queue) {
  const entries = asList(queue?.triumphalChests?.entries);
  if (entries.length === 0) return '';
  return `
    <div class="card">
      <div class="card-header">
        <h2>${t('New Triumphal Chests')} (${entries.length})</h2>
      </div>
      <div class="card-body card-body-padded">
        <table class="ui-table table-responsive">
          <thead><tr><th>${t('Chest Name')}</th><th>${t('First Seen')}</th><th>${t('Chests')}</th></tr></thead>
          <tbody>
            ${entries.map((e) => `<tr>
              <td data-label="${t('Chest Name')}" data-role="primary"><span class="mrow-name">${chestLabelHtml(e.value, esc(e.value))}</span></td>
              <td data-label="${t('First Seen')}" class="muted-copy">${formatDate(e.firstSeen)}</td>
              <td data-label="${t('Chests')}" data-role="metric">${e.count}</td>
            </tr>`).join('')}
          </tbody>
        </table>
        <p class="muted-copy mt-12">${t('Assign each a package value under {link} on the Points tab — that scores them and clears them from this list.', { link: `<a href="#admin/points">${t('Triumphal Chest Points')}</a>` })}</p>
      </div>
    </div>
  `;
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
        <p class="modal-form-hint">${t('Join two spellings of one player into one. Updates existing records and every future scan.')}</p>
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
