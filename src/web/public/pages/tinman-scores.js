// Tin Man scores — Events → Ancients. Also Olympus and Ragnarok scores (their tabs),
// the same thing per day of the run instead of per summon, without targets
// (EVENTS below holds what differs).
//
// Rise of the Ancients standings, pasted in by an admin after each summon. The
// in-game ranking is cumulative across the run, so every paste is a full
// snapshot and a player's points IN a summon are the step from the previous
// uploaded snapshot. A summon nobody pasted is simply skipped: its points land
// on the next summon that was pasted, and the table says so instead of showing
// zeros. Server side: routes/tinman.ts, data/repositories/tinman-repo.ts.
//
// Self-contained: events.js paints the page and then calls mountTinmanScores
// with the selected run; this module owns its card, state and repaints, and
// keeps the run's data cached so a sort or page change on the events table
// doesn't refetch it.

import { api, apiPut, apiDelete } from '../lib/api.js';
import { esc, memberLink, notify, confirmDialog, formatDate, formatRelativeTime } from '../lib/ui.js';
import { sortableThHtml } from '../lib/sort-headers.js';
import { getCurrentUser } from '../lib/state.js';
import { formatCompact } from '../lib/ancient-planner.js';
import { t, tn, tGame } from '../lib/i18n.js';
import { goalStatusClassFor, goalRowClassFor, goalCellContentHtml, goalCellTitle } from '../lib/leaderboard-render.js';
import { segHtml } from '../lib/ui-kit.js';

const PAGE_SIZE = 25;

/**
 * What differs per event: where its API lives, whether it has targets, and
 * every sentence that names its round — a summon for Ancients, a day for
 * Olympus. Whole sentences, so each language can order them its own way.
 */
const EVENTS = {
  ancients: {
    api: '/tinman',
    hasTargets: true,
    title: () => t('{tinman} scores', { tinman: esc(tGame('Tin Man')) }),
    eventName: () => esc(tGame('Rise of the Ancients')),
    perRound: () => t('points per summon'),
    allNote: () => t('{tinman} scores are per run — pick a single run with the arrows above to see them.', { tinman: esc(tGame('Tin Man')) }),
    loadError: () => t('Could not load the {tinman} scores.', { tinman: esc(tGame('Tin Man')) }),
    empty: () => t('No scores for this run yet — they are read from the game while the event runs.'),
    round: (n) => t('Summon {summon}', { summon: n }),
    short: (n) => t('S{summon}', { summon: n }),
    notPasted: (n) => t('Summon {summon} was not pasted — its points are in the next pasted summon', { summon: n }),
    since: (n) => t('Points scored since summon {summon} — includes the summon(s) not pasted', { summon: n }),
    scoredIn: (n) => t('Points scored in summon {summon}', { summon: n }),
    notInRanking: () => t('Not in this summon\'s ranking'),
    noPoints: () => t('No points in this summon'),
    played: (played, n) => tn(n, '{played} of {n} pasted summon', '{played} of {n} pasted summons', { n, played }),
    playedTitle: () => t('Summons this player scored in'),
    fromGameTitle: () => t('Read from the game every few minutes while the event runs — nothing to paste.'),
    liveBadge: () => t('Summon in progress'),
    liveTitle: (n) => t('Points scored so far in summon {summon} — it is still running', { summon: n }),
  },
  olympus: dayEvent('olympus', () => tGame('Olympus'), () => tGame('Trials of Olympus')),
  ragnarok: dayEvent('ragnarok', () => tGame('Ragnarok'), () => tGame('Ragnarok')),
  // Dark Omens' pasted ranking is the Spoils of Dread damage one; its Omen
  // Essence measure is the Essence column under Participants (resource tracking).
  'dark-omens': dayEvent('dark-omens', () => tGame('Spoils of Dread'), () => tGame('Dark Omens'), {
    title: () => t('{event} damage', { event: esc(tGame('Spoils of Dread')) }),
  }),
};

/**
 * An event pasted per day with no targets (Olympus, Ragnarok, Dark Omens). Only
 * its name and API differ; every sentence is shared. `name` is the short name,
 * `fullName` the in-game event name for the header hint; `overrides` replaces
 * any sentence that event words its own way.
 */
function dayEvent(key, name, fullName, overrides = {}) {
  return {
    api: `/event-scores/${key}`,
    hasTargets: false,
    ...dayEventSentences(name, fullName),
    ...overrides,
  };
}

