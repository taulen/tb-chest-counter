// Resources — Chest rewards tab.
//
// What the clan's opened chests paid out, from the game's own reply to every
// claim the scan sends (game_claims; src/data/chest-rewards.ts does the sums,
// GET /api/resources/chest-rewards). Two views of one period (Daily / Weekly /
// Monthly, stepped ← → on the game-day clock of lib/period.js):
//
//   Income   — the period's totals per reward, each in its own unit: resources
//              as amounts (a resource pack counts as the resource it holds),
//              speedups as total time, everything else as a count of the item;
//              and a per-game-day trend of one of them.
//   By chest — every chest type opened in the period: how many, and what one
//              chest gives on average and how often; a chest opens its full
//              breakdown.
//
// Items and chests are the game's own art, drawn the way the game's reward
// windows draw them (lib/game-art.js itemIconHtml / rewardChipHtml /
// chestIconHtml).

import { loadGameArt, itemIconHtml, chestIconHtml, rewardChipHtml } from '../lib/game-art.js';
import { api } from '../lib/api.js';
import { esc, contentModal } from '../lib/ui.js';
import { t, tn, tGame } from '../lib/i18n.js';
import { sortableThHtml } from '../lib/sort-headers.js';
import { computeGameWindow } from '../lib/period.js';
import { getGameDayRolloverUtcHour, getWeekStart } from '../lib/state.js';
import {
  periodScrubberHtml, wirePeriodScrubber, segHtml, tileHtml, emptyHtml as kitEmptyHtml, errorStateHtml, wireRetry, setPageActions,
} from '../lib/ui-kit.js';
import { describeChart } from '../lib/chart-a11y.js';
import {
  plainNumber, compactNumber, exactNumber, formatSeconds, formatRewardValue,
  rewardItemName, rewardItemOf, rewardTotalDetail, rewardTotalChip,
} from '../lib/reward-format.js';
import { readToken } from '../lib/theme.js';

const PAGE_SIZE = 25;
const PERIODS = ['daily', 'weekly', 'monthly'];
/** A Daily view's trend reaches back this many game days (one day is no trend). */
const DAILY_TREND_DAYS = 14;
/** Count items shown before "Show all". */
const ITEMS_PREVIEW = 24;
/** Reward chips per chest in the By chest table. */
const CHEST_TOP_REWARDS = 4;
const DAY_MS = 86_400_000;
/** A reward tile in the Income view, frame included (px). */
const TILE_SIZE = 64;

const view = {
  mode: 'income',
  period: 'weekly',
  offset: 0,
  metric: 'chests',
  sort: { key: 'chests', dir: 'desc' },
  page: 1,
  showAllItems: false,
};
let cache = null;
let mountedEl = null;
let chart = null;
let loadSeq = 0;

function destroyChart() {
  if (chart) { try { chart.destroy(); } catch (_) { /* gone */ } chart = null; }
}

// Chart.js snapshots colours when built: redraw on a theme switch.
document.addEventListener('themechange', () => {
  if (mountedEl && document.contains(mountedEl) && cache) drawTrend();
});

// ─── Formatting ─────────────────────────────────────────────────────────────

// Numbers, durations and reward totals: lib/reward-format.js (Scan History prints them the same way).
const plain = plainNumber;
const formatValue = formatRewardValue;
const pct = (share) => `${plain(share * 100, share < 0.1 ? 1 : 0)}%`;

// ─── Items ──────────────────────────────────────────────────────────────────

const itemName = (id) => rewardItemName(cache?.items, id);
/** The item a reward shows as, ready for rewardChipHtml / itemIconHtml. */
const itemOf = (id) => rewardItemOf(cache?.items, id);

function chestOf(giftType) {
  const c = cache?.chestTypes?.[giftType] ?? {};
  return {
    rawName: c.name ?? '',
    name: c.name ? tGame(c.name) : t('Chest {id}', { id: giftType }),
    source: c.source ? tGame(c.source) : '',
    iconUrl: c.iconUrl ?? null,
    quality: c.quality ?? 0,
  };
}

/** What makes up a total, for its tooltip: "250,000 from packs", "279 × 8h". */
const totalDetail = (tot) => rewardTotalDetail(tot, cache?.items);

/** A period total as the game's reward window shows it: tile, amount on it, name under it. */
const totalChip = (tot) => rewardTotalChip(tot, cache?.items, { size: TILE_SIZE });

