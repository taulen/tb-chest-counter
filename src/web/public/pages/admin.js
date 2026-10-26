// Admin — content-management page for admins/superadmins. Member
// rename + delete, OCR misread merge rules (player / chest / source),
// chest-type rarity overrides, the Chest Points board (points-board.js), the
// review queue (newly-discovered chest names / sources / members), and
// the OCR-missing-player-name reassignment workflow with hover-preview
// of the saved debug crops.
//
// Per-clan settings (Discord, ChestTracker, login bridge) live on the
// Clans page; instance-wide settings (scan interval, calibration,
// container restart, backups) live on the System page. This page is
// pure data-correction.

import { api, apiPost, apiPut, apiDelete, mustOk } from '../lib/api.js';
import {
  $, esc, formatDate, memberLink, memberHash,
  notify, confirmDialog, promptDialog,
} from '../lib/ui.js';
import { getCurrentUser } from '../lib/state.js';
import { t, tn, tGame } from '../lib/i18n.js';
import { mountPointsBoard } from './points-board.js';
import { mountMemberLevels } from './member-levels.js';

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

export async function renderAdmin(el) {
  const currentUser = getCurrentUser();
  if (currentUser?.role !== 'admin' && currentUser?.role !== 'superadmin') {
    el.innerHTML = `<div class="empty-state"><p>${t('Admin access required.')}</p></div>`;
    return;
  }
  // Chest Points are per clan (the active clan's board); Triumphal Chest Points
  // are one global table. Any admin can view them, but only superadmins can edit.
  const isSuperadmin = currentUser?.role === 'superadmin';
  // Scanner / Discord / ChestTracker / scan-interval data lives on the
  // System and Clans tabs now — the Admin page only fetches what it
  // actually renders (per-clan content management). Chest Points fetches
  // its own (see mountPointsBoard below).
  const [playerRules, chestRules, sourceRules, chestTypes, chestSources, triumphalPoints, members, memberChestCounts, stats, reviewQueue, unknownChests] = await Promise.all([
    api('/admin/merge-rules?type=player'),
    api('/admin/merge-rules?type=chest'),
    api('/admin/merge-rules?type=source'),
    api('/admin/unique-chests'),
    api('/admin/unique-sources'),
    api('/admin/triumphal-points'),
    api('/members?include=inactive'),
    api('/admin/member-chest-counts'),
    api('/stats'),
    api('/admin/review-queue'),
    api('/admin/unknown-chests'),
  ]);
  const sortedMembers = [...members].sort((a, b) => (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase()));
  // Edit Members lists active rows by default; the soft-deleted ones
  // hide behind a "Show removed members" toggle so the table doesn't
  // get cluttered. Merge-player + rename dropdowns only target active
  // members — merging into a removed identity would silently
  // resurrect them, which isn't what the operator clicked.
  const activeMembers = sortedMembers.filter((m) => m.isActive !== false);
  const removedMembers = sortedMembers.filter((m) => m.isActive === false);

  // memberId → chest-record count, from its own admin route (see the comment
  // there). Guarded because an `{ error }` body would otherwise turn every
  // count into NaN rather than the honest 0.
  const chestCounts = memberChestCounts && !memberChestCounts.error ? memberChestCounts : {};
  const memberOption = (m) => countedOption(m.name, chestCounts[m.id]);

  const reviewQueueHtml = renderReviewQueueSection(reviewQueue);
  const unknownChestsHtml = renderUnknownChestsSection(unknownChests, activeMembers, chestCounts);

  el.innerHTML = `
    ${unknownChestsHtml}
    ${reviewQueueHtml}
    <!-- ═══════════════════════════════════════════════════ -->
    <!-- SECTION: Member Data                                  -->
    <!-- ═══════════════════════════════════════════════════ -->
    <h2 class="page-section-title">${t('Member Data')}</h2>
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
              <option value="">${t('Select...')}</option>
              ${activeMembers.map(memberOption).join('')}
            </select>
          </div>
          <button class="btn btn-primary" data-action="do-merge-player">${t('Merge')}</button>
        </div>
        <div class="merge-custom-row mb-16">
          <label for="mergePlayerToCustom">${t('Or type a custom Correct Name (overrides the dropdown above)')}</label>
          <input type="text" id="mergePlayerToCustom" class="input" placeholder="${t('Custom name…')}">
        </div>
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

    <!-- ═══════════════════════════════════════════════════ -->
    <!-- SECTION: Chest Data                                   -->
    <!-- ═══════════════════════════════════════════════════ -->
    <h2 class="page-section-title">${t('Chest Data')}</h2>
    <p class="page-section-intro">${t('Fix OCR misreads in chest names and override automatic chest type classification.')}</p>

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

    <!-- Chest Points: self-contained, fills itself (pages/points-board.js). -->
    <div class="card pb-card" id="pointsBoard"></div>

    ${renderTriumphalPointsSection(triumphalPoints, isSuperadmin)}

  `;

  // Not awaited: the board loads its own data, so the rest of the page is
  // usable while it does.
  const pointsBoardEl = el.querySelector('#pointsBoard');
  if (pointsBoardEl) mountPointsBoard(pointsBoardEl, { isSuperadmin }).catch((err) => {
    if (err?.name !== 'UnauthenticatedError' && err?.name !== 'AbortError') console.error(err);
  });

  const memberLevelsEl = el.querySelector('#memberLevels');
  if (memberLevelsEl) mountMemberLevels(memberLevelsEl).catch((err) => {
    if (err?.name !== 'UnauthenticatedError' && err?.name !== 'AbortError') console.error(err);
  });

  // ChestTracker Integration is now per-clan on the Clans tab; the
  // single-clan card that used to live here has been removed.
}

