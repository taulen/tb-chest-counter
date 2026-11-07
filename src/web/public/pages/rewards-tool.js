// Tools → Rewards: share a clan reward pot (Dragon Coins, clan fragments) over
// the players of one event run, in proportion to their score. A replica of
// totalcalculator.org/rewards.php, with the clan's own scores filled in instead
// of typed as name>score lines.
//
// Where the scores come from, per event:
//  - Olympus: the cumulative clan ranking pasted on Events → Olympus, as it
//    stood after the picked day (the latest pasted, unless told otherwise).
//  - Dark Omens: Omen Essence donated in the run's window (resource tracking,
//    the same numbers as the Essence column on Events → Dark Omens), or the
//    Spoils of Dread damage ranking pasted on Events → Dark Omens.
//
// Anyone can be left out (an alt, a leader who takes no share); their part is
// spread over everyone else by score. Players the roster no longer lists start
// left out — a reward can only be sent to someone in the clan. Who is left out
// is remembered per clan in this browser. The arithmetic: lib/rewards-split.js.
//
// The inputs and the results render separately: typing a pot repaints only the
// results, so the box being typed in is never replaced.

import { api } from '../lib/api.js';
import { esc, memberLink, copyTextToClipboard } from '../lib/ui.js';
import { getCurrentUser } from '../lib/state.js';
import { t, tn, tGame } from '../lib/i18n.js';
import { formatCompact } from '../lib/ancient-planner.js';
import { isResourcesEnabledForActiveClan } from '../lib/resource-format.js';
import { distributeRewards, scoreAfterDay, parsePot } from '../lib/rewards-split.js';

const PAGE_SIZE = 25;
/** Runs offered in the picker, newest first. */
const MAX_RUNS = 12;
const PREFS_KEY = 'tbcc.rewards.prefs.v1';
const EXCLUDED_KEY = 'tbcc.rewards.excluded.v1';
const ESSENCE_SLUG = 'omen-essence';

/**
 * What a split can be based on. `pasted` bases read /event-scores/<api>; the
 * essence one reads Resources.
 */
const BASES = {
  olympus: {
    pasted: 'olympus',
    label: () => t('{event} scores', { event: esc(tGame('Olympus')) }),
    column: () => t('Points'),
  },
  damage: {
    pasted: 'dark-omens',
    label: () => t('{event} damage', { event: esc(tGame('Spoils of Dread')) }),
    column: () => t('Damage'),
  },
  essence: {
    pasted: null,
    label: () => t('{resource} donated', { resource: esc(tGame('Omen Essence')) }),
    column: () => t('Essence'),
  },
};

const EVENTS = {
  olympus: { name: () => tGame('Olympus'), bases: ['olympus'] },
  'dark-omens': { name: () => tGame('Dark Omens'), bases: ['essence', 'damage'] },
};

/** Module state for the mounted tool — rebuilt on every page render. */
let rs = null;

// ─── Remembered per browser ───────────────────────────────────────

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    return p && typeof p === 'object' ? p : {};
  } catch {
    return {};
  }
}

function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ event: rs.event, basis: rs.basisByEvent }));
  } catch { /* not remembered, still works */ }
}

function excludedKey() {
  return `${EXCLUDED_KEY}.${getCurrentUser()?.clanId ?? 0}`;
}

function loadExcluded() {
  try {
    const list = JSON.parse(localStorage.getItem(excludedKey()) || '[]');
    return new Set(Array.isArray(list) ? list.filter((k) => typeof k === 'string') : []);
  } catch {
    return new Set();
  }
}

function saveExcluded() {
  try {
    localStorage.setItem(excludedKey(), JSON.stringify([...rs.excluded]));
  } catch { /* not remembered, still works */ }
}

// ─── Mount ─────────────────────────────────────────────────────────

