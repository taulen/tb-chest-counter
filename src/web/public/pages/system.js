// System — superadmin-only instance-wide settings: scan health, scan
// interval, event schedule corrections, restart-container, recent warnings,
// plus the Backup & Export / Import Data sections.

import { api, apiPost, apiPut, apiDelete, mustOk } from '../lib/api.js';
import { $, $$, esc, notify, confirmDialog, promptDialog, formatDate } from '../lib/ui.js';
import { getCurrentUser, getLastSeenSystemWarningAt } from '../lib/state.js';
import { warningHeadline, hasMoreThanHeadline, splitWarnings } from '../lib/warning-digest.js';
import { t, tn, tGame, getLanguage } from '../lib/i18n.js';
import { errorStateHtml, wireRetry } from '../lib/ui-kit.js';

function joinAnd(items) {
  try {
    return new Intl.ListFormat(getLanguage(), { type: 'conjunction' }).format(items);
  } catch (_) {
    return items.join(', ');
  }
}

const SCAN_STATUS_LABELS = {
  pending: t('pending'),
  processing: t('processing'),
  completed: t('completed'),
  failed: t('failed'),
};

// Stable key for the Recent Warnings <details> card, so the remembered
// open/closed state keys off this rather than the count-bearing summary text
// (which also carries the "N new" badge).
const RECENT_WARNINGS_KEY = 'system-recent-warnings';

// ─── Module-local state ───
// Repainted into the freshly-rendered DOM each time renderSystem runs
// so a long-running import survives a tab re-render.
let transferStatus = {
  visible: false,
  message: '',
  progress: 0,
  tone: 'info',
};

// Clan-restore workbench state. Survives a re-render of the page the same way
// transferStatus does, because inspecting a backup and then restoring out of it
// are two round trips and losing the inspection between them would mean
// re-uploading the file.
//
//   fileName   — backup currently selected (a basename in data/backups)
//   inspection — { schemaVersion, clans: [...] } from /admin/backups/clans
//   status     — { message, tone } painted above the results
let clanRestore = {
  fileName: '',
  inspection: null,
  status: null,
};

// ─── renderSystem ───

/**
 * Capture health: how long scans take and how often they error, over time.
 *
 * scan_sessions has always been a flat list plus one dashboard tile. As a
 * series it is a different thing — duration creeping up over weeks, or an
 * error rate that climbs, shows a problem before it costs anyone a cycle.
 *
 * A trailing-median band, not an average: one five-hour outlier drags a mean
 * far enough that every normal scan afterwards looks fast by comparison, which
 * is precisely backwards.
 */
