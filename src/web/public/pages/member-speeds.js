// "Speed bonuses" sheet on a member profile: the three speeds of the game's
// Statistics page — research, construction and troop training — worked out
// from the member's city every time it is read (GET /api/game/members/:id/
// speeds; src/game-protocol/city-speeds.ts), where each comes from, and how
// they moved, one point per game day read.
//
// They are the PERMANENT bonuses: research, buildings, the gear on the hero and
// the line-up captains, captains, titles, artifacts, VIP and the clan's
// research. A boost that runs out (a speed item, a clan bonus) never reaches
// the site, so the game shows more while one runs — said under the numbers.

import { api } from '../lib/api.js';
import { esc, formatDate, formatDateShort, formatRelativeTime } from '../lib/ui.js';
import { t } from '../lib/i18n.js';
import { emptyHtml, statHtml, tableCardHtml } from '../lib/ui-kit.js';

/** The Statistics page's order, in the game's words; `short` heads a table column (four columns fit a phone). */
const STATS = [
  { key: 'research', label: () => t('Research speed'), short: () => t('Research') },
  { key: 'construction', label: () => t('Construction speed'), short: () => t('Construction') },
  { key: 'training', label: () => t('Troop training speed'), short: () => t('Training') },
];

/** Where a bonus comes from (city-speeds.ts SpeedSource). */
const SOURCE_LABEL = {
  research: () => t('Research'),
  buildings: () => t('Buildings'),
  gear: () => t('Gear'),
  captains: () => t('Captains'),
  titles: () => t('Titles'),
  artifacts: () => t('Artifacts'),
  offers: () => t('Offers'),
  vip: () => t('VIP'),
  clan: () => t('Clan research'),
  other: () => t('Other'),
};

/** Changes listed at most; older ones are counted. */
const MAX_CHANGES = 40;

/** 2016.25 → "2,016.3%", as the game rounds it. */
export function pctText(v) {
  return `${Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: 1 })}%`;
}

/** "▲ +45.5%" / "▼ −12%": the sign is in the text, so it reads without the arrow (the kit's .ui-delta colours). */
function pctDeltaHtml(delta, label = '') {
  const d = Math.round(delta * 10) / 10;
  const cls = d > 0 ? 'is-up' : d < 0 ? 'is-down' : 'is-flat';
  const glyph = d > 0 ? '▲' : d < 0 ? '▼' : '±';
  const text = `${d > 0 ? '+' : d < 0 ? '−' : ''}${pctText(Math.abs(d))}`;
  return `<span class="ui-delta ${cls}"><span aria-hidden="true">${glyph}</span> ${esc(text)}${label ? ` <span class="ui-delta-label">${esc(label)}</span>` : ''}</span>`;
}

/**
 * Every day a speed moved: { gameDate, stat, from, to } newest first. A day
 * the read missed is no change — the next read says where it went.
 */
export function speedChanges(history) {
  const out = [];
  for (let i = 1; i < history.length; i++) {
    for (const s of STATS) {
      const from = history[i - 1][s.key];
      const to = history[i][s.key];
      if (Math.abs(to - from) >= 0.005) out.push({ gameDate: history[i].gameDate, stat: s.key, from, to });
    }
  }
  return out.reverse();
}

/** A line scaled to its own lowest and highest point: a 2,000 % series that moves by 40 still shows it. */
function sparkSvg(values) {
  if (values.length < 2) return '';
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const step = 100 / (values.length - 1);
  const pts = values.map((v, i) => `${(i * step).toFixed(2)},${(hi === lo ? 14 : 25 - ((v - lo) / span) * 22).toFixed(2)}`).join(' ');
  return `<svg class="sp-spark" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true" focusable="false"><polyline points="${pts}"></polyline></svg>`;
}

export function memberSpeedsPanelHtml() {
  return `<div class="member-speeds" data-member-speeds><div class="card"><div class="card-body card-body-padded"><p class="muted-copy">${t('Loading…')}</p></div></div></div>`;
}

function noteCard(text) {
  return `<div class="card"><div class="card-body card-body-padded">${emptyHtml(text)}</div></div>`;
}

export async function mountMemberSpeeds(root, memberId) {
  const el = root.querySelector('[data-member-speeds]');
  if (!el || el.dataset.mounted === String(memberId)) return;
  el.dataset.mounted = String(memberId);
  let data;
  try {
    data = await api(`/game/members/${memberId}/speeds`);
  } catch (err) {
    if (err?.name === 'UnauthenticatedError' || err?.name === 'AbortError') throw err;
    data = null;
  }
  if (!data || data.error) {
    el.innerHTML = noteCard(t("Couldn't load the speed bonuses. Try again in a minute."));
    return;
  }
  if (!data.latest) {
    el.innerHTML = noteCard(t("This member's city hasn't been read from the game yet. It is read once a day."));
    return;
  }
  el.innerHTML = speedsHtml(data);
}