export async function renderRewardsTool(mount) {
  const prefs = loadPrefs();
  const event = EVENTS[prefs.event] ? prefs.event : 'olympus';
  const basisByEvent = { olympus: 'olympus', 'dark-omens': 'essence' };
  for (const [key, ev] of Object.entries(EVENTS)) {
    if (ev.bases.includes(prefs.basis?.[key])) basisByEvent[key] = prefs.basis[key];
  }
  rs = {
    event,
    basisByEvent,
    runs: [],
    runIdx: 0,
    /** Pasted day the scores are read after; null = the latest pasted. */
    day: null,
    /** What the picked run and basis yielded — see loadSource(). */
    source: null,
    loading: true,
    /** Member ids the roster still lists; null when that read failed. */
    activeIds: null,
    coins: 0,
    fragments: 0,
    /** Players left out by hand (persisted). */
    excluded: loadExcluded(),
    /** Players who left the clan, put back in by hand (this visit only). */
    includeLeft: new Set(),
    query: '',
    page: 1,
    copied: false,
    /** Bumped by every load, so a slow answer for an old pick is dropped. */
    token: 0,
  };

  mount.innerHTML = `
    <div class="rewards-tool">
      <div class="rewards-setup">
        <div class="card rewards-source-card">
          <div class="card-header"><h2>${t('Scores')}</h2><span class="card-header-hint">${t('The run whose ranking decides the split')}</span></div>
          <div class="card-body-padded rewards-source-slot">${sourceHtml()}</div>
        </div>
        ${potsCardHtml()}
      </div>
      <div class="rewards-results" aria-live="polite"></div>
      ${howItWorksHtml()}
    </div>`;

  const root = mount.querySelector('.rewards-tool');
  root.addEventListener('click', onClick);
  root.addEventListener('change', onChange);
  root.addEventListener('input', onInput);
  root.addEventListener('focusout', onFocusOut);

  const members = api('/members').then(
    (res) => (Array.isArray(res) ? new Set(res.map((m) => m.id)) : null),
    (err) => {
      if (err?.name === 'UnauthenticatedError') throw err;
      return null;
    },
  );
  await loadEvent(root);
  rs.activeIds = await members;
  paintResults(root);
}

// ─── Loading ───────────────────────────────────────────────────────

const basisKey = () => rs.basisByEvent[rs.event];
const basis = () => BASES[basisKey()];
const run = () => rs.runs[rs.runIdx] ?? null;

/** The event's runs, then the picked run's scores. */
async function loadEvent(root) {
  const token = ++rs.token;
  rs.loading = true;
  rs.runs = [];
  rs.runIdx = 0;
  rs.source = null;
  paintSource(root);
  paintResults(root);

  let runs = [];
  try {
    const res = await api(`/events/${encodeURIComponent(rs.event)}/occurrences`);
    runs = (Array.isArray(res?.occurrences) ? res.occurrences : []).slice(0, MAX_RUNS);
  } catch (err) {
    if (err?.name === 'UnauthenticatedError' || err?.name === 'AbortError') throw err;
  }
  // No calendar (a feed outage): the pasted rankings still know their runs.
  if (!runs.length) runs = await pastedRunsFallback();
  if (token !== rs.token) return;
  rs.runs = runs;
  await loadSource(root, token);
}

async function pastedRunsFallback() {
  const pastedApi = EVENTS[rs.event].bases.map((b) => BASES[b].pasted).find(Boolean);
  if (!pastedApi) return [];
  try {
    const res = await api(`/event-scores/${pastedApi}`);
    return (res?.dates || []).slice(0, MAX_RUNS).map((d) => ({ label: d, scoresDate: d, from: null, to: null, isCurrent: false, estimated: false }));
  } catch (err) {
    if (err?.name === 'UnauthenticatedError' || err?.name === 'AbortError') throw err;
    return [];
  }
}

/** The picked run's scores for the picked basis. */
async function loadSource(root, token = ++rs.token) {
  rs.loading = true;
  rs.source = null;
  rs.page = 1;
  paintSource(root);
  paintResults(root);

  const r = run();
  let source;
  if (!r) source = { kind: 'no-runs' };
  else if (basis().pasted) source = await loadPasted(basis().pasted, r);
  else source = await loadEssence(r);
  if (token !== rs.token) return;
  rs.source = source;
  rs.loading = false;
  paintSource(root);
  paintResults(root);
}