function dayEventSentences(name, fullName) {
  return {
    title: () => t('{event} scores', { event: esc(name()) }),
    eventName: () => esc(fullName()),
    perRound: () => t('points per day'),
    allNote: () => t('{event} scores are per run — pick a single run with the arrows above to see them.', { event: esc(name()) }),
    loadError: () => t('Could not load the {event} scores.', { event: esc(name()) }),
    empty: () => t('No scores for this run yet — they are read from the game while the event runs.'),
    round: (n) => t('Day {day}', { day: n }),
    short: (n) => t('D{day}', { day: n }),
    notPasted: (n) => t('Day {day} was not pasted — its points are in the next pasted day', { day: n }),
    since: (n) => t('Points scored since day {day} — includes the day(s) not pasted', { day: n }),
    scoredIn: (n) => t('Points scored on day {day}', { day: n }),
    notInRanking: () => t('Not in this day\'s ranking'),
    noPoints: () => t('No points on this day'),
    played: (played, n) => tn(n, '{played} of {n} pasted day', '{played} of {n} pasted days', { n, played }),
    playedTitle: () => t('Days this player scored in'),
    fromGameTitle: () => t('Read from the game every scan — nothing to paste.'),
    liveBadge: () => t('Day in progress'),
    liveTitle: (n) => t('Points scored so far on day {day} — it is still running', { day: n }),
  };
}

/** The event shown: 'ancients' | 'olympus' | 'ragnarok' | 'dark-omens'. */
let eventKey = null;
let L = EVENTS.ancients;
let mountEl = null;
/** Requested run: a Tinman date, null for "the newest", or 'all' (no single run). */
let requested = null;
let data = null;          // last GET /tinman response
let loadedFor = undefined; // the `requested` value `data` answers
let sort = { key: 'total', dir: 'desc' };
let page = 1;
let targetsOpen = false;  // admin: the targets paste panel
let targetsText = '';
let targetsResult = null;
/** Second mount at the bottom of the page for "Below target", like "Did not participate". */
let belowEl = null;
let belowOpen = false;
/** Olympus from the game: which points the day columns show — 'olympus' (the event's ranking) or 'stage' (each day's stage ranking). */
let measure = 'olympus';

/** Olympus from the game with both measures: the one shown. */
function stageMeasure() {
  return !!data?.game && Array.isArray(data.game.stages) && (measure === 'stage' || !data.game.olympusPoints);
}

/** A row's numbers in the measure shown: per column, total, columns played. */
function measured(p) {
  if (!stageMeasure() || !data.game.olympusPoints) return { per: p.perSummon, total: p.total, played: p.played };
  const per = p.stagePoints || {};
  return { per, total: p.stageTotal || 0, played: Object.values(per).filter((v) => v > 0).length };
}

/** Not every member's research has been read; a member without a level is held to G7. */
const ASSUMED_TIER = 'g7';

function isAdmin() {
  const role = getCurrentUser()?.role;
  return role === 'admin' || role === 'superadmin';
}

/**
 * Render the card into `el` for one run.
 * @param {HTMLElement} el
 * @param {{ event?: 'ancients' | 'olympus' | 'ragnarok' | 'dark-omens', date: string | null | 'all' }} opts
 */
export async function mountTinmanScores(el, opts) {
  if (!el) return;
  mountEl = el;
  belowEl = opts.belowEl || null;
  const event = EVENTS[opts.event] ? opts.event : 'ancients';
  if (event !== eventKey) {
    // Another event's card: nothing of the last one carries over.
    eventKey = event;
    L = EVENTS[event];
    data = null;
    loadedFor = undefined;
    requested = undefined;
    sort = { key: 'total', dir: 'desc' };
    targetsOpen = false;
    targetsText = '';
    targetsResult = null;
    belowOpen = false;
  }
  if (opts.date !== requested) {
    requested = opts.date;
    page = 1;
  }
  if (requested === 'all') {
    if (belowEl) belowEl.innerHTML = '';
    el.innerHTML = cardHtml(`<p class="muted-copy tinman-note">${L.allNote()}</p>`, '');
    return;
  }
  if (loadedFor !== requested || !data) {
    el.innerHTML = cardHtml(`<p class="muted-copy tinman-note">${t('Loading…')}</p>`, '');
    await load();
  }
  paint();
}

/** One run's standings; null when the read failed. */
async function fetchRun(event, date) {
  try {
    const qs = date ? `?date=${encodeURIComponent(date)}` : '';
    const res = await api(`${EVENTS[event].api}${qs}`);
    return res?.error ? null : res;
  } catch (err) {
    if (err?.name === 'UnauthenticatedError' || err?.name === 'AbortError') throw err;
    return null;
  }
}

/** A read started by prefetchTinmanScores, handed to the next load() of that run. */
let prefetched = null; // { event, date, promise }

/**
 * Whether a run has any pasted scores, read before the card is mounted so the
 * Events page can open on the right tab. True / false, or null when it can't
 * tell (the read failed). 'all' is never a single run, so it has none. The
 * response is kept for the mount that follows, which then doesn't fetch again.
 */
export async function prefetchTinmanScores(event, date) {
  const ev = EVENTS[event] ? event : 'ancients';
  if (date === 'all') return false;
  // A run the game covers counts as scored: its table comes from the game.
  const hasRounds = (res) => (res ? (res.summons || []).length > 0 || !!res.game : null);
  // The card already holds this run (the mount won't refetch it either).
  if (ev === eventKey && loadedFor === date && data) return hasRounds(data);
  const mine = { event: ev, date, promise: fetchRun(ev, date) };
  prefetched = mine;
  return hasRounds(await mine.promise);
}

