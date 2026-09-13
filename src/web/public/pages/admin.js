// Admin — content-management page for admins/superadmins. Member
// rename + delete, OCR misread merge rules (player / chest / source),
// chest-type rarity overrides, source-point overrides + recalc, the
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
  return `<option value="${esc(value)}">${esc(value)} (${n.toLocaleString()} chest${n === 1 ? '' : 's'})</option>`;
}

export async function renderAdmin(el) {
  const currentUser = getCurrentUser();
  if (currentUser?.role !== 'admin' && currentUser?.role !== 'superadmin') {
    el.innerHTML = '<div class="empty-state"><p>Admin access required.</p></div>';
    return;
  }
  // Source Point Values are a single global scoring table shared by every
  // clan. Any admin can view it, but only superadmins can edit/recalculate.
  const isSuperadmin = currentUser?.role === 'superadmin';
  // Scanner / Discord / ChestTracker / scan-interval data lives on the
  // System and Clans tabs now — the Admin page only fetches what it
  // actually renders (per-clan content management).
  const [playerRules, chestRules, sourceRules, chestTypes, chestSources, sourcePoints, triumphalPoints, members, memberChestCounts, stats, reviewQueue, unknownChests] = await Promise.all([
    api('/admin/merge-rules?type=player'),
    api('/admin/merge-rules?type=chest'),
    api('/admin/merge-rules?type=source'),
    api('/admin/unique-chests'),
    api('/admin/unique-sources'),
    api('/admin/source-points'),
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
    <h2 class="page-section-title">Member Data</h2>
    <p class="page-section-intro">Edit names, delete duplicates, and merge OCR misreads into the correct player.</p>

    <div class="card">
      <div class="card-header"><h2>Edit Members (${activeMembers.length})</h2></div>
      <div class="card-body card-body-padded">
        <details ${stats.totalSessions === 0 ? 'open' : ''}>
          <summary class="collapse-toggle">Show member list</summary>
          <p class="muted-copy mtb-12">Rename or remove members. Removing a player who has chest history keeps their existing records but excludes them from future scans — useful when a player leaves so a new player with a similar name can't accidentally be matched into their identity.</p>
          <table class="table-responsive">
            <thead><tr><th>Current Name</th><th class="col-edit">New Name</th><th class="col-actions"></th></tr></thead>
            <tbody>
              ${activeMembers.map((m) => `<tr id="member-row-${m.id}">
                <td data-label="Current" data-role="primary"><span class="mrow-name">${memberLink(m.id, m.name)}</span></td>
                <td data-label="New Name"><input type="text" class="input input-member" value="${esc(m.name)}" id="member-name-${m.id}"></td>
                <td class="col-actions nowrap">
                  <button class="btn btn-tight" data-action="save-member" data-member-id="${m.id}">Save</button>
                  <button class="btn btn-tight btn-danger ml-4" data-action="delete-member" data-member-id="${m.id}" data-member-name="${esc(m.name)}">Remove</button>
                </td>
              </tr>`).join('')}
            </tbody>
          </table>
        </details>
        ${removedMembers.length > 0 ? `<details class="mt-12">
          <summary class="collapse-toggle">Show removed members (${removedMembers.length})</summary>
          <p class="muted-copy mtb-12">Players excluded from scan matching. Their chest history is intact. Restore one if it was removed by mistake or the player rejoined the clan.</p>
          <table class="table-responsive">
            <thead><tr><th>Name</th><th class="col-date">Last Seen</th><th class="col-actions"></th></tr></thead>
            <tbody>
              ${removedMembers.map((m) => `<tr id="member-row-${m.id}">
                <td data-label="Name" data-role="primary"><span class="mrow-name">${memberLink(m.id, m.name)}</span></td>
                <td data-label="Last Seen" data-role="metric">${formatDate(m.lastSeen)}</td>
                <td class="col-actions nowrap">
                  <button class="btn btn-tight btn-primary" data-action="restore-member" data-member-id="${m.id}" data-member-name="${esc(m.name)}">Restore</button>
                </td>
              </tr>`).join('')}
            </tbody>
          </table>
        </details>` : ''}
      </div>
    </div>

    <div class="card">
      <div class="card-header"><h2>Merge Player Names</h2></div>
      <div class="card-body card-body-padded">
        <p class="muted-copy mb-12">Fix OCR name variations. Updates existing records and auto-corrects future scans.</p>
        <div class="inline-form-row">
          <div>
            <label>OCR Misread</label>
            <select id="mergePlayerFrom" class="input">
              <option value="">Select...</option>
              ${activeMembers.map(memberOption).join('')}
            </select>
          </div>
          <span class="arrow-sep">→</span>
          <div>
            <label>Correct Name</label>
            <select id="mergePlayerTo" class="input">
              <option value="">Select...</option>
              ${activeMembers.map(memberOption).join('')}
            </select>
          </div>
          <button class="btn btn-primary" data-action="do-merge-player">Merge</button>
        </div>
        <div class="merge-custom-row mb-16">
          <label for="mergePlayerToCustom">Or type a custom Correct Name (overrides the dropdown above)</label>
          <input type="text" id="mergePlayerToCustom" class="input" placeholder="Custom name…">
        </div>
        ${playerRules.length > 0 ? `<details>
          <summary class="collapse-toggle">${playerRules.length} active player merge rule${playerRules.length === 1 ? '' : 's'}</summary>
          <table class="table-responsive merge-rules-table">
            <colgroup>
              <col class="col-merge-from">
              <col class="col-merge-to">
              <col class="col-merge-created">
              <col class="col-actions">
            </colgroup>
            <thead><tr><th>From</th><th>To</th><th>Created</th><th></th></tr></thead>
            <tbody>
              ${playerRules.map((r) => `<tr>
                <td data-label="From" data-role="primary"><span class="mrow-name">${esc(r.fromValue)}</span><span class="mrow-sub">→ ${esc(r.toValue)}</span></td>
                <td data-label="To" data-role="hidden">${esc(r.toValue)}</td>
                <td data-label="Created">${formatDate(r.createdAt)}</td>
                <td class="col-actions"><button class="btn btn-tight btn-danger" data-action="delete-rule" data-rule-id="${r.id}">Delete</button></td>
              </tr>`).join('')}
            </tbody>
          </table>
        </details>` : '<p class="muted-copy">No active player merge rules.</p>'}
      </div>
    </div>

    <!-- ═══════════════════════════════════════════════════ -->
    <!-- SECTION: Chest Data                                   -->
    <!-- ═══════════════════════════════════════════════════ -->
    <h2 class="page-section-title">Chest Data</h2>
    <p class="page-section-intro">Fix OCR misreads in chest names and override automatic chest type classification.</p>

    <div class="card">
      <div class="card-header"><h2>Merge Chest Names</h2></div>
      <div class="card-body card-body-padded">
        <p class="muted-copy mb-12">Map OCR misreads to the correct chest name. Applies to existing records and future scans.</p>
        <div class="inline-form-row">
          <div>
            <label>OCR Misread</label>
            <select id="mergeChestFrom" class="input">
              <option value="">Select...</option>
              ${chestTypes.map((c) => countedOption(c.name, c.count)).join('')}
            </select>
          </div>
          <span class="arrow-sep">→</span>
          <div>
            <label>Correct Name</label>
            <select id="mergeChestTo" class="input">
              <option value="">Select...</option>
              ${chestTypes.map((c) => countedOption(c.name, c.count)).join('')}
            </select>
          </div>
          <button class="btn btn-primary" data-action="do-merge-chest">Merge</button>
        </div>
        <div class="merge-custom-row mb-16">
          <label for="mergeChestToCustom">Or type a custom Correct Name (overrides the dropdown above)</label>
          <input type="text" id="mergeChestToCustom" class="input" placeholder="Custom name…">
        </div>
        ${chestRules.length > 0 ? `<details>
          <summary class="collapse-toggle">${chestRules.length} active chest merge rule${chestRules.length === 1 ? '' : 's'}</summary>
          <table class="table-responsive merge-rules-table">
            <colgroup>
              <col class="col-merge-from">
              <col class="col-merge-to">
              <col class="col-merge-created">
              <col class="col-actions">
            </colgroup>
            <thead><tr><th>From</th><th>To</th><th>Created</th><th></th></tr></thead>
            <tbody>
              ${chestRules.map((r) => `<tr>
                <td data-label="From" data-role="primary"><span class="mrow-name">${esc(r.fromValue)}</span><span class="mrow-sub">→ ${esc(r.toValue)}</span></td>
                <td data-label="To" data-role="hidden">${esc(r.toValue)}</td>
                <td data-label="Created">${formatDate(r.createdAt)}</td>
                <td class="col-actions"><button class="btn btn-tight btn-danger" data-action="delete-rule" data-rule-id="${r.id}">Delete</button></td>
              </tr>`).join('')}
            </tbody>
          </table>
        </details>` : '<p class="muted-copy">No active chest merge rules.</p>'}
      </div>
    </div>

    <div class="card">
      <div class="card-header"><h2>Merge Chest Sources</h2></div>
      <div class="card-body card-body-padded">
        <p class="muted-copy mb-12">Map OCR misreads to the correct source string (e.g. "Level 5 Crypt." → "Level 5 Crypt"). Applies to existing records and future scans.</p>
        <div class="inline-form-row">
          <div>
            <label>OCR Misread</label>
            <select id="mergeSourceFrom" class="input">
              <option value="">Select...</option>
              ${chestSources.map((s) => countedOption(s.source, s.count)).join('')}
            </select>
          </div>
          <span class="arrow-sep">→</span>
          <div>
            <label>Correct Source</label>
            <select id="mergeSourceTo" class="input">
              <option value="">Select...</option>
              ${chestSources.map((s) => countedOption(s.source, s.count)).join('')}
            </select>
          </div>
          <button class="btn btn-primary" data-action="do-merge-source">Merge</button>
        </div>
        <div class="merge-custom-row mb-16">
          <label for="mergeSourceToCustom">Or type a custom Correct Source (overrides the dropdown above)</label>
          <input type="text" id="mergeSourceToCustom" class="input" placeholder="Custom source…">
        </div>
        ${sourceRules.length > 0 ? `<details>
          <summary class="collapse-toggle">${sourceRules.length} active source merge rule${sourceRules.length === 1 ? '' : 's'}</summary>
          <table class="table-responsive merge-rules-table">
            <colgroup>
              <col class="col-merge-from">
              <col class="col-merge-to">
              <col class="col-merge-created">
              <col class="col-actions">
            </colgroup>
            <thead><tr><th>From</th><th>To</th><th>Created</th><th></th></tr></thead>
            <tbody>
              ${sourceRules.map((r) => `<tr>
                <td data-label="From" data-role="primary"><span class="mrow-name">${esc(r.fromValue)}</span><span class="mrow-sub">→ ${esc(r.toValue)}</span></td>
                <td data-label="To" data-role="hidden">${esc(r.toValue)}</td>
                <td data-label="Created">${formatDate(r.createdAt)}</td>
                <td class="col-actions"><button class="btn btn-tight btn-danger" data-action="delete-rule" data-rule-id="${r.id}">Delete</button></td>
              </tr>`).join('')}
            </tbody>
          </table>
        </details>` : '<p class="muted-copy">No active source merge rules.</p>'}
      </div>
    </div>

    <div class="card">
      <div class="card-header"><h2>Chest Type Classification</h2></div>
      <div class="card-body card-body-padded">
        <p class="muted-copy mb-12">Override the automatic rarity classification for individual chest names. Grouped by current rarity so you can skim one tier at a time.</p>
        <details>
          <summary class="collapse-toggle">Show chest types (${chestTypes.length})</summary>
          ${(() => {
            const rarityOrder = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'arena', 'event', 'unknown'];
            const rarityOptions = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'arena', 'event'];
            const groups = new Map();
            for (const c of chestTypes) {
              const rarity = c.override || c.currentType || 'unknown';
              if (!groups.has(rarity)) groups.set(rarity, []);
              groups.get(rarity).push(c);
            }
            const sortedRarities = rarityOrder.filter((r) => groups.has(r));
            for (const r of groups.keys()) {
              if (!rarityOrder.includes(r)) sortedRarities.push(r);
            }
            return sortedRarities.map((rarity) => {
              const chests = groups.get(rarity).slice().sort((a, b) => a.name.localeCompare(b.name));
              return `<details class="chest-types-group mt-12">
                <summary class="collapse-toggle">
                  <span class="chest-type ${esc(rarity)}">${esc(rarity)}</span>
                  <span class="muted-copy">&nbsp;— ${chests.length} chest${chests.length === 1 ? '' : 's'}</span>
                </summary>
                <table class="table-responsive mt-8">
                  <thead><tr><th>Chest Name</th><th>Current Type</th><th>Set Type</th></tr></thead>
                  <tbody>
                    ${chests.map((c) => `<tr>
                      <td data-label="Chest" data-role="primary"><span class="mrow-name">${esc(c.name)}</span></td>
                      <td data-label="Current" data-role="metric"><span class="chest-type ${c.override || c.currentType}">${c.override || c.currentType}</span></td>
                      <td data-label="Set Type">
                        <select class="input chest-type-select" data-chest-name="${esc(c.name)}">
                          <option value="">--</option>
                          ${rarityOptions.map((t) =>
                            `<option value="${t}" ${c.override === t ? 'selected' : ''}>${t}</option>`).join('')}
                        </select>
                      </td>
                    </tr>`).join('')}
                  </tbody>
                </table>
              </details>`;
            }).join('');
          })()}
        </details>
      </div>
    </div>

    <div class="card">
      <div class="card-header"><h2>Source Point Values</h2></div>
      <div class="card-body card-body-padded">
        <p class="muted-copy mb-12">One <strong>global scoring table</strong> shared by every clan — how many points each chest source is worth. Each source resolves in this order: a per-<strong>chest name</strong> value, else the source's <strong>wildcard</strong> value (applies to every chest from that source), else the built-in default. Use per-name values when a single source drops multiple chests that should score differently (e.g. "Dark Omens event" drops Minor, Major, and Epic Omen Chests). Rows tagged <span class="chest-type epic">New</span> have been seen in scans but have <strong>no point value yet</strong> (they score 0) — set a value to score them. ${isSuperadmin ? 'These values are managed here by superadmins.' : '<strong>Read-only</strong> — only a superadmin can change these values.'}</p>
        ${isSuperadmin ? `<div class="mb-12">
          <button class="btn" data-action="recalculate-source-points">Recalculate All Point Values</button>
          <p class="muted-copy mt-4">Re-runs the source parser on every existing chest record <strong>across all clans</strong> and updates point values using the current defaults + values. Use this after the parser is updated or to clean up historical 0-point rows.</p>
        </div>` : ''}
        ${sourcePoints.length > 0 ? `
          <details>
            <summary class="collapse-toggle">Show source point values (${sourcePoints.length})</summary>
            <div class="source-points-list mt-12">
              ${sourcePoints.map((s) => {
                // "New" = seen in scans but scores 0 with no value set anywhere:
                // no hardcoded default AND no override. An explicit override of 0
                // (wildcard or per-chest) is a non-null value, so it counts as
                // reviewed and suppresses the badge.
                const hasHardcodedDefault = s.chestRows.some((r) => r.fallbackPoints > 0);
                const hasAnyOverride = s.wildcardOverride !== null || s.chestRows.some((r) => r.override !== null);
                const needsAttention = !hasHardcodedDefault && !hasAnyOverride;
                return `<details class="source-points-source${needsAttention ? ' row-needs-attention' : ''}">
                <summary class="collapse-toggle">
                  <strong>${esc(s.sourceKey)}</strong>${needsAttention ? ' <span class="chest-type epic" title="Seen in scans but has no point value yet — it currently scores 0. Set a wildcard or per-chest value to score it. Saving an explicit 0 also clears this badge.">New</span>' : ''}
                  <span class="muted-copy">&nbsp;— ${s.totalCount} chest${s.totalCount === 1 ? '' : 's'} · default ${s.defaultPoints}${s.wildcardOverride !== null ? ` · wildcard ${s.wildcardOverride}` : ''}${s.sampleSource ? ` · e.g. "${esc(s.sampleSource)}"` : ''}</span>
                </summary>
                <table class="table-responsive mt-12">
                  <thead><tr><th>Chest Name</th><th>Rarity</th><th>Chests</th><th>Effective</th><th>${isSuperadmin ? 'Override' : 'Value'}</th></tr></thead>
                  <tbody>
                    ${s.chestRows.map((r) => `<tr>
                      <td data-label="Chest Name" data-role="primary"><span class="mrow-name">${r.isWildcard ? '<em>all chests (wildcard)</em>' : esc(r.chestName)}</span><span class="mrow-sub">${r.isWildcard || !r.chestType ? '' : `${esc(r.chestType)} · `}${r.count} chests</span></td>
                      <td data-label="Rarity" data-role="hidden">${r.isWildcard || !r.chestType ? '' : `<span class="chest-type ${esc(r.chestType)}">${esc(r.chestType)}</span>`}</td>
                      <td data-label="Chests" data-role="hidden">${r.count}</td>
                      <td data-label="Effective" data-role="metric">${r.effectivePoints}</td>
                      <td data-label="${isSuperadmin ? 'Override' : 'Value'}">
                        <input type="number" class="input input-narrow source-points-input" min="0" step="1" value="${r.override ?? ''}" placeholder="${r.fallbackPoints}" data-source-key="${esc(s.sourceKey)}" data-chest-name="${esc(r.chestName)}" data-original-override="${r.override ?? ''}"${isSuperadmin ? '' : ' disabled'}>
                      </td>
                    </tr>`).join('')}
                  </tbody>
                </table>
              </details>`;
              }).join('')}
            </div>
            ${isSuperadmin ? `<div class="inline-form-row mt-16">
              <button class="btn btn-primary" data-action="save-all-source-points">Save All Changes</button>
            </div>
            <p class="muted-copy mt-8">Saves every chest where the value was changed. Clear an input box to remove its value — that chest will fall through to the wildcard (or the built-in default if no wildcard is set). Historical chest records are backfilled across all clans.</p>` : ''}
          </details>
        ` : '<p class="muted-copy mt-12">No source data yet.</p>'}
      </div>
    </div>

    ${renderTriumphalPointsSection(triumphalPoints, isSuperadmin)}

  `;

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
  if (!fromName || !toName) return notify('Select both players', 'Cannot merge');
  if (fromName === toName) return notify('Cannot merge a player with itself', 'Cannot merge');
  const scrollY = window.scrollY;
  const result = await apiPost('/admin/merge-players', { fromName, toName });
  if (result?.error) return notify(result.error, 'Merge failed');
  if (typeof rerender === 'function') await rerender('admin');
  window.scrollTo(0, scrollY);
  // `note` is set when an existing rule already covered this spelling, so the rules
  // list won't have grown. Say so — silently not adding the row is what left admins
  // writing the same rule four times over.
  notify(
    `Merged "${fromName}" into "${toName}".${result?.note ? ` ${result.note}` : ''}`,
    'Merge complete',
  );
}

export async function doMergeChest(rerender) {
  const from = $('#mergeChestFrom').value;
  const to = $('#mergeChestTo').value || ($('#mergeChestToCustom')?.value || '').trim();
  if (!from || !to) return notify('Select both chest names', 'Cannot merge');
  if (from === to) return notify('Cannot merge a chest with itself', 'Cannot merge');
  const scrollY = window.scrollY;
  const result = await apiPost('/admin/merge-rules', { type: 'chest', fromValue: from, toValue: to });
  if (result?.error) return notify(result.error, 'Merge failed');
  if (typeof rerender === 'function') await rerender('admin');
  window.scrollTo(0, scrollY);
  notify(`Merged "${from}" into "${to}".`, 'Merge complete');
}

export async function doMergeSource(rerender) {
  const from = $('#mergeSourceFrom').value;
  const to = $('#mergeSourceTo').value || ($('#mergeSourceToCustom')?.value || '').trim();
  if (!from || !to) return notify('Select both source values', 'Cannot merge');
  if (from === to) return notify('Cannot merge a source with itself', 'Cannot merge');
  const scrollY = window.scrollY;
  const result = await apiPost('/admin/merge-rules', { type: 'source', fromValue: from, toValue: to });
  if (result?.error) return notify(result.error, 'Merge failed');
  if (typeof rerender === 'function') await rerender('admin');
  window.scrollTo(0, scrollY);
  notify(`Merged "${from}" into "${to}".`, 'Merge complete');
}

export async function saveAllSourcePoints(rerender) {
  const inputs = document.querySelectorAll('input.source-points-input');
  if (inputs.length === 0) return;

  // Collect changed rows only. Compare current value to data-original-override.
  // Empty value with a previous override = clear it (DELETE)
  // Filled value different from original = set it (PUT)
  // Every input carries both sourceKey and chestName ('' for the wildcard row).
  const toSet = [];
  const toDelete = [];
  for (const input of inputs) {
    const sourceKey = input.dataset.sourceKey;
    const chestName = input.dataset.chestName ?? '';
    const original = input.dataset.originalOverride || '';
    const current = input.value.trim();
    if (current === original) continue;

    const label = chestName === '' ? `${sourceKey} (wildcard)` : `${sourceKey} / ${chestName}`;
    if (current === '') {
      toDelete.push({ sourceKey, chestName, label });
    } else {
      const pointValue = Number.parseInt(current, 10);
      if (!Number.isFinite(pointValue) || pointValue < 0) {
        return notify(`"${label}" must be a non-negative integer`, 'Save failed');
      }
      toSet.push({ sourceKey, chestName, pointValue, label });
    }
  }

  if (toSet.length === 0 && toDelete.length === 0) {
    return notify('No changes to save.', 'Nothing to do');
  }

  const ok = await confirmDialog(
    `Save ${toSet.length} override${toSet.length === 1 ? '' : 's'}${toDelete.length > 0 ? ` and reset ${toDelete.length} to default` : ''}?\n\nHistorical chest records will be backfilled automatically.`,
    { title: 'Save all changes', confirmLabel: 'Save' },
  );
  if (!ok) return;

  const scrollY = window.scrollY;
  let totalBackfilled = 0;
  const errors = [];

  for (const entry of toSet) {
    const result = await apiPut('/admin/source-points', {
      sourceKey: entry.sourceKey,
      chestName: entry.chestName,
      pointValue: entry.pointValue,
    });
    if (result?.error) {
      errors.push(`${entry.label}: ${result.error}`);
    } else {
      totalBackfilled += result.backfilled || 0;
    }
  }
  for (const entry of toDelete) {
    const qs = `sourceKey=${encodeURIComponent(entry.sourceKey)}&chestName=${encodeURIComponent(entry.chestName)}`;
    const result = await apiDelete(`/admin/source-points?${qs}`);
    if (result?.error) {
      errors.push(`${entry.label}: ${result.error}`);
    } else {
      totalBackfilled += result.backfilled || 0;
    }
  }

  if (typeof rerender === 'function') await rerender('admin');
  window.scrollTo(0, scrollY);

  if (errors.length > 0) {
    notify(`Some changes failed:\n${errors.join('\n')}`, 'Partial save');
  } else {
    notify(`Saved ${toSet.length + toDelete.length} change${toSet.length + toDelete.length === 1 ? '' : 's'}. ${totalBackfilled} historical records updated.`, 'Saved');
  }
}

// Triumphal Chest Points — global, superadmin-managed scoring for the
// Bank Gifts tab (mirrors the Source Point Values card). `rows` come from
// GET /admin/triumphal-points: every configured chest plus any chest
// observed in scans but not yet valued (flagged `isNew`, sorted first).
function renderTriumphalPointsSection(rows, isSuperadmin) {
  const list = rows || [];
  const hasNew = list.some((t) => t.isNew);
  return `
    <div class="card">
      <div class="card-header"><h2>Triumphal Chest Points</h2></div>
      <div class="card-body card-body-padded">
        <p class="muted-copy mb-12">One <strong>global scoring table</strong> for the <strong>Bank Gifts</strong> tab, tracked separately from the main leaderboard. Each value is the <strong>package price</strong> (a full 3-of-a-kind set); a single chest is worth one third of it, rounded — so three of a kind sum back to exactly the package value. Rows tagged <span class="chest-type epic">New</span> have been seen in scans but have <strong>no value yet</strong> (they score 0) — set a value to score them. ${isSuperadmin ? 'Managed here by superadmins; values apply to every clan.' : '<strong>Read-only</strong> — only a superadmin can change these values.'}</p>
        ${list.length > 0 ? `
          <details${hasNew ? ' open' : ''}>
            <summary class="collapse-toggle">Show triumphal chest values (${list.length})</summary>
            <table class="table-responsive mt-12">
              <thead><tr><th>Chest</th><th>Chests Seen</th><th>Per Chest</th><th>Package (3-of-a-kind)</th></tr></thead>
              <tbody>
                ${list.map((t) => `<tr${t.isNew ? ' class="row-needs-attention"' : ''}>
                  <td data-label="Chest" data-role="primary"><span class="mrow-name">${esc(t.chestName)}${t.isNew ? ' <span class="chest-type epic" title="Seen in scans but has no point value yet — it currently scores 0. Set a package value to score it.">New</span>' : ''}</span><span class="mrow-sub">${t.observedCount} seen</span></td>
                  <td data-label="Chests Seen" data-role="hidden">${t.observedCount}</td>
                  <td data-label="Per Chest" data-role="metric">${t.perChestPoints ?? '—'}</td>
                  <td data-label="Package (3-of-a-kind)">
                    <input type="number" class="input input-narrow triumphal-points-input" min="0" step="1" value="${t.packagePoints ?? ''}" placeholder="0" data-chest-name="${esc(t.chestName)}" data-original-package="${t.packagePoints ?? ''}"${isSuperadmin ? '' : ' disabled'}>
                  </td>
                </tr>`).join('')}
              </tbody>
            </table>
            ${isSuperadmin ? `<div class="inline-form-row mt-16">
              <button class="btn btn-primary" data-action="save-all-triumphal-points">Save All Changes</button>
            </div>
            <p class="muted-copy mt-8">Saves every chest whose package value changed. Clear an input to remove that chest's value — it reverts to "new" and scores 0 until set again. Points are presentation-only, so no historical backfill is needed.</p>` : ''}
          </details>
        ` : '<p class="muted-copy mt-12">No triumphal chest data yet.</p>'}
      </div>
    </div>
  `;
}

export async function saveAllTriumphalPoints(rerender) {
  const inputs = document.querySelectorAll('input.triumphal-points-input');
  if (inputs.length === 0) return;

  // Changed rows only. Empty value with a previous value = clear (DELETE,
  // reverts the chest to "new"). Filled value different from original =
  // set it (PUT). Mirrors saveAllSourcePoints.
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
        return notify(`"${chestName}" must be a non-negative integer`, 'Save failed');
      }
      toSet.push({ chestName, packagePoints });
    }
  }

  if (toSet.length === 0 && toDelete.length === 0) {
    return notify('No changes to save.', 'Nothing to do');
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
    notify(`Some changes failed:\n${errors.join('\n')}`, 'Partial save');
  } else {
    notify(`Saved ${toSet.length + toDelete.length} change${toSet.length + toDelete.length === 1 ? '' : 's'}.`, 'Saved');
  }
}