async function loadPasted(pastedApi, r) {
  if (!r.scoresDate) return { kind: 'error' };
  try {
    const res = await api(`/event-scores/${pastedApi}?date=${encodeURIComponent(r.scoresDate)}`);
    if (res?.error) return { kind: 'error' };
    const days = (res.summons || []).map((s) => s.summon).sort((a, b) => a - b);
    if (!days.length) return { kind: 'none-pasted' };
    const players = (res.players || []).map((p) => ({
      key: p.memberId ? `m:${p.memberId}` : `n:${String(p.rawName || p.name).trim().toLowerCase()}`,
      memberId: p.memberId ?? null,
      name: p.name,
      cumulative: p.cumulative || {},
    }));
    return { kind: 'pasted', days, players };
  } catch (err) {
    if (err?.name === 'UnauthenticatedError' || err?.name === 'AbortError') throw err;
    return { kind: 'error' };
  }
}

/** Omen Essence donated in the run's window — the Events → Dark Omens Essence column's numbers. */
async function loadEssence(r) {
  if (!r.from || !r.to) return { kind: 'no-window' };
  try {
    if (!(await isResourcesEnabledForActiveClan())) return { kind: 'no-resources' };
    const qs = new URLSearchParams({ from: r.from.slice(0, 10), to: r.to.slice(0, 10) });
    const [typesRes, summaryRes] = await Promise.all([api('/resources/types'), api(`/resources/summary?${qs}`)]);
    const types = Array.isArray(typesRes) ? typesRes : (typesRes?.types ?? []);
    const essence = types.find((type) => type.slug === ESSENCE_SLUG);
    if (!essence) return { kind: 'no-resources' };
    const byMember = new Map();
    for (const row of Array.isArray(summaryRes?.rows) ? summaryRes.rows : []) {
      if (row.resourceTypeId !== essence.id || !(row.sentAmount > 0)) continue;
      const p = byMember.get(row.memberId) ?? { key: `m:${row.memberId}`, memberId: row.memberId, name: row.memberName, score: 0 };
      p.score += row.sentAmount;
      byMember.set(row.memberId, p);
    }
    if (!byMember.size) return { kind: 'no-essence', from: qs.get('from'), to: qs.get('to') };
    return { kind: 'essence', players: [...byMember.values()], from: qs.get('from'), to: qs.get('to') };
  } catch (err) {
    if (err?.name === 'UnauthenticatedError' || err?.name === 'AbortError') throw err;
    return { kind: 'error' };
  }
}

// ─── Scores card ───────────────────────────────────────────────────

function paintSource(root) {
  const slot = root.querySelector('.rewards-source-slot');
  if (slot) slot.innerHTML = sourceHtml();
}

function chipsHtml(items, attr, active, label) {
  return `
    <div class="pb-chips rewards-chips" role="group" aria-label="${esc(label)}">
      ${items.map(([key, text]) => `<button type="button" class="pb-chip${key === active ? ' active' : ''}" ${attr}="${esc(key)}" aria-pressed="${key === active}">${text}</button>`).join('')}
    </div>`;
}

function runOptionLabel(r) {
  return [r.label, r.isCurrent ? t('· live') : '', r.estimated ? t('· est.') : ''].filter(Boolean).join(' ');
}

function sourceHtml() {
  const ev = EVENTS[rs.event];
  const eventChips = chipsHtml(Object.entries(EVENTS).map(([key, e]) => [key, esc(e.name())]), 'data-rw-event', rs.event, t('Event'));
  const basisChips = ev.bases.length > 1
    ? `<div class="rewards-field"><span class="rewards-field-label">${t('Split by')}</span>${chipsHtml(ev.bases.map((b) => [b, BASES[b].label()]), 'data-rw-basis', basisKey(), t('Split by'))}</div>`
    : '';
  const runSelect = rs.runs.length
    ? `<select id="rw-run" class="input tool-select" data-rw="run">${rs.runs.map((r, i) => `<option value="${i}" ${i === rs.runIdx ? 'selected' : ''}>${esc(runOptionLabel(r))}</option>`).join('')}</select>`
    : `<span class="tool-muted">${rs.loading ? t('Loading…') : t('No runs to pick from')}</span>`;
  const src = rs.source;
  const daySelect = src?.kind === 'pasted'
    ? `<div class="tool-inline-field rewards-inline">
        <label for="rw-day">${t('Scores after')}</label>
        <select id="rw-day" class="input tool-select" data-rw="day">${src.days.map((d) => `<option value="${d}" ${d === pickedDay() ? 'selected' : ''}>${esc(t('Day {day}', { day: d }))}</option>`).join('')}</select>
      </div>`
    : '';
  return `
    ${eventChips}
    ${basisChips}
    <div class="tool-inline-field rewards-inline">
      <label for="rw-run">${t('Run')}</label>
      ${runSelect}
    </div>
    ${daySelect}
    <p class="muted-copy rewards-status" role="status">${statusHtml()}</p>`;
}