async function load() {
  const want = requested;
  const wantEvent = eventKey;
  const early = prefetched && prefetched.event === wantEvent && prefetched.date === want ? prefetched.promise : null;
  prefetched = null; // used once: a later load (after a save) must read fresh
  const res = await (early || fetchRun(wantEvent, want));
  if (want !== requested || wantEvent !== eventKey) return; // superseded by another run
  data = res;
  loadedFor = want;
}

function cardHtml(body, actions) {
  const date = data && loadedFor === requested ? data.date : (requested && requested !== 'all' ? requested : '');
  const fromGame = data && loadedFor === requested && data.game
    ? ` <span class="tinman-game-badge" title="${esc(L.fromGameTitle())}">${t('From the game')}</span>`
    : '';
  return `
    <div class="card tinman-card">
      <div class="card-header">
        <div class="events-title">
          <h2>${L.title()}${fromGame}</h2>
          <span class="card-header-hint">${L.eventName()}${date ? ` · ${esc(date)}` : ''} · ${L.perRound()}</span>
        </div>
        ${actions}
      </div>
      ${body}
    </div>`;
}

// ─── Painting ────────────────────────────────────────────────────

/**
 * Summon columns: 1 … the highest uploaded, gaps included so a missed summon
 * shows. From the game: one column per summon the reads split, or one for
 * back-to-back summons they can't ("S2–3"), keyed by its first summon.
 */
function summonColumns() {
  if (data?.game) {
    return (data.game.columns || []).map((c) => ({ summon: c.first, last: c.last, live: c.live, title: c.title || '', uploaded: true, covers: [], game: true }));
  }
  const uploaded = new Map((data?.summons || []).map((s) => [s.summon, s]));
  const highest = Math.max(0, ...uploaded.keys());
  const cols = [];
  let gap = [];
  for (let n = 1; n <= highest; n++) {
    if (uploaded.has(n)) {
      cols.push({ summon: n, uploaded: true, covers: gap });
      gap = [];
    } else {
      cols.push({ summon: n, uploaded: false, covers: [] });
      gap.push(n);
    }
  }
  return cols;
}

function sortedPlayers(cols) {
  const players = [...(data?.players || [])];
  // Server order: total desc — Olympus points; the stage points rank on their own.
  if (stageMeasure() && data.game.olympusPoints) players.sort((a, b) => measured(b).total - measured(a).total || a.name.localeCompare(b.name));
  players.forEach((p, i) => { p._rank = i + 1; });
  // A summon column that no longer exists (another run) sorts by total instead.
  const key = sort.key.startsWith('s:') && !cols.some((c) => c.uploaded && `s:${c.summon}` === sort.key)
    ? 'total'
    : sort.key;
  const mul = sort.dir === 'asc' ? 1 : -1;
  const val = (p) => {
    const m = measured(p);
    if (key === 'name') return p.name.toLowerCase();
    if (key === 'rank') return p._rank;
    if (key === 'played') return m.played;
    if (key === 'tier') return Number(tierOf(p).key.slice(1)) - (tierOf(p).assumed ? 0.5 : 0);
    if (key === 'pct') {
      const e = expectedFor(p);
      return e ? p.total / e : -1;
    }
    if (key.startsWith('s:')) return m.per[Number(key.slice(2))] ?? -1;
    return m.total;
  };
  players.sort((a, b) => {
    const av = val(a);
    const bv = val(b);
    if (av < bv) return -1 * mul;
    if (av > bv) return 1 * mul;
    return a._rank - b._rank;
  });
  return players;
}

function paint() {
  if (!mountEl) return;
  if (!data) {
    mountEl.innerHTML = cardHtml(`<p class="muted-copy tinman-note">${L.loadError()}</p>`, '');
    return;
  }
  const admin = isAdmin();
  const actions = admin && L.hasTargets
    ? `<div class="tinman-actions">
        <button type="button" class="btn btn-sm ${targetsOpen ? 'active' : ''}" data-tinman="toggle-targets">${targetsOpen ? t('Close targets') : t('Targets')}</button>
      </div>`
    : '';

  const cols = summonColumns();
  const body = `
    ${data.isTinmanDay === false ? `<p class="tinman-warn">⚠ ${data.seasonalKingdom
      ? t('{date} isn\'t a Tinman day on the Seasonal Kingdom calendar.', { date: esc(data.date) })
      : t('{date} isn\'t a Tinman day on the usual 6-day cadence.', { date: esc(data.date) })}</p>` : ''}
    ${targetsOpen && admin && L.hasTargets ? targetsPanelHtml() : ''}
    ${data.game ? gameStripHtml() : summonsStripHtml()}
    ${L.hasTargets ? targetsStripHtml(admin) : ''}
    ${data.players.length ? tableHtml(cols) : `<p class="muted-copy tinman-note">${L.empty()}</p>`}`;
  mountEl.innerHTML = cardHtml(body, actions);
  wire();
  paintBelow();
}