function renderReviewQueueSection(queue) {
  if (!queue) return '';
  const groups = [
    { key: 'chest_name', label: 'New Chest Names', entries: queue.chestNames?.entries || [], ack: queue.chestNames?.acknowledgedAt || null, valueHeader: 'Chest Name' },
    { key: 'chest_source', label: 'New Chest Sources', entries: queue.chestSources?.entries || [], ack: queue.chestSources?.acknowledgedAt || null, valueHeader: 'Source' },
    { key: 'member', label: 'New Members', entries: queue.members?.entries || [], ack: queue.members?.acknowledgedAt || null, valueHeader: 'Member' },
    // Triumphal (Bank) chests with no configured value. No Acknowledge —
    // resolved by a superadmin assigning a package value in the Triumphal
    // Chest Points card below (which removes them from this list).
    { key: 'triumphal', label: 'New Triumphal Chests', entries: queue.triumphalChests?.entries || [], ack: null, valueHeader: 'Chest Name', noAck: true },
  ];
  const activeGroups = groups.filter((g) => g.entries.length > 0);
  const totalNew = activeGroups.reduce((sum, g) => sum + g.entries.length, 0);
  if (totalNew === 0) return '';

  return `
    <h2 class="page-section-title">Review Queue <span class="chest-type epic">${totalNew} new</span></h2>
    <p class="page-section-intro">Recently-discovered chest names, sources, and members. Skim for OCR misspellings or unknown source types that need a point value. Click <strong>Acknowledge</strong> once reviewed to clear the list.</p>
    ${activeGroups.map((g) => `
      <div class="card">
        <div class="card-header">
          <h2>${g.label} (${g.entries.length})</h2>
        </div>
        <div class="card-body card-body-padded">
          <details open>
            <summary class="collapse-toggle">Show ${g.entries.length} new entr${g.entries.length === 1 ? 'y' : 'ies'}</summary>
            <table class="table-responsive mt-12">
              <thead><tr>
                <th>${g.valueHeader}</th><th>First Seen</th><th>Chests</th>
                ${g.key === 'member' ? '<th>Row</th>' : ''}
              </tr></thead>
              <tbody>
                ${g.entries.map((e) => `<tr>
                  <td data-label="${g.valueHeader}" data-role="primary"><span class="mrow-name">${esc(e.value)}</span></td>
                  <td data-label="First Seen" class="muted-copy">${formatDate(e.firstSeen)}</td>
                  <td data-label="Chests" data-role="metric">${e.count}</td>
                  ${g.key === 'member' ? `<td data-label="Row">${e.hasCrop && e.memberId
                    ? `<span class="unknown-crop-hover" data-crop-url="/api/admin/members/${e.memberId}/crop" data-crop-wide tabindex="0" role="button" title="Hover to preview the screenshot this member was first seen in — click to enlarge">🖼️</span>`
                    : '<span class="muted-copy">—</span>'}</td>` : ''}
                </tr>`).join('')}
              </tbody>
            </table>
          </details>
          ${g.noAck
            ? '<p class="muted-copy mt-12">Assign each a package value under <strong>Triumphal Chest Points</strong> below — that scores them and clears them from this list.</p>'
            : `<div class="inline-form-row mt-12">
            <button class="btn" data-action="acknowledge-review" data-review-category="${g.key}">Acknowledge</button>
          </div>
          <p class="muted-copy mt-8">${g.ack ? `Last acknowledged: ${formatDate(g.ack)}` : 'Never acknowledged — all entries are shown.'}</p>`}
        </div>
      </div>
    `).join('')}
  `;
}

