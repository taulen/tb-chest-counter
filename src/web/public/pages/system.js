// System — superadmin-only instance-wide settings: scan interval,
// scanner debug, OCR calibration wizard, restart-container, plus the
// Backup & Export / Import Data sections.
//
// The calibration wizard lives here because its UI is rendered as part
// of renderSystem and its module-local state (the in-progress
// CalibrationState object) only matters while the operator is on this
// page. Closing the page abandons the in-flight calibration.

import { api, apiPost, apiPut, apiDelete, mustOk } from '../lib/api.js';
import { $, $$, esc, notify, confirmDialog, promptDialog, formatDate, forgetDetailsState, prefersReducedMotion } from '../lib/ui.js';
import { getCurrentUser, getLastSeenSystemWarningAt } from '../lib/state.js';
import { warningHeadline, hasMoreThanHeadline, splitWarnings } from '../lib/warning-digest.js';
import { t, tn, tGame, getLanguage } from '../lib/i18n.js';

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

// Stable key for the Recent Warnings <details> card. Used both as the
// data-section-key attribute (so the persisted-state map keys off this
// rather than the count-bearing summary text) and as the argument to
// forgetDetailsState below — when there are NEW warnings since the
// last visit we want the inline `open` to win even if the user had
// previously collapsed the card.
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

// In-progress calibration. Shape:
//   {
//     stage: 'main' | 'sidebars' | 'gifts' | 'members' | 'worldmap' | 'capital',
//     canvasBounds, imageNaturalWidth, imageNaturalHeight,
//     activeTarget: string | null,
//     marks: { [targetName]: { kind: 'click', xPct, yPct }
//                          | { kind: 'crop', leftPct, topPct, rightPct, bottomPct } },
//     drag: { startCssX, startCssY, startNaturalX, startNaturalY, moved } | null,
//   }
let calibrationState = null;

// ─── renderSystem ───

/**
 * Capture health: how long scans take and how often they error, over time.
 *
 * scan_sessions has always been a flat list plus one dashboard tile. As a
 * series it is a different thing — duration creeping up over weeks is how a
 * wedged browser announces itself before it costs anyone a five-hour scan, and
 * an error rate that climbs is usually calibration drifting rather than the
 * game changing.
 *
 * A trailing-median band, not an average: one five-hour outlier drags a mean
 * far enough that every normal scan afterwards looks fast by comparison, which
 * is precisely backwards.
 */