/** The clans present in an all-clans series, for the card's filter. */
function scanHealthClans(scans) {
  const seen = new Map();
  for (const s of Array.isArray(scans) ? scans : []) if (s.clanId && !seen.has(s.clanId)) seen.set(s.clanId, s.clanName || `#${s.clanId}`);
  return [...seen].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

// Scans read from the game take seconds; older browser scans took minutes.
function fmtScanDuration(ms) {
  return ms < 60_000
    ? t('{seconds}s', { seconds: Math.max(1, Math.round(ms / 1000)) })
    : t('{minutes}m', { minutes: Math.round(ms / 60000) });
}

/** Chart + legend for a series; `allClans` adds the clan to each bar's tooltip. Returns { html, median }. */
function scanHealthBody(scans, allClans) {
  if (!Array.isArray(scans) || scans.length < 3) {
    return { html: `<div class="empty-state"><p>${t('Not enough scans recorded yet to show a trend.')}</p></div>`, median: null };
  }
  const durations = scans.map((s) => s.durationMs).filter((d) => d !== null);
  const sorted = [...durations].sort((a, b) => a - b);
  const median = sorted.length
    ? (sorted.length % 2
      ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2)
    : 0;
  const peak = Math.max(1, ...durations);
  const errorScans = scans.filter((s) => s.errors > 0).length;
  const unfinished = scans.filter((s) => s.durationMs === null && !s.running).length;
  const live = scans.find((s) => s.running) ?? null;
  const who = (s) => (allClans && s.clanName ? `${esc(s.clanName)} · ` : '');

  const bars = scans.map((s) => {
    // The scan running right now: its height is the time so far, capped at the
    // tallest finished scan. Not a failure, so never red — but it still turns
    // gold once it runs past three times the median, because a stuck scan
    // looks exactly like one that won't end.
    if (s.running) {
      const elapsed = s.elapsedMs ?? 0;
      const h = Math.min(100, Math.max(2, Math.round((elapsed / peak) * 100)));
      const slow = median > 0 && elapsed > median * 3;
      return `<span class="scanhealth-bar is-running${slow ? ' is-slow' : ''}" style="height: ${h}%"
                title="${who(s)}${s.startedAt} · ${t('Scan in progress')} · ${t('{duration} so far', { duration: fmtScanDuration(elapsed) })}"></span>`;
    }
    // An unfinished scan is drawn as a full-height marked bar. Plotting it as
    // zero would render the worst outcome as the fastest one.
    if (s.durationMs === null) {
      return `<span class="scanhealth-bar is-unfinished" style="height: 100%"
                title="${who(s)}${s.startedAt} · ${SCAN_STATUS_LABELS[s.status] ?? s.status} · ${t('never completed')}"></span>`;
    }
    const h = Math.max(2, Math.round((s.durationMs / peak) * 100));
    const slow = median > 0 && s.durationMs > median * 3;
    return `<span class="scanhealth-bar${slow ? ' is-slow' : ''}${s.errors > 0 ? ' has-errors' : ''}"
              style="height: ${h}%"
              title="${who(s)}${s.startedAt} · ${fmtScanDuration(s.durationMs)} · ${tn(s.chests, '{n} chest', '{n} chests', { n: s.chests })} · ${tn(s.errors, '{n} error(s)', '{n} error(s)', { n: s.errors })}"></span>`;
  }).join('');

  const medianPct = peak > 0 ? Math.round((median / peak) * 100) : 0;
  const intro = allClans
    ? tn(scans.length, 'Duration of the last {n} scans across all clans, oldest first (hover a bar for its clan). The line is the median; a bar more than three times it is marked, and a scan that never finished is drawn full height rather than as zero.', 'Duration of the last {n} scans across all clans, oldest first (hover a bar for its clan). The line is the median; a bar more than three times it is marked, and a scan that never finished is drawn full height rather than as zero.', { n: scans.length })
    : tn(scans.length, 'Duration of the last {n} scans for this clan, oldest first. The line is the median; a bar more than three times it is marked, and a scan that never finished is drawn full height rather than as zero.', 'Duration of the last {n} scans for this clan, oldest first. The line is the median; a bar more than three times it is marked, and a scan that never finished is drawn full height rather than as zero.', { n: scans.length });
  return {
    median,
    html: `
        <p class="muted-copy mb-12">${intro}</p>
        <div class="scanhealth-chart">
          <span class="scanhealth-median" style="bottom: ${medianPct}%"></span>
          ${bars}
        </div>
        <div class="scanhealth-legend">
          <span>${tn(errorScans, '{n} of {total} logged an error', '{n} of {total} logged an error', { n: errorScans, total: scans.length })}</span>
          ${live ? `<span class="scanhealth-running">${t('Scan in progress')} · ${t('{duration} so far', { duration: fmtScanDuration(live.elapsedMs ?? 0) })}</span>` : ''}
          ${unfinished > 0 ? `<span class="scanhealth-warn">${tn(unfinished, '{n} never completed', '{n} never completed', { n: unfinished })}</span>` : ''}
        </div>`,
  };
}

/**
 * Capture Health: every clan's scans by default (the scanner is one thing),
 * narrowed to one clan with the picker. The picker lists the clans present in
 * the all-clans series; picking one reloads just the chart (wireScanHealthFilter).
 */
function scanHealthCardHtml(scans) {
  const clans = scanHealthClans(scans);
  const body = scanHealthBody(scans, true);
  return `
    <details class="card card-collapsible" data-section-key="capture-health">
      <summary class="card-header"><h2>${t('Capture Health')} <span class="muted-copy" id="scanHealthMedian">${body.median !== null ? `· ${t('median {duration}', { duration: fmtScanDuration(body.median) })}` : ''}</span></h2></summary>
      <div class="card-body card-body-padded">
        ${clans.length > 1 ? `<div class="scanhealth-filter mb-12">
          <label for="scanHealthClan">${t('Clan')}</label>
          <select id="scanHealthClan" class="input input-sm">
            <option value="">${t('All clans')}</option>
            ${clans.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}
          </select>
        </div>` : ''}
        <div id="scanHealthBody">${body.html}</div>
      </div>
    </details>`;
}

function wireScanHealthFilter(root) {
  const select = root.querySelector('#scanHealthClan');
  select?.addEventListener('change', async () => {
    const v = select.value;
    const res = await api(`/admin/scan-health${v ? `?clanId=${encodeURIComponent(v)}` : ''}`).catch(() => ({ scans: [] }));
    const body = scanHealthBody(res?.scans, !v);
    const target = root.querySelector('#scanHealthBody');
    if (target) target.innerHTML = body.html;
    const med = root.querySelector('#scanHealthMedian');
    if (med) med.textContent = body.median !== null ? `· ${t('median {duration}', { duration: fmtScanDuration(body.median) })}` : '';
  });
}

// Event Schedule — corrections for runs the tbclanportal calendar feed has on
// the wrong dates (it lags the game when the game moves its rotation). One
// game-wide schedule, so a correction applies to every clan. `data` comes from
// GET /admin/event-schedule: each feed-scheduled event's recent + upcoming runs
// as the feed lists them, and the stored corrections with whether each still
// applies.
function eventScheduleCardHtml(data) {
  if (!data || data.error) {
    return `
      <details class="card card-collapsible" data-section-key="event-schedule">
        <summary class="card-header"><h2>${t('Event Schedule')}</h2></summary>
        <div class="card-body card-body-padded"><p class="muted-copy">${t('The event calendar feed is unavailable right now.')}</p></div>
      </details>
    `;
  }
  const corrections = data.corrections || [];
  const applied = corrections.filter((c) => c.active).length;
  const events = (data.events || []).filter((e) => e.runs.length > 0);
  const runOption = (e, r) => {
    const moved = r.correctedLabel ? ` → ${t('corrected to {date}', { date: r.correctedLabel })}` : '';
    return `<option value="${esc(`${e.key}|${r.feedStart}`)}">${esc(tGame(e.name))} — ${esc(r.feedLabel)}${esc(moved)}</option>`;
  };
  return `
    <details class="card card-collapsible" data-section-key="event-schedule">
      <summary class="card-header"><h2>${t('Event Schedule')} <span class="muted-copy">${applied > 0 ? `· ${tn(applied, '{n} correction applied', '{n} corrections applied', { n: applied })}` : `· ${t('calendar dates')}`}</span></h2></summary>
      <div class="card-body card-body-padded">
        <p class="muted-copy mb-12">${t('Event dates come from the <strong>tbclanportal calendar</strong>, which can lag when the game moves an event. If a run is on the wrong dates, correct it here: chests are counted into the corrected window and the Events page shows the corrected dates. Corrections apply to <strong>every clan</strong>, and each one stops applying by itself once the calendar is fixed.')}</p>
        ${corrections.length > 0 ? `
          <table class="ui-table table-responsive">
            <thead><tr><th>${t('Event')}</th><th>${t('Calendar says')}</th><th>${t('Actually')}</th><th>${t('Status')}</th><th class="col-actions"></th></tr></thead>
            <tbody>
              ${corrections.map((c) => `<tr>
                <td data-label="${t('Event')}" data-role="lead">${esc(tGame(c.eventName))}</td>
                <td data-label="${t('Calendar says')}" data-role="metric">${esc(c.feedLabel)}</td>
                <td data-label="${t('Actually')}" data-role="primary">${esc(c.actualLabel)}</td>
                <td data-label="${t('Status')}">${c.active ? t('Applied') : `<span class="muted-copy" title="${t('The calendar no longer lists a run on the original date, most likely because it was fixed. This correction does nothing now.')}">${t('Calendar caught up, safe to remove')}</span>`}</td>
                <td class="col-actions"><button class="btn btn-tight btn-danger" data-action="delete-schedule-correction" data-correction-id="${c.id}">${t('Remove')}</button></td>
              </tr>`).join('')}
            </tbody>
          </table>
        ` : `<p class="muted-copy">${t('No corrections. Every run uses the calendar\'s dates.')}</p>`}
        ${events.length > 0 ? `
          <div class="inline-form-row mt-16">
            <div>
              <label for="scheduleRun">${t('Run (as the calendar lists it)')}</label>
              <select id="scheduleRun" class="input">
                ${events.map((e) => `<optgroup label="${esc(tGame(e.name))}">${e.runs.map((r) => runOption(e, r)).join('')}</optgroup>`).join('')}
              </select>
            </div>
            <span class="arrow-sep">→</span>
            <div>
              <label for="scheduleActualDate">${t('Actually starts')}</label>
              <input type="date" id="scheduleActualDate" class="input" lang="sv">
            </div>
            <button class="btn btn-primary" data-action="save-schedule-correction">${t('Save Correction')}</button>
          </div>
          <p class="muted-copy mt-8">${t('Pick the first day of the run. Runs open at the daily reset (17:00 UTC) and keep their length.')}</p>
        ` : ''}
      </div>
    </details>
  `;
}

export async function saveScheduleCorrection(rerender) {
  const run = $('#scheduleRun')?.value || '';
  const actualDate = $('#scheduleActualDate')?.value || '';
  const sep = run.indexOf('|');
  if (sep < 0) return notify(t('Pick a run first.'), t('Save failed'));
  if (!actualDate) return notify(t('Pick the date the run actually starts.'), t('Save failed'));
  const result = await apiPut('/admin/event-schedule', {
    eventKey: run.slice(0, sep),
    feedStart: run.slice(sep + 1),
    actualDate,
  });
  if (result?.error) return notify(result.error, t('Save failed'));
  const scrollY = window.scrollY;
  if (typeof rerender === 'function') await rerender('system');
  window.scrollTo(0, scrollY);
  notify(t('Correction saved. It applies to every clan.'), t('Saved'));
}

export async function deleteScheduleCorrection(id, rerender) {
  if (!id) return;
  const ok = await confirmDialog(t('The run goes back to the calendar\'s dates for every clan.'), {
    title: t('Remove correction?'), confirmLabel: t('Remove'), danger: true,
  });
  if (!ok) return;
  const result = await apiDelete(`/admin/event-schedule/${id}`);
  if (result?.error) return notify(result.error, t('Remove failed'));
  const scrollY = window.scrollY;
  if (typeof rerender === 'function') await rerender('system');
  window.scrollTo(0, scrollY);
}

export async function renderSystem(el) {
  if (getCurrentUser()?.role !== 'superadmin') {
    el.innerHTML = `<div class="empty-state"><p>${t('Super admin access required.')}</p></div>`;
    return;
  }

  // Opening this page is the operator's acknowledgement of any prior
  // scan failure — wipe the header error badge so it doesn't linger
  // until the next successful scan. Fire-and-forget: a clear failure
  // shouldn't block rendering, and the badge will simply refresh on the
  // next /api/status poll if the request fails.
  apiPost('/admin/clear-last-scan-error', {}).catch(() => {});

  let settings;
  let backupsResp;
  let deletedClansResp;
  let logBufferResp;
  let scanHealth;
  let eventSchedule;
  try {
    [settings, backupsResp, deletedClansResp, logBufferResp, scanHealth, eventSchedule] = await Promise.all([
      api('/admin/settings'),
      api('/admin/backups').catch(() => ({ backups: [] })),
      // Lives on /api/clans, not /api/admin — the clan router owns clan state.
      fetch('/api/clans/deleted', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : { clans: [] }))
        .catch(() => ({ clans: [] })),
      api('/admin/log-buffer').catch(() => ({ entries: [] })),
      api('/admin/scan-health').catch(() => ({ scans: [] })),
      api('/admin/event-schedule').catch(() => null),
    ]);
  } catch (err) {
    // A navigation aborted this load — don't paint an error over the
    // page the user switched to; the router re-renders the live page.
    if (err?.name === 'AbortError') return;
    el.innerHTML = errorStateHtml(t('Failed to load system settings.'), err?.message || '');
    wireRetry(el, () => renderSystem(el));
    return;
  }
  const backups = Array.isArray(backupsResp?.backups) ? backupsResp.backups : [];
  const deletedClans = Array.isArray(deletedClansResp?.clans) ? deletedClansResp.clans : [];
  const logEntries = Array.isArray(logBufferResp?.entries) ? logBufferResp.entries : [];

  // Recent Warnings stays collapsed like every other card; what is new since
  // the user's last visit shows as a badge on its header instead. It used to
  // auto-open, and with roughly a warning a day it was open on nearly every
  // visit. It also counted informational entries the nav dot ignores, so it
  // opened with the dot dark. The badge counts what the dot counts: alerting
  // entries (resolved ones are no longer alerting), grouped like the list,
  // newer than the last visit. loadPage() bumps lastSeen AFTER rendering, so
  // here it still reflects the previous visit.
  const lastSeenWarningAt = getLastSeenSystemWarningAt();
  const newWarningCount = splitWarnings(logEntries).attention
    .filter((e) => Number(e.ts) > lastSeenWarningAt).length;

  const scanIntervalMinutes = settings?.scanIntervalMinutes ?? 60;
  const scanIntervalLiveApplied = !!settings?.liveApplied;
  // The page at a glance: four plain numbers, then the folded cards.
  const needsAttention = splitWarnings(logEntries).attention.length;
  const stat = (value, label, sub = '') => `<div class="ui-tile span-3 system-stat"><div class="ui-big">${value}</div><div class="ui-stat-label">${esc(label)}</div>${sub ? `<div class="ui-sub">${sub}</div>` : ''}</div>`;

  el.innerHTML = `
    <div class="ui-grid system-stats">
      ${stat(esc(tn(scanIntervalMinutes, '{n} min', '{n} min', { n: scanIntervalMinutes })), t('Scan interval'))}
      ${stat(needsAttention > 0 ? `<span aria-hidden="true">!</span> ${needsAttention}` : `<span aria-hidden="true">✓</span> 0`, t('Warnings that need attention'))}
      ${stat(String(backups.length), t('Server-side backups'), Number.isFinite(backups[0]?.mtimeMs) ? esc(t('Newest {date}', { date: formatDate(new Date(backups[0].mtimeMs).toISOString()) })) : '')}
      ${stat(String(deletedClans.length), t('Deleted clans'))}
    </div>
    <p class="ui-copy system-intro">${t('Instance-wide settings that affect every clan: scan cadence, event dates and container lifecycle. Each card is collapsed by default — click the header to expand.')}</p>

    ${scanHealthCardHtml(scanHealth?.scans)}

    <details class="card card-collapsible" data-section-key="system-scan-interval">
      <summary class="card-header"><h2>${t('Scan Interval')}</h2></summary>
      <div class="card-body card-body-padded">
        <p class="muted-copy mb-12">${t('How often the scanner pulls new chest data from the game. The scheduler iterates every active clan in sequence on each tick — keep this number high enough that one full sweep finishes inside the interval.')}</p>
        <div class="inline-form-row">
          <div>
            <label>${t('Scan Interval (minutes)')}</label>
            <input type="number" id="scanIntervalMinutes" class="input" min="1" max="1440" value="${scanIntervalMinutes}">
          </div>
          <button class="btn btn-primary" data-action="save-scan-interval">${t('Save Interval')}</button>
        </div>
        <p class="muted-copy mt-8">${scanIntervalLiveApplied ? t('Applied live to running scanner and persisted to data/app.env.') : t('Persisted to data/app.env. Will apply on next startup.')}</p>
      </div>
    </details>

    ${eventScheduleCardHtml(eventSchedule)}

    <details class="card card-collapsible" data-section-key="system-restart">
      <summary class="card-header"><h2>${t('Restart Container')}</h2></summary>
      <div class="card-body card-body-padded">
        <p class="muted-copy mb-12">${t('Gracefully exits the Node process. Docker will restart the container automatically (usually within 5–10 seconds). Use this to pick up changes that require a restart.')}</p>
        <button class="btn btn-danger" data-action="restart-container">${t('Restart Now')}</button>
        <p id="restartStatus" class="muted-copy mt-8"></p>
      </div>
    </details>

    <details class="card card-collapsible" data-section-key="${RECENT_WARNINGS_KEY}">
      <summary class="card-header"><h2>${t('Recent Warnings ({count})', { count: logEntries.length })}${newWarningCount > 0 ? ` <span class="chest-type epic">${tn(newWarningCount, '{n} new', '{n} new', { n: newWarningCount })}</span>` : ''}</h2></summary>
      <div class="card-body card-body-padded">
        <p class="muted-copy mb-12">${t('Captures every <strong>warn</strong> and <strong>error</strong> log entry the app emits. Persisted to <code>data/warnings.jsonl</code> so this survives container restarts. Newest first.')}</p>
        <div class="inline-form-row mb-12">
          <button class="btn btn-tight" data-action="refresh-log-buffer">${t('Refresh')}</button>
        </div>
        ${renderLogBufferTable(logEntries)}
      </div>
    </details>

    ${deletedClansCardHtml(deletedClans)}

    <h2 class="ui-eyebrow system-group">${t('Backup &amp; Export')}</h2>
    <p class="ui-copy system-intro">${t('Download a catalog of chest names + sources or a full database snapshot. The server also takes automatic snapshots: a daily rotation, plus one before any destructive admin action (delete user, delete clan).')}</p>

    <details class="card card-collapsible" data-section-key="system-download">
      <summary class="card-header"><h2>${t('Download Data')}</h2></summary>
      <div class="card-body card-body-padded">
        <div class="transfer-export-row">
          <a href="/api/export/catalog" class="btn">${t('Export Catalog (JSON)')}</a>
          <a href="/api/export/backup" class="btn">${t('Full DB Backup (.db)')}</a>
        </div>
        <p class="muted-copy mt-8">${t('Catalog contains every distinct chest name, source, and admin correction — intended to seed source code for new deployments. Full DB backup is a complete SQLite snapshot.')}</p>
      </div>
    </details>

    <details class="card card-collapsible" data-section-key="system-backups">
      <summary class="card-header"><h2>${t('Server-Side Backups ({count})', { count: backups.length })}</h2></summary>
      <div class="card-body card-body-padded">
        <p class="muted-copy mb-12">${t('Newest first. The server keeps a rolling set of automatic backups — daily snapshots and pre-action snapshots taken before destructive admin operations. Click <strong>Restore</strong> to swap the live database with one of these files (a pre-restore snapshot is taken automatically first).')}</p>
        <div class="inline-form-row mb-12">
          <button class="btn btn-primary" data-action="create-manual-backup">${t('Create Backup Now')}</button>
          <span class="muted-copy">${t('Saves a fresh gzipped snapshot to the same rotation (counts against the 14-file cap).')}</span>
        </div>
        ${renderBackupsTable(backups)}
      </div>
    </details>

    <details class="card card-collapsible" data-section-key="system-restore-upload">
      <summary class="card-header"><h2>${t('Restore Database Backup (Upload)')}</h2></summary>
      <div class="card-body card-body-padded">
        <div class="transfer-card transfer-card-danger">
          <h3>${t('Restore Full DB Backup (.db)')}</h3>
          <p class="muted-copy mb-12">${t('This <strong>replaces</strong> the entire database with the uploaded backup. A pre-restore backup is created automatically before the swap.')}</p>
          <div class="transfer-fields transfer-fields-single">
            <div>
              <label for="importDbBackupFile">${t('Backup File')}</label>
              <input type="file" id="importDbBackupFile" class="input" accept=".db,.db.gz,.gz,application/octet-stream,application/gzip">
            </div>
          </div>
          <div class="transfer-actions-row">
            <button class="btn btn-danger" data-action="import-db-backup" data-transfer-action="1">${t('Restore Backup')}</button>
          </div>
        </div>
      </div>
    </details>

    ${clanRestoreCardHtml(backups)}
  `;

  wireScanHealthFilter(el);
  // Repaint any in-flight import status into the freshly-rendered DOM.
  renderTransferStatus();
}