/** What one chest gives on average, small and inline for a table cell. */
function perChestChip(r) {
  const item = itemOf(r.itemId);
  const avg = formatValue(r.unit, r.perChest, { exact: r.unit !== 'time' });
  const label = r.dropRate === null
    ? t('{name}: {amount} per chest', { name: item.name, amount: avg })
    : t('{name}: {amount} per chest, in {rate} of chests', { name: item.name, amount: avg, rate: pct(r.dropRate) });
  return rewardChipHtml(item, formatValue(r.unit, r.perChest), { size: 32, layout: 'inline', label });
}

// ─── Data ───────────────────────────────────────────────────────────────────

function windowFor(period, offset) {
  const win = computeGameWindow(period, offset);
  const trendFrom = period === 'daily'
    ? new Date(Date.parse(win.from) - (DAILY_TREND_DAYS - 1) * DAY_MS).toISOString()
    : win.from;
  return { ...win, trendFrom };
}

async function reload() {
  const seq = ++loadSeq;
  const win = windowFor(view.period, view.offset);
  const qs = new URLSearchParams({ from: win.from, to: win.to, trendFrom: win.trendFrom });
  mountedEl?.querySelector('.chest-rewards-body')?.classList.add('is-loading');
  let res;
  try {
    res = await api(`/resources/chest-rewards?${qs}`);
  } catch (err) {
    // A navigation away (AbortError) or a signed-out session is not this page's to report.
    if (err?.name === 'AbortError' || err?.name === 'UnauthenticatedError') return;
    res = { error: err?.message || t('Could not load the chest rewards.') };
  }
  if (seq !== loadSeq) return; // a newer period was asked for meanwhile
  if (!res || res.error) {
    cache = null;
    paint(res?.error || ' ');
    return;
  }
  cache = res;
  const keys = new Set(['chests', ...trendKeys().map((k) => k.key)]);
  if (!keys.has(view.metric)) view.metric = 'chests';
  paint();
}

/** The totals the trend can show: amounts and time (counts are too sparse per day). */
function trendKeys() {
  return (cache?.income?.totals ?? []).filter((tot) => tot.unit !== 'count');
}

// ─── Render ─────────────────────────────────────────────────────────────────

export async function renderResourcesChestRewards(el) {
  mountedEl = el;
  destroyChart();
  setPageActions('');
  el.innerHTML = `<div class="chest-rewards-page">${kitEmptyHtml(t('Loading chest rewards…'))}</div>`;
  // The game's art index (frames, chest icons) is in before the first paint.
  await loadGameArt();
  await reload();
}

/**
 * The window (the kit's period scrubber) and the view (Income | By chest):
 * one header for both, the period is theirs together.
 */
function headerHtml() {
  const rolloverHr = getGameDayRolloverUtcHour();
  const weekStart = getWeekStart();
  return `<div class="ui-toolbar cr-controls">
      ${periodScrubberHtml({
        periods: PERIODS, period: view.period, offset: view.offset, rolloverHr, weekStart,
        win: computeGameWindow(view.period, view.offset, rolloverHr, weekStart),
      })}
      ${segHtml({
        label: t('View'),
        items: [{ value: 'income', label: t('Income') }, { value: 'chests', label: t('By chest') }],
        current: view.mode,
        attr: 'cr-mode',
      })}
    </div>`;
}

function paint(error = '') {
  if (!mountedEl) return;
  destroyChart();
  const body = error
    ? errorStateHtml(t('Could not load the chest rewards.'), error.trim())
    : (view.mode === 'income' ? incomeHtml() : byChestHtml());
  mountedEl.innerHTML = `
    <div class="chest-rewards-page">
      ${headerHtml()}
      <div class="chest-rewards-body">${body}</div>
    </div>`;
  wire(mountedEl);
  if (error) wireRetry(mountedEl, reload);
  else if (view.mode === 'income') drawTrend();
}

function noChestsHtml() {
  return kitEmptyHtml(t('No chests were opened in this period.'));
}

// ─── Income ─────────────────────────────────────────────────────────────────

/** Game days of [from, now) inside the window, at least 1 — "per day" never counts days still ahead. */
function elapsedDays() {
  const end = Math.min(Date.parse(cache.to), Date.now());
  return Math.max(1, Math.ceil((end - Date.parse(cache.from)) / DAY_MS));
}