function scanHealthCardHtml(scans) {
  if (!Array.isArray(scans) || scans.length < 3) {
    return `
      <details class="card card-collapsible" data-section-key="capture-health">
        <summary class="card-header"><h2>${t('Capture Health')}</h2></summary>
        <div class="card-body card-body-padded">
          <div class="empty-state"><p>${t('Not enough scans recorded yet to show a trend.')}</p></div>
        </div>
      </details>`;
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
  const unfinished = scans.filter((s) => s.durationMs === null).length;

  const fmtMin = (ms) => t('{minutes}m', { minutes: Math.round(ms / 60000) });

  const bars = scans.map((s) => {
    // An unfinished scan is drawn as a full-height marked bar. Plotting it as
    // zero would render the worst outcome as the fastest one.
    if (s.durationMs === null) {
      return `<span class="scanhealth-bar is-unfinished" style="height: 100%"
                title="${s.startedAt} · ${SCAN_STATUS_LABELS[s.status] ?? s.status} · ${t('never completed')}"></span>`;
    }
    const h = Math.max(2, Math.round((s.durationMs / peak) * 100));
    const slow = median > 0 && s.durationMs > median * 3;
    return `<span class="scanhealth-bar${slow ? ' is-slow' : ''}${s.errors > 0 ? ' has-errors' : ''}"
              style="height: ${h}%"
              title="${s.startedAt} · ${fmtMin(s.durationMs)} · ${tn(s.chests, '{n} chest', '{n} chests', { n: s.chests })} · ${tn(s.errors, '{n} error(s)', '{n} error(s)', { n: s.errors })}"></span>`;
  }).join('');

  const medianPct = peak > 0 ? Math.round((median / peak) * 100) : 0;

  return `
    <details class="card card-collapsible" data-section-key="capture-health">
      <summary class="card-header"><h2>${t('Capture Health')} <span class="muted-copy">· ${t('median {duration}', { duration: fmtMin(median) })}</span></h2></summary>
      <div class="card-body card-body-padded">
        <p class="muted-copy mb-12">
          ${tn(scans.length, 'Duration of the last {n} scans for this clan, oldest first. The line is the median; a bar more than three times it is marked, and a scan that never finished is drawn full height rather than as zero. Chests-per-screenshot is deliberately absent — screenshots_taken stays at zero on the partial-keep path, so the ratio divides by zero on exactly the aborted scans worth looking at.', 'Duration of the last {n} scans for this clan, oldest first. The line is the median; a bar more than three times it is marked, and a scan that never finished is drawn full height rather than as zero. Chests-per-screenshot is deliberately absent — screenshots_taken stays at zero on the partial-keep path, so the ratio divides by zero on exactly the aborted scans worth looking at.', { n: scans.length })}
        </p>
        <div class="scanhealth-chart">
          <span class="scanhealth-median" style="bottom: ${medianPct}%"></span>
          ${bars}
        </div>
        <div class="scanhealth-legend">
          <span>${tn(errorScans, '{n} of {total} logged an error', '{n} of {total} logged an error', { n: errorScans, total: scans.length })}</span>
          ${unfinished > 0 ? `<span class="scanhealth-warn">${tn(unfinished, '{n} never completed', '{n} never completed', { n: unfinished })}</span>` : ''}
        </div>
      </div>
    </details>`;
}

/**
 * The stages, in the order the wizard runs them. Falls back to this shape when
 * /admin/calibration couldn't be read, so the checklist degrades to "nothing
 * done yet" rather than disappearing.
 */
const STAGE_FALLBACK = [
  { key: 'main', number: 1, label: 'Main map', required: true, complete: false },
  { key: 'sidebars', number: 2, label: 'My Clan sidebars', required: true, complete: false },
  { key: 'gifts', number: 3, label: 'Gifts panel', required: true, complete: false },
  { key: 'members', number: 4, label: 'Members list', required: true, complete: false },
  { key: 'worldmap', number: 5, label: 'World map', required: false, complete: false },
  { key: 'capital', number: 6, label: 'Capital history', required: false, complete: false },
];

// Display labels by stage key — the server's /admin/calibration list carries
// the same English labels, so translate by key rather than by the text.
const STAGE_LABELS = {
  main: t('Main map'),
  sidebars: t('My Clan sidebars'),
  gifts: t('Gifts panel'),
  members: t('Members list'),
  worldmap: t('World map'),
  capital: t('Capital history'),
};

function stageLabel(stage) {
  return STAGE_LABELS[stage.key] ?? stage.label;
}

function stageList(calibration) {
  const list = calibration?.stages?.list;
  return Array.isArray(list) && list.length ? list : STAGE_FALLBACK;
}

/** True while a stage a SCAN needs is still outstanding. Drives the card's
 *  attention styling and its default-open state — the optional resource stages
 *  deliberately don't, or an instance that never wanted resource capture would
 *  be nagged forever. */
function calibrationOutstanding(calibration) {
  return stageList(calibration).some((s) => s.required && !s.complete);
}

function calibrationHeaderBadge(calibration) {
  const stages = stageList(calibration);
  const required = stages.filter((s) => s.required);
  const done = required.filter((s) => s.complete).length;
  if (done < required.length) {
    return `<span class="chest-type epic">${t('Action required · {done}/{total}', { done, total: required.length })}</span>`;
  }
  const optionalDone = stages.filter((s) => !s.required && s.complete).length;
  const optionalTotal = stages.filter((s) => !s.required).length;
  return `<span class="muted-copy">· ${optionalDone < optionalTotal ? tn(optionalTotal - optionalDone, 'scanning ready, {n} optional stage left', 'scanning ready, {n} optional stages left', { n: optionalTotal - optionalDone }) : t('scanning ready')}</span>`;
}

/** Stage buttons carrying their own state: done, next up, or not started.
 *  Previously six identical buttons, which said nothing about where you were. */
function stageButtonsHtml(calibration) {
  const stages = stageList(calibration);
  const nextRequired = stages.find((s) => s.required && !s.complete);
  return stages.map((s) => {
    const isNext = nextRequired && s.key === nextRequired.key;
    const cls = ['btn', 'calibration-stage-btn'];
    if (isNext) cls.push('btn-primary');
    if (s.complete) cls.push('is-complete');
    const mark = s.complete ? '✓' : (isNext ? '▶' : '○');
    return `<button class="${cls.join(' ')}" data-action="calibrate-stage" data-stage="${esc(s.key)}"${isNext ? ' data-next-stage="1"' : ''}${s.required ? '' : ` title="${t('Only needed for automated resource collection')}"`}>`
      + `<span class="calibration-stage-mark">${mark}</span> ${t('Stage {number} · {label}', { number: s.number, label: esc(stageLabel(s)) })}`
      + `${s.required ? '' : ` <span class="muted-copy">${t('(optional)')}</span>`}</button>`;
  }).join('');
}

/**
 * The top-of-page setup checklist.
 *
 * The banner used to hand the operator to /system and stop there — the wizard
 * is one collapsed card among a dozen, mid-page, and its six identical stage
 * buttons gave no hint which to press. This puts the ordered steps at the top
 * of the page, says which one is next, and starts it in one click.
 *
 * Renders nothing once everything required is done, so it is a setup aid and
 * not permanent furniture.
 */
function setupChecklistHtml(calibration, status) {
  const stages = stageList(calibration);
  const required = stages.filter((s) => s.required);
  const done = required.filter((s) => s.complete).length;
  const nextRequired = required.find((s) => !s.complete);

  // memberCaptureDone is null when the request failed or no clan is in scope;
  // treat unknown as done so a failed read can't invent a step.
  const memberCaptureDone = status?.onboarding?.memberCaptureDone !== false;
  const everythingDone = !nextRequired && memberCaptureDone;
  if (everythingDone) return '';

  // The mark on each row is the STAGE number, not this list's position.
  // Numbering the rows 1..5 made the member-capture row read as "Stage 5",
  // which is the world-map stage the footnote right below it calls optional —
  // so the list appeared to contradict itself. Only calibration stages carry a
  // number now; the capture is a different kind of step and gets its own glyph.
  const steps = required.map((s) => ({
    mark: String(s.number),
    label: t('Stage {number} · {label}', { number: s.number, label: stageLabel(s) }),
    complete: s.complete,
    action: `<button class="btn btn-sm${nextRequired && nextRequired.key === s.key ? ' btn-primary' : ''}" data-action="calibrate-stage" data-stage="${esc(s.key)}">${s.complete ? t('Re-run') : t('Start')}</button>`,
  }));
  steps.push({
    mark: '👥',
    label: t('Capture the clan member list'),
    complete: memberCaptureDone,
    // Blocked until calibration is done — the capture drives the game through
    // the positions the wizard teaches it, so offering it earlier only buys a
    // failed run.
    action: nextRequired
      ? `<span class="muted-copy">${t('after calibration')}</span>`
      : `<a class="btn btn-sm${memberCaptureDone ? '' : ' btn-primary'}" href="#clans">${t('Open Clans')}</a>`,
  });

  const totalDone = steps.filter((s) => s.complete).length;
  const nextIndex = steps.findIndex((s) => !s.complete);

  return `
    <div class="card card-attention setup-checklist" id="setupChecklist">
      <div class="card-body card-body-padded">
        <h2 class="setup-checklist-title">${t('Finish setting up the scanner')} <span class="chest-type epic">${t('{done} of {total} done', { done: totalDone, total: steps.length })}</span></h2>
        <p class="muted-copy mb-12">${t('Scans stay paused until these are complete. Each stage shows the scanner a screenshot of your game and asks you to click on one or two things.')}</p>
        <ol class="setup-checklist-list">
          ${steps.map((s, i) => `
            <li class="setup-checklist-step${s.complete ? ' is-complete' : ''}${i === nextIndex ? ' is-next' : ''}">
              <span class="setup-checklist-mark">${s.complete ? '✓' : s.mark}</span>
              <span class="setup-checklist-label">${esc(s.label)}</span>
              <span class="setup-checklist-action">${s.action}</span>
            </li>`).join('')}
        </ol>
        <p class="muted-copy mt-12">${t('Stages 5 and 6 (world map, capital history) are not listed here because nothing above needs them — they exist only for automated resource collection, and live in Scanner Calibration below.')}</p>
      </div>
    </div>
  `;
}

/**
 * Where the onboarding banner lands.
 *
 * The checklist at the top of the page IS the entry point when setup is
 * outstanding, and the render has already scrolled the page to it — so
 * scrolling on DOWN to the wizard walks straight past the thing the banner was
 * sending them to. Flash the checklist and stop there.
 *
 * The wizard is still the destination once the checklist has retired itself
 * (a later re-run of a stage, or the optional resource stages), since then
 * there is nothing at the top of the page to land on.
 */
export function focusSetupTarget() {
  const checklist = document.getElementById('setupChecklist');
  if (!checklist) {
    focusCalibrationCard();
    return;
  }
  flashElement(checklist);
}

/** A short outline pulse, so the eye lands on what was just asked for.
 *  Re-triggerable: the class has to come off, force a reflow, go back on, or a
 *  second request on an already-flashed element does nothing. */
function flashElement(el) {
  if (!el) return;
  el.classList.remove('is-flashing');
  void el.offsetWidth;
  el.classList.add('is-flashing');
  setTimeout(() => el.classList.remove('is-flashing'), 2000);
}

/**
 * Open the calibration card, bring it on screen and flash it.
 *
 * Used by the checklist's Start buttons — starting a stage needs the wizard's
 * screenshot canvas on screen — and as the banner's fallback when no checklist
 * is rendered.
 */
export function focusCalibrationCard({ scroll = true, flash = true } = {}) {
  const card = document.getElementById('calibrationCard');
  if (!card) return;
  card.open = true;
  if (scroll) card.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
  if (flash) flashElement(card);
}

/** Roughly: is the calibration card already where the operator is looking?
 *  Used to decide whether starting a stage needs to scroll and flash, or
 *  whether doing so would just be a jolt. */
function isCalibrationCardInView() {
  const card = document.getElementById('calibrationCard');
  if (!card) return false;
  const rect = card.getBoundingClientRect();
  return rect.top >= 0 && rect.top < window.innerHeight * 0.6;
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
          <table class="table-responsive">
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

export async function renderSystem(el, options = {}) {
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
  let scannerSettings;
  let backupsResp;
  let deletedClansResp;
  let logBufferResp;
  let rawOcrCapture;
  let mightSettings;
  let resourceCapture;
  let scanHealth;
  let calibration;
  let status;
  let eventSchedule;
  try {
    [settings, scannerSettings, backupsResp, deletedClansResp, logBufferResp, rawOcrCapture, mightSettings,
     resourceCapture, scanHealth, calibration, status, eventSchedule] = await Promise.all([
      api('/admin/settings'),
      api('/admin/scanner-settings').catch(() => null),
      api('/admin/backups').catch(() => ({ backups: [] })),
      // Lives on /api/clans, not /api/admin — the clan router owns clan state.
      fetch('/api/clans/deleted', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : { clans: [] }))
        .catch(() => ({ clans: [] })),
      api('/admin/log-buffer').catch(() => ({ entries: [] })),
      api('/admin/settings/raw-ocr-capture').catch(() => ({ enabled: false, capturedCounts: { chestRecords: 0, triumphalChestRecords: 0 } })),
      api('/might/settings').catch(() => ({ enabled: false, calibrated: false, cropIncludesMight: false, lastCapture: null })),
      api('/admin/resource-capture').catch(() => ({ enabled: false, calibrated: false, missingTargets: [] })),
      api('/admin/scan-health').catch(() => ({ scans: [] })),
      // Which calibration stages are done, and — from /status — whether this
      // clan still needs its member list captured. Both drive the setup
      // checklist at the top of the page.
      api('/admin/calibration').catch(() => null),
      api('/status').catch(() => null),
      api('/admin/event-schedule').catch(() => null),
    ]);
  } catch (err) {
    // A navigation aborted this load — don't paint an error over the
    // page the user switched to; the router re-renders the live page.
    if (err?.name === 'AbortError') return;
    el.innerHTML = `<div class="empty-state"><p>${t('Failed to load system settings.')}</p></div>`;
    return;
  }
  const backups = Array.isArray(backupsResp?.backups) ? backupsResp.backups : [];
  const deletedClans = Array.isArray(deletedClansResp?.clans) ? deletedClansResp.clans : [];
  const logEntries = Array.isArray(logBufferResp?.entries) ? logBufferResp.entries : [];

  // Auto-open Recent Warnings if anything has been logged since the
  // user's last visit to this page. loadPage() bumps lastSeen AFTER
  // restoreDetailsState runs, so on every render lastSeen still
  // reflects the previous visit — exactly what we want to compare
  // against. forgetDetailsState clears any persisted collapse so the
  // inline `open` we add below isn't immediately overridden.
  const lastSeenWarningAt = getLastSeenSystemWarningAt();
  const hasNewWarnings = logEntries.some((e) => Number(e.ts) > lastSeenWarningAt);
  if (hasNewWarnings) forgetDetailsState(RECENT_WARNINGS_KEY);

  const scanIntervalMinutes = settings?.scanIntervalMinutes ?? 60;
  const scanIntervalLiveApplied = !!settings?.liveApplied;

  el.innerHTML = `
    <p class="page-section-intro">${t('Instance-wide settings that affect every clan: scanner cadence, OCR calibration, and container lifecycle. Each card is collapsed by default — click the header to expand.')}</p>

    ${setupChecklistHtml(calibration, status)}

    ${scanHealthCardHtml(scanHealth?.scans)}

    <details class="card card-collapsible">
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

    <details class="card card-collapsible" data-section-key="raw-ocr-capture">
      <summary class="card-header"><h2>${t('Raw OCR Capture')} <span class="muted-copy">· ${rawOcrCapture?.enabled ? t('enabled') : t('disabled')}</span></h2></summary>
      <div class="card-body card-body-padded">
        <p class="muted-copy mb-12">${t('Persist the raw OCR\'d player name on every chest record so you can later diagnose "why did this scan land on member X" — e.g. an OCR misread getting merged into an unrelated member. Off by default because the extra TEXT column accumulates one row per scanned chest.')}</p>
        <p class="muted-copy mb-12">${t('When disabled, captured rows are wiped so the column doesn\'t sit there eating space.')}</p>
        <div class="inline-form-row">
          ${rawOcrCapture?.enabled
            ? `<button class="btn btn-danger" data-action="raw-ocr-capture-disable">${t('Disable &amp; purge captured data')}</button>
               <span class="muted-copy">${t('Currently capturing — {chests} chest rows, {triumphals} triumphal rows have raw OCR attached.', { chests: (rawOcrCapture.capturedCounts?.chestRecords ?? 0).toLocaleString(), triumphals: (rawOcrCapture.capturedCounts?.triumphalChestRecords ?? 0).toLocaleString() })}</span>`
            : `<button class="btn btn-primary" data-action="raw-ocr-capture-enable">${t('Enable capture')}</button>
               ${((rawOcrCapture?.capturedCounts?.chestRecords ?? 0) + (rawOcrCapture?.capturedCounts?.triumphalChestRecords ?? 0)) > 0
                 ? `<span class="muted-copy">${t('{chests} chest rows + {triumphals} triumphal rows still hold captured OCR. Toggling on will overwrite older captures as new scans run; toggling off again purges them.', { chests: (rawOcrCapture.capturedCounts.chestRecords).toLocaleString(), triumphals: (rawOcrCapture.capturedCounts.triumphalChestRecords).toLocaleString() })}</span>`
                 : `<span class="muted-copy">${t('View captured OCR per member from the member detail page once a few scans have run.')}</span>`}`}
        </div>
      </div>
    </details>

    <details class="card card-collapsible" data-section-key="might-tracking">
      <summary class="card-header"><h2>${t('Might Tracking')} <span class="muted-copy">· ${mightSettings?.enabled ? t('enabled') : t('disabled')}</span></h2></summary>
      <div class="card-body card-body-padded">
        <p class="muted-copy mb-12">${t('Read every member\'s might (power level) off the in-game member list once per game day and store it, so growth over time can be charted. Runs after the chest scan has already committed, so a failure here can never affect chest or gift data.')}</p>
        <p class="muted-copy mb-12">${t('Uses the <strong>Stage 4</strong> member-list rectangle. Capture stays blocked until that rectangle has been re-saved with the might column inside it — the old instructions told you to exclude it, so every existing calibration needs one re-run.')}</p>
        ${mightSettings?.cropIncludesMight
          ? ''
          : `<p class="muted-copy mb-12">${t('<strong>Blocked:</strong> the saved Stage 4 rectangle predates might tracking. Open Scanner Calibration below, run Stage 4, and drag the rectangle right so it includes the number beside the shield icon.')} ${mightSettings?.calibrated ? '' : t('(Stage 4 has never been calibrated at all.)')}</p>`}
        <div class="inline-form-row">
          ${mightSettings?.enabled
            ? `<button class="btn btn-danger" data-action="might-tracking-disable">${t('Disable capture')}</button>
               ${mightSettings.cropIncludesMight
                 ? `<button class="btn" data-action="might-recapture">${t('Re-capture now')}</button>`
                 : ''}
               <span class="muted-copy">${mightSettings.cropIncludesMight
                 ? (mightSettings.lastCapture
                     ? t('Last captured on game day {date}. "Re-capture now" clears the once-a-day gate for every active clan, so their next scan refreshes today\'s readings.', { date: mightSettings.lastCapture.gameDate })
                     : t('Enabled — the first snapshot lands on the next scan cycle after the game-day rollover.'))
                 : t('Enabled, but waiting on a Stage 4 re-calibration before it will read anything.')}</span>`
            : `<button class="btn btn-primary" data-action="might-tracking-enable">${t('Enable capture')}</button>
               <span class="muted-copy">${t('Existing snapshots are always kept when disabling — the value of this data is its history.')}</span>`}
        </div>
      </div>
    </details>

    <details class="card card-collapsible" data-section-key="resource-capture">
      <summary class="card-header"><h2>${t('Automated Resource Collection')} <span class="muted-copy">· ${resourceCapture?.enabled ? t('enabled') : t('disabled')}</span></h2></summary>
      <div class="card-body card-body-padded">
        <p class="muted-copy mb-12">${t('Read each clan\'s Clan Capital → History list off the game once per game day instead of relying on uploaded screenshots. Runs after the chest scan and the might snapshot have committed, so a failure here cannot affect chest, gift or might data.')}</p>
        <p class="muted-copy mb-12">${t('This switch is <strong>instance-wide</strong>. Each clan still needs resource tracking turned on individually under <strong>Clans → Resource Tracking</strong>, which is also where you\'ll find the manual collect and diagnostic controls for a single clan.')}</p>
        ${resourceCapture?.calibrated
          ? ''
          : `<p class="muted-copy mb-12">${t('<strong>Blocked:</strong> the world-map chain isn\'t calibrated. Outstanding: {targets}. Complete Stage 5 and Stage 6 below (plus the MAP button in Stage 1).', { targets: esc((resourceCapture?.missingTargets ?? []).join('; ')) })}</p>`}
        <div class="inline-form-row">
          ${resourceCapture?.enabled
            ? `<button class="btn btn-danger" data-action="resource-capture-disable">${t('Disable capture')}</button>
               <span class="muted-copy">${t('Everything already recorded is kept when disabling — the value of this data is its history.')}</span>`
            : `<button class="btn btn-primary" data-action="resource-capture-enable" ${resourceCapture?.calibrated ? '' : 'disabled'}>${t('Enable capture')}</button>
               <span class="muted-copy">${resourceCapture?.calibrated
                 ? t('Prove a clan out first with "Collect now" on the Clans page, then enable the daily run here.')
                 : t('Calibrate Stages 5 and 6 before enabling.')}</span>`}
        </div>
      </div>
    </details>

    ${eventScheduleCardHtml(eventSchedule)}

    <details class="card card-collapsible${calibrationOutstanding(calibration) ? ' card-attention' : ''}" id="calibrationCard" data-section-key="scanner-calibration"${calibrationOutstanding(calibration) ? ' open' : ''}>
      <summary class="card-header">
        <h2>${t('Scanner Calibration')} ${calibrationHeaderBadge(calibration)}</h2>
      </summary>
      <div class="card-body card-body-padded">
        <p class="muted-copy mb-12">${t('Six short stages teach the scanner where to click on your game UI. Each stage is independent — re-run any stage if the game UI shifts. Resolution-independent: the same calibration works at 1920×1080 and 1600×900. Stages 5 and 6 are only needed for automated resource collection; chest scanning works without them.')}</p>

        <div class="mb-16">
          <label>${t('Max chests per scan')} <span class="muted-copy">(100–10,000)</span></label>
          <input type="number" id="scannerMaxChests" class="input input-narrow" min="100" max="10000" step="100" value="${Number.isFinite(scannerSettings?.scanMaxChests) ? scannerSettings.scanMaxChests : 2000}">
          <p class="muted-copy mt-4">${t('Safety ceiling on a single sweep of a tab, not a target — a normal scan stops when the Gifts tab runs dry, well below this. Rounded up to a whole batch of 4 clicks. Raising it also raises the capture-phase time budget, so a long-but-healthy sweep isn’t cut short.')}</p>
        </div>

        <div class="mb-16">
          <label>${t('Debug screenshots — first N iterations')} <span class="muted-copy">${t('(0–100, 0 = off)')}</span></label>
          <input type="number" id="scannerDebugFirstN" class="input input-narrow" min="0" max="100" step="1" value="${Number.isFinite(scannerSettings?.scanDebugFirstN) ? scannerSettings.scanDebugFirstN : 10}">
          <p class="muted-copy mt-4">${t('Save annotated PNGs of the first N scanner iterations to <code>data/screenshots/</code>. Useful for verifying the click target lands correctly.')}</p>
        </div>

        <div class="inline-form-row mb-16">
          <button class="btn btn-primary" data-action="save-scanner-settings">${t('Save Settings')}</button>
        </div>

        <hr class="section-divider">

        <div id="calibrationWizardStatus" class="mb-12"></div>

        <div id="calibrationStageButtons" class="inline-form-row mb-12">
          ${stageButtonsHtml(calibration)}
        </div>

        <p id="calibrationStageInstruction" class="muted-copy mb-12" style="display: none;"></p>
        <!-- Worked example for the selected stage, injected by
             renderCalibrationExample(). -->
        <p id="calibrationExample" class="mb-12"></p>

        <div class="inline-form-row mb-12" id="calibrationCaptureRow" style="display: none;">
          <button class="btn" id="captureScreenshotBtn" data-action="capture-calibration-screenshot">${t('Capture new screenshot')}</button>
          <!-- Reset sits here rather than beside Save Stage so it's reachable as soon
               as a stage is picked. Next to Save it would only appear once a
               screenshot had loaded, i.e. after a ~60s capture you don't need just to
               clear a bad mark. -->
          <button class="btn btn-danger" data-action="reset-calibration-stage">${t('Reset Stage')}</button>
          <span id="calibrationStatus" class="muted-copy"></span>
        </div>

        <div id="calibrationCanvas" class="calibration-canvas" style="display: none;">
          <div id="calibrationTargetToolbar" class="inline-form-row mb-12"></div>
          <p id="calibrationActiveTargetHint" class="muted-copy mb-8"></p>
          <div id="calibrationImageWrapper" class="calibration-image-wrapper">
            <img id="calibrationImage" class="calibration-image" alt="${t('Calibration screenshot')}" draggable="false">
            <svg id="calibrationOverlay" class="calibration-overlay"></svg>
          </div>
          <div class="inline-form-row mt-12">
            <button class="btn btn-primary" data-action="save-calibration" disabled id="saveCalibrationBtn">${t('Save Stage')}</button>
            <button class="btn" data-action="cancel-calibration">${t('Cancel')}</button>
            <span id="calibrationSaveHint" class="muted-copy"></span>
          </div>
        </div>
      </div>
    </details>

    <details class="card card-collapsible">
      <summary class="card-header"><h2>${t('Restart Container')}</h2></summary>
      <div class="card-body card-body-padded">
        <p class="muted-copy mb-12">${t('Gracefully exits the Node process. Docker will restart the container automatically (usually within 5–10 seconds). Use this to pick up changes that require a restart.')}</p>
        <button class="btn btn-danger" data-action="restart-container">${t('Restart Now')}</button>
        <p id="restartStatus" class="muted-copy mt-8"></p>
      </div>
    </details>

    <details class="card card-collapsible" data-section-key="${RECENT_WARNINGS_KEY}"${hasNewWarnings ? ' open' : ''}>
      <summary class="card-header"><h2>${t('Recent Warnings ({count})', { count: logEntries.length })}</h2></summary>
      <div class="card-body card-body-padded">
        <p class="muted-copy mb-12">${t('Captures every <strong>warn</strong> and <strong>error</strong> log entry the app emits. Persisted to <code>data/warnings.jsonl</code> so this survives container restarts. Newest first.')}</p>
        <div class="inline-form-row mb-12">
          <button class="btn btn-tight" data-action="refresh-log-buffer">${t('Refresh')}</button>
        </div>
        ${renderLogBufferTable(logEntries)}
      </div>
    </details>

    ${deletedClansCardHtml(deletedClans)}

    <h2 class="page-section-title">${t('Backup &amp; Export')}</h2>
    <p class="page-section-intro">${t('Download a catalog of chest names + sources or a full database snapshot. The server also takes automatic snapshots: a daily rotation, plus one before any destructive admin action (delete user, delete clan).')}</p>

    <details class="card card-collapsible">
      <summary class="card-header"><h2>${t('Download Data')}</h2></summary>
      <div class="card-body card-body-padded">
        <div class="transfer-export-row">
          <a href="/api/export/catalog" class="btn">${t('Export Catalog (JSON)')}</a>
          <a href="/api/export/backup" class="btn">${t('Full DB Backup (.db)')}</a>
        </div>
        <p class="muted-copy mt-8">${t('Catalog contains every distinct chest name, source, and admin correction — intended to seed source code for new deployments. Full DB backup is a complete SQLite snapshot.')}</p>
      </div>
    </details>

    <details class="card card-collapsible">
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

    <details class="card card-collapsible">
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

  // Repaint any in-flight import status into the freshly-rendered DOM.
  renderTransferStatus();

  // #system/calibration (the onboarding banner's button) lands here. Open the
  // wizard and scroll to it — dropping the operator at the top of a page whose
  // calibration card is collapsed five cards down is the complaint this whole
  // path exists to answer. Deferred a frame so restoreDetailsState, which runs
  // after this render, can't immediately collapse what we just opened.
  if (options.focus === 'calibration') {
    requestAnimationFrame(() => focusSetupTarget());
  }
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
      <table class="table-responsive">
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
    <h2 class="page-section-title">${t('Deleted Clans ({count})', { count: clans.length })}</h2>
    <p class="page-section-intro">${t('Deleting a clan hides it everywhere — the clan picker, the scanner, Discord, its public share link — but keeps every row. Restoring puts it back exactly as it was, on the same id and the same share link. Its members can\'t sign in to it while it sits here.')}</p>
    <details class="card card-collapsible" data-section-key="system-deleted-clans" open>
      <summary class="card-header"><h2>${t('Restore a Deleted Clan')}</h2></summary>
      <div class="card-body card-body-padded">
        <div class="table-responsive-wrap">
          <table class="table-responsive">
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
    <table class="table-responsive">
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

// ─── Scan interval / scanner settings ───

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

export async function saveScannerSettings(rerender) {
  if (getCurrentUser()?.role !== 'superadmin') {
    return notify(t('Only super admins can change scanner settings.'), t('Not allowed'));
  }
  const debugRaw = document.getElementById('scannerDebugFirstN')?.value;
  const scanDebugFirstN = Number.parseInt(debugRaw, 10);
  if (!Number.isFinite(scanDebugFirstN) || scanDebugFirstN < 0 || scanDebugFirstN > 100) {
    return notify(t('Debug first-N must be a number between 0 and 100.'), t('Invalid value'));
  }
  const maxRaw = document.getElementById('scannerMaxChests')?.value;
  const scanMaxChests = Number.parseInt(maxRaw, 10);
  if (!Number.isFinite(scanMaxChests) || scanMaxChests < 100 || scanMaxChests > 10000) {
    return notify(t('Max chests per scan must be a number between 100 and 10,000.'), t('Invalid value'));
  }
  const result = await apiPut('/admin/scanner-settings', { scanDebugFirstN, scanMaxChests });
  if (result?.error) {
    return notify(result.error, t('Save failed'));
  }
  await notify(t('Scanner settings saved.'), t('Saved'));
  if (typeof rerender === 'function') rerender('system');
}

export async function toggleRawOcrCapture(enabled, rerender) {
  if (getCurrentUser()?.role !== 'superadmin') {
    return notify(t('Only super admins can change capture settings.'), t('Not allowed'));
  }
  if (!enabled) {
    const ok = await confirmDialog(
      t('Disable raw OCR capture and purge every captured raw OCR value? Future scans will go back to storing only the resolved member_id. This cannot be undone.'),
      { title: t('Disable raw OCR capture'), confirmLabel: t('Disable & purge'), cancelLabel: t('Cancel'), danger: true },
    );
    if (!ok) return;
  }
  const result = await apiPut('/admin/settings/raw-ocr-capture', { enabled });
  if (result?.error) return notify(result.error, t('Save failed'));
  await notify(
    enabled
      ? t('Raw OCR capture enabled. New scans will persist the raw OCR’d player name on each chest record.')
      : t('Raw OCR capture disabled. Purged {chests} chest rows and {triumphals} triumphal rows.', { chests: (result.purged?.chestRecords ?? 0).toLocaleString(), triumphals: (result.purged?.triumphalChestRecords ?? 0).toLocaleString() }),
    t('Saved'),
  );
  if (typeof rerender === 'function') rerender('system');
}

/**
 * Turn the daily might snapshot on or off.
 *
 * No confirmation on disable (unlike raw-OCR capture): disabling only stops
 * future capture, it never deletes stored snapshots, so there's nothing
 * destructive to warn about.
 */
/** Flip the instance-wide daily resource capture. Instance-wide by design, and
 *  therefore on the instance-wide page — see the route comment in api.ts for why it
 *  no longer lives on a clan's own page. */
export async function toggleResourceCapture(enabled, rerender) {
  const res = await apiPut('/admin/resource-capture', { enabled });
  if (res?.error) return notify(res.error, t('Could not change the setting'));
  await notify(
    enabled
      ? t('Automated resource collection is on. Every clan with resource tracking enabled will have its capital history read once per game day, after the might snapshot.')
      : t('Automated resource collection is off. Nothing already recorded was removed.'),
    enabled ? t('Enabled') : t('Disabled'),
  );
  if (typeof rerender === 'function') rerender('system');
}

export async function toggleMightTracking(enabled, rerender) {
  if (getCurrentUser()?.role !== 'superadmin') {
    return notify(t('Only super admins can change might tracking.'), t('Not allowed'));
  }
  const result = await apiPut('/might/settings', { enabled });
  if (result?.error) return notify(result.error, t('Save failed'));
  await notify(
    enabled
      ? (result.cropIncludesMight
          ? t('Might tracking enabled. The first snapshot lands on the next scan cycle after the game-day rollover.')
          : t('Might tracking enabled, but capture stays blocked until calibration Stage 4 is re-saved with the might column inside the rectangle.'))
      : t('Might tracking disabled. Snapshots already collected are kept.'),
    t('Saved'),
  );
  if (typeof rerender === 'function') rerender('system');
}

/**
 * Arm a one-shot might re-capture. Doesn't scan — that's the manual-scan button
 * — it just removes the once-a-day gate so the next cycle refreshes today.
 */
export async function requestMightRecapture() {
  if (getCurrentUser()?.role !== 'superadmin') {
    return notify(t('Only super admins can trigger a re-capture.'), t('Not allowed'));
  }
  const result = await apiPost('/might/recapture', {});
  if (result?.error) return notify(result.error, t('Could not arm re-capture'));
  const clans = result?.armed ?? 0;
  return notify(
    tn(clans, 'Re-capture armed for {n} clan. Each one\'s next scan will re-read the member list and overwrite today\'s might readings. A scheduled cycle covers every clan; to do it now use "Scan all clans" on the Admin page — a single-clan manual scan only refreshes that clan and leaves the others armed for later.', 'Re-capture armed for {n} clans. Each one\'s next scan will re-read the member list and overwrite today\'s might readings. A scheduled cycle covers every clan; to do it now use "Scan all clans" on the Admin page — a single-clan manual scan only refreshes that clan and leaves the others armed for later.', { n: clans }),
    t('Armed'),
  );
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

// ─── Calibration wizard ───
//
// The wizard walks the operator through six short stages (Stages 5 and 6 only
// matter for automated resource collection). Each stage:
//   1. Operator manually puts the game on the right screen (main map,
//      Gifts panel, or Members list) — auto-navigation isn't possible
//      for stages whose UI positions haven't been calibrated yet.
//   2. "Capture screenshot" hits POST /admin/calibration/screenshot
//      with the stage param. Backend takes a fresh screenshot of
//      whatever the game is currently showing.
//   3. Frontend shows the screenshot. The toolbar lists every target
//      that needs marking on this stage. Operator clicks a target
//      name to make it active, then clicks (or drags, for crop targets)
//      on the screenshot. Targets can be re-marked any number of times.
//   4. Save Stage → PUT /admin/calibration with stage + a fields object
//      derived from the marked targets.
//
// Stages are independent — re-running stage 1 doesn't disturb stages
// 2/3, and partial calibrations are valid. Each stage's runtime
// consumer (navigator.ts, member-capture.ts) refuses with a
// CalibrationMissingError if its required targets are still 0.

const CALIBRATION_STAGE_SCHEMA = {
  main: {
    title: t('Stage {number} · {label}', { number: 1, label: STAGE_LABELS.main }),
    example: 'stage-1-main.jpg',
    instruction: t('Click Capture new screenshot. The scanner loads the game and lands on your city (auto-Escape clears any blocking popups). On the saved screenshot, click the CLAN icon in the bottom nav bar. Also click the MAP icon (bottom-left of the same nav cluster) if you want automated resource collection — it\'s the first step of the world-map chain in Stages 5 and 6, and can be left unmarked otherwise. Save Stage.'),
    targets: [
      { name: 'clanButton', kind: 'click', label: t('CLAN button (bottom nav)') },
      // Not required for chest scanning, which is why isFullyCalibrated() doesn't
      // demand it — but required for resource collection, so it gets a note saying
      // so rather than a bare "(optional)" that reads as "doesn't matter".
      {
        name: 'worldMapButton',
        kind: 'click',
        label: t('MAP button (bottom nav)'),
        optional: true,
        note: t('resource collection'),
      },
    ],
  },
  sidebars: {
    title: t('Stage {number} · {label}', { number: 2, label: STAGE_LABELS.sidebars }),
    example: 'stage-2-sidebars.jpg',
    instruction: t('Requires Stage 1. Click Capture new screenshot — the scanner clicks CLAN (from Stage 1) and the screenshot shows the My Clan dialog on whichever sub-section is the default. The two sidebar items (Gifts and Members) are visible from any sub-section, so it doesn\'t matter which one is open. On the screenshot, click the Gifts sidebar item and the Members sidebar item in the left rail. Save Stage.'),
    targets: [
      { name: 'giftsSidebar', kind: 'click', label: t('Gifts sidebar (left rail)') },
      { name: 'membersSidebar', kind: 'click', label: t('Members sidebar (left rail)') },
    ],
  },
  gifts: {
    title: t('Stage {number} · {label}', { number: 3, label: STAGE_LABELS.gifts }),
    example: 'stage-3-gifts.jpg',
    instruction: t('Requires Stages 1 + 2. Make sure at least one gift is in your Gifts list in-game before you start, otherwise there\'ll be no Open button and no card text to mark. Click Capture new screenshot — the scanner clicks CLAN + Gifts sidebar so the screenshot is the Gifts panel with cards visible. On the screenshot, click the Gifts top tab, the Triumphal top tab (optional, skip if your clan has none), the Open button on the topmost gift card, and drag a rectangle covering the text of all 4 visible gift cards: the chest name, the From row INCLUDING the "Time left" countdown to the right of the player name, and the Source row. Extend the rectangle far enough right to include the "Time left" value — it\'s what records when each chest was actually received (not just when it was scanned); leave it out and every chest falls back to the scan time. The "Open" button can be inside the rectangle or not, it\'s ignored either way. Save Stage.'),
    targets: [
      { name: 'giftsTab', kind: 'click', label: t('Gifts top sub-tab') },
      { name: 'triumphalTab', kind: 'click', label: t('Triumphal sub-tab'), optional: true },
      { name: 'openButton', kind: 'click', label: t('Topmost Open button') },
      { name: 'cardCrop', kind: 'crop', label: t('All 4 visible gift cards (chest name / From + "Time left" / Source)') },
    ],
  },
  members: {
    title: t('Stage {number} · {label}', { number: 4, label: STAGE_LABELS.members }),
    example: 'stage-4-members.jpg',
    instruction: t('Requires Stages 1 + 2. Click Capture new screenshot — the scanner clicks CLAN + Members sidebar so the screenshot is the Members panel showing the member list. On the screenshot, drag a rectangle around the member rows. Names, might and level are all read from this one rectangle, so each edge decides what gets captured: extend it RIGHT past the might number beside the shield icon (stop short and might tracking reads nothing); drag the BOTTOM edge down to the bottom of the panel, because each row\'s number sits lower than its name and a short rectangle permanently loses the last member\'s value; and optionally start at the LEFT edge of the avatars to also capture each member\'s level from the gold badge. Save Stage.'),
    targets: [
      { name: 'memberListCrop', kind: 'crop', label: t('Member list rows (names + might, avatars optional)') },
    ],
  },
  worldmap: {
    title: t('Stage {number} · {label}', { number: 5, label: STAGE_LABELS.worldmap }),
    // One image covers both passes here: it is the recentred map, with the
    // minimap icon of the first pass still visible bottom-left.
    example: 'stage-5-worldmap.jpg',
    instruction: t('Only needed for automated resource collection. Requires the MAP button from Stage 1. This stage is captured TWICE, because its two targets are never on screen at the same time. First Capture: the scanner clicks MAP, so the screenshot is the world map with the minimap and its row of icons in the bottom-left — click the show-clan-capital icon in that row, then Save Stage. Then click Capture new screenshot AGAIN: this time the scanner also clicks that icon, so the map is already recentred on your clan capital — now click the capital itself and Save Stage. Marking it on the recentred view is the point: on the first screenshot you would be guessing where the camera is about to put it.'),
    targets: [
      { name: 'clanCapitalButton', kind: 'click', label: t('Show-clan-capital icon (above the minimap)') },
      // secondPass, NOT optional: it is required for the feature, it just cannot be
      // marked on the first capture because the map hasn't been recentred yet. The
      // two are deliberately different flags — labelling this "optional" told the
      // operator it didn't matter, which is the opposite of true.
      {
        name: 'clanCapitalMarker',
        kind: 'click',
        label: t('Clan capital (on the recentred map)'),
        secondPass: true,
      },
    ],
  },
  capital: {
    title: t('Stage {number} · {label}', { number: 6, label: STAGE_LABELS.capital }),
    example: 'stage-6-capital.jpg',
    exampleSecondPass: 'stage-6-capital-rows.jpg',
    instruction: t('Only needed for automated resource collection. Requires Stages 1 + 5. This stage is captured TWICE. First Capture: the scanner clicks MAP, show-clan-capital and the capital, so the screenshot is the Clan Capital dialog on its Information section — click History at the bottom of the left rail. Then click Capture new screenshot AGAIN: this time the scanner also clicks History, so the screenshot shows the resource history rows. Now drag a rectangle around the list of rows — from just under the "All players / All resources" dropdowns down to the bottom of the panel, and wide enough to include BOTH the player name on the left AND the amount plus its resource icon on the right. The icon is what identifies the resource, so a rectangle that clips it makes every row Unknown. Save Stage.'),
    targets: [
      { name: 'capitalHistorySidebar', kind: 'click', label: t('History (left rail)') },
      // secondPass, not optional — required for the feature, but only markable once
      // History is open, which is what the second capture is for.
      {
        name: 'resourceHistoryCrop',
        kind: 'crop',
        label: t('History rows (name → amount + resource icon)'),
        secondPass: true,
      },
    ],
  },
};

/**
 * Targets whose in-flight (marked but unsaved) value the backend can use to
 * navigate for a later stage's capture. Sent as `overrides` on every Capture so
 * an operator can walk Stage 1 → 5 → 6 in one sitting without a save between
 * each. `capitalHistorySidebar` is in here for a slightly different reason: it
 * feeds back into its OWN stage's second capture (see the Stage 6 instruction).
 */
const CALIBRATION_NAV_OVERRIDE_TARGETS = [
  'clanButton', 'giftsSidebar', 'membersSidebar',
  'worldMapButton', 'clanCapitalButton', 'clanCapitalMarker', 'capitalHistorySidebar',
];

// Map a marked target → the AppConfig fields it sets. Used at save time
// to translate the wizard's target-keyed marks into the field-keyed
// payload the API expects.
const TARGET_TO_FIELDS = {
  clanButton: (v) => ({ uiClanButtonXPct: v.xPct, uiClanButtonYPct: v.yPct }),
  worldMapButton: (v) => ({ uiWorldMapButtonXPct: v.xPct, uiWorldMapButtonYPct: v.yPct }),
  clanCapitalButton: (v) => ({ uiClanCapitalButtonXPct: v.xPct, uiClanCapitalButtonYPct: v.yPct }),
  clanCapitalMarker: (v) => ({ uiClanCapitalMarkerXPct: v.xPct, uiClanCapitalMarkerYPct: v.yPct }),
  capitalHistorySidebar: (v) => ({
    uiCapitalHistorySidebarXPct: v.xPct, uiCapitalHistorySidebarYPct: v.yPct,
  }),
  resourceHistoryCrop: (v) => ({
    resourceHistoryCropLeftPct: v.leftPct, resourceHistoryCropTopPct: v.topPct,
    resourceHistoryCropRightPct: v.rightPct, resourceHistoryCropBottomPct: v.bottomPct,
  }),
  giftsSidebar: (v) => ({ uiGiftsSidebarXPct: v.xPct, uiGiftsSidebarYPct: v.yPct }),
  giftsTab: (v) => ({ uiGiftsTabXPct: v.xPct, uiGiftsTabYPct: v.yPct }),
  triumphalTab: (v) => ({ uiTriumphalTabXPct: v.xPct, uiTriumphalTabYPct: v.yPct }),
  membersSidebar: (v) => ({ uiMembersSidebarXPct: v.xPct, uiMembersSidebarYPct: v.yPct }),
  openButton: (v) => ({ scanOpenButtonXPct: v.xPct, scanOpenButtonYPct: v.yPct }),
  cardCrop: (v) => ({
    scanCropLeftPct: v.leftPct, scanCropTopPct: v.topPct,
    scanCropRightPct: v.rightPct, scanCropBottomPct: v.bottomPct,
  }),
  memberListCrop: (v) => ({
    memberListCropLeftPct: v.leftPct, memberListCropTopPct: v.topPct,
    memberListCropRightPct: v.rightPct, memberListCropBottomPct: v.bottomPct,
  }),
};

// Reverse mapping: AppConfig field values → wizard mark object. Used
// when entering a stage to show the operator where their previously-
// saved positions are. A target is considered "saved" only when its
// fields are non-zero (and crop rectangles are non-degenerate).
const TARGET_FROM_FIELDS = {
  clanButton: (f) => f.uiClanButtonXPct > 0 && f.uiClanButtonYPct > 0
    ? { kind: 'click', xPct: f.uiClanButtonXPct, yPct: f.uiClanButtonYPct } : null,
  worldMapButton: (f) => f.uiWorldMapButtonXPct > 0 && f.uiWorldMapButtonYPct > 0
    ? { kind: 'click', xPct: f.uiWorldMapButtonXPct, yPct: f.uiWorldMapButtonYPct } : null,
  clanCapitalButton: (f) => f.uiClanCapitalButtonXPct > 0 && f.uiClanCapitalButtonYPct > 0
    ? { kind: 'click', xPct: f.uiClanCapitalButtonXPct, yPct: f.uiClanCapitalButtonYPct } : null,
  clanCapitalMarker: (f) => f.uiClanCapitalMarkerXPct > 0 && f.uiClanCapitalMarkerYPct > 0
    ? { kind: 'click', xPct: f.uiClanCapitalMarkerXPct, yPct: f.uiClanCapitalMarkerYPct } : null,
  capitalHistorySidebar: (f) => f.uiCapitalHistorySidebarXPct > 0 && f.uiCapitalHistorySidebarYPct > 0
    ? { kind: 'click', xPct: f.uiCapitalHistorySidebarXPct, yPct: f.uiCapitalHistorySidebarYPct } : null,
  resourceHistoryCrop: (f) => f.resourceHistoryCropRightPct > f.resourceHistoryCropLeftPct
      && f.resourceHistoryCropBottomPct > f.resourceHistoryCropTopPct
    ? { kind: 'crop', leftPct: f.resourceHistoryCropLeftPct, topPct: f.resourceHistoryCropTopPct,
        rightPct: f.resourceHistoryCropRightPct, bottomPct: f.resourceHistoryCropBottomPct } : null,
  giftsSidebar: (f) => f.uiGiftsSidebarXPct > 0 && f.uiGiftsSidebarYPct > 0
    ? { kind: 'click', xPct: f.uiGiftsSidebarXPct, yPct: f.uiGiftsSidebarYPct } : null,
  giftsTab: (f) => f.uiGiftsTabXPct > 0 && f.uiGiftsTabYPct > 0
    ? { kind: 'click', xPct: f.uiGiftsTabXPct, yPct: f.uiGiftsTabYPct } : null,
  triumphalTab: (f) => f.uiTriumphalTabXPct > 0 && f.uiTriumphalTabYPct > 0
    ? { kind: 'click', xPct: f.uiTriumphalTabXPct, yPct: f.uiTriumphalTabYPct } : null,
  membersSidebar: (f) => f.uiMembersSidebarXPct > 0 && f.uiMembersSidebarYPct > 0
    ? { kind: 'click', xPct: f.uiMembersSidebarXPct, yPct: f.uiMembersSidebarYPct } : null,
  openButton: (f) => f.scanOpenButtonXPct > 0 && f.scanOpenButtonYPct > 0
    ? { kind: 'click', xPct: f.scanOpenButtonXPct, yPct: f.scanOpenButtonYPct } : null,
  cardCrop: (f) => f.scanCropRightPct > f.scanCropLeftPct && f.scanCropBottomPct > f.scanCropTopPct
    ? { kind: 'crop', leftPct: f.scanCropLeftPct, topPct: f.scanCropTopPct,
        rightPct: f.scanCropRightPct, bottomPct: f.scanCropBottomPct } : null,
  memberListCrop: (f) => f.memberListCropRightPct > f.memberListCropLeftPct && f.memberListCropBottomPct > f.memberListCropTopPct
    ? { kind: 'crop', leftPct: f.memberListCropLeftPct, topPct: f.memberListCropTopPct,
        rightPct: f.memberListCropRightPct, bottomPct: f.memberListCropBottomPct } : null,
};

/** Operator clicked one of the four stage buttons. Resets state for
 *  this stage, shows the per-stage instruction, and — if a screenshot
 *  for this stage already exists on disk — loads it immediately so the
 *  operator can mark targets without waiting for a fresh capture. The
 *  Capture button on the row stays available for forcing a fresh one
 *  whenever the panel state has changed. */
export async function startCalibrationStage(stage, opts = {}) {
  if (getCurrentUser()?.role !== 'superadmin') {
    return notify(t('Only super admins can recalibrate the scanner.'), t('Not allowed'));
  }
  if (!CALIBRATION_STAGE_SCHEMA[stage]) {
    return notify(t('Unknown calibration stage: {stage}', { stage }), t('Invalid stage'));
  }

  // Clean up any prior stage's marks/handlers before switching.
  cancelCalibration({ keepMessage: true });

  // The wizard's controls live inside a collapsible card, and this action is
  // now also fired from the setup checklist at the top of the page — so make
  // sure the thing the operator just started is actually on screen. No flash
  // when it is already open and in view: re-flashing on every stage switch
  // reads as an error.
  // Scroll the wizard into view if it isn't, but never flash the card itself:
  // a whole section blinking to say "press this one button" is a lot of motion
  // for a small instruction, and it draws the eye to the container rather than
  // to the control. The pulse goes on Capture instead, below.
  focusCalibrationCard({ scroll: !isCalibrationCardInView(), flash: false });

  calibrationState = {
    stage,
    canvasBounds: null,
    imageNaturalWidth: 0,
    imageNaturalHeight: 0,
    activeTarget: null,
    marks: {},
    drag: null,
  };

  const schema = CALIBRATION_STAGE_SCHEMA[stage];
  const instructionEl = document.getElementById('calibrationStageInstruction');
  if (instructionEl) {
    instructionEl.textContent = `${schema.title} — ${schema.instruction}`;
    instructionEl.style.display = '';
  }
  const captureRow = document.getElementById('calibrationCaptureRow');
  if (captureRow) captureRow.style.display = '';
  // Picking a stage does nothing visible on its own — the wizard has no
  // screenshot to mark until Capture runs, and the operator is left looking at
  // a highlighted stage button that appears to have done nothing. So the
  // emphasis moves to Capture, which is the only control that advances from
  // here. showCalibrationImage hands it on to Save Stage once an image is up.
  setCaptureButtonPrimary(true);
  flashElement(document.getElementById('captureScreenshotBtn'));
  const wizardStatus = document.getElementById('calibrationWizardStatus');
  if (wizardStatus) wizardStatus.textContent = '';

  // Highlight the active stage button.
  document.querySelectorAll('[data-action="calibrate-stage"]').forEach((btn) => {
    btn.classList.toggle('btn-primary', btn.dataset.stage === stage);
  });

  // Pre-populate marks from saved field values so the operator sees
  // where their previously-calibrated positions are when re-opening a
  // completed stage. Marks render as crosshairs/rectangles on the
  // screenshot via the existing redrawCalibrationOverlay path. A target
  // with zero fields is treated as unmarked (Triumphal can stay zero
  // when the clan has no Triumphal tab).
  try {
    const cal = await api('/admin/calibration');
    if (cal?.fields) {
      for (const tg of schema.targets) {
        const reverse = TARGET_FROM_FIELDS[tg.name];
        const m = reverse?.(cal.fields);
        if (m) calibrationState.marks[tg.name] = m;
      }
    }
  } catch {
    // Non-fatal — operator can still mark targets fresh.
  }

  renderCalibrationExample();

  // Re-entering for the second pass: the screenshot on disk is the FIRST-pass
  // frame, taken before the map was recentred, and on it the capital is often
  // nowhere to be seen (a city far from the capital is exactly the case that
  // makes this stage confusing). Showing it invites marking the target on the
  // wrong frame, so skip it and say what the next capture will do instead.
  if (opts.secondPass) {
    const deferred = joinAnd(schema.targets.filter((tg) => tg.secondPass).map((tg) => tg.label));
    setCalibrationStatus(
      document.getElementById('calibrationStatus'),
      t('Saved. One more capture to go: the scanner now clicks the target you just marked before screenshotting, so the next screenshot is the view where {targets} is actually visible. Click Capture new screenshot.', { targets: deferred }),
      'warning',
    );
    return;
  }

  // If a screenshot for this stage exists on disk (from a prior wizard
  // run or a recovered process restart), load it immediately. Operator
  // can verify saved marks render where they expect, mark new targets,
  // or click Capture to take a new screenshot if the panel state has
  // changed since.
  try {
    const existing = await api(`/admin/calibration/screenshot/status?stage=${stage}`);
    if (existing?.status === 'done' && existing.stage === stage) {
      const statusEl = document.getElementById('calibrationStatus');
      setCalibrationStatus(statusEl, t('Showing the previous screenshot for this stage. Click Capture new screenshot to take a fresh one if anything has changed.'), 'warning');
      showCalibrationImage(existing);
    }
  } catch {
    // Non-fatal — operator can still click Capture to take a fresh one.
  }
}

/** Always force a fresh capture. Sends any in-flight click marks as
 *  `overrides` so the backend's auto-nav can use them before they've been
 *  saved via Save Stage — that's what lets a single Stage 2 session capture
 *  the sidebars first, mark them, then recapture into the Gifts panel, and
 *  what lets Stage 6 recapture into the History rows once History is marked. */
export async function captureCalibrationScreenshot() {
  if (!calibrationState?.stage) {
    return notify(t('Pick a stage first (the Stage 1–6 buttons above).'), t('No stage'));
  }
  const stage = calibrationState.stage;
  const status = document.getElementById('calibrationStatus');

  // Build overrides from in-flight click marks. Only the navigation
  // targets matter to the backend; crop marks aren't used during
  // auto-nav so we skip those.
  const overrides = {};
  for (const navName of CALIBRATION_NAV_OVERRIDE_TARGETS) {
    const m = calibrationState.marks?.[navName];
    if (m?.kind === 'click') {
      overrides[navName] = { xPct: m.xPct, yPct: m.yPct };
    }
  }

  setCalibrationStatus(status, t('Starting capture (~30s)…'));
  try {
    const startResult = await apiPost(
      `/admin/calibration/screenshot?stage=${stage}`,
      Object.keys(overrides).length > 0 ? { overrides } : {},
    );
    if (startResult?.error) {
      setCalibrationStatus(status, startResult.error, 'error');
      return;
    }
    pollCalibrationStatus();
  } catch (err) {
    setCalibrationStatus(status, String(err), 'error');
  }
}

async function pollCalibrationStatus() {
  const status = document.getElementById('calibrationStatus');
  const start = Date.now();
  const maxWaitMs = 120_000;

  while (Date.now() - start < maxWaitMs) {
    let result;
    try {
      result = await api('/admin/calibration/screenshot/status');
    } catch (err) {
      setCalibrationStatus(status, t('Status poll failed: {error}', { error: String(err) }), 'error');
      return;
    }

    if (!result || result.status === 'idle') {
      setCalibrationStatus(status, t('Calibration job vanished. Try again.'), 'error');
      return;
    }
    if (result.status === 'error') {
      setCalibrationStatus(status, result.error || t('Calibration capture failed.'), 'error');
      return;
    }
    if (result.status === 'done') {
      // A warning means the screenshot exists but auto-nav couldn't confirm it
      // reached the right screen — usually a popup over the top. Show the warning
      // instead of "ready", and still show the image: seeing what blocked the view
      // is how the operator fixes it.
      if (result.warning) {
        setCalibrationStatus(status, result.warning, 'warning');
      } else {
        setCalibrationStatus(status, t('Screenshot ready ({seconds}s). Mark the targets below.', { seconds: Math.round((result.elapsedMs ?? 0) / 1000) }), 'success');
      }
      showCalibrationImage(result);
      return;
    }

    const elapsedSec = Math.round((Date.now() - start) / 1000);
    setCalibrationStatus(status, t('Capturing screenshot… {seconds}s elapsed', { seconds: elapsedSec }));
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  setCalibrationStatus(status, t('Calibration timed out after 2 minutes. Check container logs and retry.'), 'error');
}

/** Set the calibration status pill's text + tone class. tone is one of
 *  'success', 'error', 'warning', or undefined for the neutral state. */
function setCalibrationStatus(el, text, tone) {
  if (!el) return;
  el.textContent = text;
  el.classList.remove('is-success', 'is-error', 'is-warning');
  if (tone === 'success') el.classList.add('is-success');
  else if (tone === 'error') el.classList.add('is-error');
  else if (tone === 'warning') el.classList.add('is-warning');
}

/**
 * Offer the worked example for the stage (and pass) the operator is on.
 *
 * The instructions are exact but long, and "drag a rectangle wide enough to
 * include the amount AND its resource icon" only really lands once you have
 * seen it done. These are screenshots of this wizard with the stage's targets
 * already marked.
 *
 * Rendered as a `.unknown-crop-hover` trigger, the same contract the
 * unresolved-row evidence crops use (lib/ui.js): hover previews it, click opens
 * the lightbox that magnifies past natural size — which is what a screenshot of
 * a full game window needs. attachCropPreviews is already delegated on
 * #content, so injecting the trigger is the whole integration.
 *
 * Files live in assets/calibration-examples/ and are served from /assets,
 * behind requireAuth — which this superadmin-only page already satisfies.
 */
function renderCalibrationExample() {
  const host = document.getElementById('calibrationExample');
  if (!host) return;
  host.innerHTML = '';
  if (!calibrationState) return;

  const schema = CALIBRATION_STAGE_SCHEMA[calibrationState.stage];
  // On a two-pass stage the relevant example depends on where the operator is,
  // and the first pass's targets being marked is what says they moved on (they
  // are preloaded from saved config when the stage is re-entered).
  const hasSecondPass = schema.targets.some((tg) => tg.secondPass);
  const firstPassDone = hasSecondPass && schema.targets
    .filter((tg) => !tg.optional && !tg.secondPass)
    .every((tg) => !!calibrationState.marks[tg.name]);
  const file = firstPassDone && schema.exampleSecondPass ? schema.exampleSecondPass : schema.example;
  if (!file) return;

  const label = firstPassDone && schema.exampleSecondPass
    ? t('See an example of the second capture, marked')
    : t('See an example of this stage, marked');

  host.innerHTML = `<span class="unknown-crop-hover calibration-example-link" tabindex="0" role="button"
    data-crop-url="/assets/calibration-examples/${esc(file)}" data-crop-wide>📷 ${esc(label)}</span>
    <span class="muted-copy">${t('— hover to preview, click to enlarge. Your game\'s layout will differ; match the targets, not the pixels.')}</span>`;
}

/** Emphasise "Capture new screenshot" while it is the only control that does
 *  anything. Safe to call before the card exists. */
function setCaptureButtonPrimary(primary) {
  const btn = document.getElementById('captureScreenshotBtn');
  if (btn) btn.classList.toggle('btn-primary', primary);
}

function showCalibrationImage(statusResponse) {
  const canvas = document.getElementById('calibrationCanvas');
  const img = document.getElementById('calibrationImage');
  if (!canvas || !img || !calibrationState) return;

  // There is something to mark now, so Capture stops being the highlighted
  // action; Save Stage (already btn-primary, enabled once a target is marked)
  // takes over. Two primaries at once would just move the ambiguity.
  setCaptureButtonPrimary(false);

  calibrationState.canvasBounds = statusResponse.canvasBounds;
  calibrationState.imageNaturalWidth = 0;
  calibrationState.imageNaturalHeight = 0;
  calibrationState.drag = null;
  // Preserve marks across recaptures inside the same wizard session.
  if (!calibrationState.marks) calibrationState.marks = {};
  // Active target = first unmarked required target, falling back to
  // first optional or first target overall. After the operator marks
  // a target it auto-advances; on a fresh capture this picks up where
  // they left off.
  const targets = CALIBRATION_STAGE_SCHEMA[calibrationState.stage].targets;
  calibrationState.activeTarget =
    targets.find((tg) => !tg.optional && !calibrationState.marks[tg.name])?.name
    ?? targets.find((tg) => !calibrationState.marks[tg.name])?.name
    ?? targets[0]?.name
    ?? null;

  img.onload = () => {
    if (!calibrationState) return;
    calibrationState.imageNaturalWidth = img.naturalWidth;
    calibrationState.imageNaturalHeight = img.naturalHeight;
    redrawCalibrationOverlay();
  };
  img.src = statusResponse.imageUrl;
  canvas.style.display = '';

  const wrapper = document.getElementById('calibrationImageWrapper');
  if (wrapper) {
    wrapper.onmousedown = onCalibrationMouseDown;
    wrapper.onmousemove = onCalibrationMouseMove;
    wrapper.onmouseup = onCalibrationMouseUp;
    wrapper.onmouseleave = onCalibrationMouseUp;
  }

  renderCalibrationTargetToolbar();
  updateCalibrationActiveTargetHint();
  updateCalibrationSaveButton();
}

function renderCalibrationTargetToolbar() {
  const toolbar = document.getElementById('calibrationTargetToolbar');
  if (!toolbar || !calibrationState) return;
  const schema = CALIBRATION_STAGE_SCHEMA[calibrationState.stage];
  const cb = calibrationState.canvasBounds;
  const resolvePoint = (xPct, yPct) => {
    if (!cb) return null;
    return {
      x: Math.round(cb.x + cb.width * xPct),
      y: Math.round(cb.y + cb.height * yPct),
    };
  };
  toolbar.innerHTML = schema.targets
    .map((tg) => {
      const mark = calibrationState.marks[tg.name];
      const isActive = calibrationState.activeTarget === tg.name;
      // Three distinct states, three distinct labels. Collapsing them into one
      // "(optional)" was actively misleading: a target needed for the feature read
      // as one that could be skipped.
      let optTag = '';
      if (tg.secondPass) {
        optTag = ` <span class="muted-copy">${t('(mark on the 2nd capture)')}</span>`;
      } else if (tg.note) {
        optTag = ` <span class="muted-copy">(${tg.note})</span>`;
      } else if (tg.optional) {
        optTag = ` <span class="muted-copy">${t('(optional)')}</span>`;
      }
      const iconCh = mark ? '✅' : '⏳';
      const cls = isActive ? 'btn btn-primary' : 'btn';
      let coordTag = '';
      if (mark?.kind === 'click') {
        const p = resolvePoint(mark.xPct, mark.yPct);
        coordTag = p
          ? ` <span class="muted-copy">(${p.x}, ${p.y})</span>`
          : ` <span class="muted-copy">(${mark.xPct.toFixed(3)}, ${mark.yPct.toFixed(3)})</span>`;
      } else if (mark?.kind === 'crop') {
        const tl = resolvePoint(mark.leftPct, mark.topPct);
        const br = resolvePoint(mark.rightPct, mark.bottomPct);
        coordTag = (tl && br)
          ? ` <span class="muted-copy">(${tl.x},${tl.y}–${br.x},${br.y})</span>`
          : ` <span class="muted-copy">[${mark.leftPct.toFixed(3)},${mark.topPct.toFixed(3)}–${mark.rightPct.toFixed(3)},${mark.bottomPct.toFixed(3)}]</span>`;
      }
      return `<button class="${cls}" data-action="select-calibration-target" data-target="${tg.name}">${iconCh} ${tg.label}${optTag}${coordTag}</button>`;
    })
    .join('');
}

export function selectCalibrationTarget(targetName) {
  if (!calibrationState) return;
  const schema = CALIBRATION_STAGE_SCHEMA[calibrationState.stage];
  if (!schema.targets.some((tg) => tg.name === targetName)) return;
  calibrationState.activeTarget = targetName;
  renderCalibrationTargetToolbar();
  updateCalibrationActiveTargetHint();
}

function updateCalibrationActiveTargetHint() {
  const hint = document.getElementById('calibrationActiveTargetHint');
  if (!hint || !calibrationState) return;
  const schema = CALIBRATION_STAGE_SCHEMA[calibrationState.stage];
  const target = schema.targets.find((tg) => tg.name === calibrationState.activeTarget);
  if (!target) {
    hint.textContent = '';
    return;
  }
  hint.textContent = target.kind === 'click'
    ? t('Active target: {target}. Single-click on the screenshot.', { target: target.label })
    : t('Active target: {target}. Click-and-drag a rectangle on the screenshot.', { target: target.label });
}

function calibrationPointFromEvent(event) {
  if (!calibrationState) return null;
  if (!calibrationState.imageNaturalWidth || !calibrationState.imageNaturalHeight) return null;
  const img = document.getElementById('calibrationImage');
  if (!img) return null;
  const rect = img.getBoundingClientRect();
  const cssX = event.clientX - rect.left;
  const cssY = event.clientY - rect.top;
  if (cssX < 0 || cssY < 0 || cssX > rect.width || cssY > rect.height) {
    return null;
  }
  const naturalX = (cssX / rect.width) * calibrationState.imageNaturalWidth;
  const naturalY = (cssY / rect.height) * calibrationState.imageNaturalHeight;
  return { cssX, cssY, naturalX, naturalY, rectWidth: rect.width, rectHeight: rect.height };
}

function naturalToCanvasPct(naturalX, naturalY) {
  const cb = calibrationState?.canvasBounds;
  if (!cb || !(cb.width > 0)) return null;
  const scaleRatio = calibrationState.imageNaturalWidth / cb.width;
  const canvasLeftInImage = cb.x * scaleRatio;
  const canvasTopInImage = cb.y * scaleRatio;
  const canvasWidthInImage = cb.width * scaleRatio;
  const canvasHeightInImage = cb.height * scaleRatio;
  let xPct = (naturalX - canvasLeftInImage) / canvasWidthInImage;
  let yPct = (naturalY - canvasTopInImage) / canvasHeightInImage;
  xPct = Math.min(1, Math.max(0, xPct));
  yPct = Math.min(1, Math.max(0, yPct));
  return { xPct, yPct };
}

function onCalibrationMouseDown(event) {
  const point = calibrationPointFromEvent(event);
  if (!point) return;
  calibrationState.drag = {
    startCssX: point.cssX,
    startCssY: point.cssY,
    startNaturalX: point.naturalX,
    startNaturalY: point.naturalY,
    moved: false,
  };
  event.preventDefault();
}

function onCalibrationMouseMove(event) {
  const drag = calibrationState?.drag;
  if (!drag) return;
  const point = calibrationPointFromEvent(event);
  if (!point) return;
  const dx = Math.abs(point.cssX - drag.startCssX);
  const dy = Math.abs(point.cssY - drag.startCssY);
  // 5 px threshold disambiguates clicks from intentional drags.
  if (dx > 5 || dy > 5) {
    drag.moved = true;
    redrawCalibrationOverlay({
      previewRect: {
        startNaturalX: drag.startNaturalX,
        startNaturalY: drag.startNaturalY,
        endNaturalX: point.naturalX,
        endNaturalY: point.naturalY,
      },
    });
  }
}

function onCalibrationMouseUp(event) {
  const drag = calibrationState?.drag;
  if (!drag) return;
  const point = calibrationPointFromEvent(event);
  if (drag.moved && point) {
    saveCropFromDrag(drag.startNaturalX, drag.startNaturalY, point.naturalX, point.naturalY);
  } else if (point) {
    saveClickFromPoint(point.naturalX, point.naturalY);
  }
  calibrationState.drag = null;
  redrawCalibrationOverlay();
  renderCalibrationTargetToolbar();
  updateCalibrationActiveTargetHint();
  updateCalibrationSaveButton();
}

function getActiveTargetSchema() {
  if (!calibrationState?.activeTarget) return null;
  const schema = CALIBRATION_STAGE_SCHEMA[calibrationState.stage];
  return schema?.targets.find((tg) => tg.name === calibrationState.activeTarget) ?? null;
}

function saveClickFromPoint(naturalX, naturalY) {
  const target = getActiveTargetSchema();
  if (!target) return;
  if (target.kind !== 'click') return;
  const pct = naturalToCanvasPct(naturalX, naturalY);
  if (!pct) {
    setCalibrationError();
    return;
  }
  calibrationState.marks[target.name] = { kind: 'click', xPct: pct.xPct, yPct: pct.yPct };
  advanceActiveTarget();
}

function saveCropFromDrag(startNaturalX, startNaturalY, endNaturalX, endNaturalY) {
  const target = getActiveTargetSchema();
  if (!target || target.kind !== 'crop') return;
  const leftN = Math.min(startNaturalX, endNaturalX);
  const rightN = Math.max(startNaturalX, endNaturalX);
  const topN = Math.min(startNaturalY, endNaturalY);
  const bottomN = Math.max(startNaturalY, endNaturalY);
  const tl = naturalToCanvasPct(leftN, topN);
  const br = naturalToCanvasPct(rightN, bottomN);
  if (!tl || !br) {
    setCalibrationError();
    return;
  }
  // Reject degenerate rectangles — likely jitter that crossed the 5px threshold.
  if (br.xPct - tl.xPct < 0.005 || br.yPct - tl.yPct < 0.005) return;
  calibrationState.marks[target.name] = {
    kind: 'crop',
    leftPct: tl.xPct, topPct: tl.yPct,
    rightPct: br.xPct, bottomPct: br.yPct,
  };
  advanceActiveTarget();
}

function advanceActiveTarget() {
  if (!calibrationState) return;
  const schema = CALIBRATION_STAGE_SCHEMA[calibrationState.stage];
  const next = schema.targets.find((tg) => !tg.optional && !calibrationState.marks[tg.name]);
  if (next) calibrationState.activeTarget = next.name;
}

function setCalibrationError() {
  const status = document.getElementById('calibrationStatus');
  setCalibrationStatus(status, t('The saved screenshot is missing canvas bounds metadata. Click Calibrate again to take a fresh screenshot.'), 'error');
}

function redrawCalibrationOverlay(opts = {}) {
  const overlay = document.getElementById('calibrationOverlay');
  if (!overlay || !calibrationState) return;
  const imgW = calibrationState.imageNaturalWidth;
  const imgH = calibrationState.imageNaturalHeight;
  if (!imgW || !imgH) return;
  const cb = calibrationState.canvasBounds;
  if (!cb) return;

  const scaleRatio = imgW / cb.width;
  const canvasLeftInImage = cb.x * scaleRatio;
  const canvasTopInImage = cb.y * scaleRatio;
  const canvasWidthInImage = cb.width * scaleRatio;
  const canvasHeightInImage = cb.height * scaleRatio;
  const naturalToImagePct = (nx, ny) => ({ x: (nx / imgW) * 100, y: (ny / imgH) * 100 });

  let svg = '';

  // Crop marks first (so click crosshairs render on top).
  for (const [name, mark] of Object.entries(calibrationState.marks)) {
    if (mark.kind !== 'crop') continue;
    const isActive = name === calibrationState.activeTarget;
    const stroke = isActive ? '#ff5050' : '#aa3030';
    const fill = isActive ? '#ff303033' : '#ff303018';
    const leftN = canvasLeftInImage + mark.leftPct * canvasWidthInImage;
    const topN = canvasTopInImage + mark.topPct * canvasHeightInImage;
    const rightN = canvasLeftInImage + mark.rightPct * canvasWidthInImage;
    const bottomN = canvasTopInImage + mark.bottomPct * canvasHeightInImage;
    const tl = naturalToImagePct(leftN, topN);
    const br = naturalToImagePct(rightN, bottomN);
    svg += `<rect x="${tl.x.toFixed(3)}%" y="${tl.y.toFixed(3)}%" width="${(br.x - tl.x).toFixed(3)}%" height="${(br.y - tl.y).toFixed(3)}%" fill="${fill}" stroke="${stroke}" stroke-width="0.25%" />`;
  }

  for (const [name, mark] of Object.entries(calibrationState.marks)) {
    if (mark.kind !== 'click') continue;
    const isActive = name === calibrationState.activeTarget;
    const stroke = isActive ? '#30ff60' : '#208840';
    const naturalX = canvasLeftInImage + mark.xPct * canvasWidthInImage;
    const naturalY = canvasTopInImage + mark.yPct * canvasHeightInImage;
    const p = naturalToImagePct(naturalX, naturalY);
    const cxStr = `${p.x.toFixed(3)}%`;
    const cyStr = `${p.y.toFixed(3)}%`;
    svg += `
      <circle cx="${cxStr}" cy="${cyStr}" r="1.5%" fill="none" stroke="${stroke}" stroke-width="0.4%" />
      <line x1="${(p.x - 2).toFixed(3)}%" y1="${cyStr}" x2="${(p.x + 2).toFixed(3)}%" y2="${cyStr}" stroke="${stroke}" stroke-width="0.4%" />
      <line x1="${cxStr}" y1="${(p.y - 2).toFixed(3)}%" x2="${cxStr}" y2="${(p.y + 2).toFixed(3)}%" stroke="${stroke}" stroke-width="0.4%" />
      <text x="${(p.x + 2).toFixed(3)}%" y="${(p.y - 2).toFixed(3)}%" fill="${stroke}" font-size="2.2%" font-family="monospace">${name}</text>
    `;
  }

  if (opts.previewRect) {
    const leftN = Math.min(opts.previewRect.startNaturalX, opts.previewRect.endNaturalX);
    const rightN = Math.max(opts.previewRect.startNaturalX, opts.previewRect.endNaturalX);
    const topN = Math.min(opts.previewRect.startNaturalY, opts.previewRect.endNaturalY);
    const bottomN = Math.max(opts.previewRect.startNaturalY, opts.previewRect.endNaturalY);
    const tl = naturalToImagePct(leftN, topN);
    const br = naturalToImagePct(rightN, bottomN);
    svg += `<rect x="${tl.x.toFixed(3)}%" y="${tl.y.toFixed(3)}%" width="${(br.x - tl.x).toFixed(3)}%" height="${(br.y - tl.y).toFixed(3)}%" fill="#ffd00030" stroke="#ffd000" stroke-width="0.3%" stroke-dasharray="0.5%" />`;
  }

  overlay.innerHTML = svg;
}

function updateCalibrationSaveButton() {
  const saveBtn = document.getElementById('saveCalibrationBtn');
  if (!saveBtn || !calibrationState) {
    if (saveBtn) saveBtn.disabled = true;
    return;
  }
  const schema = CALIBRATION_STAGE_SCHEMA[calibrationState.stage];
  // secondPass targets are excluded here for the same reason optional ones are:
  // the first pass of a two-pass stage has to be savable, because saving is what
  // makes the second capture able to navigate.
  const outstanding = schema.targets
    .filter((tg) => !tg.optional && !tg.secondPass && !calibrationState.marks[tg.name]);
  saveBtn.disabled = outstanding.length > 0;

  // A two-pass stage saved on its first pass is not finished, and "Save Stage"
  // says otherwise. The label carries the difference, because this is the
  // moment the operator decides whether they are done.
  const deferred = schema.targets
    .filter((tg) => tg.secondPass && !calibrationState.marks[tg.name]);
  saveBtn.textContent = deferred.length > 0 ? t('Save and continue') : t('Save Stage');
  renderCalibrationExample();

  // Name what's missing, on the button and beside it. A disabled button with no
  // explanation is only marginally better than one that silently does nothing —
  // the operator still has to work out which of the stage's targets they
  // haven't clicked yet.
  const hint = document.getElementById('calibrationSaveHint');
  if (outstanding.length > 0) {
    const labels = outstanding.map((tg) => tg.label).join(', ');
    saveBtn.title = t('Still to mark: {targets}', { targets: labels });
    if (hint) hint.textContent = t('Still to mark: {targets}', { targets: labels });
  } else {
    saveBtn.title = '';
    if (hint) {
      // Optional targets are worth calling out at the point of saving: skipping
      // one is a real choice (a clan with no Triumphal tab), but so is having
      // forgotten it, and after the save the distinction is invisible.
      const skipped = schema.targets
        .filter((tg) => tg.optional && !calibrationState.marks[tg.name])
        .map((tg) => tg.label);
      if (deferred.length > 0) {
        // Never "Ready to save" on a half-done stage: the operator would read it
        // as "finished", and the stage's remaining target only becomes markable
        // after a save and another capture.
        hint.textContent = t('Save, then capture again to mark {targets} — it is not visible until the scanner navigates one step further.', { targets: joinAnd(deferred.map((tg) => tg.label)) });
      } else {
        hint.textContent = skipped.length > 0
          ? t('Ready to save. Optional and unmarked: {targets}.', { targets: skipped.join(', ') })
          : t('Ready to save.');
      }
    }
  }
}

export async function saveCalibration(rerender) {
  if (!calibrationState?.stage) {
    return notify(t('No calibration in progress.'), t('Nothing to save'));
  }
  const schema = CALIBRATION_STAGE_SCHEMA[calibrationState.stage];

  const missing = schema.targets
    .filter((tg) => !tg.optional && !tg.secondPass && !calibrationState.marks[tg.name])
    .map((tg) => tg.label);
  if (missing.length > 0) {
    return notify(t('Mark these targets first: {targets}', { targets: missing.join(', ') }), t('Incomplete'));
  }

  const fields = {};
  for (const [name, mark] of Object.entries(calibrationState.marks)) {
    Object.assign(fields, TARGET_TO_FIELDS[name](mark));
  }

  const result = await apiPut('/admin/calibration', {
    stage: calibrationState.stage,
    fields,
  });
  if (result?.error) {
    return notify(result.error, t('Save failed'));
  }
  const stageTitle = schema.title;

  // A two-pass stage saved with its second-pass target still unmarked is only half
  // done, and the operator has no way to know that from a bare "saved" — so say
  // what to do next instead of leaving the instruction paragraph to carry it.
  const stillDeferred = schema.targets
    .filter((tg) => tg.secondPass && !calibrationState.marks[tg.name])
    .map((tg) => tg.label);
  const stage = calibrationState.stage;
  if (stillDeferred.length > 0) {
    await notify(
      t('{stage} saved — but this stage isn\'t finished. Click "Capture new screenshot" again: now that the earlier target is saved, the scanner can navigate one step further, and the new screenshot is where you mark {targets}.', { stage: stageTitle, targets: joinAnd(stillDeferred) }),
      t('Half done — capture again'),
    );
    cancelCalibration();
    // Re-enter the stage rather than dropping the operator on a page with
    // nothing selected. Told "capture again", they previously had to work out
    // for themselves that this meant re-picking the stage first — and the stage
    // button looks the same whether it is half done or untouched.
    if (typeof rerender === 'function') await rerender('system');
    await startCalibrationStage(stage, { secondPass: true });
    return;
  }
  await notify(t('{stage} saved.', { stage: stageTitle }), t('Calibrated'));
  cancelCalibration();
  if (typeof rerender === 'function') rerender('system');
}

/**
 * Zero every target in the current stage, on the server and in the wizard.
 *
 * The escape hatch for a mark that needs *removing* rather than moving — re-marking
 * and saving can correct a position, but there is no way to express "nothing here"
 * through a save, because the save route rejects zeros on purpose.
 */
export async function resetCalibrationStage(rerender) {
  if (!calibrationState?.stage) {
    return notify(t('Pick a stage first (the Stage 1–6 buttons above).'), t('No stage'));
  }
  const stage = calibrationState.stage;
  const schema = CALIBRATION_STAGE_SCHEMA[stage];
  const ok = await confirmDialog(
    t('This clears every saved mark for {stage} — {targets} — back to uncalibrated. Other stages are untouched. You will need to re-capture and re-mark this one before whatever depends on it can run again.', { stage: schema.title, targets: schema.targets.map((tg) => tg.label).join(', ') }),
    { title: t('Reset {stage}?', { stage: schema.title }), confirmLabel: t('Reset stage'), danger: true },
  );
  if (!ok) return;

  const result = await apiPost('/admin/calibration/reset', { stage });
  if (result?.error) {
    return notify(result.error, t('Reset failed'));
  }
  await notify(
    t('{stage} reset. Click Capture new screenshot to start it over.', { stage: schema.title }),
    t('Stage cleared'),
  );
  cancelCalibration();
  if (typeof rerender === 'function') rerender('system');
}

export function cancelCalibration(opts = {}) {
  calibrationState = null;
  const canvas = document.getElementById('calibrationCanvas');
  if (canvas) canvas.style.display = 'none';
  const wrapper = document.getElementById('calibrationImageWrapper');
  if (wrapper) {
    wrapper.onmousedown = null;
    wrapper.onmousemove = null;
    wrapper.onmouseup = null;
    wrapper.onmouseleave = null;
  }
  const overlay = document.getElementById('calibrationOverlay');
  if (overlay) overlay.innerHTML = '';
  const saveBtn = document.getElementById('saveCalibrationBtn');
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.title = '';
  }
  const saveHint = document.getElementById('calibrationSaveHint');
  if (saveHint) saveHint.textContent = '';
  const status = document.getElementById('calibrationStatus');
  if (status && !opts.keepMessage) status.textContent = '';
  const toolbar = document.getElementById('calibrationTargetToolbar');
  if (toolbar) toolbar.innerHTML = '';
  const hint = document.getElementById('calibrationActiveTargetHint');
  if (hint) hint.textContent = '';
  if (!opts.keepMessage) {
    const instr = document.getElementById('calibrationStageInstruction');
    if (instr) instr.style.display = 'none';
    const example = document.getElementById('calibrationExample');
    if (example) example.innerHTML = '';
    const captureRow = document.getElementById('calibrationCaptureRow');
    if (captureRow) captureRow.style.display = 'none';
    setCaptureButtonPrimary(false);
    // Put the highlight back on the stage the operator has yet to do, instead
    // of leaving all six flat — cancelling a stage shouldn't erase the page's
    // own sense of where they are.
    document.querySelectorAll('[data-action="calibrate-stage"]').forEach((btn) => {
      btn.classList.toggle('btn-primary', btn.dataset.nextStage === '1');
    });
  }
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
  setTransferStatus(t('Reading backup file...'), 15);

  try {
    const buffer = await file.arrayBuffer();
    setTransferStatus(t('Encoding backup for upload...'), 35);

    const contentBase64 = arrayBufferToBase64(buffer);
    setTransferStatus(t('Uploading backup and restoring database...'), 75);

    const result = await apiPost('/import/backup-db', {
      fileName: file.name,
      contentBase64,
    });

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

