// "City bonuses" sheet on a member profile: the three speeds of the game's
// Statistics page — research, construction and troop training — worked out
// from the member's city every time it is read (GET /api/game/members/:id/
// speeds; src/game-protocol/city-speeds.ts), where each comes from, and how
// they moved, one point per game day read. Under them every other bonus the
// city has, as the game names it — production per resource, strength, health
// and march speed per troop type, crypts, points… (GET …/stats;
// city-stats.ts) — and every change.
//
// They are the PERMANENT bonuses: research, buildings, the gear on the hero and
// the line-up captains, captains, titles, artifacts, VIP and the clan's
// research. A boost that runs out (a speed item, a clan bonus) never reaches
// the site, so the game shows more while one runs — said under the numbers.

import { api } from '../lib/api.js';
import { esc, formatDate, formatDateShort, formatRelativeTime } from '../lib/ui.js';
import { t, tGame } from '../lib/i18n.js';
import { emptyHtml, foldHtml, statHtml, tableCardHtml } from '../lib/ui-kit.js';

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

/**
 * Every bonus, grouped by its effect kind (T20; city-stats.ts keys them
 * "kind:label"). A kind not listed goes under Other. `open`: unfolded at first.
 */
const GROUPS = [
  { key: 'speeds', title: () => t('Speeds'), kinds: [0, 2, 17, 24, 25, 26], open: true },
  { key: 'production', title: () => t('Production and storage'), kinds: [1, 9, 15, 72], open: true },
  { key: 'army', title: () => t('Army'), kinds: [3, 4, 5, 6, 7, 8, 20, 22, 23, 28, 56, 59, 93, 101, 102] },
  { key: 'crypts', title: () => t('Crypts'), kinds: [10, 11, 12, 21, 73] },
  { key: 'points', title: () => t('Points and experience'), kinds: [18, 19] },
  { key: 'captains', title: () => t('Captains'), kinds: [67, 75, 84] },
  { key: 'other', title: () => t('Other'), kinds: [] },
];

/** "17:Research speed" → { kind, label }. */
function splitStat(stat) {
  const i = stat.indexOf(':');
  return { kind: Number(stat.slice(0, i)), label: stat.slice(i + 1) };
}

/** [percent, flat] as the game prints a bonus: "+541%", "−78%", "+11,000", or both. */
export function statValueText([pct, flat]) {
  const sign = (v) => (v > 0 ? '+' : '−');
  const parts = [];
  if (pct) parts.push(`${sign(pct)}${pctText(Math.abs(pct))}`);
  if (flat) parts.push(`${sign(flat)}${Math.abs(flat).toLocaleString('en-US')}`);
  return parts.join(' · ') || '0';
}

/** A bonus's move as words with its arrow; '' when it didn't move. */
function statDeltaHtml(from, to) {
  const dp = Math.round((to[0] - from[0]) * 10) / 10;
  const df = Math.round(to[1] - from[1]);
  if (!dp && !df) return '';
  const up = (dp || df) > 0;
  return `<span class="ui-delta ${up ? 'is-up' : 'is-down'}"><span aria-hidden="true">${up ? '▲' : '▼'}</span> ${esc(statValueText([dp, df]))}</span>`;
}

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
  let stats = null;
  try {
    // Every bonus rides along; the speeds stand without it.
    [data, stats] = await Promise.all([
      api(`/game/members/${memberId}/speeds`),
      api(`/game/members/${memberId}/stats`).catch(() => null),
    ]);
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
  el.innerHTML = speedsHtml(data, stats?.latest ? stats : null);
}

function speedsHtml(data, stats) {
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
    ${stats ? everyBonusHtml(stats) : ''}
    ${stats ? statChangesHtml(stats) : changesHtml(history)}`;
}

/** Every bonus of the city, a fold per group: the bonus, what it is now, how it moved since the first read. */
function everyBonusHtml(stats) {
  const now = stats.latest.stats || {};
  const first = stats.first?.stats || {};
  const since = stats.first?.gameDate && stats.first.gameDate !== stats.latest.gameDate ? stats.first.gameDate : null;
  const placed = new Set(GROUPS.flatMap((g) => g.kinds));
  const groupOf = (kind) => GROUPS.find((g) => g.kinds.includes(kind)) || GROUPS[GROUPS.length - 1];
  const byGroup = new Map(GROUPS.map((g) => [g.key, []]));
  for (const [stat, value] of Object.entries(now)) {
    const { kind, label } = splitStat(stat);
    byGroup.get((placed.has(kind) ? groupOf(kind) : GROUPS[GROUPS.length - 1]).key).push({ stat, kind, label, value });
  }
  const folds = GROUPS.map((g) => {
    const rows = byGroup.get(g.key).sort((a, b) => a.kind - b.kind || tGame(a.label).localeCompare(tGame(b.label)));
    if (!rows.length) return '';
    const body = `
      <table class="ui-table sp-table sp-all">
        <colgroup><col class="col-bonus"><col class="col-now"><col class="col-since"></colgroup>
        <thead><tr><th scope="col">${esc(t('Bonus'))}</th><th scope="col" class="num">${esc(t('Now'))}</th><th scope="col" class="num">${since ? esc(t('Since {date}', { date: formatDateShort(since) })) : ''}</th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
            <th scope="row">${esc(tGame(r.label))}</th>
            <td class="num">${esc(statValueText(r.value))}</td>
            <td class="num">${since ? statDeltaHtml(first[r.stat] || [0, 0], r.value) : ''}</td>
          </tr>`).join('')}</tbody>
      </table>`;
    return foldHtml({ key: `member-bonus-${g.key}`, title: `${esc(g.title())} <span class="sp-count">${rows.length}</span>`, body, open: !!g.open, cls: 'sp-group' });
  }).join('');
  return `
    <section class="ui-tile sp-every" aria-labelledby="sp-every-title">
      <div class="ui-tile-head"><h2 class="ui-tile-title" id="sp-every-title">${esc(t('Every bonus'))}</h2><span class="ui-sub">${esc(t('As the game names them; boosts that run out are not included'))}</span></div>
      ${folds}
    </section>`;
}

/** Every bonus that moved, newest first. */
function statChangesHtml(stats) {
  const changes = Array.isArray(stats.changes) ? stats.changes : [];
  const total = Number(stats.changeCount) || changes.length;
  const since = stats.first?.gameDate;
  const body = changes.length
    ? `<ul class="sp-changes">${changes.slice(0, MAX_CHANGES).map((c) => {
        const { label } = splitStat(c.stat);
        return `<li class="sp-change">
          <span class="sp-change-date">${esc(formatDateShort(c.gameDate))}</span>
          <span class="sp-change-stat">${esc(tGame(label))}</span>
          <span class="sp-change-values">${esc(statValueText(c.from))} → ${esc(statValueText(c.to))}</span>
          ${statDeltaHtml(c.from, c.to)}
        </li>`;
      }).join('')}</ul>${total > MAX_CHANGES ? `<p class="ui-sub sp-more">${esc(t('… and {n} earlier', { n: total - MAX_CHANGES }))}</p>` : ''}`
    : `<div class="ui-card-pad">${emptyHtml(since ? t('No change since {date}', { date: formatDateShort(since) }) : t('No changes yet'))}</div>`;
  return tableCardHtml({
    title: esc(t('Changes')),
    hint: since ? esc(t('Since {date}, one read a day', { date: formatDateShort(since) })) : '',
    body,
    cls: 'sp-history',
  });
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