function speedsHtml(data) {
  const history = Array.isArray(data.history) ? data.history : [];
  const first = history[0];
  const latest = data.latest.speeds;
  const tiles = STATS.map((s) => {
    const now = latest[s.key]?.total ?? 0;
    const since = first && history.length > 1 ? now - first[s.key] : null;
    const sub = since === null
      ? ''
      : Math.abs(since) < 0.05
        ? esc(t('No change since {date}', { date: formatDateShort(first.gameDate) }))
        : pctDeltaHtml(since, t('since {date}', { date: formatDateShort(first.gameDate) }));
    return statHtml({ label: esc(s.label()), value: esc(pctText(now)), sub, extra: sparkSvg(history.map((h) => h[s.key])) });
  }).join('');
  const read = `<span title="${esc(formatDate(data.latest.readAt))}">${esc(formatRelativeTime(data.latest.readAt))}</span>`;
  return `
    <section class="ui-tile sp-card" aria-labelledby="sp-title">
      <div class="ui-tile-head"><h2 class="ui-tile-title" id="sp-title">${esc(t('Totals'))}</h2><span class="ui-sub">${t('City read {when}', { when: read })}</span></div>
      <div class="ui-stats sp-stats">${tiles}</div>
      <p class="ui-sub sp-note">${esc(t("As the game's Statistics page adds them up. Boosts that run out — speed items, clan bonuses — don't reach the site, so the game shows more while one runs."))}</p>
    </section>
    ${breakdownHtml(latest)}
    ${changesHtml(history)}`;
}

/** Where each speed comes from: one row per source, the biggest first. */
function breakdownHtml(latest) {
  const sources = Object.keys(SOURCE_LABEL)
    .map((src) => ({ src, values: STATS.map((s) => latest[s.key]?.by?.[src] ?? 0) }))
    .filter((r) => r.values.some((v) => v !== 0))
    .sort((a, b) => b.values.reduce((x, y) => x + y, 0) - a.values.reduce((x, y) => x + y, 0));
  if (!sources.length) return '';
  const cell = (v) => `<td class="num${v ? '' : ' is-zero'}">${v ? esc(pctText(v)) : '—'}</td>`;
  const body = `
    <table class="ui-table sp-table">
      <colgroup><col class="col-source">${STATS.map(() => '<col class="col-pct">').join('')}</colgroup>
      <thead><tr><th scope="col">${esc(t('From'))}</th>${STATS.map((s) => `<th scope="col" class="num" title="${esc(s.label())}">${esc(s.short())}</th>`).join('')}</tr></thead>
      <tbody>${sources.map((r) => `<tr><th scope="row">${esc(SOURCE_LABEL[r.src]())}</th>${r.values.map(cell).join('')}</tr>`).join('')}</tbody>
      <tfoot><tr><th scope="row">${esc(t('Total'))}</th>${STATS.map((s) => `<td class="num">${esc(pctText(latest[s.key]?.total ?? 0))}</td>`).join('')}</tr></tfoot>
    </table>`;
  return tableCardHtml({ title: esc(t('Where they come from')), hint: esc(t('Gear counts on the hero and the three captains in the line-up, as in the game')), body, cls: 'sp-breakdown' });
}

/** Every day a speed moved, newest first. */
function changesHtml(history) {
  const changes = speedChanges(history);
  const since = history[0]?.gameDate;
  const label = Object.fromEntries(STATS.map((s) => [s.key, s.label()]));
  const body = changes.length
    ? `<ul class="sp-changes">${changes.slice(0, MAX_CHANGES).map((c) => `<li class="sp-change">
          <span class="sp-change-date">${esc(formatDateShort(c.gameDate))}</span>
          <span class="sp-change-stat">${esc(label[c.stat])}</span>
          <span class="sp-change-values">${esc(pctText(c.from))} → ${esc(pctText(c.to))}</span>
          ${pctDeltaHtml(c.to - c.from)}
        </li>`).join('')}</ul>${changes.length > MAX_CHANGES ? `<p class="ui-sub sp-more">${esc(t('… and {n} earlier', { n: changes.length - MAX_CHANGES }))}</p>` : ''}`
    : `<div class="ui-card-pad">${emptyHtml(since ? t('No change since {date}', { date: formatDateShort(since) }) : t('No changes yet'))}</div>`;
  return tableCardHtml({
    title: esc(t('Changes')),
    hint: since ? esc(t('Since {date}, one read a day', { date: formatDateShort(since) })) : '',
    body,
    cls: 'sp-history',
  });
}