/** The pasted day the scores are read after: the picked one, else the latest. */
function pickedDay() {
  const days = rs.source?.days || [];
  return days.includes(rs.day) ? rs.day : days[days.length - 1] ?? null;
}

function eventsLink() {
  return `<a href="#events/${esc(rs.event)}">${t('Events → {event}', { event: esc(EVENTS[rs.event].name()) })}</a>`;
}

function statusHtml() {
  const src = rs.source;
  if (rs.loading || !src) return t('Loading…');
  switch (src.kind) {
    case 'pasted': {
      const day = pickedDay();
      const last = src.days[src.days.length - 1];
      return day === last
        ? tn(src.players.length, '{n} player in the ranking pasted after day {day}.', '{n} players in the ranking pasted after day {day}.', { day })
        : tn(src.players.length, '{n} player · scores as they stood after day {day} (day {last} is pasted too).', '{n} players · scores as they stood after day {day} (day {last} is pasted too).', { day, last });
    }
    case 'essence':
      return tn(src.players.length, '{n} member donated {resource} between {from} and {to}.', '{n} members donated {resource} between {from} and {to}.', {
        resource: esc(tGame('Omen Essence')), from: esc(src.from), to: esc(src.to),
      });
    case 'none-pasted':
      return t('Nothing pasted for this run yet — an admin adds the ranking on {link} after each day.', { link: eventsLink() });
    case 'no-essence':
      return t('Nobody donated {resource} between {from} and {to}.', { resource: esc(tGame('Omen Essence')), from: esc(src.from), to: esc(src.to) });
    case 'no-resources':
      return t('This clan doesn\'t track resources, so {resource} can\'t be read. Split by {damage} instead.', {
        resource: esc(tGame('Omen Essence')), damage: BASES.damage.label(),
      });
    case 'no-window':
      return t('The event calendar is unavailable, so this run\'s dates aren\'t known.');
    case 'no-runs':
      return t('No runs to pick from — the event calendar is unavailable and nothing has been pasted.');
    default:
      return t('Could not load the scores.');
  }
}

// ─── Pots card ─────────────────────────────────────────────────────

function potsCardHtml() {
  const field = (key, label) => `
    <label class="rewards-pot">
      <span class="rewards-pot-label">${label}</span>
      <input type="text" inputmode="numeric" autocomplete="off" class="input rewards-pot-input" data-pot="${key}" placeholder="0" value="">
    </label>`;
  return `
    <div class="card rewards-pots-card">
      <div class="card-header"><h2>${t('Rewards to share')}</h2><span class="card-header-hint">${t('The clan\'s totals')}</span></div>
      <div class="card-body-padded">
        <div class="rewards-pots">
          ${field('coins', esc(tGame('Dragon Coins')))}
          ${field('fragments', t('Clan fragments'))}
        </div>
        <p class="tool-slider-hint">${t('Whole numbers; 7.5m and 250k work too.')}</p>
      </div>
    </div>`;
}

// ─── Results ───────────────────────────────────────────────────────

/** The players with their score for the current pick, ranked; null while there are none. */
function rankedPlayers() {
  const src = rs.source;
  if (!src || (src.kind !== 'pasted' && src.kind !== 'essence')) return null;
  const day = pickedDay();
  const players = src.players.map((p) => ({
    ...p,
    score: src.kind === 'pasted' ? scoreAfterDay(p.cumulative, day) : p.score,
    left: !!(p.memberId && rs.activeIds && !rs.activeIds.has(p.memberId)),
    unmatched: !p.memberId,
  }));
  players.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return players.map((p, i) => ({
    ...p,
    rank: i + 1,
    included: p.left ? rs.includeLeft.has(p.key) : !rs.excluded.has(p.key),
  }));
}

function currentSplit() {
  const players = rankedPlayers();
  if (!players) return null;
  return distributeRewards(players, { coins: rs.coins, fragments: rs.fragments });
}

const fmtInt = (n) => Math.round(n).toLocaleString();
const fmtShare = (s) => `${(s * 100).toFixed(s >= 0.1 ? 1 : 2)}%`;