// ─── Restore a single clan out of a backup ───
//
// The two restore paths above swap the whole file, which cannot undo a clan
// deletion: every other clan would be rewound to the same moment, losing
// however many weeks of scanning have happened since. This card reads one clan
// out of a backup and adds it alongside the live data instead.

function clanRestoreCardHtml(backups) {
  const options = (backups || []).map((b) => {
    const when = formatDate(new Date(b.mtimeMs).toISOString());
    const mb = (b.bytes / (1024 * 1024)).toFixed(1);
    const label = `${when} — ${backupKindLabel(b.kind)} — ${b.fileName} (${t('{size} MB', { size: mb })})`;
    const selected = b.fileName === clanRestore.fileName ? ' selected' : '';
    return `<option value="${esc(b.fileName)}"${selected}>${esc(label)}</option>`;
  }).join('');

  const status = clanRestore.status
    ? `<div class="transfer-status transfer-status-${esc(clanRestore.status.tone || 'info')}">
         <div class="transfer-status-row"><strong>${esc(clanRestore.status.message)}</strong></div>
       </div>`
    : '';

  return `
    <details class="card card-collapsible" data-section-key="system-clan-restore">
      <summary class="card-header"><h2>${t('Restore a Single Clan')}</h2></summary>
      <div class="card-body card-body-padded">
        <p class="muted-copy mb-12">
          ${t('For a clan deleted <strong>before</strong> soft delete existed, whose rows are genuinely gone. Deleting a clan now keeps everything and is undone from <strong>Deleted Clans</strong> above — you should not normally need this card.')}
        </p>
        <p class="muted-copy mb-12">
          ${t('It pulls <strong>one clan</strong> out of a backup and adds it back next to the live data — unlike the full restores above, no other clan is rewound. Member, session and chest ids are renumbered on the way in, and chest names, sources and resource types are matched to the rows this database already has rather than duplicated.')}
        </p>
        <p class="muted-copy mb-12">
          ${t('Everything comes back: members, chests, scans, resources, snapshots, merge rules, share links, and the clan\'s <strong>user accounts with their existing passwords</strong>. A username that is already taken is left alone rather than overwritten, and a <code>superadmin</code> in the backup comes back as <code>admin</code> — both are reported after the restore.')}
        </p>

        <div class="inline-form-row mb-12">
          <div class="form-row-grow">
            <label for="clanRestoreFile">${t('Backup on the server')}</label>
            <select id="clanRestoreFile" class="input">
              <option value="">${t('Select a backup…')}</option>
              ${options}
            </select>
          </div>
          <button class="btn btn-primary" data-action="clan-restore-inspect">${t('Read clans')}</button>
        </div>

        <p class="muted-copy mb-12">
          ${t('Only backups already on the server are listed. To use one that isn\'t, copy it into the <code>data/backups</code> volume and reload this page.')}
        </p>

        <div id="clanRestoreStatus">${status}</div>
        ${clanRestoreResultsHtml()}
      </div>
    </details>
  `;
}