function incomeHtml() {
  const inc = cache?.income;
  if (!inc?.chests) return noChestsHtml();
  const tiles = [
    [t('Chests opened'), plain(inc.chests)],
    // A day's "per day" would only repeat the count beside it.
    ...(view.period === 'daily' ? [] : [[t('Chests per day'), exactNumber(inc.chests / elapsedDays())]]),
    [t('Chest types'), plain(inc.chestTypes)],
    [t('Different rewards'), plain(inc.totals.length)],
  ];
  const groups = [
    { unit: 'amount', title: t('Resources'), hint: t('Each in its own unit · packs count as the resource they hold') },
    { unit: 'time', title: t('Speedups'), hint: t('Total time') },
    { unit: 'count', title: t('Items'), hint: t('How many of each') },
  ];
  const sections = groups.map(({ unit, title, hint }) => {
    const list = inc.totals.filter((tot) => tot.unit === unit);
    if (!list.length) return '';
    // Fold only when it saves a real amount of scrolling, never to hide two or three.
    const foldable = unit === 'count' && list.length > ITEMS_PREVIEW + 6;
    const shown = foldable && !view.showAllItems ? list.slice(0, ITEMS_PREVIEW) : list;
    const more = foldable
      ? `<button type="button" class="btn btn-tight chest-rewards-more" data-cr-more>${view.showAllItems
        ? t('Show fewer')
        : tn(list.length, 'Show all {n} item', 'Show all {n} items', { n: list.length })}</button>`
      : '';
    return `
      <section class="chest-rewards-group">
        <div class="chest-rewards-group-head"><h3>${title}</h3><span class="ui-sub">${hint}</span></div>
        <div class="reward-grid">${shown.map((tot) => totalChip(tot)).join('')}</div>
        ${more}
      </section>`;
  }).join('');

  const options = [
    `<option value="chests"${view.metric === 'chests' ? ' selected' : ''}>${esc(t('Chests opened'))}</option>`,
    ...trendKeys().map((tot) => `<option value="${esc(tot.key)}"${view.metric === tot.key ? ' selected' : ''}>${esc(itemName(tot.itemId))}</option>`),
  ].join('');

  const stats = `<div class="ui-big-row">${tiles.map(([label, value]) => `<div class="ui-stat"><div class="ui-stat-label">${esc(label)}</div><div class="ui-big">${esc(value)}</div></div>`).join('')}</div>`;
  const trendTitle = view.period === 'daily'
    ? tn(DAILY_TREND_DAYS, 'Last {n} game day', 'Last {n} game days', { n: DAILY_TREND_DAYS })
    : t('By game day');
  const pick = `<label class="chest-trend-pick">
      <span class="visually-hidden">${t('Show')}</span>
      <select class="input input-tight" id="crTrendMetric">${options}</select>
    </label>`;
  return `<div class="ui-grid">
      ${tileHtml('cr-stats', t('This period'), stats, { span: 12 })}
      ${tileHtml('cr-trend', esc(trendTitle), '<div class="chest-trend-wrap"><canvas id="crTrendChart"></canvas></div>', { span: 12, link: pick })}
      ${tileHtml('cr-rewards', t('Rewards'), `<p class="ui-sub">${t('Hover a reward for the exact total')}</p><div class="chest-rewards-groups">${sections}</div>`, { span: 12 })}
    </div>`;
}

function drawTrend() {
  destroyChart();
  const canvas = document.getElementById('crTrendChart');
  const days = cache?.income?.days ?? [];
  if (!canvas || !days.length || typeof Chart === 'undefined') return;
  const tot = view.metric === 'chests' ? null : trendKeys().find((k) => k.key === view.metric);
  const unit = tot?.unit ?? 'count';
  const label = tot ? itemName(tot.itemId) : t('Chests opened');
  const values = days.map((d) => (tot ? (d.values[tot.key] ?? 0) : d.chests));
  const fmt = (v) => (unit === 'time' ? formatSeconds(v) : plain(v));
  const tick = readToken('--chart-tick');
  const grid = readToken('--chart-grid');
  chart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: days.map((d) => d.day),
      datasets: [{
        label,
        data: values,
        backgroundColor: readToken('--chart-bar-gold'),
        hoverBackgroundColor: readToken('--chart-bar-gold-hover'),
        borderRadius: 4,
        borderSkipped: 'start',
        maxBarThickness: 28,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: readToken('--chart-tooltip-bg'),
          titleColor: readToken('--chart-tooltip-text'),
          bodyColor: readToken('--chart-tooltip-text'),
          borderColor: readToken('--chart-tooltip-border'),
          borderWidth: 1,
          cornerRadius: 8,
          padding: 10,
          callbacks: { label: (ctx) => `${label}: ${fmt(ctx.parsed.y)}` },
        },
      },
      scales: {
        x: { ticks: { color: tick, font: { size: 11 }, maxRotation: 0, autoSkip: true }, grid: { display: false } },
        y: {
          beginAtZero: true,
          ticks: { color: tick, font: { size: 11 }, maxTicksLimit: 5, callback: (v) => (unit === 'time' ? formatSeconds(v) : compactNumber(v)) },
          grid: { color: grid },
        },
      },
    },
  });
  describeChart(chart, { caption: t('{metric} by game day', { metric: label }), xLabel: t('Game day'), format: fmt });
}