// ─── Action handlers ───
//
// All `loadPage('admin')` re-renders are routed through the `rerender`
// callback the dispatcher injects so this module never has to import
// loadPage from app.js (would be a circular dep).

export async function doMergePlayer(rerender) {
  const fromName = $('#mergePlayerFrom').value;
  // Dropdown selection takes priority; custom input is the fallback
  // when no dropdown value is picked. The custom input is auto-filled
  // with the misread when picking a "From" value, so it's there as a
  // starting point for editing - the dropdown still wins if a real
  // member is chosen.
  const toName = $('#mergePlayerTo').value || ($('#mergePlayerToCustom')?.value || '').trim();
  if (!fromName || !toName) return notify(t('Select both players'), t('Cannot merge'));
  if (fromName === toName) return notify(t('Cannot merge a player with itself'), t('Cannot merge'));
  const scrollY = window.scrollY;
  const result = await apiPost('/admin/merge-players', { fromName, toName });
  if (result?.error) return notify(result.error, t('Merge failed'));
  if (typeof rerender === 'function') await rerender('admin');
  window.scrollTo(0, scrollY);
  // `note` is set when an existing rule already covered this spelling, so the rules
  // list won't have grown. Say so — silently not adding the row is what left admins
  // writing the same rule four times over.
  notify(
    `${t('Merged "{from}" into "{to}".', { from: fromName, to: toName })}${result?.note ? ` ${result.note}` : ''}`,
    t('Merge complete'),
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
  if (typeof rerender === 'function') await rerender('admin');
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
  if (typeof rerender === 'function') await rerender('admin');
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

  if (typeof rerender === 'function') await rerender('admin');
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
    // Chest Points card below (which removes them from this list).
    { key: 'triumphal', label: t('New Triumphal Chests'), entries: queue.triumphalChests?.entries || [], ack: null, valueHeader: t('Chest Name'), noAck: true },
  ];
  const activeGroups = groups.filter((g) => g.entries.length > 0);
  const totalNew = activeGroups.reduce((sum, g) => sum + g.entries.length, 0);
  if (totalNew === 0) return '';

  return `
    <h2 class="page-section-title">${t('Review Queue')} <span class="chest-type epic">${tn(totalNew, '{n} new', '{n} new', { n: totalNew })}</span></h2>
    <p class="page-section-intro">${t('Recently-discovered chest names, sources, and members. Skim for OCR misspellings or unknown source types that need a point value. Click <strong>Acknowledge</strong> once reviewed to clear the list.')}</p>
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
            ? `<p class="muted-copy mt-12">${t('Assign each a package value under <strong>Triumphal Chest Points</strong> below — that scores them and clears them from this list.')}</p>`
            : `<div class="inline-form-row mt-12">
            <button class="btn" data-action="acknowledge-review" data-review-category="${g.key}">${t('Acknowledge')}</button>
          </div>
          <p class="muted-copy mt-8">${g.ack ? t('Last acknowledged: {date}', { date: formatDate(g.ack) }) : t('Never acknowledged — all entries are shown.')}</p>`}
        </div>
      </div>
    `).join('')}
  `;
}

export async function acknowledgeReviewQueue(category, rerender) {
  const result = await apiPost('/admin/review-queue/acknowledge', { category });
  if (result?.error) return notify(result.error, t('Acknowledge failed'));
  const scrollY = window.scrollY;
  if (typeof rerender === 'function') await rerender('admin');
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
  if (typeof rerender === 'function') await rerender('admin');
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
  if (typeof rerender === 'function') await rerender('admin');
  window.scrollTo(0, scrollY);
}

export async function deleteRule(id, rerender) {
  const ok = await confirmDialog(
    t('Delete this merge rule? Existing records that were already rewritten by this rule are not reverted, but future scans will stop auto-applying it.'),
    { title: t('Delete merge rule'), confirmLabel: t('Delete'), cancelLabel: t('Cancel'), danger: true },
  );
  if (!ok) return;
  if (!await mustOk(apiDelete(`/admin/merge-rules/${id}`), t('Delete rule failed'))) return;
  if (typeof rerender === 'function') rerender('admin');
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
    t('Remove {member}? Their chest history stays intact, but they\'ll be excluded from future scans so a new player with a similar name can\'t get matched into their identity. You can restore them later from "Show removed members".', { member: label }),
    { title: t('Remove member'), confirmLabel: t('Remove'), cancelLabel: t('Cancel'), danger: true },
  );
  if (!ok) return;
  if (!await mustOk(apiDelete(`/members/${id}`), t('Remove member failed'))) return;
  // Rerender so the row moves into the "Show removed members"
  // collapsible (always soft-deleted now, so it's always recoverable).
  if (rerender) rerender('admin');
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
  if (rerender) rerender('admin');
}

export async function promptMergePlayerById(id, rerender) {
  const member = await api(`/members/${id}`);
  if (!member || member.error || !member.name) return;

  const target = await promptDialog(t('Merge "{name}" into which player name?', { name: member.name }), {
    title: t('Merge Player'),
    confirmLabel: t('Merge'),
  });
  if (!target || !target.trim()) return;
  if (!await mustOk(
    apiPost('/admin/merge-players', { fromName: member.name, toName: target.trim() }),
    t('Merge failed'),
  )) return;
  if (typeof rerender === 'function') rerender('admin');
}