function clanRestoreResultsHtml() {
  const inspection = clanRestore.inspection;
  if (!inspection) return '';
  const clans = Array.isArray(inspection.clans) ? inspection.clans : [];
  if (clans.length === 0) {
    return `<p class="muted-copy">${t('That backup holds no clans.')}</p>`;
  }

  const rows = clans.map((c) => {
    const n = c.counts || {};
    const fresh = c.newestChestAt
      ? t('newest chest {date}', { date: esc(formatDate(c.newestChestAt)) })
      : t('no chests');
    // A live clan under the same name means the restore would double its rows,
    // so the server refuses it — say so here rather than letting the operator
    // find out by clicking.
    const action = c.nameTakenLive
      ? `<span class="muted-copy">${t('Already live')}</span>`
      : `<button class="btn btn-tight btn-danger" data-action="clan-restore-run"
           data-file-name="${esc(inspection.fileName || clanRestore.fileName)}"
           data-clan-id="${c.clanId}">${t('Restore')}</button>`;
    const landing = c.nameTakenLive
      ? t('a clan of this name is already live')
      : c.idTakenLive
        ? t('id {id} is taken — lands on a new id', { id: c.clanId })
        : t('lands back on id {id}', { id: c.clanId });

    return `<tr>
      <td data-label="${t('Clan')}" data-role="lead"><span class="mrow-name">${esc(c.name)}</span><span class="mrow-sub">${esc(landing)}</span></td>
      <td data-label="${t('Members')}" class="num" data-role="metric">${(n.members || 0).toLocaleString()}</td>
      <td data-label="${t('Chests')}" class="num" data-role="primary">${(n.chestRecords || 0).toLocaleString()}</td>
      <td data-label="${t('Triumphal')}" class="num" data-role="hidden">${(n.triumphalRecords || 0).toLocaleString()}</td>
      <td data-label="${t('Scans')}" class="num" data-role="hidden">${(n.scanSessions || 0).toLocaleString()}</td>
      <td data-label="${t('Resources')}" class="num" data-role="hidden">${(n.resourceTransactions || 0).toLocaleString()}</td>
      <td data-label="${t('Freshness')}" data-role="hidden">${fresh}${n.users ? ` · ${tn(n.users, '{n} user account(s)', '{n} user account(s)', { n: n.users })}` : ''}</td>
      <td class="col-actions">${action}</td>
    </tr>`;
  }).join('');

  return `
    <hr class="section-divider">
    <p class="muted-copy mb-12">${t('Clans inside {file} (schema v{version}). Counts are what the backup holds — check them against what you expect before restoring.', { file: `<code>${esc(inspection.fileName || clanRestore.fileName)}</code>`, version: esc(String(inspection.schemaVersion ?? '?')) })}</p>
    <div class="table-responsive-wrap">
      <table class="ui-table table-responsive">
        <colgroup>
          <col>
          <col style="width: 9%;">
          <col style="width: 9%;">
          <col style="width: 9%;">
          <col style="width: 8%;">
          <col style="width: 10%;">
          <col style="width: 20%;">
          <col style="width: 11%;">
        </colgroup>
        <thead>
          <tr>
            <th>${t('Clan')}</th>
            <th class="num">${t('Members')}</th>
            <th class="num">${t('Chests')}</th>
            <th class="num">${t('Triumphal')}</th>
            <th class="num">${t('Scans')}</th>
            <th class="num">${t('Resources')}</th>
            <th>${t('Freshness')}</th>
            <th>${t('Actions')}</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function setClanRestoreStatus(message, tone = 'info') {
  clanRestore.status = message ? { message, tone } : null;
  const el = $('#clanRestoreStatus');
  if (!el) return;
  el.innerHTML = clanRestore.status
    ? `<div class="transfer-status transfer-status-${esc(tone)}">
         <div class="transfer-status-row"><strong>${esc(message)}</strong></div>
       </div>`
    : '';
}

// ─── Deleted clans ───
//
// Deleting a clan hides it and keeps every row, so this card is the undo. The
// counts are what makes the promise checkable: they are read from the same
// tables the clan used while it was live, because nothing moved.

function deletedClansCardHtml(clans) {
  if (!clans || clans.length === 0) return '';

  const rows = clans.map((c) => {
    const when = c.deletedAt ? formatDate(c.deletedAt) : t('unknown');
    return `<tr>
      <td data-label="${t('Clan')}" data-role="lead"><span class="mrow-name">${esc(c.name)}</span><span class="mrow-sub">${t('deleted {date}', { date: esc(when) })}</span></td>
      <td data-label="${t('Deleted')}" data-role="hidden">${esc(when)}</td>
      <td data-label="${t('Members')}" class="num" data-role="metric">${Number(c.memberCount || 0).toLocaleString()}</td>
      <td data-label="${t('Chests')}" class="num" data-role="primary">${Number(c.chestCount || 0).toLocaleString()}</td>
      <td data-label="${t('Scans')}" class="num" data-role="hidden">${Number(c.scanCount || 0).toLocaleString()}</td>
      <td class="col-actions">
        <button class="btn btn-tight btn-primary" data-action="restore-clan"
          data-clan-id="${c.id}" data-clan-name="${esc(c.name)}">${t('Restore')}</button>
      </td>
    </tr>`;
  }).join('');

  return `
    <h2 class="ui-eyebrow system-group">${t('Deleted Clans ({count})', { count: clans.length })}</h2>
    <p class="ui-copy system-intro">${t('Deleting a clan hides it everywhere — the clan picker, the scanner, Discord, its public share link — but keeps every row. Restoring puts it back exactly as it was, on the same id and the same share link. Its members can\'t sign in to it while it sits here.')}</p>
    <details class="card card-collapsible" data-section-key="system-deleted-clans">
      <summary class="card-header"><h2>${t('Restore a Deleted Clan')}</h2></summary>
      <div class="card-body card-body-padded">
        <div class="table-responsive-wrap">
          <table class="ui-table table-responsive">
            <colgroup>
              <col>
              <col style="width: 18%;">
              <col style="width: 11%;">
              <col style="width: 11%;">
              <col style="width: 10%;">
              <col style="width: 12%;">
            </colgroup>
            <thead>
              <tr>
                <th>${t('Clan')}</th>
                <th>${t('Deleted')}</th>
                <th class="num">${t('Members')}</th>
                <th class="num">${t('Chests')}</th>
                <th class="num">${t('Scans')}</th>
                <th>${t('Actions')}</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    </details>
  `;
}

export async function restoreDeletedClan(clanId, clanName, rerender) {
  if (!Number.isFinite(clanId)) return;
  const ok = await confirmDialog(
    t('Restore "{name}"? It comes back with all of its data, on the same id and the same public share link, and its members can sign in again.', { name: clanName || t('clan #{id}', { id: clanId }) }),
    {
      title: t('Restore clan'),
      confirmLabel: t('Restore'),
      cancelLabel: t('Cancel'),
    },
  );
  if (!ok) return;

  const result = await mustOk(apiPost(`/clans/${clanId}/restore`, {}), t('Restore failed'));
  if (!result) return;
  notify(t('Restored "{name}".', { name: result.name }), t('Clan restored'));
  if (typeof rerender === 'function') await rerender('system');
}

/** Read the clan list out of the selected backup. Read-only. */
export async function inspectClanRestoreBackup(rerender) {
  const select = $('#clanRestoreFile');
  const fileName = select?.value || '';
  if (!fileName) return notify(t('Select a backup first.'), t('Restore a clan'));

  clanRestore.fileName = fileName;
  clanRestore.inspection = null;
  setClanRestoreStatus(t('Reading {file}…', { file: fileName }));

  const result = await mustOk(
    api(`/admin/backups/clans?file=${encodeURIComponent(fileName)}`),
    t('Could not read backup'),
  );
  if (!result) {
    setClanRestoreStatus(t('Could not read {file}.', { file: fileName }), 'error');
    if (typeof rerender === 'function') await rerender('system');
    return;
  }

  clanRestore.inspection = result;
  setClanRestoreStatus(tn((result.clans || []).length, '{n} clan(s) found in {file}.', '{n} clan(s) found in {file}.', { n: (result.clans || []).length, file: fileName }), 'success');
  if (typeof rerender === 'function') await rerender('system');
}

export async function runClanRestore(fileName, clanId, rerender) {
  if (!fileName || !Number.isFinite(clanId)) return;
  const summary = (clanRestore.inspection?.clans || []).find((c) => c.clanId === clanId);
  const label = summary ? t('{name} (id {id})', { name: summary.name, id: clanId }) : t('clan id {id}', { id: clanId });
  const rowParams = summary
    ? {
      members: (summary.counts?.members || 0).toLocaleString(),
      chests: (summary.counts?.chestRecords || 0).toLocaleString(),
      resources: (summary.counts?.resourceTransactions || 0).toLocaleString(),
      users: summary.counts?.users,
    }
    : null;
  const rowHint = summary
    ? `\n\n${summary.counts?.users
      ? t('{members} members, {chests} chest records, {resources} resource rows, and {users} user account(s) — restored with their existing passwords.', rowParams)
      : t('{members} members, {chests} chest records, {resources} resource rows.', rowParams)}`
    : '';

  const ok = await confirmDialog(
    `${t('Restore {label} from "{file}"?', { label, file: fileName })}${rowHint}\n\n`
    + t('This ADDS the clan back alongside the live data — no other clan is changed. A snapshot is taken first.'),
    {
      title: t('Restore clan'),
      confirmLabel: t('Continue'),
      cancelLabel: t('Cancel'),
      danger: true,
    },
  );
  if (!ok) return;

  const typed = await promptDialog(t('Type RESTORE to confirm:'), {
    title: t('Restore clan'),
    confirmLabel: t('Restore'),
    cancelLabel: t('Cancel'),
  });
  if (typed === null) return;
  if (String(typed).trim().toUpperCase() !== 'RESTORE') {
    return notify(t('Confirmation did not match — nothing was restored.'), t('Restore cancelled'));
  }

  setClanRestoreStatus(t('Restoring {label}… this can take a minute on a large backup.', { label }));
  const result = await mustOk(
    apiPost('/admin/backups/restore-clan', { fileName, clanId }),
    t('Clan restore failed'),
  );
  if (!result) {
    setClanRestoreStatus(t('Restore of {label} failed.', { label }), 'error');
    return;
  }

  const perTable = Object.entries(result.tables || {})
    .map(([table, n]) => `${table} ${Number(n).toLocaleString()}`)
    .join(', ');

  // The account outcomes are the part an operator has to act on — a skipped
  // username means somebody still can't sign in — so they go in the persistent
  // status line, not just the toast that disappears.
  const u = result.users || { restored: [], skipped: [], demoted: [] };
  const accountNotes = [];
  if (u.restored.length) accountNotes.push(tn(u.restored.length, '{n} user account(s) restored with their existing passwords', '{n} user account(s) restored with their existing passwords', { n: u.restored.length }));
  if (u.skipped.length) accountNotes.push(tn(u.skipped.length, '{n} left alone — username already in use: {names}', '{n} left alone — username already in use: {names}', { n: u.skipped.length, names: u.skipped.join(', ') }));
  if (u.demoted.length) accountNotes.push(t('restored as admin rather than superadmin: {names}', { names: u.demoted.join(', ') }));

  clanRestore.inspection = null;
  setClanRestoreStatus(
    `${t('Restored "{name}" as clan #{id} — {rows} rows.', { name: result.name, id: result.clanId, rows: Number(result.totalRows).toLocaleString() })} `
    + (accountNotes.length ? `${accountNotes.join('. ')}. ` : '')
    + t('Snapshot before the restore: {file}.', { file: result.preRestoreBackup }),
    'success',
  );
  notify(
    t('Restored "{name}" as clan #{id}: {rows} rows ({tables}).', { name: result.name, id: result.clanId, rows: Number(result.totalRows).toLocaleString(), tables: perTable }),
    t('Clan restored'),
  );
  if (typeof rerender === 'function') await rerender('system');
}

function renderBackupsTable(backups) {
  if (!backups || backups.length === 0) {
    return `<p class="muted-copy">${t('No backups on disk yet. The first daily snapshot will appear here within 24 hours, or sooner if you delete a user or clan.')}</p>`;
  }

  const rows = backups.map((b) => {
    const kb = (b.bytes / 1024).toFixed(1);
    const when = formatDate(new Date(b.mtimeMs).toISOString());
    const kindLabel = backupKindLabel(b.kind);
    return `<tr>
      <td data-label="${t('When')}" data-role="primary"><span class="mrow-name">${esc(when)}</span><span class="mrow-sub">${esc(kindLabel)}</span></td>
      <td data-label="${t('Kind')}" data-role="hidden">${esc(kindLabel)}</td>
      <td data-label="${t('File')}"><code class="muted-copy">${esc(b.fileName)}</code></td>
      <td data-label="${t('Size')}" class="num" data-role="metric">${t('{size} KB', { size: esc(kb) })}</td>
      <td class="col-actions">
        <a href="/api/admin/backups/download?file=${encodeURIComponent(b.fileName)}" class="btn btn-tight" download>${t('Download')}</a>
        <button class="btn btn-tight btn-danger" data-action="restore-server-backup" data-file-name="${esc(b.fileName)}">${t('Restore')}</button>
        <button class="btn btn-tight btn-danger" data-action="delete-server-backup" data-file-name="${esc(b.fileName)}">${t('Delete')}</button>
      </td>
    </tr>`;
  }).join('');

  return `<div class="table-responsive-wrap">
    <table class="ui-table table-responsive">
      <colgroup>
        <col style="width: 22%;">
        <col style="width: 14%;">
        <col>
        <col style="width: 12%;">
        <col style="width: 22%;">
      </colgroup>
      <thead>
        <tr>
          <th>${t('When')}</th>
          <th>${t('Kind')}</th>
          <th>${t('File')}</th>
          <th class="num">${t('Size')}</th>
          <th>${t('Actions')}</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function backupKindLabel(kind) {
  switch (kind) {
    case 'daily': return t('Daily');
    case 'pre-action': return t('Pre-delete');
    case 'pre-import': return t('Pre-restore');
    default: return t('Manual');
  }
}

function renderWarningRow(e) {
  const isError = e.levelName === 'error' || e.levelName === 'fatal';
  const levelClass = isError ? 'log-level-error' : 'log-level-warn';
  const headline = warningHeadline(e.msg);
  // Only offer the expander when there is genuinely more to read. A row whose
  // headline already is the whole message must not pretend to hide something.
  const hasMore = hasMoreThanHeadline(e.msg, headline);
  const when = formatDate(new Date(e.ts).toISOString());
  const repeat = e.count > 1
    ? `<span class="warn-repeat" title="${tn(e.count, 'Logged {n} time. The time shown is the most recent.', 'Logged {n} times. The time shown is the most recent.', { n: e.count })}">×${e.count}</span>`
    : '';
  // Resolved = the app saw the condition clear (e.g. the clan signed in
  // again). Filed under Informational by its alert flag; this says why.
  const resolved = e.resolvedAt != null
    ? ` · <span class="warn-resolved">${t('resolved {date}', { date: esc(formatDate(new Date(e.resolvedAt).toISOString())) })}</span>`
    : '';
  const meta = `<span class="warn-meta">${e.module ? esc(e.module) : 'root'} · ${esc(when)}${resolved}</span>`;
  const head = `<span class="log-level-badge ${levelClass}">${esc(e.levelName)}</span><span class="warn-headline">${esc(headline)}</span>${repeat}`;

  if (!hasMore) {
    return `<li class="warn-item">
      <div class="warn-row warn-row-flat">${head}</div>
      ${meta}
    </li>`;
  }
  // An explicit section key so an expanded row stays expanded across the
  // re-renders that any action on this page triggers. Without one, ui.js falls
  // back to the summary text with every digit stripped — and these headlines
  // differ mainly BY their digits ("wrote 2 row(s)" vs "wrote 5 row(s)"), so
  // two unrelated warnings would share a key and expand together.
  const key = esc(`warn:${e.levelName}:${e.module}:${headline}`);
  return `<li class="warn-item">
    <details class="warn-details" data-section-key="${key}">
      <summary class="warn-row">${head}</summary>
      <p class="log-message warn-full">${esc(e.msg)}</p>
    </details>
    ${meta}
  </li>`;
}

/**
 * Recent warnings, split by whether they are asking for anything.
 *
 * The split reuses the `alert` flag that already drives the System nav dot
 * (`log.warn({ noAlert: true }, ...)` at the call site), so one place decides
 * whether something is actionable rather than the UI forming a second opinion.
 * Informational starts collapsed: those entries are worth keeping and not
 * worth reading on the way to the ones that matter.
 */
function renderLogBufferTable(entries) {
  if (!entries || entries.length === 0) {
    return `<p class="muted-copy">${t('No warnings or errors recorded. The buffer fills as the app runs — empty here means smooth operation.')}</p>`;
  }
  const { attention, fyi } = splitWarnings(entries);

  const attentionHtml = attention.length === 0
    ? `<p class="muted-copy">${t('Nothing is asking for attention.')}</p>`
    : `<ul class="warn-list">${attention.map(renderWarningRow).join('')}</ul>`;

  const fyiHtml = fyi.length === 0
    ? ''
    : `<details class="warn-group" data-section-key="system-warnings-fyi">
        <summary class="warn-group-summary">${t('Informational ({count})', { count: fyi.length })}</summary>
        <ul class="warn-list mt-8">${fyi.map(renderWarningRow).join('')}</ul>
      </details>`;

  return `<div class="warn-panel">
    <h3 class="warn-group-title">${t('Needs attention ({count})', { count: attention.length })}</h3>
    ${attentionHtml}
    ${fyiHtml}
  </div>`;
}

export async function refreshLogBuffer(rerender) {
  if (typeof rerender === 'function') await rerender('system');
}

export async function deleteServerBackup(fileName, rerender) {
  if (!fileName) return;
  const ok = await confirmDialog(
    t('Delete backup "{file}"? The file is removed permanently from the server. Other backups in the rotation are not affected.', { file: fileName }),
    {
      title: t('Delete backup'),
      confirmLabel: t('Delete'),
      cancelLabel: t('Cancel'),
      danger: true,
    },
  );
  if (!ok) return;
  const result = await mustOk(apiDelete(`/admin/backups?file=${encodeURIComponent(fileName)}`), t('Delete backup failed'));
  if (!result) return;
  notify(t('Deleted {file}.', { file: fileName }), t('Backup removed'));
  if (typeof rerender === 'function') await rerender('system');
}

export async function createManualBackup(rerender) {
  const result = await mustOk(apiPost('/admin/backups', {}), t('Backup failed'));
  if (!result) return;
  const kb = ((result.bytes || 0) / 1024).toFixed(1);
  notify(t('Saved {file} ({size} KB).', { file: result.fileName, size: kb }), t('Backup created'));
  if (typeof rerender === 'function') await rerender('system');
}

export async function restoreServerBackup(fileName, rerender) {
  if (!fileName) return;
  const ok = await confirmDialog(
    t('Restore the live database from "{file}"? This replaces ALL current data with the contents of the backup. A pre-restore snapshot is taken automatically before the swap.', { file: fileName }),
    {
      title: t('Restore backup'),
      confirmLabel: t('Continue'),
      cancelLabel: t('Cancel'),
      danger: true,
    },
  );
  if (!ok) return;
  // Second-step confirmation: typing RESTORE gives a clear pause moment
  // before an irreversible swap.
  const typed = await promptDialog(
    t('Type RESTORE to confirm:'),
    {
      title: t('Restore backup'),
      confirmLabel: t('Restore'),
      cancelLabel: t('Cancel'),
    },
  );
  if (typed === null) return;
  if (String(typed).trim().toUpperCase() !== 'RESTORE') {
    return notify(t('Confirmation did not match — backup was not restored.'), t('Restore cancelled'));
  }

  const result = await mustOk(apiPost('/admin/backups/restore', { fileName }), t('Restore failed'));
  if (!result) return;
  notify(
    t('DB restored from {file}. Pre-restore snapshot saved as {snapshot}.', { file: result.restoredFrom, snapshot: result.preRestoreBackup }),
    t('Restore complete'),
  );
  if (typeof rerender === 'function') await rerender('system');
}

// ─── Scan interval ───

export async function saveScanIntervalSetting(rerender) {
  if (getCurrentUser()?.role !== 'superadmin') {
    return notify(t('Only super admins can change scanner settings.'), t('Not allowed'));
  }

  const input = $('#scanIntervalMinutes');
  if (!input) return;

  const minutes = Number.parseInt(input.value, 10);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) {
    return notify(t('Scan interval must be between 1 and 1440 minutes.'), t('Invalid interval'));
  }

  const result = await apiPut('/admin/settings/scan-interval', { scanIntervalMinutes: minutes });
  if (result.error) {
    return notify(result.error, t('Save failed'));
  }

  await notify(tn(result.scanIntervalMinutes, 'Scan interval updated to {n} minute(s).', 'Scan interval updated to {n} minute(s).', { n: result.scanIntervalMinutes }), t('Saved'));
  if (typeof rerender === 'function') rerender('system');
}