// ─── By chest ───────────────────────────────────────────────────────────────

function sortedChests() {
  const rows = [...(cache?.byChest ?? [])];
  const mul = view.sort.dir === 'asc' ? 1 : -1;
  if (view.sort.key === 'chest') {
    rows.sort((a, b) => chestOf(a.giftType).name.localeCompare(chestOf(b.giftType).name) * mul
      || chestOf(a.giftType).source.localeCompare(chestOf(b.giftType).source) * mul);
  } else {
    rows.sort((a, b) => (a.chests - b.chests) * mul || a.giftType - b.giftType);
  }
  return rows;
}

/** A chest's best rewards for the table: what most chests give first (drop rate, then amount). */
function topRewards(stat) {
  return [...stat.rewards]
    .sort((a, b) => (b.dropRate ?? 0) - (a.dropRate ?? 0) || (a.unit === b.unit ? b.perChest - a.perChest : 0))
    .slice(0, CHEST_TOP_REWARDS);
}

function byChestHtml() {
  const all = sortedChests();
  if (!all.length) return noChestsHtml();
  const totalChests = cache.income?.chests || all.reduce((n, c) => n + c.chests, 0);
  const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  if (view.page > pages) view.page = pages;
  const start = (view.page - 1) * PAGE_SIZE;
  const rows = all.slice(start, start + PAGE_SIZE).map((stat) => {
    const chest = chestOf(stat.giftType);
    const tile = chestIconHtml(chest.rawName, { size: 44, url: chest.iconUrl, quality: chest.quality, name: chest.name });
    const gives = topRewards(stat).map((r) => perChestChip(r)).join('');
    const tab = stat.tab === 2 ? t('Triumphal Chests') : t('Gifts');
    return `<tr>
      <td data-label="${t('Chest')}" data-role="primary" class="col-chest">
        <span class="chest-cell">
          ${tile}
          <span class="chest-cell-text">
            <button type="button" class="mrow-name chest-cell-name" data-cr-chest="${stat.giftType}">${esc(chest.name)}</button>
            <span class="chest-cell-source">${esc(chest.source || tab)}</span>
          </span>
        </span>
      </td>
      <td data-label="${t('Opened')}" data-role="metric" class="col-num">${plain(stat.chests)}</td>
      <td data-label="${t('Share')}" class="col-num">${pct(totalChests ? stat.chests / totalChests : 0)}</td>
      <td data-label="${t('One chest gives (average)')}" class="col-gives"><span class="chest-gives">${gives}</span></td>
    </tr>`;
  }).join('');
  const pager = all.length > PAGE_SIZE ? `
    <div class="pagination">
      <button class="btn btn-tight" data-cr-page="prev" ${view.page <= 1 ? 'disabled' : ''}>${t('← Prev')}</button>
      <span class="pagination-info">${t('Page {page} of {pages}', { page: view.page, pages })} · ${tn(all.length, '{n} chest type', '{n} chest types', { n: all.length })}</span>
      <button class="btn btn-tight" data-cr-page="next" ${view.page >= pages ? 'disabled' : ''}>${t('Next →')}</button>
    </div>` : '';
  return `
    <p class="ui-sub">${t('Chest types')} · ${t('Click a chest for everything it gives')}</p>
      <div class="ui-table-card">
        <table class="table-responsive ui-table chest-rewards-table">
          <colgroup><col class="col-chest"><col class="col-opened"><col class="col-share"><col class="col-gives"></colgroup>
          <thead><tr>
            ${sortableThHtml({ key: 'chest', labelHtml: t('Chest'), sortState: view.sort })}
            ${sortableThHtml({ key: 'chests', labelHtml: t('Opened'), sortState: view.sort, className: 'col-num' })}
            <th class="col-num">${t('Share')}</th>
            <th>${t('One chest gives (average)')}</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
        ${pager}
      </div>`;
}