// ─── Targets ─────────────────────────────────────────────────────

function tierOf(p) {
  return p.guardsLevel ? { key: `g${p.guardsLevel}`, assumed: false } : { key: ASSUMED_TIER, assumed: true };
}

/**
 * This player's target: their tier's points for the whole run. Never split
 * per summon — the clan judges the run's total, so mid-run everyone simply
 * reads as not there yet.
 */
function expectedFor(p) {
  const target = data?.targets?.tiers?.[tierOf(p).key];
  return Number.isFinite(target) && target > 0 ? target : null;
}

const TARGET_NOTE = t("Totals are held against each tier's target for the whole run.");

function targetsStripHtml(admin) {
  const targets = data.targets;
  if (!targets) {
    return admin
      ? `<p class="muted-copy tinman-note tinman-targets-hint">${t('No targets for this run yet — open <strong>Targets</strong> and paste the <em>Points per member</em> table from {link}.', { link: `<a href="#tools/ancient">${t('Tools → Ancient planner')}</a>` })}</p>`
      : '';
  }
  const chips = ['t9', 'g9', 'g8', 'g7', 'g6', 'g5', 'g4', 'g3', 'g2', 'g1']
    .filter((k) => Number.isFinite(targets.tiers[k]))
    .map((k) => `<span class="tinman-target"><span class="tool-tier-badge">${k.toUpperCase()}</span> ${formatCompact(targets.tiers[k])}</span>`)
    .join('');
  return `
    <div class="tinman-targets">
      <span class="tinman-targets-label">${targets.kills ? tn(targets.kills, 'Targets · {n} kill', 'Targets · {n} kills', { n: targets.kills }) : t('Targets')}</span>
      ${chips}
      <span class="tinman-targets-note muted-copy">${esc(TARGET_NOTE)} ${t('Unknown guards level counts as G7.')}</span>
    </div>`;
}

function targetsPanelHtml() {
  const res = targetsResult
    ? `<div class="tinman-result ${targetsResult.error ? 'is-error' : ''}" role="status">${targetsResult.html}</div>`
    : '';
  return `
    <div class="tinman-upload">
      <label class="tinman-upload-row" for="tinmanTargets">${t('Targets for this run')}</label>
      <textarea id="tinmanTargets" class="input tinman-text" rows="7" spellcheck="false"
        placeholder="${t('One line per tier with its points each, or the Points per member table from Tools → Ancient planner, e.g.')}&#10;G7 1.3M&#10;G6 600K&#10;G5 250K">${esc(targetsText)}</textarea>
      <p class="muted-copy tinman-hint">${t('Points each per guards tier, for the whole run. Saving again replaces the targets.')}</p>
      <div class="tinman-upload-actions">
        <button type="button" class="btn btn-primary" data-tinman="save-targets">${t('Save targets')}</button>
        ${data.targets ? `<button type="button" class="btn" data-tinman="delete-targets">${t('Remove targets')}</button>` : ''}
      </div>
      ${res}
    </div>`;
}

/** "Below target" at the bottom of the page — collapsed by default, like "Did not participate". */
function paintBelow() {
  if (!belowEl) return;
  if (!data?.targets || !(data.players || []).length) {
    belowEl.innerHTML = '';
    return;
  }
  const below = data.players
    .map((p) => ({ p, expected: expectedFor(p) }))
    .filter(({ p, expected }) => expected !== null && p.total < expected)
    .map((x) => ({ ...x, pct: x.p.total / x.expected }))
    .sort((a, b) => a.pct - b.pct || a.p.name.localeCompare(b.p.name));
  const rows = below.map(({ p, expected, pct }) => {
    const tier = tierOf(p);
    const name = p.memberId ? memberLink(p.memberId, p.name) : `<span class="tinman-raw">${esc(p.rawName)}</span>`;
    return `<tr class="${goalRowClassFor(p.total, expected)}">
      <td data-role="primary"><span class="mrow-name">${name}</span><span class="mrow-sub">${tierLabel(tier)} · ${t('{pct}% of target', { pct: Math.round(pct * 100) })}</span></td>
      <td data-label="${t('Tier')}" data-role="hidden">${tierBadgeHtml(tier)}</td>
      <td class="num" data-label="${t('Total')}">${formatCompact(p.total)}</td>
      <td class="num" data-label="${t('Target')}">${formatCompact(expected)}</td>
      <td class="num" data-role="metric" data-label="${t('Short by')}" title="${Math.round(expected - p.total).toLocaleString()}">${formatCompact(expected - p.total)}</td>
      <td class="num" data-label="${t('% of target')}" data-role="hidden">${Math.round(pct * 100)}%</td>
    </tr>`;
  }).join('');
  const body = below.length
    ? `<div class="tinman-below-head">
         <p class="muted-copy tinman-hint">${esc(TARGET_NOTE)} ${t('Unknown guards level counts as G7.')}</p>
         <button type="button" class="btn btn-sm" data-tinman-below="copy" title="${t('Copy the list as a Markdown table, ready to paste')}">${t('Copy as table')}</button>
       </div>
       <table class="table-responsive tinman-below-table">
         <colgroup><col class="col-member"><col class="col-tier"><col class="col-num"><col class="col-num"><col class="col-num"><col class="col-num"></colgroup>
         <thead><tr><th>${t('Player')}</th><th>${t('Tier')}</th><th class="num">${t('Total')}</th><th class="num">${t('Target')}</th><th class="num">${t('Short by')}</th><th class="num">${t('% of target')}</th></tr></thead>
         <tbody>${rows}</tbody>
       </table>`
    : `<p class="empty-state">${t('Everyone is on target.')}</p>`;
  belowEl.innerHTML = `
    <details class="card card-collapsible" data-section-key="tinman-below"${belowOpen ? ' open' : ''}>
      <summary class="card-header"><h2>${t('Below {tinman} target ({count})', { tinman: esc(tGame('Tin Man')), count: below.length })}</h2></summary>
      <div class="card-body">${body}</div>
    </details>`;
  const d = belowEl.querySelector('details');
  if (d) d.addEventListener('toggle', () => { belowOpen = d.open; });
  const copyBtn = belowEl.querySelector('[data-tinman-below="copy"]');
  if (copyBtn) copyBtn.addEventListener('click', () => copyBelow(copyBtn, below));
}

