/**
 * The shell's scan card: which clan the scanner is on, what it is doing, how
 * long it has run and where it is in the cycle. It sits in the sidebar's
 * scanner card, which is also the phone's More sheet; every [data-scan-card]
 * gets the same content.
 *
 * Clans on different game accounts scan at the same time: `activity.clans`
 * lists every one, shown as "CWB · SIK" with one current segment each on the
 * track. Fed from /api/status's `activity` block every 2 s. The skeleton is built
 * once and only its text changes between polls: re-rendering the markup would
 * restart the pulse and shimmer animations every two seconds.
 */
import { t, tn } from './i18n.js';
import { formatCountdown } from './ui.js';

const PHASE_LABELS = {
  starting: t('Starting'),
  scan: t('Scanning'),
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
  // The sidebar's scanner card swaps its state line for this card (style.css).
  document.body.classList.toggle('is-scanning', !!activity);
  if (!activity) {
    elapsedBase = null;
    return;
  }
  elapsedBase = Number.isFinite(activity.elapsedMs)
    ? { ms: activity.elapsedMs, at: Date.now() }
    : null;

  const clans = Array.isArray(activity.clans) && activity.clans.length ? activity.clans : [activity];
  const several = clans.length > 1;
  const inCycle = Number.isFinite(activity.cycleTotal) && activity.cycleTotal > 1
    && (Number.isFinite(activity.cycleDone) || Number.isFinite(activity.cyclePosition));
  const done = Number.isFinite(activity.cycleDone) ? activity.cycleDone : (activity.cyclePosition ?? 1) - 1;
  const nameOf = (c) => c.clanName || t('Clan #{id}', { id: c.clanId });
  // Several clans at once: their short codes ("CWB · SIK · SK7") fit the card;
  // full names were cut off. The full names stay in the tooltip.
  const shortOf = (c) => c.clanShort || nameOf(c);
  const clanName = clans.map(several ? shortOf : nameOf).join(' · ');
  const clanTitle = clans.map(nameOf).join(' · ');
  // One segment per clan of the cycle: done, current (one per clan scanning
  // now), still to come. Outside a cycle the single segment is just the
  // "working" shimmer.
  const trackKey = inCycle ? `${done}+${clans.length}/${activity.cycleTotal}` : '0+1/1';
  const stepText = !inCycle ? '' : several ? `${done}/${activity.cycleTotal}` : `${done + 1}/${activity.cycleTotal}`;
  const stepTitle = !inCycle ? ''
    : several ? t('{done} of {total} clans done', { done, total: activity.cycleTotal })
      : t('Clan {position} of {total}', { position: done + 1, total: activity.cycleTotal });
  const detailText = several ? tn(clans.length, '{n} clan scanning at once', '{n} clans scanning at once') : detail;

  for (const card of document.querySelectorAll('[data-scan-card]')) {
    if (!card.querySelector('.scan-card-head')) card.innerHTML = SKELETON;
    card.dataset.phase = activity.phase;
    setText(card.querySelector('.scan-card-phase'), PHASE_LABELS[activity.phase] ?? PHASE_LABELS.scan);
    const clanEl = card.querySelector('.scan-card-clan');
    setText(clanEl, clanName);
    if (clanEl) clanEl.title = clanTitle;
    const detailEl = card.querySelector('.scan-card-detail');
    setText(detailEl, detailText);
    if (detailEl) detailEl.title = several ? clans.map((c) => `${nameOf(c)}: ${c.progressMessage || ''}`).join('\n') : detailText;

    const track = card.querySelector('.scan-card-track');
    if (track && track.dataset.key !== trackKey) {
      const [head, totalStr] = trackKey.split('/');
      const [doneN, runningN] = head.split('+').map(Number);
      const total = Number(totalStr);
      track.innerHTML = Array.from({ length: total }, (_, i) => {
        const cls = i < doneN ? ' is-done' : (i < doneN + runningN ? ' is-current' : '');
        return `<span class="scan-card-seg${cls}"></span>`;
      }).join('');
      track.dataset.key = trackKey;
    }
    const stepEl = card.querySelector('.scan-card-step');
    setText(stepEl, stepText);
    if (stepEl) stepEl.title = stepTitle;
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
