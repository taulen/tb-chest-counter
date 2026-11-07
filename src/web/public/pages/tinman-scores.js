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
import { esc, memberLink, notify, confirmDialog, formatDate } from '../lib/ui.js';
import { sortableThHtml } from '../lib/sort-headers.js';
import { getCurrentUser } from '../lib/state.js';
import { formatCompact } from '../lib/ancient-planner.js';
import { t, tn, tGame } from '../lib/i18n.js';
import { goalStatusClassFor, goalRowClassFor, goalCellContentHtml, goalCellTitle } from '../lib/leaderboard-render.js';

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
    emptyAdmin: () => t('No scores for this run yet. After each summon, copy the in-game ranking and add it with <strong>Add summon scores</strong>.'),
    emptyMember: () => t('No scores for this run yet — an admin adds them after each summon.'),
    addButton: () => t('Add summon scores'),
    round: (n) => t('Summon {summon}', { summon: n }),
    short: (n) => t('S{summon}', { summon: n }),
    deleteAria: (n) => t('Delete summon {summon} scores', { summon: n }),
    replaceOption: (n) => t('Summon {summon} — replaces the current upload', { summon: n }),
    placeholder: () => t('Paste the whole clan ranking as it stands after this summon, e.g.'),
    pasteHint: () => t('The in-game ranking keeps growing through the run — paste it as it stands. Missed a summon? Just paste the next one: those points land there.'),
    save: (n) => t('Save summon {summon}', { summon: n }),
    notPasted: (n) => t('Summon {summon} was not pasted — its points are in the next pasted summon', { summon: n }),
    since: (n) => t('Points scored since summon {summon} — includes the summon(s) not pasted', { summon: n }),
    scoredIn: (n) => t('Points scored in summon {summon}', { summon: n }),
    notInRanking: () => t('Not in this summon\'s ranking'),
    noPoints: () => t('No points in this summon'),
    played: (played, n) => tn(n, '{played} of {n} pasted summon', '{played} of {n} pasted summons', { n, played }),
    playedTitle: () => t('Summons this player scored in'),
    reviewHint: () => t('Pick who each pasted name is. It applies to every summon of this run, and the spelling is remembered for future runs.'),
    replaced: (n, names) => t('<strong>Summon {summon} replaced</strong>: {names} read', { summon: n, names }),
    saved: (n, names) => t('<strong>Summon {summon} saved</strong>: {names} read', { summon: n, names }),
    gapWarn: (count, ranks) => tn(count, '{n} rank is missing from the paste ({ranks}). The copy probably skipped that row — their points aren\'t in this summon. Paste the full list again to replace it.', '{n} ranks are missing from the paste ({ranks}). The copy probably skipped those rows — their points aren\'t in this summon. Paste the full list again to replace it.', { n: count, ranks }),
    deleteConfirm: (n) => t('Delete the pasted scores for summon {summon}? Its points move to the next pasted summon.', { summon: n }),
    deleteTitle: () => t('Delete summon scores'),
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
    emptyAdmin: () => t('No scores for this run yet. After each day, copy the in-game ranking and add it with <strong>Add day scores</strong>.'),
    emptyMember: () => t('No scores for this run yet — an admin adds them after each day.'),
    addButton: () => t('Add day scores'),
    round: (n) => t('Day {day}', { day: n }),
    short: (n) => t('D{day}', { day: n }),
    deleteAria: (n) => t('Delete day {day} scores', { day: n }),
    replaceOption: (n) => t('Day {day} — replaces the current upload', { day: n }),
    placeholder: () => t('Paste the whole clan ranking as it stands after this day, e.g.'),
    pasteHint: () => t('The in-game ranking keeps growing through the run — paste it as it stands. Missed a day? Just paste the next one: those points land there.'),
    save: (n) => t('Save day {day}', { day: n }),
    notPasted: (n) => t('Day {day} was not pasted — its points are in the next pasted day', { day: n }),
    since: (n) => t('Points scored since day {day} — includes the day(s) not pasted', { day: n }),
    scoredIn: (n) => t('Points scored on day {day}', { day: n }),
    notInRanking: () => t('Not in this day\'s ranking'),
    noPoints: () => t('No points on this day'),
    played: (played, n) => tn(n, '{played} of {n} pasted day', '{played} of {n} pasted days', { n, played }),
    playedTitle: () => t('Days this player scored in'),
    reviewHint: () => t('Pick who each pasted name is. It applies to every day of this run, and the spelling is remembered for future runs.'),
    replaced: (n, names) => t('<strong>Day {day} replaced</strong>: {names} read', { day: n, names }),
    saved: (n, names) => t('<strong>Day {day} saved</strong>: {names} read', { day: n, names }),
    gapWarn: (count, ranks) => tn(count, '{n} rank is missing from the paste ({ranks}). The copy probably skipped that row — their points aren\'t in this day\'s scores. Paste the full list again to replace it.', '{n} ranks are missing from the paste ({ranks}). The copy probably skipped those rows — their points aren\'t in this day\'s scores. Paste the full list again to replace it.', { n: count, ranks }),
    deleteConfirm: (n) => t('Delete the pasted scores for day {day}? Its points move to the next pasted day.', { day: n }),
    deleteTitle: () => t('Delete day scores'),
  };
}