/**
 * The below-target list as a compact pipe table, in the order shown. Kept
 * short on purpose: in-game chat caps the length of a post, so numbers are
 * compact (10M), an assumed tier is "G7?", and there is no separator row.
 */
function belowMarkdown(below) {
  const cell = (s) => String(s).replace(/\|/g, '\\|');
  const tier = (x) => (x.assumed ? 'G7?' : x.key.toUpperCase());
  const lines = [
    `| ${t('Name')} | ${t('Tier')} | ${t('Points')} | ${t('Target')} | % |`,
    ...below.map(({ p, expected, pct }) => `| ${cell(p.memberId ? p.name : p.rawName)} | ${tier(tierOf(p))} | ${formatCompact(p.total)} | ${formatCompact(expected)} | ${Math.round(pct * 100)}% |`),
  ];
  return lines.join('\n');
}

async function copyBelow(btn, below) {
  const text = belowMarkdown(below);
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback for browsers/contexts without the clipboard API.
    const tmp = document.createElement('textarea');
    tmp.value = text;
    document.body.appendChild(tmp);
    tmp.select();
    try { document.execCommand('copy'); } catch {}
    tmp.remove();
  }
  btn.textContent = `✓ ${t('Copied')}`;
  clearTimeout(btn._copyTimer);
  btn._copyTimer = setTimeout(() => { btn.textContent = t('Copy as table'); }, 1800);
}

function tierLabel(tier) {
  return tier.assumed ? t('G7 (assumed)') : tier.key.toUpperCase();
}

function tierBadgeHtml(tier) {
  return tier.assumed
    ? `<span class="tool-tier-badge is-assumed" title="${t('Guards level unknown — assumed G7')}">G7?</span>`
    : `<span class="tool-tier-badge">${tier.key.toUpperCase()}</span>`;
}

/** A run the game covers: where it comes from, summons left, a summon scoring now, when it was read. */
function gameStripHtml() {
  const g = data.game;
  if (Array.isArray(g.stages)) return olympusStripHtml(g);
  const parts = [];
  if (Array.isArray(g.days)) {
    if ((g.columns || []).some((c) => c.live)) parts.push(`<span class="game-run-badge is-live">● ${esc(L.liveBadge())}</span>`);
    parts.push(`<span class="tinman-chip-meta">${t('Read {time}', { time: esc(formatRelativeTime(g.readAt)) })}</span>`);
    return `<div class="tinman-chips tinman-game-strip">${parts.join('')}</div>`;
  }
  if (g.summonsLeft !== null && g.summonsMax) {
    parts.push(`<span class="tinman-chip tinman-chip-plain"><strong>${t('Summons left: {left} of {max}', { left: g.summonsLeft, max: g.summonsMax })}</strong></span>`);
  }
  if ((g.columns || []).some((c) => c.live)) parts.push(`<span class="game-run-badge is-live">● ${esc(L.liveBadge())}</span>`);
  parts.push(`<span class="tinman-chip-meta">${t('Read {time}', { time: esc(formatRelativeTime(g.readAt)) })}</span>`);
  const note = !g.reads
    ? t('This run was read before summons were tracked — totals only.')
    : !(g.columns || []).length ? t('No summons yet this run.') : '';
  return `<div class="tinman-chips tinman-game-strip">${parts.join('')}</div>${note ? `<p class="muted-copy tinman-note">${note}</p>` : ''}`;
}

/**
 * Olympus from the game: the five days with their stages, which points the
 * columns show, and the clan-vs-clan matchup (Ranking → Clan ranking) with
 * the score the clan needs for rewards.
 */
