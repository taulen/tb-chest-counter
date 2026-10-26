// ChestTracker.com external-ingest tab. Now an ES module — utilities
// (api/esc/formatDate/notify) come in via explicit imports from
// ./lib/, not classic-script globals as before.
//
// This tab is read-only. Admin controls (share code, poll interval,
// enable flag, manual fetch buttons) live on the Admin tab — rendered
// by renderAdmin() in app.js, not here.

import { api, apiPost, apiPut } from './lib/api.js';
import { esc, formatDate, formatDateShort, formatUtcDateKey, notify, promptDialog, $ } from './lib/ui.js';
import {
  renderSnapshotDetailCardHtml,
  renderShareCodeSelect,
  renderArchivedNotice,
} from './lib/chesttracker-render.js';
import { computeGameWindow } from './lib/period.js';
import { t, tn } from './lib/i18n.js';

let selectedSnapshotId = null;
// Which of the clan's ChestTracker codes we're viewing. null = the live
// one. Set when the user picks an archived tracker from the header.
let selectedShareCode = null;

// Append the selected share code to an API path, minding whether the path
// already carries a query string.
function withCode(path) {
  if (!selectedShareCode) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}shareCode=${encodeURIComponent(selectedShareCode)}`;
}

  // The collapsed "Snapshot history" list only needs to show a few of the
  // most recent rows — enough to let the user jump back a day or two, not
  // every snapshot ever taken. Full history is still in the DB if needed.
  const SNAPSHOT_LIST_LIMIT = 10;

  async function renderExternal(el, navigate) {
    el.innerHTML = `<div class="empty-state"><p>${t('Loading external data…')}</p></div>`;
    try {
      const [status, snapshotsResp, weeksResp, codesResp] = await Promise.all([
        api(withCode('/external/status')),
        api(withCode(`/external/snapshots?limit=${SNAPSHOT_LIST_LIMIT}`)),
        // One row per game-week (last snapshot of each), newest first —
        // drives the prev/next week stepper. Best-effort: a failure here
        // just hides the arrows, it doesn't break the tab.
        api(withCode('/external/weeks')).catch(() => ({ rows: [] })),
        // Every tracker code this clan has history under. Best-effort —
        // but say so loudly if it fails, otherwise the picker just
        // silently isn't there and there's nothing to debug from.
        api('/external/share-codes').catch((err) => {
          console.warn('[chesttracker] /external/share-codes failed — tracker picker hidden', err);
          return { current: '', rows: [] };
        }),
      ]);
      // The ChestTracker tab only applies to clans with the integration
      // enabled. A superadmin can switch the header clan-picker to a clan
      // that has it disabled while sitting on this tab (the switch reloads
      // with the old #external hash) — rather than show an empty wireframe
      // for a feature that clan doesn't use, bounce back to the dashboard.
      // The nav link is already hidden for disabled clans; this covers the
      // hash that survives the reload.
      if (status?.settings?.enabled !== true && typeof navigate === 'function') {
        navigate('dashboard');
        return;
      }
      // The server is the authority on which tracker actually got read —
      // it falls back to the live code if we asked for one the clan no
      // longer has rows under. Re-sync so the picker can't drift.
      selectedShareCode = status?.settings?.viewShareCode || null;
      const shareCodes = codesResp.rows || [];
      // The picker needs two codes to be worth showing. When there's only
      // one, leave a breadcrumb — "no picker" and "picker broke" look
      // identical on screen otherwise.
      if (shareCodes.length < 2) {
        console.info(
          `[chesttracker] tracker picker hidden — clan has ${shareCodes.length} share code(s):`,
          shareCodes.map((c) => c.shareCode),
        );
      }

      const snapshots = snapshotsResp.rows || [];
      const weeks = weeksResp.rows || [];
      const totalSnapshots = snapshotsResp.total ?? snapshots.length;
      // Default to the newest game-week's canonical (last) snapshot. Falls
      // back to the newest raw snapshot if the weeks endpoint came back
      // empty (e.g. it errored above).
      if (selectedSnapshotId === null) {
        selectedSnapshotId = weeks[0]?.id ?? snapshots[0]?.id ?? null;
      }
      const detail = selectedSnapshotId
        ? await api(`/external/snapshots/${selectedSnapshotId}`).catch(() => null)
        : null;
      el.innerHTML = renderShell(status, snapshots, totalSnapshots, detail, weeks, shareCodes);
      wireHandlers(el);
    } catch (err) {
      if (err?.name === 'UnauthenticatedError') throw err;
      el.innerHTML = `<div class="card"><div class="card-body card-body-padded">
        <h2>${t('External (ChestTracker.com)')}</h2>
        <p class="error">${t('Failed to load: {error}', { error: esc(String(err?.message || err)) })}</p>
      </div></div>`;
    }
  }

  function renderShell(status, snapshots, totalSnapshots, detail, weeks, shareCodes) {
    // Detail (latest snapshot or whichever the user picked) goes up top —
    // that's the data most people came here to see. Status + snapshot
    // history are tucked into collapsed <details> blocks below since
    // they're reference info, not daily-use info.
    return `
      ${renderSnapshotDetailCard(detail, status, weeks, shareCodes)}
      ${renderCollapsibleStatusCard(status, shareCodes)}
      ${renderCollapsibleSnapshotListCard(snapshots, totalSnapshots)}
    `;
  }

  function renderCollapsibleStatusCard(status, shareCodes) {
    const s = status.settings;
    const loop = status.loop;

    const summaryLines = [];
    if (s.shareCode) {
      summaryLines.push(t('Share code: <code>{code}</code>', { code: esc(s.shareCode) }));
      summaryLines.push(t('Every {hours}h · Weekly window (Sun 17:00 UTC → Sun 17:00 UTC)', { hours: s.pollIntervalHours }));
    } else {
      summaryLines.push(`<em>${t('No share code configured yet — ask an admin to set one on the Admin tab.')}</em>`);
    }

    // Spell out the retained archives so it's obvious nothing was lost
    // when the clan moved trackers.
    const archived = (shareCodes || []).filter((c) => !c.isCurrent);
    if (archived.length) {
      const list = archived
        .map((c) => `<code>${esc(c.shareCode)}</code> (${tn(c.weeks, '{n} week', '{n} weeks', { n: c.weeks })}, ${tn(c.snapshots, '{n} snapshot', '{n} snapshots', { n: c.snapshots })})`)
        .join(', ');
      summaryLines.push(tn(
        archived.length,
        'Archived tracker: {list} — still browsable from the Tracker picker above.',
        'Archived trackers: {list} — still browsable from the Tracker picker above.',
        { list },
      ));
    }

    const dotClass = loop.running ? 'ok' : 'idle';
    const stateText = loop.running ? t('Scheduled polling is active') : t('Scheduled polling is paused');
    const nextFetch = loop.nextFetchAt
      ? t('Next fetch: {date}', { date: formatDate(loop.nextFetchAt) })
      : '';
    const lastChecked = loop.lastSuccessAt
      ? t('Last checked: {date}', { date: formatDate(loop.lastSuccessAt) })
      : '';
    const latestData = status.latestSnapshot?.fetchedAt
      ? t('Latest data: {date}', { date: formatDate(status.latestSnapshot.fetchedAt) })
      : '';

    const errorLine = loop.lastError
      ? `<div class="ext-error-line">${t('Last error ({date}): {message}', { date: formatDate(loop.lastError.at), message: esc(loop.lastError.message) })}</div>`
      : '';

    return `<div class="card ext-collapsible-card">
      <details>
        <summary class="ext-collapsible-summary">
          <span class="ext-collapsible-title">${t('Ingest status')}</span>
          <span class="ext-collapsible-meta">${s.shareCode ? `<code>${esc(s.shareCode)}</code> · ${loop.running ? t('active') : t('paused')}` : `<em>${t('not configured')}</em>`}</span>
        </summary>
        <div class="ext-collapsible-body">
          <p class="ext-intro">
            ${t('Snapshots ingested from <code>chesttracker.com</code>. Stored locally in a separate DB so clan history survives even if the upstream site changes.')}
          </p>
          <div class="ext-summary-lines">
            ${summaryLines.map((l) => `<div>${l}</div>`).join('')}
          </div>
          <div class="ext-status-line">
            <span class="ext-status-dot ${dotClass}"></span>
            <span>${esc(stateText)}</span>
            ${nextFetch ? `<span class="ext-status-sep">·</span><span>${esc(nextFetch)}</span>` : ''}
            ${lastChecked ? `<span class="ext-status-sep">·</span><span title="${t('Includes 304 polls (no new data)')}">${esc(lastChecked)}</span>` : ''}
            ${latestData ? `<span class="ext-status-sep">·</span><span title="${t('When chesttracker last had new data for us')}">${esc(latestData)}</span>` : ''}
          </div>
          ${errorLine}
        </div>
      </details>
    </div>`;
  }

  function renderCollapsibleSnapshotListCard(snapshots, totalSnapshots) {
    if (!snapshots.length) {
      return `<div class="card"><div class="card-body card-body-padded">
        <h2 class="ext-subheader">${t('Snapshots')}</h2>
        <div class="empty-state"><p>${t('No snapshots yet. An admin needs to configure a share code and enable polling.')}</p></div>
      </div></div>`;
    }

    const rows = snapshots.map((s) => {
      const active = s.id === selectedSnapshotId ? ' class="ext-snapshot-row-active"' : '';
      // The whole row is the tap target (selects the snapshot), so there
      // is no room for a separate expander on mobile — every secondary
      // column is data-role="hidden" and the summary line carries the
      // players/chests counts.
      return `<tr${active} data-action="ext-select-snapshot" data-id="${s.id}">
        <td data-label="${t('Fetched')}" data-role="primary"><span class="mrow-name">${formatDate(s.fetchedAt)}</span><span class="mrow-sub">${tn(s.playerCount, '{n} player', '{n} players', { n: s.playerCount })} · ${tn(s.totalChests, '{n} chest', '{n} chests', { n: s.totalChests })} · ${tn(s.durationDays, '{n}d', '{n}d', { n: s.durationDays })}</span></td>
        <td data-label="${t('CT scanned')}" data-role="hidden">${s.lastScannedAt ? formatDate(s.lastScannedAt) : '—'}</td>
        <td data-label="${t('Window')}" data-role="hidden">${formatDate(s.windowStart)} → ${formatDate(s.windowEnd)}</td>
        <td data-label="${t('Duration')}" data-role="hidden">${tn(s.durationDays, '{n}d', '{n}d', { n: s.durationDays })}</td>
        <td data-label="${t('Trigger')}" data-role="hidden">${renderTriggerBadge(s.trigger)}</td>
        <td data-label="${t('Players')}" data-role="hidden">${s.playerCount}</td>
        <td data-label="${t('Chests')}" data-role="hidden">${s.totalChests}</td>
        <td data-label="${t('Points')}" data-role="metric">${s.totalPoints.toLocaleString()}</td>
      </tr>`;
    }).join('');

    const meta = totalSnapshots > snapshots.length
      ? t('Showing {shown} of {total} · click a row to load it above', { shown: snapshots.length, total: totalSnapshots })
      : t('Select any row to load it above');

    return `<div class="card ext-collapsible-card">
      <details>
        <summary class="ext-collapsible-summary">
          <span class="ext-collapsible-title">${t('Snapshot history')}</span>
          <span class="ext-collapsible-meta">${esc(meta)}</span>
        </summary>
        <div class="ext-collapsible-body">
          <table class="table-responsive ext-snapshots-table"><thead><tr>
            <th>${t('Fetched')}</th><th title="${t('Upstream chesttracker scan time')}">${t('CT scanned')}</th><th>${t('Window')}</th><th>${t('Duration')}</th><th>${t('Trigger')}</th><th>${t('Players')}</th><th>${t('Chests')}</th><th>${t('Points')}</th>
          </tr></thead><tbody>${rows}</tbody></table>
        </div>
      </details>
    </div>`;
  }

  function renderTriggerBadge(trigger) {
    const cls = trigger === 'manual' ? 'epic' : trigger === 'backfill' ? 'rare' : 'common';
    const TRIGGER_LABELS = { scheduled: t('scheduled'), manual: t('manual'), backfill: t('backfill') };
    return `<span class="chest-type ${cls}">${esc(TRIGGER_LABELS[trigger] ?? trigger)}</span>`;
  }

  // Snapshot-detail card rendering lives in lib/chesttracker-render.js
  // — the SAME module the public-share page uses. Auth-only context
  // (tooltip-with-next-fetch-eta, status.loop.lastSuccessAt for the
  // "Last checked" pill) is wired in here.
  function renderSnapshotDetailCard(detail, status, weeks, shareCodes) {
    // Title names the tracker actually on screen, which is the archived
    // code when one is selected — not the clan's live code.
    const viewCode = status?.settings?.viewShareCode || detail?.shareCode || '';
    const isArchived = status?.settings?.viewIsArchived === true;
    const title = viewCode
      ? t('ChestTracker.com data ({code})', { code: esc(viewCode) })
      : t('ChestTracker.com data');
    const codeInfo = (shareCodes || []).find((c) => c.shareCode === viewCode) || null;
    return renderSnapshotDetailCardHtml({
      detail,
      title,
      fetchedAtTooltip: detail ? buildFetchedTooltip(detail.fetchedAt, status) : '',
      // An archived tracker isn't polled any more, so the loop's live
      // timestamp describes a different code — use the last poll actually
      // recorded against the one on screen.
      lastCheckedAt: isArchived
        ? (status?.viewLastPolledAt || null)
        : (status?.loop?.lastSuccessAt || null),
      weekNav: renderWeekNav(detail, weeks),
      archiveSelect: renderShareCodeSelect(shareCodes, viewCode),
      archivedNotice: isArchived ? renderArchivedNotice(codeInfo) : '',
    });
  }

  // Prev/next week stepper, rendered beside the detail-card title. Reuses
  // the Leaderboard's `.period-nav` look (arrows + centred label) so week
  // navigation feels the same everywhere. Steps by game-week: each arrow
  // jumps to the canonical (last) snapshot of the adjacent week, matched on
  // the window so we always load data for the correct week. Returns '' when
  // there's nothing to step through (no detail, or only one week of data).
  function renderWeekNav(detail, weeks) {
    if (!detail || !Array.isArray(weeks) || weeks.length === 0) return '';
    // Locate the displayed week by its window, not the snapshot id — that
    // way a non-canonical snapshot picked from the history table still
    // resolves to its week here.
    let index = weeks.findIndex((w) => w.windowStart === detail.windowStart);
    if (index < 0) index = 0;

    // weeks is newest-first, so the *previous* (older) week is at index+1
    // and the *next* (more recent) week is at index-1.
    const olderId = index < weeks.length - 1 ? weeks[index + 1].id : null;
    const newerId = index > 0 ? weeks[index - 1].id : null;

    const label = `${formatDateShort(detail.windowStart)} → ${formatDateShort(detail.windowEnd)}`;
    let tag = '';
    if (index === 0 && isCurrentGameWeek(detail.windowStart)) {
      tag = `<span class="ext-week-nav-tag">${t('current')}</span>`;
    } else if (weeks.length > 1) {
      tag = `<span class="ext-week-nav-tag">${index + 1} / ${weeks.length}</span>`;
    }

    return `<div class="ext-week-nav period-nav" role="group" aria-label="${t('Switch week')}">
      <button class="btn btn-tight" data-action="ext-week-prev" data-target-id="${olderId ?? ''}" ${olderId == null ? 'disabled' : ''} title="${t('Previous week')}">←</button>
      <span class="period-nav-label">${label}${tag}</span>
      <button class="btn btn-tight" data-action="ext-week-next" data-target-id="${newerId ?? ''}" ${newerId == null ? 'disabled' : ''} title="${t('Next week')}">→</button>
    </div>`;
  }

  // True when the given window-start ISO is the live current game week, so
  // the stepper can tag the newest slot as "current". Compares UTC date
  // keys (not raw ms) against the same weekly window math the Leaderboard
  // uses, so a one-hour discrepancy in how the window instant was stamped
  // can't cause a false negative. Degrades to false if the period math is
  // unavailable for any reason.
  function isCurrentGameWeek(windowStart) {
    try {
      // ChestTracker's weeks are always Sunday-based, whatever week shape
      // this clan uses on its own leaderboard.
      const cur = computeGameWindow('weekly', 0, undefined, 'sunday');
      if (!cur) return false;
      return formatUtcDateKey(new Date(windowStart)) === formatUtcDateKey(new Date(cur.from));
    } catch {
      return false;
    }
  }

  // Build the "We fetched" pill tooltip: absolute fetch time plus, when
  // the scheduled loop is running, how long until the next fetch. Skips
  // the "next fetch" suffix when polling is paused or unknown. Public
  // page doesn't have access to scheduler state so it doesn't compute
  // this — that's the only material difference between the two pages'
  // detail cards.
  function buildFetchedTooltip(fetchedAt, status) {
    const parts = [formatDate(fetchedAt)];
    const running = status?.loop?.running === true;
    const nextAt = status?.loop?.nextFetchAt;
    if (running && nextAt) {
      const untilStr = formatTimeUntil(nextAt);
      if (untilStr) parts.push(t('Next fetch in {time}', { time: untilStr }));
    }
    return parts.join(' · ');
  }

  // Future-time counterpart to formatTimeAgo — returns how long until an
  // ISO timestamp in the same h/m granularity. Used for the "We fetched"
  // tooltip so hovering shows both when we last hit the API and when
  // we're scheduled to hit it again.
  function formatTimeUntil(iso) {
    if (!iso) return null;
    const then = new Date(iso).getTime();
    const diffSec = Math.floor((then - Date.now()) / 1000);
    if (!Number.isFinite(diffSec)) return null;
    if (diffSec <= 0) return t('any moment');
    if (diffSec < 60) return t('<1m');
    const totalMin = Math.round(diffSec / 60);
    if (totalMin < 60) return tn(totalMin, '{n}m', '{n}m');
    const totalHr = Math.floor(totalMin / 60);
    const remMin = totalMin - totalHr * 60;
    if (totalHr < 24) {
      return remMin > 0 ? t('{h}h {m}m', { h: totalHr, m: remMin }) : tn(totalHr, '{n}h', '{n}h');
    }
    const totalDay = Math.floor(totalHr / 24);
    return tn(totalDay, '{n}d', '{n}d');
  }

  function wireHandlers(el) {
    // Tracker picker: switching codes invalidates the current snapshot
    // selection (ids belong to one code's history), so clear it and let
    // the reload land on the newest week of the chosen tracker.
    el.querySelectorAll('[data-action="ext-select-share-code"]').forEach((sel) => {
      sel.addEventListener('change', async () => {
        const code = sel.value;
        if (!code || code === selectedShareCode) return;
        selectedShareCode = code;
        selectedSnapshotId = null;
        await renderExternal($('#content'));
      });
    });

    el.querySelectorAll('[data-action="ext-select-snapshot"]').forEach((row) => {
      row.addEventListener('click', async () => {
        const id = Number(row.dataset.id);
        if (!Number.isFinite(id) || id === selectedSnapshotId) return;
        selectedSnapshotId = id;
        await renderExternal($('#content'));
      });
    });

    // Week stepper: load the adjacent week's canonical snapshot. The target
    // id is baked into each arrow; disabled arrows carry no id.
    el.querySelectorAll('[data-action="ext-week-prev"], [data-action="ext-week-next"]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (btn.disabled) return;
        const id = Number(btn.dataset.targetId);
        if (!Number.isFinite(id) || id === selectedSnapshotId) return;
        selectedSnapshotId = id;
        await renderExternal($('#content'));
      });
    });
  }

  // Reset selection when navigating away so a fresh visit shows the newest
  // snapshot.
  window.addEventListener('hashchange', () => {
    if (!window.location.hash.startsWith('#external')) {
      selectedSnapshotId = null;
      selectedShareCode = null;
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // ADMIN SECTION
  // ───────────────────────────────────────────────────────────────────
  // Rendered inline by renderAdmin() in app.js — the same place every
  // other admin card lives — so it matches the Discord Integration
  // section visually. We expose two helpers:
  //   renderExternalAdminCardHtml(status) → HTML string
  //   wireExternalAdminHandlers(card)     → attach button handlers
  //
  // Separated so app.js can build the full admin tab innerHTML in one
  // pass, then come back and wire our handlers on the rendered DOM.
  // ═══════════════════════════════════════════════════════════════════

  function renderExternalAdminCardHtml(status) {
    const s = status?.settings || {};
    const loop = status?.loop || { running: false, nextFetchAt: null, lastError: null };

    const statusBadge = s.enabled
      ? `<span class="chest-type uncommon">${t('Enabled')}</span>`
      : `<span class="chest-type common">${t('Disabled')}</span>`;

    const statusLine = loop.running
      ? (loop.nextFetchAt
        ? t('Scheduled polling is <strong>active</strong> · next fetch {date}', { date: formatDate(loop.nextFetchAt) })
        : t('Scheduled polling is <strong>active</strong>'))
      : t('Scheduled polling is <strong>paused</strong>');

    const errorBlock = loop.lastError
      ? `<div class="ext-error-line">${t('Last error ({date}): {message}', { date: formatDate(loop.lastError.at), message: esc(loop.lastError.message) })}</div>`
      : '';

    return `<div class="card">
      <div class="card-header">
        <h2>${t('ChestTracker Integration')}</h2>
        ${statusBadge}
      </div>
      <div class="card-body card-body-padded">
        <details>
          <summary class="collapse-toggle">${t('Show ChestTracker settings')}</summary>
          <p class="muted-copy mb-12 mt-12">${t('Pulls weekly chest-count snapshots from a public <code>chesttracker.com</code> share code and stores them locally. When disabled, the ChestTracker tab is hidden from the nav and no background polling happens. Changes apply live — no restart required.')}</p>

          <details class="mb-12">
            <summary class="collapse-toggle">${t('How do I set this up?')}</summary>
            <ol class="muted-copy" style="padding-left: 20px; line-height: 1.6;">
              <li>${t('On {link}, open your clan\'s public counts page. The URL looks like <code>chesttracker.com/counts/XXXXX</code>.', { link: '<a href="https://chesttracker.com" target="_blank" rel="noopener">chesttracker.com</a>' })}</li>
              <li>${t('Copy the <code>XXXXX</code> portion (4–32 letters/digits) and paste it into <strong>Share code</strong> below.')}</li>
              <li>${t('Tick <strong>Enable ChestTracker integration</strong>, click <strong>Save</strong>. On first enable the app backfills the last N weeks automatically.')}</li>
              <li>${t('Use <strong>Fetch current week</strong> to force an immediate update, or <strong>Fetch a past week…</strong> to pull a specific historical window.')}</li>
            </ol>
          </details>

          <div class="inline-form-row mb-8" style="align-items: center;">
            <label style="display:flex; align-items:center; gap:8px;">
              <input type="checkbox" id="ext-admin-enabled" ${s.enabled ? 'checked' : ''}>
              <span>${t('Enable ChestTracker integration')}</span>
            </label>
          </div>

          <div class="mb-8">
            <label>${t('Share code')}</label>
            <input type="text" id="ext-admin-share-code" class="input" value="${esc(s.shareCode || '')}" placeholder="${t('e.g. XQOOZXYGBC')}" maxlength="32">
            <p class="muted-copy mt-4">${t('Changing this doesn\'t delete anything. The previous code\'s snapshots are <strong>archived</strong> against this clan and stay readable from the <em>Tracker</em> picker on the ChestTracker tab.')}</p>
          </div>
          <div class="mb-8">
            <label>${t('Poll interval')} <span class="muted-copy">${t('(hours, 0.25–24 — fractions OK)')}</span></label>
            <input type="number" id="ext-admin-poll-hours" class="input" min="0.0833" max="24" step="0.25" value="${s.pollIntervalHours ?? 3}" style="max-width: 140px;">
          </div>
          <div class="mb-12">
            <label>${t('Initial backfill')} <span class="muted-copy">${t('(prior weeks, 0–52)')}</span></label>
            <input type="number" id="ext-admin-backfill-weeks" class="input" min="0" max="52" value="${s.backfillWeeks ?? 4}" style="max-width: 140px;">
            <p class="muted-copy mt-4">${t('On first enable, the app fetches each of the past N weeks as a separate snapshot so you get real weekly-trend data from day one.')}</p>
          </div>

          <hr style="border:0; border-top:1px solid var(--border); margin: 16px 0 8px;">
          <p class="muted-copy mb-8">${t('The ingest window is always one game week (Sun 17:00 UTC → next Sun 17:00 UTC). Each scheduled poll refreshes the current week\'s snapshot until the Sunday rollover.')}</p>

          <div class="inline-form-row">
            <button class="btn btn-primary" id="ext-admin-save">${t('Save')}</button>
            <button class="btn" id="ext-admin-fetch-now" ${s.shareCode ? '' : 'disabled'}>${t('Fetch current week')}</button>
            <button class="btn" id="ext-admin-fetch-historical" ${s.shareCode ? '' : 'disabled'}>${t('Fetch a past week…')}</button>
            <button class="btn" id="ext-admin-backfill" ${s.shareCode ? '' : 'disabled'}>${t('Backfill past weeks…')}</button>
            <a class="btn" href="/api/external/poll-log.csv" download>${t('Download poll log (CSV)')}</a>
          </div>
          <p class="muted-copy mt-8">${t('The <strong>Initial backfill</strong> figure above only applies the first time a share code is enabled. To pull more history later, use <strong>Backfill past weeks…</strong> — it re-runs the same fetch for the last N weeks and is safe to repeat.')}</p>

          <p id="ext-admin-status-line" class="muted-copy mt-8">${statusLine}</p>
          ${errorBlock}
        </details>
      </div>
    </div>`;
  }

  function wireExternalAdminHandlers(card) {
    if (!card) return;
    const shareInput = card.querySelector('#ext-admin-share-code');
    const pollInput = card.querySelector('#ext-admin-poll-hours');
    const backInput = card.querySelector('#ext-admin-backfill-weeks');
    const enabledInput = card.querySelector('#ext-admin-enabled');
    const saveBtn = card.querySelector('#ext-admin-save');
    const fetchBtn = card.querySelector('#ext-admin-fetch-now');
    const histBtn = card.querySelector('#ext-admin-fetch-historical');
    const backfillBtn = card.querySelector('#ext-admin-backfill');
    const statusLine = card.querySelector('#ext-admin-status-line');

    saveBtn?.addEventListener('click', async () => {
      saveBtn.disabled = true;
      saveBtn.textContent = t('Saving…');
      try {
        await apiPut('/external/config', {
          shareCode: shareInput.value.trim(),
          pollIntervalHours: Number(pollInput.value),
          backfillWeeks: Number(backInput.value),
          enabled: enabledInput.checked,
        });
        if (statusLine) statusLine.textContent = t('Saved. Settings applied.');
        const fresh = await api('/external/status').catch(() => null);
        if (fresh) {
          fetchBtn.disabled = !fresh.settings.shareCode;
          histBtn.disabled = !fresh.settings.shareCode;
        }
        // Show/hide the nav tab based on the new enabled flag.
        if (typeof window.refreshExternalNavVisibility === 'function') {
          window.refreshExternalNavVisibility();
        }
      } catch (err) {
        if (err?.name === 'UnauthenticatedError') throw err;
        await notify(String(err?.message || err), t('Save failed'));
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = t('Save');
      }
    });

    fetchBtn?.addEventListener('click', async () => {
      fetchBtn.disabled = true;
      fetchBtn.textContent = t('Fetching…');
      try {
        const result = await apiPost('/external/fetch', {});
        if (result?.error) {
          await notify(result.error, t('Fetch failed'));
        } else if (statusLine) {
          statusLine.textContent = result?.status === 'not_modified'
            ? t('Up to date — chesttracker returned 304, no new snapshot.')
            : tn(result.playerCount, 'Inserted current-week snapshot with {n} player.', 'Inserted current-week snapshot with {n} players.', { n: result.playerCount });
        }
      } catch (err) {
        if (err?.name === 'UnauthenticatedError') throw err;
        await notify(String(err?.message || err), t('Fetch failed'));
      } finally {
        fetchBtn.disabled = false;
        fetchBtn.textContent = t('Fetch current week');
      }
    });

    histBtn?.addEventListener('click', async () => {
      const weeksStr = await promptDialog(
        t('How many weeks ago? (1 = last week, 2 = two weeks ago, …). Must be ≥ 1.'),
        {
          title: t('Fetch a past week'),
          defaultValue: '1',
          confirmLabel: t('Fetch'),
        },
      );
      if (!weeksStr) return;
      const n = Number.parseInt(String(weeksStr), 10);
      if (!Number.isFinite(n) || n < 1 || n > 520) {
        await notify(t('Enter a number between 1 and 520.'), t('Invalid input'));
        return;
      }
      histBtn.disabled = true;
      histBtn.textContent = t('Fetching…');
      try {
        const result = await apiPost('/external/fetch', { weeksAgo: n });
        if (result?.error) {
          await notify(result.error, t('Fetch failed'));
        } else if (statusLine) {
          statusLine.textContent = tn(n, 'Inserted snapshot for week {n} ago ({players}).', 'Inserted snapshot for week {n} ago ({players}).', {
            n,
            players: tn(result.playerCount, '{n} player', '{n} players', { n: result.playerCount }),
          });
        }
      } catch (err) {
        if (err?.name === 'UnauthenticatedError') throw err;
        await notify(String(err?.message || err), t('Fetch failed'));
      } finally {
        histBtn.disabled = false;
        histBtn.textContent = t('Fetch a past week…');
      }
    });

    // Bulk backfill. The server returns as soon as the run starts (a long
    // range would outlive the proxy timeout), so poll /status for progress
    // rather than awaiting the whole thing.
    backfillBtn?.addEventListener('click', async () => {
      const weeksStr = await promptDialog(
        t('How many past weeks should I fetch? (1–52). Weeks already stored are re-fetched harmlessly; weeks from before the tracker existed come back empty.'),
        { title: t('Backfill past weeks'), defaultValue: '12', confirmLabel: t('Backfill') },
      );
      if (!weeksStr) return;
      const n = Number.parseInt(String(weeksStr), 10);
      if (!Number.isFinite(n) || n < 1 || n > 52) {
        await notify(t('Enter a number between 1 and 52.'), t('Invalid input'));
        return;
      }

      backfillBtn.disabled = true;
      backfillBtn.textContent = t('Starting…');
      try {
        await apiPost('/external/backfill', { weeks: n });
        backfillBtn.textContent = t('Backfilling…');
        await pollBackfillProgress(statusLine);
      } catch (err) {
        if (err?.name === 'UnauthenticatedError') throw err;
        await notify(String(err?.message || err), t('Backfill failed'));
      } finally {
        backfillBtn.disabled = false;
        backfillBtn.textContent = t('Backfill past weeks…');
      }
    });
  }

  // Follow a running backfill to completion, writing progress into the
  // admin card's status line. Gives up watching after a generous ceiling —
  // the run itself keeps going server-side regardless, so this only ever
  // abandons the display, never the work.
  async function pollBackfillProgress(statusLine) {
    const MAX_POLLS = 400;
    for (let i = 0; i < MAX_POLLS; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const fresh = await api('/external/status').catch(() => null);
      const bf = fresh?.loop?.backfill;
      if (!bf) return;
      if (bf.running) {
        if (statusLine) statusLine.textContent = t('Backfilling… week {done} of {total}', { done: bf.done, total: bf.total });
        continue;
      }
      if (statusLine) {
        const bits = [tn(bf.done, '{n} week processed', '{n} weeks processed', { n: bf.done })];
        if (bf.inserted) bits.push(t('{n} with data', { n: bf.inserted }));
        if (bf.empty) bits.push(t('{n} empty (before this tracker\'s history)', { n: bf.empty }));
        if (bf.failed) bits.push(t('{n} failed', { n: bf.failed }));
        statusLine.textContent = t('Backfill complete — {summary}.', { summary: bits.join(', ') });
      }
      return;
    }
  }

// Module exports — app.js imports these directly. The
// `window.renderExternal = ...` shims that classic-script callers
// relied on are gone; everything goes through ES module imports now.
export { renderExternal, renderExternalAdminCardHtml, wireExternalAdminHandlers };