function openChest(giftType) {
  const stat = cache?.byChest?.find((c) => c.giftType === giftType);
  if (!stat) return;
  const chest = chestOf(giftType);
  const tab = stat.tab === 2 ? t('Triumphal Chests') : t('Gifts');
  const rows = stat.rewards.map((r) => {
    const item = itemOf(r.itemId);
    return `<tr>
      <td data-label="${t('Reward')}" data-role="primary">
        <span class="reward-cell">${itemIconHtml(item.iconUrl, { size: 36, quality: item.quality, name: item.name })}
          <span class="mrow-name" title="${esc(totalDetail(r))}">${esc(item.name)}</span></span>
      </td>
      <td data-label="${t('Per chest')}" data-role="metric" class="col-num">${esc(formatValue(r.unit, r.perChest, { exact: r.unit !== 'time' }))}</td>
      <td data-label="${t('Drop rate')}" class="col-num">${r.dropRate === null ? '—' : pct(r.dropRate)}</td>
      <td data-label="${t('Total')}" class="col-num" title="${esc(totalDetail(r))}">${esc(formatValue(r.unit, r.total))}</td>
    </tr>`;
  }).join('');
  const facts = [
    tab,
    tn(stat.chests, '{n} chest opened', '{n} chests opened', { n: plain(stat.chests) }),
    tn(stat.singles, '{n} opened one at a time', '{n} opened one at a time', { n: plain(stat.singles) }),
  ];
  const html = `
    <div class="chest-detail">
      <div class="chest-detail-head">
        ${chestIconHtml(chest.rawName, { size: 76, url: chest.iconUrl, quality: chest.quality, name: chest.name })}
        <div class="chest-detail-meta">
          ${chest.source ? `<div class="chest-detail-source">${esc(chest.source)}</div>` : ''}
          <div class="chest-detail-facts">${facts.map((f) => `<span>${esc(f)}</span>`).join('')}</div>
        </div>
      </div>
      <table class="table-responsive chest-detail-table">
        <colgroup><col class="col-reward"><col class="col-per"><col class="col-drop"><col class="col-total"></colgroup>
        <thead><tr>
          <th>${t('Reward')}</th><th class="col-num">${t('Per chest')}</th><th class="col-num">${t('Drop rate')}</th><th class="col-num">${t('Total')}</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="chest-detail-note">${t('Drop rate: the share of chests opened one at a time that held the reward. Chests opened as a stack come back as one summed reward, so they count toward the averages only.')}</p>
    </div>`;
  contentModal({ title: chest.name, html, wide: true, className: 'chest-detail-modal' });
}

// ─── Wiring ─────────────────────────────────────────────────────────────────

function wire(el) {
  el.querySelectorAll('[data-cr-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (view.mode === btn.dataset.crMode) return;
      view.mode = btn.dataset.crMode;
      paint();
    });
  });

  wirePeriodScrubber(el, {
    onPeriod: async (p) => { view.period = p; view.offset = 0; view.page = 1; await reload(); },
    onStep: async (delta) => { view.offset = Math.max(0, view.offset + delta); view.page = 1; await reload(); },
  });

  el.querySelector('#crTrendMetric')?.addEventListener('change', (ev) => {
    view.metric = ev.target.value;
    drawTrend();
  });
  el.querySelector('[data-cr-more]')?.addEventListener('click', () => {
    view.showAllItems = !view.showAllItems;
    paint();
  });

  el.querySelectorAll('.chest-rewards-table th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sortKey;
      if (view.sort.key === key) view.sort.dir = view.sort.dir === 'asc' ? 'desc' : 'asc';
      else view.sort = { key, dir: key === 'chest' ? 'asc' : 'desc' };
      view.page = 1;
      paint();
    });
  });
  el.querySelectorAll('[data-cr-page]').forEach((btn) => {
    btn.addEventListener('click', () => {
      view.page = Math.max(1, view.page + (btn.dataset.crPage === 'next' ? 1 : -1));
      paint();
    });
  });
  el.querySelectorAll('[data-cr-chest]').forEach((btn) => {
    btn.addEventListener('click', () => openChest(Number(btn.dataset.crChest)));
  });
}