function olympusStripHtml(g) {
  const days = g.stages.map((s) => `<span class="tinman-chip tinman-chip-plain${s.state === 'upcoming' ? ' is-upcoming' : ''}">
      <strong>${esc(L.short(s.day))}</strong> ${esc(tGame(s.title))}${s.live ? ` <span class="game-run-badge is-live">● ${esc(L.liveBadge())}</span>` : ''}
    </span>`).join('');
  const toggle = g.olympusPoints
    ? segHtml({
      label: t('Show'),
      items: [
        { value: 'olympus', label: t('Overall points') },
        { value: 'stage', label: t('Stage points') },
      ],
      current: stageMeasure() ? 'stage' : 'olympus',
      attr: 'olympus-measure',
    })
    : '';
  const note = stageMeasure()
    ? t('Each day\'s stage ranking, as the game shows it under the stage.')
    : t('Points scored each day in the overall ranking — the clan\'s score is its sum. Points scored between a day\'s last scan and its 17:00 UTC end count on the next day; the last day keeps everything until the event closes.');
  return `<div class="tinman-chips tinman-game-strip">${days}<span class="tinman-chip-meta">${t('Read {time}', { time: esc(formatRelativeTime(g.readAt)) })}</span></div>
    ${matchupHtml(g.matchup)}
    <div class="olympus-measure">${toggle}<p class="muted-copy tinman-note">${esc(note)}</p></div>`;
}

/** The matchup's clans, best first, ours marked; the reward minimum under them. */
function matchupHtml(m) {
  if (!m || !(m.clans || []).length) return '';
  const own = m.clans.find((c) => c.own);
  const rows = m.clans.map((c) => {
    const name = c.name ? `${c.tag ? `[${esc(c.tag)}] ` : ''}${esc(c.name)}` : esc(t('Clan #{n}', { n: c.gameClanId }));
    const sub = [
      c.kingdom ? t('Kingdom #{n}', { n: c.kingdom }) : '',
      c.members !== null && c.memberLimit ? `${c.members}/${c.memberLimit}` : '',
    ].filter(Boolean).map(esc).join(' · ');
    return `<li class="ui-row${c.own ? ' is-own' : ''}">
        <span class="ui-rank">#${c.rank}</span>
        <span class="ui-row-main"><span class="ui-row-name">${name}</span>${sub ? `<span class="ui-row-sub">${sub}</span>` : ''}</span>
        <span class="ui-row-n">${Number(c.points).toLocaleString()}</span>
      </li>`;
  }).join('');
  const goal = m.rewardMinPoints && own
    ? `<p class="muted-copy tinman-note">${own.points >= m.rewardMinPoints
      ? esc(t('The clan has the {min} points rewards need.', { min: m.rewardMinPoints.toLocaleString() }))
      : esc(t('Rewards need {min} points — {left} to go.', { min: m.rewardMinPoints.toLocaleString(), left: (m.rewardMinPoints - own.points).toLocaleString() }))}</p>`
    : '';
  return `<div class="olympus-matchup">
      <h3 class="ui-sub">${esc(t('Clan ranking'))}</h3>
      <ol class="ui-rows">${rows}</ol>
      ${goal}
    </div>`;
}

/** A run pasted by hand before the game read it: what was pasted, by whom. Read-only. */
function summonsStripHtml() {
  const summons = data.summons || [];
  if (!summons.length) return '';
  const chips = summons.map((s) => `
    <span class="tinman-chip">
      <strong>${L.round(s.summon)}</strong>
      <span class="tinman-chip-meta">${tn(s.rows, '{n} name', '{n} names', { n: s.rows })}${s.unmatched ? ` · <span class="tool-warn">${tn(s.unmatched, '{n} unmatched', '{n} unmatched', { n: s.unmatched })}</span>` : ''} · ${esc(s.uploadedBy || '—')} · ${esc(formatDate(s.uploadedAt))}</span>
    </span>`).join('');
  return `<div class="tinman-chips">${chips}</div>`;
}