// ─── Restart container ───

export async function restartContainer() {
  const ok = await confirmDialog(t('This will restart the container. The page will reload automatically when it comes back (usually 10–30 seconds). Continue?'), {
    title: t('Restart Container'),
    confirmLabel: t('Restart'),
    danger: true,
  });
  if (!ok) return;
  const statusEl = document.getElementById('restartStatus');
  if (statusEl) {
    statusEl.textContent = t('Restarting…');
    statusEl.classList.remove('is-error', 'is-success');
  }
  try {
    await apiPost('/admin/restart', {});
  } catch {
    // Expected — connection drops as process exits
  }
  const start = Date.now();
  const poll = setInterval(async () => {
    if (Date.now() - start > 90_000) {
      clearInterval(poll);
      if (statusEl) {
        statusEl.textContent = t('Container did not come back within 90s. Check Portainer.');
        statusEl.classList.add('is-error');
      }
      return;
    }
    try {
      const r = await fetch('/api/status', { credentials: 'include' });
      if (r.ok) { clearInterval(poll); location.reload(); }
    } catch { /* still restarting */ }
  }, 2000);
}

// ─── Backup / Import / Restore ───

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function setTransferStatus(message, progress, tone = 'info') {
  transferStatus = {
    visible: true,
    message,
    progress: Math.max(0, Math.min(100, Number(progress) || 0)),
    tone,
  };
  renderTransferStatus();
}