/** The event shown: 'ancients' | 'olympus' | 'ragnarok' | 'dark-omens'. */
let eventKey = null;
let L = EVENTS.ancients;
let mountEl = null;
let members = [];
/** Requested run: a Tinman date, null for "the newest", or 'all' (no single run). */
let requested = null;
let data = null;          // last GET /tinman response
let loadedFor = undefined; // the `requested` value `data` answers
let sort = { key: 'total', dir: 'desc' };
let page = 1;
let uploadOpen = false;
let uploadSummon = null;  // chosen summon in the upload form
let uploadText = '';
let lastResult = null;    // message after a save
/** "Names to check" open state: null until the user toggles it (then it opens
 *  by itself while anything is unmatched). Kept across saves, which repaint the card. */
let reviewOpen = null;
/** Member picks not saved yet, by pasted name ('' = not a clan member). A save
 *  repaints every row, and without this it reset the other rows' dropdowns. */
const pending = new Map();
let targetsOpen = false;  // admin: the targets paste panel
let targetsText = '';
let targetsResult = null;
/** Second mount at the bottom of the page for "Below target", like "Did not participate". */
let belowEl = null;
let belowOpen = false;

/** Guards levels can't be inferred for everyone; a member without one is held to G7. */
const ASSUMED_TIER = 'g7';

function isAdmin() {
  const role = getCurrentUser()?.role;
  return role === 'admin' || role === 'superadmin';
}

/**
 * Render the card into `el` for one run.
 * @param {HTMLElement} el
 * @param {{ event?: 'ancients' | 'olympus' | 'ragnarok' | 'dark-omens', date: string | null | 'all', members: Array<{ id: number, name: string }> }} opts
 */