export async function acknowledgeReviewQueue(category, rerender) {
  const result = await apiPost('/admin/review-queue/acknowledge', { category });
  if (result?.error) return notify(result.error, 'Acknowledge failed');
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
          <h2>Session #${sid} <span class="chest-type epic">${rows.length} row${rows.length === 1 ? '' : 's'}</span></h2>
        </div>
        <div class="card-body card-body-padded">
          <p class="muted-copy mb-12">Debug crops for this session were saved to <code>data/screenshots/ocr_missing_name/</code> — filenames contain <code>s${sid}</code>. Open them to see which player each row belongs to, then reassign below.</p>
          <div class="inline-form-row mb-12">
            <div>
              <label>Reassign ALL rows in this session to</label>
              <select class="input" id="unknownBulkMember-${sid}">
                <option value="">Select member...</option>
                ${memberOptions}
              </select>
            </div>
            <button class="btn" data-action="reassign-unknown-bulk" data-session-id="${sid}">Reassign All</button>
          </div>
          <table class="table-responsive">
            <thead><tr><th>Received</th><th>Chest</th><th>Source</th><th>Pts</th><th>Crop</th><th class="col-edit">Reassign To</th><th class="col-actions"></th></tr></thead>
            <tbody>
              ${rows.map((r) => `<tr id="unknown-row-${r.id}">
                <td data-label="Received" class="muted-copy">${formatDate(r.effectiveAt)}</td>
                <td data-label="Chest" data-role="primary"><span class="mrow-name">${esc(r.chestName)}</span><span class="mrow-sub">${formatDate(r.effectiveAt)}</span></td>
                <td data-label="Source" class="muted-copy">${esc(r.chestSource)}</td>
                <td data-label="Pts" data-role="metric">${r.pointValue}</td>
                <td data-label="Crop">${r.hasCrop
                  ? `<span class="unknown-crop-hover" data-crop-url="/api/admin/unknown-chests/${r.id}/crop" tabindex="0" role="button" title="Hover to preview — click to open a zoomable full-size view">🖼️ view</span>`
                  : `<span class="muted-copy">—</span>`}</td>
                <td data-label="Reassign To">
                  <select class="input" id="unknownMember-${r.id}">
                    <option value="">Select member...</option>
                    ${memberOptions}
                  </select>
                </td>
                <td class="col-actions nowrap">
                  <button class="btn btn-tight" data-action="reassign-unknown-row" data-chest-id="${r.id}">Save</button>
                </td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }).join('');

  return `
    <h2 class="page-section-title">OCR Missing Player Name <span class="chest-type epic">${chests.length} row${chests.length === 1 ? '' : 's'}</span></h2>
    <p class="page-section-intro">These rows were saved with an empty or <code>[Unknown]</code> player name because OCR couldn't read the name region. Reassign each row to the correct player — the row's <strong>Captured</strong> timestamp and the debug crop saved under <code>data/screenshots/ocr_missing_name/</code> for the matching session should tell you which player it belongs to.</p>
    ${sections}
  `;
}

export async function reassignUnknownRow(chestId, rerender) {
  const select = document.getElementById(`unknownMember-${chestId}`);
  const memberName = (select?.value || '').trim();
  if (!memberName) return notify('Select a member from the dropdown first', 'No member selected');
  const result = await apiPost('/admin/unknown-chests/reassign', { chestIds: [chestId], memberName });
  if (result?.error) return notify(result.error, 'Reassign failed');
  const scrollY = window.scrollY;
  if (typeof rerender === 'function') await rerender('admin');
  window.scrollTo(0, scrollY);
}

export async function reassignUnknownBulk(sessionId, rerender) {
  const select = document.getElementById(`unknownBulkMember-${sessionId}`);
  const memberName = (select?.value || '').trim();
  if (!memberName) return notify('Select a member from the dropdown first', 'No member selected');
  // Scope to the card containing the clicked dropdown so we only grab
  // chest ids for this session, not every unknown row on the page.
  const card = select.closest('.card');
  const chestIds = [...(card?.querySelectorAll(`[data-action="reassign-unknown-row"]`) || [])]
    .map((btn) => Number.parseInt(btn.dataset.chestId || '0', 10))
    .filter((n) => n > 0);
  if (chestIds.length === 0) return notify('No rows found to reassign', 'Nothing to do');
  const ok = await confirmDialog(`Reassign all ${chestIds.length} row${chestIds.length === 1 ? '' : 's'} in session #${sessionId} to "${memberName}"?`, {
    title: 'Confirm bulk reassign',
    confirmLabel: 'Reassign',
  });
  if (!ok) return;
  const result = await apiPost('/admin/unknown-chests/reassign', { chestIds, memberName });
  if (result?.error) return notify(result.error, 'Reassign failed');
  const scrollY = window.scrollY;
  if (typeof rerender === 'function') await rerender('admin');
  window.scrollTo(0, scrollY);
}