function renderTransferStatus() {
  const statusEl = $('#transferProgress');
  if (!statusEl) return;
  if (!transferStatus.visible) {
    statusEl.innerHTML = '';
    return;
  }

  statusEl.innerHTML = `
    <div class="transfer-status transfer-status-${esc(transferStatus.tone)}">
      <div class="transfer-status-row">
        <strong>${esc(transferStatus.message)}</strong>
        <span>${transferStatus.progress}%</span>
      </div>
      <div class="transfer-progress-track">
        <div class="transfer-progress-fill" style="width:${transferStatus.progress}%"></div>
      </div>
    </div>`;
}

function setTransferActionsDisabled(disabled) {
  $$('#dataTransferSection [data-transfer-action]').forEach((el) => {
    if (el instanceof HTMLButtonElement) {
      el.disabled = disabled;
    }
  });
}

/**
 * Read an import file. If the file is gzip-compressed (.gz extension),
 * send it as base64 (the backend will detect the gzip magic bytes and
 * decompress server-side). Plain text files are sent as a string.
 */
async function readImportFile(file) {
  const isGz = file.name.toLowerCase().endsWith('.gz');
  if (isGz) {
    const buffer = await file.arrayBuffer();
    return { contentBase64: arrayBufferToBase64(buffer) };
  }
  return { content: await file.text() };
}