function tableHtml(cols) {
  const players = sortedPlayers(cols);
  const total = players.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (page > pages) page = pages;
  const rows = players.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const th = (key, labelHtml, className = '', title = '') => sortableThHtml({
    key, labelHtml, sortState: sort, title,
    className: [className, sort.key === key ? 'is-sorted' : ''].filter(Boolean).join(' '),
  });
  const sLabel = L.short;
  // A game column the reads couldn't split covers several summons: "S2–3".
  const colLabel = (c) => (c.game && c.last > c.summon ? t('S{first}–{last}', { first: c.summon, last: c.last }) : sLabel(c.summon));
  const summonHeads = cols.map((c) => {
    if (c.game) {
      const sub = c.live ? `<span class="tinman-col-sub tinman-col-live">${t('in progress')}</span>` : '';
      const said = c.last > c.summon
        ? t('Points scored in summons {first}–{last}: they ran back to back, so the reads can\'t split them', { first: c.summon, last: c.last })
        : c.live ? L.liveTitle(c.summon) : L.scoredIn(c.summon);
      // An Olympus day names its stage.
      return th(`s:${c.summon}`, `${colLabel(c)}${sub}`, 'num', c.title ? `${tGame(c.title)} — ${said}` : said);
    }
    if (!c.uploaded) {
      return `<th class="num tinman-missing-col" title="${L.notPasted(c.summon)}">${sLabel(c.summon)}<span class="tinman-col-sub">${t('not uploaded')}</span></th>`;
    }
    const covers = c.covers.length ? `<span class="tinman-col-sub">${t('incl. {summons}', { summons: c.covers.map(sLabel).join(', ') })}</span>` : '';
    const title = c.covers.length
      ? L.since(c.covers[0] - 1 || t('the start'))
      : L.scoredIn(c.summon);
    return th(`s:${c.summon}`, `${sLabel(c.summon)}${covers}`, 'num', title);
  }).join('');

  const body = rows.map((p) => {
    // A game player with no member yet is still a real player, not an unread paste.
    const nameHtml = p.memberId
      ? memberLink(p.memberId, p.name)
      : data.game ? esc(p.name) : `<span class="tinman-raw">${esc(p.rawName)}</span>`;
    // Game rows are the game's own players: nothing to match.
    const tag = data.game ? ''
      : !p.memberId
      ? ` <span class="tinman-tag" title="${t('Not matched to a clan member yet')}">${t('not matched')}</span>`
      : p.matchKind === 'fuzzy' && p.rawName !== p.name
        ? ` <span class="tinman-tag tinman-tag-fuzzy" title="${t('Pasted as “{name}” — matched by spelling', { name: esc(p.rawName) })}">≈</span>`
        : '';
    const m = measured(p);
    const cells = cols.map((c) => {
      if (!c.uploaded) return `<td class="num tinman-missing-col" data-label="${sLabel(c.summon)}"><span class="events-zero">·</span></td>`;
      const label = colLabel(c);
      const live = c.live ? ' tinman-live-cell' : '';
      const v = m.per[c.summon];
      if (v === undefined) return `<td class="num${live}" data-label="${label}"><span class="events-zero" title="${L.notInRanking()}">–</span></td>`;
      if (v === 0) return `<td class="num${live}" data-label="${label}"><span class="events-zero" title="${L.noPoints()}">—</span></td>`;
      return `<td class="num${v < 0 ? ' tool-short' : ''}${live}" data-label="${label}" title="${v.toLocaleString()}">${formatCompact(v)}</td>`;
    }).join('');
    const tier = tierOf(p);
    const expected = expectedFor(p);
    const full = data.targets?.tiers?.[tier.key];
    const totalTitle = expected !== null ? goalCellTitle(p.total, expected) : m.total.toLocaleString();
    const targetCell = expected !== null
      ? `<td class="num" data-label="${t('Target')}" title="${esc(t('{points} for the run', { points: Math.round(full).toLocaleString() }))}">${formatCompact(expected)}</td>`
      : `<td class="num" data-label="${t('Target')}"><span class="events-zero">—</span></td>`;
    const pastedCount = cols.filter((c) => c.uploaded).length;
    const playedText = !data.game ? L.played(p.played, pastedCount)
      : Array.isArray(data.game.stages)
        ? tn(pastedCount, '{played} of {n} day', '{played} of {n} days', { n: pastedCount, played: m.played })
      : cols.some((c) => c.last > c.summon)
        ? tn(pastedCount, '{played} of {n} column', '{played} of {n} columns', { n: pastedCount, played: p.played })
        : tn(pastedCount, '{played} of {n} summon', '{played} of {n} summons', { n: pastedCount, played: p.played });
    return `<tr class="${expected !== null ? goalRowClassFor(p.total, expected) : ''}">
      <td data-role="lead">${p._rank}</td>
      <td data-role="primary"><span class="mrow-name">${nameHtml}${tag}</span><span class="mrow-sub">${L.hasTargets ? `${tierLabel(tier)} · ${playedText}` : playedText}</span></td>
      ${L.hasTargets ? `<td data-label="${t('Tier')}">${tierBadgeHtml(tier)}</td>` : ''}
      ${cells}
      <td class="num ${expected !== null ? goalStatusClassFor(p.total, expected) : ''}" data-role="metric" data-label="${t('Total')}" title="${esc(totalTitle)}">${expected !== null ? goalCellContentHtml(p.total, expected, `<strong>${formatCompact(p.total)}</strong>`) : `<strong>${formatCompact(m.total)}</strong>`}</td>
      ${L.hasTargets ? targetCell : ''}
      <td class="num" data-role="hidden">${m.played}</td>
    </tr>`;
  }).join('');

  const pagination = total > PAGE_SIZE
    ? `<div class="pagination">
        <button class="btn btn-tight" data-tinman-page="prev" ${page <= 1 ? 'disabled' : ''}>${t('← Prev')}</button>
        <span class="pagination-info">${t('Page {page} of {pages} · {players}', { page, pages, players: tn(total, '{n} player', '{n} players', { n: total }) })}</span>
        <button class="btn btn-tight" data-tinman-page="next" ${page >= pages ? 'disabled' : ''}>${t('Next →')}</button>
      </div>`
    : '';

  return `
    <div class="card-body">
      <div class="events-scroll">
        <table class="table-responsive tinman-table">
          <colgroup><col class="col-rank"><col class="col-member">${L.hasTargets ? '<col class="col-tier">' : ''}${cols.map(() => '<col class="col-num">').join('')}<col class="col-num">${L.hasTargets ? '<col class="col-num">' : ''}<col class="col-played"></colgroup>
          <thead><tr>
            ${th('rank', t('Rank'))}
            ${th('name', t('Player'))}
            ${L.hasTargets ? th('tier', t('Tier'), '', t('Guards level from their research — G7 assumed when unknown')) : ''}
            ${summonHeads}
            ${th('total', t('Total'), 'num', t('Points over the whole run so far'))}
            ${L.hasTargets ? th('pct', t('Target'), 'num', t('What this tier should have by now — sorts by how far along each player is')) : ''}
            ${th('played', t('Played'), 'num', L.playedTitle())}
          </tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>
      ${pagination}
    </div>`;
}