/**
 * The results card is built once per loaded run and then only its parts are
 * repainted, so the search box (inside it) keeps focus while typing.
 */
function paintResults(root) {
  const slot = root.querySelector('.rewards-results');
  if (!slot) return;
  const split = currentSplit();
  if (!split) {
    slot.innerHTML = '';
    return;
  }
  if (!slot.querySelector('.rewards-results-card')) slot.innerHTML = resultsShellHtml();
  const head = resultsHeadHtml(split);
  slot.querySelector('.rewards-results-hint').innerHTML = head.hint;
  slot.querySelector('.rewards-actions').innerHTML = head.actions;
  slot.querySelector('.rewards-summary-line').innerHTML = head.summary;
  slot.querySelector('.rewards-note-slot').innerHTML = head.note;
  slot.querySelector('.rewards-table-slot').innerHTML = tableAreaHtml(split);
}

function matchesQuery(p) {
  const q = rs.query.trim().toLowerCase();
  return !q || p.name.toLowerCase().includes(q);
}

function resultsShellHtml() {
  return `
    <div class="card rewards-results-card">
      <div class="card-header rewards-results-header">
        <div class="events-title">
          <h2>${t('Distribution')}</h2>
          <span class="card-header-hint rewards-results-hint"></span>
        </div>
        <div class="rewards-actions"></div>
      </div>
      <div class="card-body-padded rewards-summary">
        <p class="tool-total-line rewards-summary-line"></p>
        <div class="rewards-note-slot"></div>
        <input type="search" class="input rewards-search" placeholder="${t('Find a player…')}" aria-label="${t('Find a player')}" data-rw="search" value="${esc(rs.query)}">
      </div>
      <div class="card-body rewards-table-slot"></div>
    </div>`;
}

function resultsHeadHtml(split) {
  const { rows, recipients, scoreTotal } = split;
  const leftOut = rows.filter((r) => !r.included).length;
  const anyPot = rs.coins > 0 || rs.fragments > 0;
  const handExcluded = rows.some((r) => !r.left && !r.included);
  const r = run();
  return {
    hint: [esc(EVENTS[rs.event].name()), r ? esc(r.label) : '', basis().label()].filter(Boolean).join(' · '),
    actions: `
      ${handExcluded ? `<button type="button" class="btn btn-sm" data-rw-action="include-all">${t('Include all members')}</button>` : ''}
      <button type="button" class="btn btn-sm btn-primary" data-rw-action="copy" ${anyPot && recipients ? '' : 'disabled'}>${rs.copied ? `✓ ${t('Copied')}` : t('Copy list')}</button>`,
    summary: [
      tn(recipients, '<strong>{n}</strong> player shares', '<strong>{n}</strong> players share'),
      leftOut ? tn(leftOut, '<strong>{n}</strong> left out', '<strong>{n}</strong> left out') : '',
      t('{column} total <strong>{total}</strong>', { column: basis().column(), total: formatCompact(scoreTotal) }),
    ].filter(Boolean).join(' · '),
    note: anyPot ? '' : `<p class="muted-copy rewards-note">${t('Enter the clan\'s totals above to see what each player gets.')}</p>`,
  };
}

function tableAreaHtml(split) {
  const shown = split.rows.filter(matchesQuery);
  if (!shown.length) {
    return `<p class="muted-copy rewards-empty">${t('No player matches “{query}”.', { query: esc(rs.query.trim()) })}</p>`;
  }
  const pages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
  rs.page = Math.min(Math.max(1, rs.page), pages);
  const pageRows = shown.slice((rs.page - 1) * PAGE_SIZE, rs.page * PAGE_SIZE);
  const pagination = shown.length > PAGE_SIZE
    ? `<div class="pagination">
        <button type="button" class="btn btn-tight" data-rw-page="prev" ${rs.page <= 1 ? 'disabled' : ''}>${t('← Prev')}</button>
        <span class="pagination-info">${t('Page {page} of {pages} · {players}', { page: rs.page, pages, players: tn(shown.length, '{n} player', '{n} players') })}</span>
        <button type="button" class="btn btn-tight" data-rw-page="next" ${rs.page >= pages ? 'disabled' : ''}>${t('Next →')}</button>
      </div>`
    : '';
  return `${tableHtml(pageRows)}${pagination}`;
}