/**
 * Send a DB backup in raw slices, then ask the server to restore it. One
 * request per slice keeps every body far below Cloudflare's 100MB cap, which
 * a whole backup passed in Oct 2026 (see src/web/backup-upload.ts). The
 * upload fills the bar to 90%; the restore itself is the last stretch.
 * Resolves to the final response body; failures come back as `{ error }`.
 */
async function uploadDbBackup(file) {
  const start = await apiPost('/import/backup-db/start', { fileName: file.name });
  if (start.error) return start;

  const { uploadId, chunkBytes } = start;
  for (let index = 0, offset = 0; offset < file.size; index++, offset += chunkBytes) {
    const result = await api(`/import/backup-db/${encodeURIComponent(uploadId)}/${index}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file.slice(offset, offset + chunkBytes),
    });
    if (result.error) return result;
    setTransferStatus(t('Uploading backup...'), (Math.min(offset + chunkBytes, file.size) / file.size) * 90);
  }

  setTransferStatus(t('Restoring database...'), 95);
  return apiPost('/import/backup-db', { uploadId });
}

export async function runDbBackupImportFromFile(rerender) {
  const input = $('#importDbBackupFile');
  const file = input?.files?.[0];
  if (!file) return notify(t('Choose a DB backup (.db or .db.gz) file first'), t('Restore backup'));

  const lowerName = file.name.toLowerCase();
  if (!lowerName.endsWith('.db') && !lowerName.endsWith('.db.gz') && !lowerName.endsWith('.gz')) {
    return notify(t('Please select a .db or .db.gz backup file.'), t('Restore backup'));
  }

  const confirmed = await confirmDialog(
    t('Restore full database from "{file}"?\n\nThis will replace all current data.\nA pre-restore backup will be created automatically.', { file: file.name }),
    {
      title: t('Restore Database Backup'),
      confirmLabel: t('Restore'),
      danger: true,
    }
  );
  if (!confirmed) return;

  setTransferActionsDisabled(true);
  setTransferStatus(t('Uploading backup...'), 0);

  try {
    const result = await uploadDbBackup(file);

    if (result.error) {
      setTransferStatus(result.error, 100, 'error');
      return notify(result.error, t('Restore failed'));
    }

    setTransferStatus(t('Database restore completed'), 100, 'success');
    notify(t('DB restore complete from {file}. Pre-restore backup: {snapshot}', { file: result.restoredFrom, snapshot: result.preRestoreBackup }), t('Restore success'));
    if (typeof rerender === 'function') rerender('users');
  } finally {
    setTransferActionsDisabled(false);
  }
}