export async function recalculateSourcePoints(rerender) {
  const ok = await confirmDialog('Re-run the source parser on every existing chest record and update point values? This is safe to run repeatedly.', {
    title: 'Recalculate point values',
    confirmLabel: 'Recalculate',
  });
  if (!ok) return;
  const scrollY = window.scrollY;
  const result = await apiPost('/admin/source-points/recalculate', {});
  if (result?.error) return notify(result.error, 'Recalculate failed');
  if (typeof rerender === 'function') await rerender('admin');
  window.scrollTo(0, scrollY);
  notify(`Recalculated ${result.updated || 0} chest records.`, 'Recalculate complete');
}

export async function deleteRule(id, rerender) {
  const ok = await confirmDialog(
    'Delete this merge rule? Existing records that were already rewritten by this rule are not reverted, but future scans will stop auto-applying it.',
    { title: 'Delete merge rule', confirmLabel: 'Delete', cancelLabel: 'Cancel', danger: true },
  );
  if (!ok) return;
  if (!await mustOk(apiDelete(`/admin/merge-rules/${id}`), 'Delete rule failed')) return;
  if (typeof rerender === 'function') rerender('admin');
}

export async function setChestType(chestName, chestType) {
  if (!chestType) return;
  await mustOk(apiPost('/admin/chest-types', { chestName, chestType }), 'Save chest type failed');
}