export async function mountTinmanScores(el, opts) {
  if (!el) return;
  mountEl = el;
  belowEl = opts.belowEl || null;
  members = [...(opts.members || [])].sort((a, b) => a.name.localeCompare(b.name));
  const event = EVENTS[opts.event] ? opts.event : 'ancients';
  if (event !== eventKey) {
    // Another event's card: nothing of the last one carries over.
    eventKey = event;
    L = EVENTS[event];
    data = null;
    loadedFor = undefined;
    requested = undefined;
    sort = { key: 'total', dir: 'desc' };
    uploadOpen = false;
    uploadText = '';
    targetsOpen = false;
    targetsText = '';
    targetsResult = null;
    belowOpen = false;
  }
  if (opts.date !== requested) {
    requested = opts.date;
    page = 1;
    uploadSummon = null;
    lastResult = null;
    reviewOpen = null;
    pending.clear();
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
  const hasRounds = (res) => (res ? (res.summons || []).length > 0 : null);
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
  return `
    <div class="card tinman-card">
      <div class="card-header">
        <div class="events-title">
          <h2>${L.title()}</h2>
          <span class="card-header-hint">${L.eventName()}${date ? ` · ${esc(date)}` : ''} · ${L.perRound()}</span>
        </div>
        ${actions}
      </div>
      ${body}
    </div>`;
}

// ─── Painting ────────────────────────────────────────────────────

/** Summon columns: 1 … the highest uploaded, gaps included so a missed summon shows. */
function summonColumns() {
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
  players.forEach((p, i) => { p._rank = i + 1; }); // server order: total desc
  // A summon column that no longer exists (another run) sorts by total instead.
  const key = sort.key.startsWith('s:') && !cols.some((c) => c.uploaded && `s:${c.summon}` === sort.key)
    ? 'total'
    : sort.key;
  const mul = sort.dir === 'asc' ? 1 : -1;
  const val = (p) => {
    if (key === 'name') return p.name.toLowerCase();
    if (key === 'rank') return p._rank;
    if (key === 'played') return p.played;
    if (key === 'tier') return Number(tierOf(p).key.slice(1)) - (tierOf(p).assumed ? 0.5 : 0);
    if (key === 'pct') {
      const e = expectedFor(p);
      return e ? p.total / e : -1;
    }
    if (key.startsWith('s:')) return p.perSummon[Number(key.slice(2))] ?? -1;
    return p.total;
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
  const actions = admin
    ? `<div class="tinman-actions">
        ${L.hasTargets ? `<button type="button" class="btn btn-sm ${targetsOpen ? 'active' : ''}" data-tinman="toggle-targets">${targetsOpen ? t('Close targets') : t('Targets')}</button>` : ''}
        <button type="button" class="btn btn-sm ${uploadOpen ? 'active' : 'btn-primary'}" data-tinman="toggle-upload">${uploadOpen ? t('Close') : L.addButton()}</button>
      </div>`
    : '';

  const cols = summonColumns();
  const body = `
    ${data.isTinmanDay === false ? `<p class="tinman-warn">⚠ ${t('{date} isn\'t a Tinman day on the usual 6-day cadence.', { date: esc(data.date) })}</p>` : ''}
    ${targetsOpen && admin && L.hasTargets ? targetsPanelHtml() : ''}
    ${uploadOpen && admin ? uploadPanelHtml() : ''}
    ${summonsStripHtml(admin)}
    ${L.hasTargets ? targetsStripHtml(admin) : ''}
    ${data.players.length ? tableHtml(cols) : `<p class="muted-copy tinman-note">${admin ? L.emptyAdmin() : L.emptyMember()}</p>`}
    ${reviewHtml(admin)}`;
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
        placeholder="${t('Paste the Points per member table from Tools → Ancient planner, e.g.')}&#10;For 3 kills, already lowered for a 15% overshoot.&#10;G9 	6 members 	61.3M 	368M 	19.2%&#10;G8 	33 members 	27.2M 	898M 	46.9%">${esc(targetsText)}</textarea>
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

function summonsStripHtml(admin) {
  const summons = data.summons || [];
  if (!summons.length) return '';
  const chips = summons.map((s) => `
    <span class="tinman-chip">
      <strong>${L.round(s.summon)}</strong>
      <span class="tinman-chip-meta">${tn(s.rows, '{n} name', '{n} names', { n: s.rows })}${s.unmatched ? ` · <span class="tool-warn">${tn(s.unmatched, '{n} unmatched', '{n} unmatched', { n: s.unmatched })}</span>` : ''}${s.missingRanks?.length ? ` · <span class="tool-warn" title="${t('Ranks missing from the paste: {ranks}', { ranks: esc(rankRanges(s.missingRanks)) })}">⚠ ${tn(s.missingRanks.length, '{n} rank missing', '{n} ranks missing', { n: s.missingRanks.length })}</span>` : ''} · ${esc(s.uploadedBy || '—')} · ${esc(formatDate(s.uploadedAt))}</span>
      ${admin ? `<button type="button" class="tinman-chip-del" data-tinman="delete" data-summon="${s.summon}" aria-label="${L.deleteAria(s.summon)}" title="${t('Delete this upload')}">×</button>` : ''}
    </span>`).join('');
  return `<div class="tinman-chips">${chips}</div>`;
}

function uploadPanelHtml() {
  const uploaded = new Set((data.summons || []).map((s) => s.summon));
  const max = data.maxSummons || 8;
  const next = Math.min(max, Math.max(0, ...uploaded) + 1);
  const chosen = uploadSummon ?? next;
  const options = [];
  for (let n = 1; n <= max; n++) {
    options.push(`<option value="${n}" ${n === chosen ? 'selected' : ''}>${uploaded.has(n) ? L.replaceOption(n) : L.round(n)}</option>`);
  }
  const res = lastResult
    ? `<div class="tinman-result ${lastResult.error ? 'is-error' : ''}" role="status">${lastResult.html}</div>`
    : '';
  return `
    <div class="tinman-upload">
      <div class="tinman-upload-row">
        <label for="tinmanSummon">${t('Scores after')}</label>
        <select id="tinmanSummon" class="input tinman-summon-select" data-tinman="summon">${options.join('')}</select>
      </div>
      <label class="visually-hidden" for="tinmanText">${t('Pasted ranking')}</label>
      <textarea id="tinmanText" class="input tinman-text" rows="8" spellcheck="false"
        placeholder="${L.placeholder()}&#10;| 1 | Fiin SK 2 | 63,965,364 |&#10;| 2 | Frostbite | 59,878,655 |">${esc(uploadText)}</textarea>
      <p class="muted-copy tinman-hint">${L.pasteHint()}</p>
      <div class="tinman-upload-actions">
        <button type="button" class="btn btn-primary" data-tinman="save">${L.save(chosen)}</button>
      </div>
      ${res}
    </div>`;
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
  const summonHeads = cols.map((c) => {
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
    const nameHtml = p.memberId
      ? memberLink(p.memberId, p.name)
      : `<span class="tinman-raw">${esc(p.rawName)}</span>`;
    const tag = !p.memberId
      ? ` <span class="tinman-tag" title="${t('Not matched to a clan member yet')}">${t('not matched')}</span>`
      : p.matchKind === 'fuzzy' && p.rawName !== p.name
        ? ` <span class="tinman-tag tinman-tag-fuzzy" title="${t('Pasted as “{name}” — matched by spelling', { name: esc(p.rawName) })}">≈</span>`
        : '';
    const cells = cols.map((c) => {
      if (!c.uploaded) return `<td class="num tinman-missing-col" data-label="${sLabel(c.summon)}"><span class="events-zero">·</span></td>`;
      const v = p.perSummon[c.summon];
      if (v === undefined) return `<td class="num" data-label="${sLabel(c.summon)}"><span class="events-zero" title="${L.notInRanking()}">–</span></td>`;
      if (v === 0) return `<td class="num" data-label="${sLabel(c.summon)}"><span class="events-zero" title="${L.noPoints()}">—</span></td>`;
      return `<td class="num${v < 0 ? ' tool-short' : ''}" data-label="${sLabel(c.summon)}" title="${v.toLocaleString()}">${formatCompact(v)}</td>`;
    }).join('');
    const tier = tierOf(p);
    const expected = expectedFor(p);
    const full = data.targets?.tiers?.[tier.key];
    const totalTitle = expected !== null ? goalCellTitle(p.total, expected) : p.total.toLocaleString();
    const targetCell = expected !== null
      ? `<td class="num" data-label="${t('Target')}" title="${esc(t('{points} for the run', { points: Math.round(full).toLocaleString() }))}">${formatCompact(expected)}</td>`
      : `<td class="num" data-label="${t('Target')}"><span class="events-zero">—</span></td>`;
    const pastedCount = cols.filter((c) => c.uploaded).length;
    const playedText = L.played(p.played, pastedCount);
    return `<tr class="${expected !== null ? goalRowClassFor(p.total, expected) : ''}">
      <td data-role="lead">${p._rank}</td>
      <td data-role="primary"><span class="mrow-name">${nameHtml}${tag}</span><span class="mrow-sub">${L.hasTargets ? `${tierLabel(tier)} · ${playedText}` : playedText}</span></td>
      ${L.hasTargets ? `<td data-label="${t('Tier')}">${tierBadgeHtml(tier)}</td>` : ''}
      ${cells}
      <td class="num ${expected !== null ? goalStatusClassFor(p.total, expected) : ''}" data-role="metric" data-label="${t('Total')}" title="${esc(totalTitle)}">${expected !== null ? goalCellContentHtml(p.total, expected, `<strong>${formatCompact(p.total)}</strong>`) : `<strong>${formatCompact(p.total)}</strong>`}</td>
      ${L.hasTargets ? targetCell : ''}
      <td class="num" data-role="hidden">${p.played}</td>
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
            ${L.hasTargets ? th('tier', t('Tier'), '', t('Estimated guards level — G7 assumed when unknown')) : ''}
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

function reviewHtml(admin) {
  const review = data.review || [];
  if (!review.length) return '';
  const unmatched = review.filter((r) => !r.memberId).length;
  if (!admin) {
    return unmatched ? `<p class="muted-copy tinman-note">${tn(unmatched, '{n} pasted name is not matched to a member yet — an admin can assign them.', '{n} pasted names are not matched to a member yet — an admin can assign them.', { n: unmatched })}</p>` : '';
  }
  const options = (selected) => [
    `<option value="">${t('— Not a clan member —')}</option>`,
    ...members.map((m) => `<option value="${m.id}" ${m.id === selected ? 'selected' : ''}>${esc(m.name)}</option>`),
  ].join('');
  const rows = review.map((r) => {
    const picked = pending.has(r.rawName) ? pending.get(r.rawName) : String(r.memberId ?? '');
    return `
    <tr>
      <td data-role="primary"><span class="mrow-name">${esc(r.rawName)}</span><span class="mrow-sub">${r.memberId ? t('matched by spelling') : r.matchKind === 'rejected' ? t('marked as not a member') : t('no match')}</span></td>
      <td class="num" data-role="metric" data-label="${t('Points')}">${formatCompact(r.points)}</td>
      <td data-label="${t('Member')}">
        <select class="input tinman-assign" data-raw-name="${esc(r.rawName)}" aria-label="${t('Member for {name}', { name: esc(r.rawName) })}">${options(picked === '' ? null : Number(picked))}</select>
      </td>
      <td data-label="">
        <button type="button" class="btn btn-sm" data-tinman="assign" data-raw-name="${esc(r.rawName)}">${r.memberId ? t('Confirm') : t('Save')}</button>
      </td>
    </tr>`;
  }).join('');
  const open = reviewOpen ?? unmatched > 0;
  const changed = changedPicks().length;
  return `
    <details class="card-collapsible tinman-review" data-section-key="tinman-review" ${open ? 'open' : ''}>
      <summary class="card-header"><h2>${t('Names to check ({count})', { count: review.length })}</h2><span class="card-header-hint">${tn(unmatched, '{n} unmatched', '{n} unmatched', { n: unmatched })} · ${tn(review.length - unmatched, '{n} matched by spelling', '{n} matched by spelling', { n: review.length - unmatched })}</span></summary>
      <div class="card-body">
        <div class="tinman-review-head">
          <p class="muted-copy tinman-hint">${L.reviewHint()}</p>
          <button type="button" class="btn btn-sm btn-primary" data-tinman="assign-all" ${changed ? '' : 'disabled'}>${saveAllLabel(changed)}</button>
        </div>
        <table class="table-responsive tinman-review-table">
          <colgroup><col class="col-member"><col class="col-num"><col class="col-assign"><col class="col-action"></colgroup>
          <thead><tr><th>${t('Pasted name')}</th><th class="num">${t('Points')}</th><th>${t('Member')}</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </details>`;
}

/** [13, 19, 30, 31, 37, 38, 39, 40] → "13, 19, 30–31, 37–40". */
function rankRanges(ranks) {
  const out = [];
  for (let i = 0; i < ranks.length; i++) {
    let j = i;
    while (j + 1 < ranks.length && ranks[j + 1] === ranks[j] + 1) j++;
    out.push(j > i ? `${ranks[i]}–${ranks[j]}` : String(ranks[i]));
    i = j;
  }
  return out.join(', ');
}

const saveAllLabel = (n) => (n ? t('Save all changes ({count})', { count: n }) : t('Save all changes'));

/** Picks that differ from what is saved: [{ rawName, memberId }]. */
function changedPicks() {
  const out = [];
  for (const r of data?.review || []) {
    if (!pending.has(r.rawName)) continue;
    const v = pending.get(r.rawName);
    if (v !== String(r.memberId ?? '')) out.push({ rawName: r.rawName, memberId: v === '' ? null : Number(v) });
  }
  return out;
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
  const targetsArea = el.querySelector('#tinmanTargets');
  if (targetsArea) targetsArea.addEventListener('input', () => { targetsText = targetsArea.value; });
  const text = el.querySelector('#tinmanText');
  if (text) text.addEventListener('input', () => { uploadText = text.value; });
  const select = el.querySelector('[data-tinman="summon"]');
  if (select) {
    select.addEventListener('change', () => {
      uploadSummon = Number(select.value);
      const btn = el.querySelector('[data-tinman="save"]');
      if (btn) btn.textContent = L.save(uploadSummon);
    });
  }
  const review = el.querySelector('details.tinman-review');
  if (review) review.addEventListener('toggle', () => { reviewOpen = review.open; });
  el.querySelectorAll('select.tinman-assign').forEach((sel) => {
    sel.addEventListener('change', () => {
      pending.set(sel.dataset.rawName, sel.value);
      const n = changedPicks().length;
      const all = el.querySelector('[data-tinman="assign-all"]');
      if (all) {
        all.disabled = n === 0;
        all.textContent = saveAllLabel(n);
      }
    });
  });
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
  if (action === 'toggle-upload') {
    uploadOpen = !uploadOpen;
    lastResult = null;
    paint();
    if (uploadOpen) mountEl.querySelector('#tinmanText')?.focus();
    return;
  }
  if (action === 'save') return save(btn);
  if (action === 'delete') return removeSummon(Number(btn.dataset.summon));
  if (action === 'assign') return assign(btn);
  if (action === 'assign-all') return assignAll(btn);
}

async function save(btn) {
  const summonSel = mountEl.querySelector('[data-tinman="summon"]');
  const summon = Number(summonSel?.value || 1);
  const text = mountEl.querySelector('#tinmanText')?.value || '';
  if (!text.trim()) {
    lastResult = { error: true, html: t('Paste the ranking first.') };
    paint();
    return;
  }
  btn.disabled = true;
  btn.textContent = t('Saving…');
  try {
    const res = await apiPut(`${L.api}/${encodeURIComponent(data.date)}/summons/${summon}`, { text });
    if (res?.error) {
      const sample = Array.isArray(res.skipped) && res.skipped.length
        ? `<br><span class="muted-copy">${t('Couldn\'t read: {lines}', { lines: res.skipped.map((s) => `<code>${esc(s)}</code>`).join(' ') })}</span>`
        : '';
      lastResult = { error: true, html: `${esc(res.error)}${sample}` };
    } else {
      const r = res.result;
      const names = tn(r.rows, '{n} name', '{n} names', { n: r.rows });
      const parts = [
        r.replaced ? L.replaced(summon, names) : L.saved(summon, names),
        tn(r.matched - r.fuzzy, '{n} matched exactly', '{n} matched exactly', { n: r.matched - r.fuzzy }),
        r.fuzzy ? tn(r.fuzzy, '{n} matched by spelling', '{n} matched by spelling', { n: r.fuzzy }) : '',
        r.unmatched ? `<span class="tool-warn">${tn(r.unmatched, '{n} not matched — see Names to check', '{n} not matched — see Names to check', { n: r.unmatched })}</span>` : '',
      ].filter(Boolean);
      const skipped = r.skipped ? `<br><span class="muted-copy">${tn(r.skipped, '{n} line skipped: {lines}', '{n} lines skipped: {lines}', { n: r.skipped, lines: r.skippedSample.map((s) => `<code>${esc(s)}</code>`).join(' ') })}</span>` : '';
      const gaps = Array.isArray(r.missingRanks) ? r.missingRanks : [];
      const gapWarn = gaps.length
        ? `<br><span class="tool-warn">⚠ ${L.gapWarn(gaps.length, esc(rankRanges(gaps)))}</span>`
        : '';
      const warn = [res.warning, res.staleWarning].filter(Boolean).map((w) => `<br><span class="tool-warn">⚠ ${esc(w)}</span>`).join('');
      lastResult = { error: false, html: `${parts.join(' · ')}${skipped}${gapWarn}${warn}` };
      uploadText = '';
      uploadSummon = null;
      await load();
    }
  } catch (err) {
    if (err?.name === 'UnauthenticatedError') return;
    lastResult = { error: true, html: esc(t('Could not save: {error}', { error: err?.message || err })) };
  }
  paint();
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

async function removeSummon(summon) {
  const ok = await confirmDialog(L.deleteConfirm(summon), {
    title: L.deleteTitle(), confirmLabel: t('Delete'), danger: true,
  });
  if (!ok) return;
  try {
    const res = await apiDelete(`${L.api}/${encodeURIComponent(data.date)}/summons/${summon}`);
    if (res?.error) await notify(res.error, t('Could not delete'));
  } catch (err) {
    if (err?.name === 'UnauthenticatedError') return;
    await notify(t('Could not delete: {error}', { error: err?.message || err }), t('Could not delete'));
  }
  await load();
  paint();
}

/** PUT one assignment; the error message, or null on success. */
async function putAssign(rawName, memberId) {
  try {
    const res = await apiPut(`${L.api}/${encodeURIComponent(data.date)}/assign`, { rawName, memberId });
    return res?.error ? `${rawName}: ${res.error}` : null;
  } catch (err) {
    if (err?.name === 'UnauthenticatedError') throw err;
    return `${rawName}: ${err?.message || err}`;
  }
}

async function assign(btn) {
  const rawName = btn.dataset.rawName;
  const selects = [...mountEl.querySelectorAll('select.tinman-assign')];
  const at = selects.findIndex((s) => s.dataset.rawName === rawName);
  const memberId = at >= 0 && selects[at].value ? Number(selects[at].value) : null;
  const nextName = selects[at + 1]?.dataset.rawName ?? null;
  btn.disabled = true;
  const error = await putAssign(rawName, memberId);
  if (error) {
    await notify(error, t('Could not assign'));
    btn.disabled = false;
    return;
  }
  pending.delete(rawName);
  reviewOpen = true;
  await load();
  paint();
  // Carry on where you were: the next name's dropdown, if it is still listed.
  const next = [...mountEl.querySelectorAll('select.tinman-assign')].find((s) => s.dataset.rawName === nextName);
  (next || mountEl.querySelector('select.tinman-assign'))?.focus();
}

async function assignAll(btn) {
  const picks = changedPicks();
  if (!picks.length) return;
  btn.disabled = true;
  btn.textContent = t('Saving…');
  const errors = [];
  for (const p of picks) {
    const error = await putAssign(p.rawName, p.memberId);
    if (error) errors.push(error);
    else pending.delete(p.rawName);
  }
  reviewOpen = true;
  await load();
  paint();
  if (errors.length) await notify(errors.join('\n'), t('Some names were not saved'));
}