function tableHtml(rows) {
  const column = basis().column();
  const coinsLabel = esc(tGame('Dragon Coins'));
  const fragLabel = t('Clan fragments');
  const body = rows.map((p) => {
    const nameHtml = p.memberId ? memberLink(p.memberId, p.name) : `<span class="tinman-raw">${esc(p.name)}</span>`;
    const tag = p.left
      ? ` <span class="tinman-tag" title="${t('No longer on the clan roster — a reward can\'t reach them. Tick to include anyway.')}">${t('left the clan')}</span>`
      : p.unmatched
        ? ` <span class="tinman-tag" title="${t('Not matched to a clan member yet')}">${t('not matched')}</span>`
        : '';
    const amount = (v, pot) => (!p.included ? '<span class="events-zero">—</span>' : pot > 0 ? fmtInt(v) : '<span class="events-zero">·</span>');
    const share = p.included ? fmtShare(p.share) : '—';
    const sub = [`#${p.rank}`, p.included && rs.fragments > 0 ? tn(p.fragments, '{n} fragment', '{n} fragments') : '', share]
      .filter(Boolean).join(' · ');
    const label = p.included ? t('Leave out {name}', { name: esc(p.name) }) : t('Include {name}', { name: esc(p.name) });
    return `
      <tr class="${p.included ? '' : 'is-excluded'}">
        <td data-role="lead" class="rewards-take"><input type="checkbox" class="rewards-check" data-rw-take="${esc(p.key)}" ${p.included ? 'checked' : ''} aria-label="${label}" title="${label}"></td>
        <td data-role="hidden">${p.rank}</td>
        <td data-role="primary"><span class="mrow-name">${nameHtml}${tag}</span><span class="mrow-sub">${sub}</span></td>
        <td class="num" data-label="${esc(column)}" title="${fmtInt(p.score)}">${formatCompact(p.score)}</td>
        <td class="num" data-label="${t('Share')}">${share}</td>
        <td class="num rewards-amount" data-role="metric" data-label="${coinsLabel}">${amount(p.coins, rs.coins)}</td>
        <td class="num rewards-amount" data-label="${esc(fragLabel)}">${amount(p.fragments, rs.fragments)}</td>
      </tr>`;
  }).join('');
  return `
    <table class="table-responsive rewards-table">
      <colgroup><col class="col-take"><col class="col-rank"><col class="col-member"><col class="col-score"><col class="col-share"><col class="col-amount"><col class="col-amount"></colgroup>
      <thead><tr>
        <th><span class="visually-hidden">${t('Included')}</span></th>
        <th>${t('Rank')}</th>
        <th>${t('Player')}</th>
        <th class="num">${esc(column)}</th>
        <th class="num">${t('Share')}</th>
        <th class="num">${coinsLabel}</th>
        <th class="num">${esc(fragLabel)}</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table>`;
}

/** Tab-separated, header first: pastes into a sheet as columns and reads fine in chat. */
function copyText(split) {
  const cols = [rs.coins > 0, rs.fragments > 0];
  const header = [t('Player'), ...(cols[0] ? [tGame('Dragon Coins')] : []), ...(cols[1] ? [t('Clan fragments')] : [])];
  const lines = split.rows
    .filter((p) => p.included && (p.coins > 0 || p.fragments > 0))
    .map((p) => [p.name, ...(cols[0] ? [p.coins] : []), ...(cols[1] ? [p.fragments] : [])].join('\t'));
  return [header.join('\t'), ...lines].join('\n');
}

// ─── Events ────────────────────────────────────────────────────────