export async function saveMemberName(id) {
  const input = $(`#member-name-${id}`);
  if (!input) return;
  if (!await mustOk(apiPut(`/members/${id}`, { name: input.value }), 'Rename failed')) return;
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
  const label = name ? `"${name}"` : 'this member';
  const ok = await confirmDialog(
    `Remove ${label}? Their chest history stays intact, but they'll be excluded from future scans so a new player with a similar name can't get matched into their identity. You can restore them later from "Show removed members".`,
    { title: 'Remove member', confirmLabel: 'Remove', cancelLabel: 'Cancel', danger: true },
  );
  if (!ok) return;
  if (!await mustOk(apiDelete(`/members/${id}`), 'Remove member failed')) return;
  // Rerender so the row moves into the "Show removed members"
  // collapsible (always soft-deleted now, so it's always recoverable).
  if (rerender) rerender('admin');
  else {
    const row = $(`#member-row-${id}`);
    if (row) row.remove();
  }
}

export async function restoreMemberById(id, name, rerender) {
  const label = name ? `"${name}"` : 'this member';
  const ok = await confirmDialog(
    `Restore ${label}? They'll be eligible for matching in future scans again.`,
    { title: 'Restore member', confirmLabel: 'Restore', cancelLabel: 'Cancel' },
  );
  if (!ok) return;
  if (!await mustOk(apiPost(`/members/${id}/restore`, {}), 'Restore member failed')) return;
  if (rerender) rerender('admin');
}

export async function promptMergePlayerById(id, rerender) {
  const member = await api(`/members/${id}`);
  if (!member || member.error || !member.name) return;

  const target = await promptDialog(`Merge "${member.name}" into which player name?`, {
    title: 'Merge Player',
    confirmLabel: 'Merge',
  });
  if (!target || !target.trim()) return;
  if (!await mustOk(
    apiPost('/admin/merge-players', { fromName: member.name, toName: target.trim() }),
    'Merge failed',
  )) return;
  if (typeof rerender === 'function') rerender('admin');
}