// ─── Actions ─────────────────────────────────────────────────────

function wire() {
  const el = mountEl;
  el.querySelectorAll('.tinman-table th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sortKey;
      if (sort.key === key) sort.dir = sort.dir === 'asc' ? 'desc' : 'asc';
      else sort = { key, dir: key === 'name' || key === 'rank' ? 'asc' : 'desc' };
      page = 1;
      paint();
    });
  });
  el.querySelectorAll('[data-tinman-page]').forEach((btn) => {
    btn.addEventListener('click', () => {
      page += btn.dataset.tinmanPage === 'next' ? 1 : -1;
      if (page < 1) page = 1;
      paint();
    });
  });
  el.querySelectorAll('[data-olympus-measure]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (measure === btn.dataset.olympusMeasure) return;
      measure = btn.dataset.olympusMeasure;
      page = 1;
      paint();
    });
  });
  const targetsArea = el.querySelector('#tinmanTargets');
  if (targetsArea) targetsArea.addEventListener('input', () => { targetsText = targetsArea.value; });
  el.querySelectorAll('[data-tinman]').forEach((btn) => {
    if (btn.tagName !== 'BUTTON') return;
    btn.addEventListener('click', () => onAction(btn));
  });
}

async function onAction(btn) {
  const action = btn.dataset.tinman;
  if (action === 'toggle-targets') {
    targetsOpen = !targetsOpen;
    targetsResult = null;
    paint();
    if (targetsOpen) mountEl.querySelector('#tinmanTargets')?.focus();
    return;
  }
  if (action === 'save-targets') return saveTargets(btn);
  if (action === 'delete-targets') return removeTargets();
}

async function saveTargets(btn) {
  const text = mountEl.querySelector('#tinmanTargets')?.value || '';
  if (!text.trim()) {
    targetsResult = { error: true, html: t('Paste the Points per member table first.') };
    paint();
    return;
  }
  btn.disabled = true;
  btn.textContent = t('Saving…');
  try {
    const res = await apiPut(`${L.api}/${encodeURIComponent(data.date)}/targets`, { text });
    if (res?.error) {
      targetsResult = { error: true, html: esc(res.error) };
    } else {
      const n = Object.keys(res.targets?.tiers || {}).length;
      const kills = res.targets?.kills;
      targetsResult = {
        error: false,
        html: kills
          ? tn(n, '<strong>Targets saved</strong>: {n} tier (planned for {kills}).', '<strong>Targets saved</strong>: {n} tiers (planned for {kills}).', { n, kills: tn(kills, '{n} kill', '{n} kills', { n: kills }) })
          : tn(n, '<strong>Targets saved</strong>: {n} tier.', '<strong>Targets saved</strong>: {n} tiers.', { n }),
      };
      targetsText = '';
      await load();
    }
  } catch (err) {
    if (err?.name === 'UnauthenticatedError') return;
    targetsResult = { error: true, html: esc(t('Could not save: {error}', { error: err?.message || err })) };
  }
  paint();
}

async function removeTargets() {
  const ok = await confirmDialog(t('Remove the targets for this run? The colours and the Below target list go with them.'), {
    title: t('Remove targets'), confirmLabel: t('Remove'), danger: true,
  });
  if (!ok) return;
  try {
    const res = await apiDelete(`${L.api}/${encodeURIComponent(data.date)}/targets`);
    if (res?.error) await notify(res.error, t('Could not remove'));
  } catch (err) {
    if (err?.name === 'UnauthenticatedError') return;
    await notify(t('Could not remove: {error}', { error: err?.message || err }), t('Could not remove'));
  }
  targetsResult = null;
  await load();
  paint();
}