function onClick(e) {
  const root = e.currentTarget;
  const eventChip = e.target.closest('[data-rw-event]');
  if (eventChip) {
    if (eventChip.dataset.rwEvent === rs.event) return;
    rs.event = eventChip.dataset.rwEvent;
    rs.day = null;
    savePrefs();
    loadEvent(root).catch(ignoreAbort);
    return;
  }
  const basisChip = e.target.closest('[data-rw-basis]');
  if (basisChip) {
    if (basisChip.dataset.rwBasis === basisKey()) return;
    rs.basisByEvent[rs.event] = basisChip.dataset.rwBasis;
    rs.day = null;
    savePrefs();
    loadSource(root).catch(ignoreAbort);
    return;
  }
  const pager = e.target.closest('[data-rw-page]');
  if (pager) {
    rs.page += pager.dataset.rwPage === 'next' ? 1 : -1;
    paintResults(root);
    return;
  }
  const action = e.target.closest('[data-rw-action]')?.dataset.rwAction;
  if (action === 'include-all') {
    const split = currentSplit();
    for (const p of split?.rows ?? []) rs.excluded.delete(p.key);
    saveExcluded();
    paintResults(root);
  } else if (action === 'copy') {
    const split = currentSplit();
    if (!split) return;
    copyTextToClipboard(copyText(split)).then(() => {
      rs.copied = true;
      paintResults(root);
      clearTimeout(rs.copiedTimer);
      rs.copiedTimer = setTimeout(() => {
        rs.copied = false;
        if (root.isConnected) paintResults(root);
      }, 1800);
    });
  }
}

function onChange(e) {
  const root = e.currentTarget;
  const el = e.target;
  if (el.dataset.rwTake) {
    const key = el.dataset.rwTake;
    const p = rankedPlayers()?.find((x) => x.key === key);
    if (!p) return;
    if (p.left) {
      if (el.checked) rs.includeLeft.add(key); else rs.includeLeft.delete(key);
    } else {
      if (el.checked) rs.excluded.delete(key); else rs.excluded.add(key);
      saveExcluded();
    }
    paintResults(root);
    root.querySelector(`[data-rw-take="${CSS.escape(key)}"]`)?.focus();
    return;
  }
  if (el.dataset.rw === 'run') {
    rs.runIdx = Number(el.value) || 0;
    rs.day = null;
    loadSource(root).catch(ignoreAbort);
  } else if (el.dataset.rw === 'day') {
    rs.day = Number(el.value);
    rs.page = 1;
    paintSource(root);
    paintResults(root);
  }
}

function onInput(e) {
  const root = e.currentTarget;
  const el = e.target;
  if (el.dataset.pot) {
    rs[el.dataset.pot] = parsePot(el.value);
    paintResults(root);
  } else if (el.dataset.rw === 'search') {
    rs.query = el.value;
    rs.page = 1;
    paintResults(root);
  }
}

/** A pot box shows the number it was read as once you leave it. */
function onFocusOut(e) {
  const el = e.target;
  if (!el.dataset?.pot) return;
  const v = rs[el.dataset.pot];
  el.value = v > 0 ? v.toLocaleString() : '';
}

function ignoreAbort(err) {
  if (err?.name === 'UnauthenticatedError' || err?.name === 'AbortError') return;
  throw err;
}

// ─── How it works ──────────────────────────────────────────────────

function howItWorksHtml() {
  return `
    <details class="card card-collapsible" data-section-key="tools-rewards-howto">
      <summary class="card-header"><h2>${t('How this works')}</h2></summary>
      <div class="card-body-padded tool-howto">
        <ul>
          <li>${t('<strong>The split.</strong> Each player gets the pot × their score ÷ everyone\'s total, rounded down. The units left over go one each to the largest remainders, so the parts always add up to the pot.')}</li>
          <li>${t('<strong>Leaving someone out.</strong> Untick them: they get nothing, and their part is spread over everyone else by score. Who you leave out is remembered in this browser.')}</li>
          <li>${t('<strong>Left the clan.</strong> Players the roster no longer lists start unticked — a reward can only be sent to a member.')}</li>
          <li>${t('<strong>{olympus}.</strong> The clan ranking pasted on Events → {olympus}, as it stood after the day you pick. The ranking keeps growing through the run, so the last day is the whole run.', { olympus: esc(tGame('Olympus')) })}</li>
          <li>${t('<strong>{omens}.</strong> {essence} donated during the run, from resource tracking, or the {spoils} damage ranking pasted on Events → {omens}.', { omens: esc(tGame('Dark Omens')), essence: esc(tGame('Omen Essence')), spoils: esc(tGame('Spoils of Dread')) })}</li>
        </ul>
        <p class="muted-copy">${t('Splits like {link}. Where a leftover fragment could go either way, it may land on a different player.', { link: `<a href="https://totalcalculator.org/rewards.php" target="_blank" rel="noopener">${t('totalcalculator.org\'s rewards page')}</a>` })}</p>
      </div>
    </details>`;
}
