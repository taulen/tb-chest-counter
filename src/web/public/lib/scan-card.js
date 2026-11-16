/**
 * The shell's scan card: which clan the scanner is on, what it is doing, how
 * long it has run and where it is in the cycle. One copy sits in the sidebar
 * foot (a strip in the tablet top bar), another at the top of the phone menu;
 * every [data-scan-card] gets the same content.
 *
 * Fed from /api/status's `activity` block every 2 s. The skeleton is built
 * once and only its text changes between polls: re-rendering the markup would
 * restart the pulse and shimmer animations every two seconds.
 */
import { t } from './i18n.js';
import { formatCountdown } from './ui.js';

const PHASE_LABELS = {
  starting: t('Starting'),
  scan: t('Scanning'),
  might: t('Reading might'),
  resources: t('Reading resources'),
  calibration: t('Calibrating'),
};

const SKELETON = `
  <div class="scan-card-head">
    <span class="scan-card-pulse" aria-hidden="true"></span>
    <span class="scan-card-phase"></span>
    <span class="scan-card-time"></span>
  </div>
  <div class="scan-card-clan"></div>
  <div class="scan-card-detail"></div>
  <div class="scan-card-progress">
    <div class="scan-card-track" aria-hidden="true"></div>
    <span class="scan-card-step"></span>
  </div>`;

/** Elapsed time as of the last poll, ticked locally between polls. */
let elapsedBase = null;

function setText(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}

/**
 * @param {object|null} activity /api/status `activity` (null = nothing running)
 * @param {{ detail?: string }} opts the line under the clan name
 */
export function renderScanCards(activity, { detail = '' } = {}) {
  const topbar = document.querySelector('.topbar');
  topbar?.classList.toggle('is-scanning', !!activity);
  if (!activity) {
    elapsedBase = null;
    return;
  }
  elapsedBase = Number.isFinite(activity.elapsedMs)
    ? { ms: activity.elapsedMs, at: Date.now() }
    : null;

  const inCycle = Number.isFinite(activity.cyclePosition) && Number.isFinite(activity.cycleTotal)
    && activity.cycleTotal > 1;
  const clanName = activity.clanName || t('Clan #{id}', { id: activity.clanId });
  // One segment per clan of the cycle: done, current, still to come. Outside
  // a cycle the single segment is just the "working" shimmer.
  const trackKey = inCycle ? `${activity.cyclePosition}/${activity.cycleTotal}` : '1/1';

  for (const card of document.querySelectorAll('[data-scan-card]')) {
    if (!card.querySelector('.scan-card-head')) card.innerHTML = SKELETON;
    card.dataset.phase = activity.phase;
    setText(card.querySelector('.scan-card-phase'), PHASE_LABELS[activity.phase] ?? PHASE_LABELS.scan);
    const clanEl = card.querySelector('.scan-card-clan');
    setText(clanEl, clanName);
    if (clanEl) clanEl.title = clanName;
    const detailEl = card.querySelector('.scan-card-detail');
    setText(detailEl, detail);
    if (detailEl) detailEl.title = detail;

    const track = card.querySelector('.scan-card-track');
    if (track && track.dataset.key !== trackKey) {
      const [pos, total] = trackKey.split('/').map(Number);
      track.innerHTML = Array.from({ length: total }, (_, i) => {
        const cls = i + 1 < pos ? ' is-done' : (i + 1 === pos ? ' is-current' : '');
        return `<span class="scan-card-seg${cls}"></span>`;
      }).join('');
      track.dataset.key = trackKey;
    }
    const stepEl = card.querySelector('.scan-card-step');
    setText(stepEl, inCycle ? `${activity.cyclePosition}/${activity.cycleTotal}` : '');
    if (stepEl) {
      stepEl.title = inCycle ? t('Clan {position} of {total}', { position: activity.cyclePosition, total: activity.cycleTotal }) : '';
    }
  }
  tickScanCards();
}

/** Advance the elapsed timer; app.js calls this every second. */
export function tickScanCards() {
  const text = elapsedBase
    // Floored to whole seconds: formatCountdown rounds up, which suits a
    // countdown but would run an elapsed time a second ahead.
    ? formatCountdown(Math.floor((elapsedBase.ms + Date.now() - elapsedBase.at) / 1000) * 1000)
    : '';
  for (const el of document.querySelectorAll('[data-scan-card] .scan-card-time')) setText(el, text);
}
