// Members + Member Detail pages. List view with name search and
// sortable columns; per-member detail view with rank badge, weekly
// progress, chest type breakdown, and paginated chest history.

import { api } from '../lib/api.js';
import {
  $, esc, formatDate, formatDateShort, formatGameDayShort, formatRelativeTime,
  memberHash, memberLink, chestHash, parseHashRoute,
} from '../lib/ui.js';
import {
  computeGameWindow, periodAnchorFromOffset, periodOffsetFromAnchor,
} from '../lib/period.js';
import { renderPeriodNav } from '../lib/period-nav.js';
import {
  scaleGoalForPeriod, goalStatusClassFor,
} from '../lib/leaderboard-render.js';
import { getCurrentUser } from '../lib/state.js';
import {
  formatResourceAmount, resourceIconOnly, resourceIconHtml, resourceSparklineSvg,
  directionPillHtml, isResourcesEnabledForActiveClan,
} from '../lib/resource-format.js';

// ─── Members list ─────────────────────────────────────────────

const MEMBER_CHESTS_PAGE_SIZE = 25;
let cachedMembers = [];
// memberId → { might, delta, gameDate }. Empty when might tracking is off or
// has never captured, which is what hides the two columns.
let cachedMightByMember = new Map();
let membersFilter = '';
let membersSort = { key: 'name', dir: 'asc' };
let currentMemberChestsPage = 1;
let currentMemberTriumphalsPage = 1;
let currentMemberResourcesPage = 1;
let currentMemberId = null;
// Active tab on the member detail page — 'chests' | 'triumphals' |
// 'resources'. Preserved across pagination rerenders so a Prev/Next click
// stays on the user's current tab. Resets to 'chests' when the operator
// opens a different member.
let currentMemberChestsTab = 'chests';
// Timeframe for the member profile. Page-local, like Analytics and Events —
// lib/state.js's currentPeriod belongs to the Leaderboard and Triumphal pages.
// All Time is the default so a profile opened from a link reads the same as
// it always has.
const MEMBER_PERIODS = ['daily', 'weekly', 'monthly', 'yearly', 'all'];
let currentMemberPeriod = 'all';
// Explicit, because the obvious trick (strip a trailing "ly") turns daily
// into "dai". All Time is absent on purpose — the badge says just "Rank".
const MEMBER_PERIOD_NOUN = {
  daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year',
};
let currentMemberOffset = 0;
let memberWeeklyGoalPoints = null;
// The mounted might chart's draw callback for the member currently on screen.
// Held here (rather than only in the loader) because a tab flip re-renders the
// whole detail view — including the might card — and Chart.js needs the canvas
// redrawn against the fresh DOM. `draw` destroys the previous chart itself, so
// calling it on every render is safe.
let currentMemberMightDraw = () => {};

export async function renderMembers(el) {
  cachedMembers = await api('/members');
  // Might is optional data from an opt-in feature, so it's fetched separately
  // and merged in. A failure (or the feature being off) just leaves the columns
  // out — the roster table must never break over it.
  cachedMightByMember = await fetchMightMap();
  renderMembersTable(el);
}

/**
 * memberId → { might, delta, gameDate } for the active clan, or an empty map
 * when might tracking has nothing to show. Empty map = columns hidden.
 */
async function fetchMightMap() {
  try {
    const res = await api('/might/overview?deltaDays=7');
    const rows = Array.isArray(res?.rows) ? res.rows : [];
    const withData = rows.filter((r) => r.might !== null);
    if (withData.length === 0) return new Map();
    return new Map(rows.map((r) => [r.memberId, r]));
  } catch {
    return new Map();
  }
}

/** Signed delta with an arrow, reusing the progress-* classes from the
 *  member-detail weekly cards so up/down colouring is consistent site-wide. */
function formatMightDelta(delta) {
  if (delta === null || delta === undefined) return { text: '—', cls: 'progress-flat', arrow: '' };
  if (delta === 0) return { text: '±0', cls: 'progress-flat', arrow: '—' };
  const abs = Math.abs(delta).toLocaleString('en-US');
  return delta > 0
    ? { text: `+${abs}`, cls: 'progress-up', arrow: '▲' }
    : { text: `-${abs}`, cls: 'progress-down', arrow: '▼' };
}

export function renderMembersTable(el) {
  const currentUser = getCurrentUser();
  const isAdmin = currentUser?.role === 'admin' || currentUser?.role === 'superadmin';
  const showMight = cachedMightByMember.size > 0;
  const filterText = membersFilter.trim().toLowerCase();
  const filteredMembers = filterText
    ? cachedMembers.filter((m) => (m.name || '').toLowerCase().includes(filterText))
    : cachedMembers;
  const sortedMembers = sortMembers(filteredMembers, membersSort.key, membersSort.dir);
  const arrow = (key) => membersSort.key === key ? (membersSort.dir === 'asc' ? ' ▲' : ' ▼') : '';

  const countLabel = filterText
    ? `${sortedMembers.length} of ${cachedMembers.length}`
    : `${cachedMembers.length}`;

  el.innerHTML = `<div class="card">
    <div class="card-header">
      <h2>Clan Members (${countLabel})</h2>
      <input
        type="text"
        id="membersFilter"
        class="input members-filter"
        placeholder="Search by name..."
        value="${esc(membersFilter)}">
    </div>
    <div class="card-body">
    ${cachedMembers.length === 0
      ? '<div class="empty-state"><p>No members yet.</p></div>'
      : sortedMembers.length === 0
        ? '<div class="empty-state"><p>No members match your search.</p></div>'
        : `<table class="table-responsive members-table"><colgroup>
            <col class="col-member">
            ${showMight ? '<col class="col-metric"><col class="col-metric">' : ''}
            <col class="col-date">
            <col class="col-date">
            ${isAdmin ? '<col class="col-actions">' : ''}
          </colgroup><thead><tr>
            <th class="sortable" data-action="sort-members" data-sort-key="name">Name${arrow('name')}</th>
            ${showMight ? `
              <th class="sortable num" data-action="sort-members" data-sort-key="might">Might${arrow('might')}</th>
              <th class="sortable num" data-action="sort-members" data-sort-key="mightDelta" title="Change over the last ~7 days">7d${arrow('mightDelta')}</th>
            ` : ''}
            <th class="sortable" data-action="sort-members" data-sort-key="firstSeen">First Seen${arrow('firstSeen')}</th>
            <th class="sortable" data-action="sort-members" data-sort-key="lastSeen">Last Seen${arrow('lastSeen')}</th>
            ${isAdmin ? '<th>Actions</th>' : ''}
          </tr></thead><tbody>
            ${sortedMembers.map((m) => {
              const might = cachedMightByMember.get(m.id);
              const d = formatMightDelta(might?.delta);
              return `<tr>
              <td data-label="Name" data-role="primary"><span class="mrow-name">${memberLink(m.id, m.name)}</span></td>
              ${showMight ? `
                <td data-label="Might" data-role="metric" class="num">${might?.might != null ? Number(might.might).toLocaleString('en-US') : '—'}</td>
                <td data-label="7d" class="num ${d.cls}">${d.arrow} ${d.text}</td>
              ` : ''}
              <td data-label="First Seen">${formatDate(m.firstSeen)}</td>
              ${/* With might present it takes over as the headline metric, so Last
                    Seen drops into the expand panel. Left unmarked (not "hidden")
                    so it stays reachable — "hidden" means shown elsewhere. */''}
              <td data-label="Last Seen"${showMight ? '' : ' data-role="metric"'}>${formatDate(m.lastSeen)}</td>
              ${isAdmin ? `<td class="col-actions"><button class="btn btn-tight" data-action="prompt-merge-member" data-member-id="${m.id}">Merge</button></td>` : ''}
            </tr>`;
            }).join('')}
          </tbody></table>`}
  </div></div>`;
}

function sortMembers(members, key, dir) {
  // Apply direction inline so tied rows return 0 and the stable sort
  // preserves the input order. Reversing afterwards flips equal items.
  const mul = dir === 'desc' ? -1 : 1;
  return [...members].sort((a, b) => {
    let av = a[key];
    let bv = b[key];
    if (key === 'name') {
      av = (av || '').toLowerCase();
      bv = (bv || '').toLowerCase();
    } else if (key === 'might' || key === 'mightDelta') {
      // Might lives in a side map, not on the member row. Members with no
      // reading sort last in both directions rather than colliding with 0 —
      // "no data" is not the same as "no might" or "no growth".
      const field = key === 'might' ? 'might' : 'delta';
      const raw = (m) => cachedMightByMember.get(m.id)?.[field];
      const va = raw(a);
      const vb = raw(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      av = va;
      bv = vb;
    } else {
      // Date fields — compare as timestamps, treat missing as 0
      av = av ? new Date(av).getTime() : 0;
      bv = bv ? new Date(bv).getTime() : 0;
    }
    if (av < bv) return -1 * mul;
    if (av > bv) return 1 * mul;
    return 0;
  });
}

export function setMembersSort(key, rerender) {
  if (membersSort.key === key) {
    membersSort.dir = membersSort.dir === 'asc' ? 'desc' : 'asc';
  } else {
    membersSort.key = key;
    membersSort.dir = key === 'name' ? 'asc' : 'desc';
  }
  // Re-render in place using cached members so the search input keeps
  // focus and we don't waste a network call.
  if (cachedMembers.length > 0) {
    renderMembersTable($('#content'));
  } else {
    rerender('members');
  }
}

/** Update the in-memory filter text and re-render the table without
 *  refetching. Called from app.js's input listener. */
export function setMembersFilter(text) {
  membersFilter = text;
  if (cachedMembers.length > 0) {
    renderMembersTable($('#content'));
  }
}

// ─── Member detail ────────────────────────────────────────────

async function fetchRawOcrRows(memberId, source) {
  // Forensic data — superadmin only, mirroring the System-page toggle
  // that controls capture. Skip the request entirely for everyone else
  // so we don't generate wasted 403s on every member-page view; the
  // server endpoint is the authoritative gate.
  if (getCurrentUser()?.role !== 'superadmin') return [];
  try {
    const r = await api(`/members/${memberId}/raw-ocr?limit=100&source=${source}`);
    return Array.isArray(r?.rows) ? r.rows : [];
  } catch {
    return [];
  }
}

export async function viewMemberByName(name, navigate) {
  const data = await api(`/members/${encodeURIComponent(name)}`);
  if (data.error) { navigate('members'); return; }
  if (window.location.hash !== memberHash(data.id)) {
    window.location.hash = memberHash(data.id);
    return;
  }
  await loadAndRenderMemberDetail(data);
}

export async function viewMember(id, navigate) {
  // Compare only the PAGE part. Comparing the whole hash meant any timeframe
  // in the query string looked like the wrong route, and the redirect below
  // rewrote it away before anything could read it.
  const route = parseHashRoute();
  if (route.page !== `member/${id}`) {
    window.location.hash = memberHash(id, currentMemberPeriod,
      periodAnchorFromOffset(currentMemberPeriod, currentMemberOffset));
    return;
  }
  const requested = route.params.get('period');
  currentMemberPeriod = MEMBER_PERIODS.includes(requested) ? requested : 'all';
  currentMemberOffset = currentMemberPeriod === 'all'
    ? 0
    : periodOffsetFromAnchor(currentMemberPeriod, route.params);
  if (currentMemberId !== id) {
    // New member — reset all per-member detail state so a fresh view
    // doesn't inherit pagination / tab selection from the previous one.
    currentMemberChestsPage = 1;
    currentMemberTriumphalsPage = 1;
    currentMemberResourcesPage = 1;
    currentMemberChestsTab = 'chests';
    currentMemberId = id;
  }
  const [data, goal] = await Promise.all([
    api(`/members/${id}${memberWindowQuery()}`),
    api('/leaderboard/goal').catch(() => null),
  ]);
  memberWeeklyGoalPoints = Number.isFinite(goal?.weeklyPoints) ? goal.weeklyPoints : null;
  // The member belongs to a different clan (or doesn't exist): the API
  // answers 404 with { error }. This happens to a superadmin who switches
  // the active clan while sitting on #member/<id> for the previous clan —
  // the reload keeps the hash but the id no longer resolves in the new
  // clan. Without this guard we'd render a broken profile and (worse) the
  // resources card would fetch memberId=undefined and show the whole
  // clan's resources. Bounce to the main page instead.
  if (!data || data.error) {
    currentMemberId = null;
    if (typeof navigate === 'function') navigate('dashboard');
    return;
  }
  await loadAndRenderMemberDetail(data);
}

async function loadAndRenderMemberDetail(data) {
  // Fetch both chest types + both raw-ocr sources up front so the tab
  // switcher is instant (no per-click round-trip). Bandwidth is fine —
  // a single page of each is ≤ 25 rows + at most 100 raw-OCR strings.
  const [chestPage, triumphalPage, rawOcrChests, rawOcrTriumphals] = await Promise.all([
    fetchMemberChests(data.id),
    fetchMemberTriumphals(data.id),
    fetchRawOcrRows(data.id, 'chests'),
    fetchRawOcrRows(data.id, 'triumphals'),
  ]);
  // One feature check for both resource surfaces (the donated-totals card and
  // the Resources history tab) so a member view makes a single /clans call.
  const resourcesEnabled = await isResourcesEnabledForActiveClan().catch(() => false);
  const [resourceCardHtml, resourcePage] = await Promise.all([
    buildMemberResourcesCard(data.id, resourcesEnabled),
    fetchMemberResources(data.id, resourcesEnabled),
  ]);
  // Might history card. Returns null when the member has fewer than two
  // readings (or the feature is off), in which case the card is simply absent.
  // Its chart needs a mounted canvas, so the draw call happens after render.
  const { buildMemberMightCard } = await import('./might.js');
  const mightCard = await buildMemberMightCard(data.id).catch(() => null);
  currentMemberMightDraw = mightCard?.draw ?? (() => {});
  renderMemberDetail(
    data, chestPage, triumphalPage, rawOcrChests, rawOcrTriumphals,
    resourceCardHtml, mightCard?.html ?? '', mightCard?.statsHtml ?? '', resourcePage,
  );
}

// Per-member "Resources donated" card — one row per resource type the member
// has sent, each with its own-unit total and a weekly sparkline. Read-only, so
// visible to any clan member; shown only when the active clan has resource
// tracking enabled. Any failure silently drops the card so a member view never
// breaks over it.
async function buildMemberResourcesCard(memberId, resourcesEnabled) {
  try {
    if (!resourcesEnabled) return '';
    const [dailyRes, typesRes] = await Promise.all([
      api(`/resources/daily?memberId=${memberId}`),
      api('/resources/types'),
    ]);
    const daily = Array.isArray(dailyRes?.rows) ? dailyRes.rows : [];
    const types = Array.isArray(typesRes) ? typesRes : (typesRes?.types ?? []);
    const typeById = new Map(types.map((t) => [t.id, t]));

    const byType = new Map();
    for (const d of daily) {
      if (d.resourceTypeId == null || !d.sent) continue;
      const cur = byType.get(d.resourceTypeId) || { sent: 0, rows: [] };
      cur.sent += d.sent;
      cur.rows.push({ date: d.date, sent: d.sent });
      byType.set(d.resourceTypeId, cur);
    }
    const rows = [...byType.entries()]
      .map(([id, v]) => ({ type: typeById.get(id), sent: v.sent, series: weeklySent(v.rows) }))
      .filter((r) => r.type && r.sent > 0)
      .sort((a, b) => b.sent - a.sent);
    if (rows.length === 0) return '';

    // Uniform card grid mirroring the Resources Overview page: one card per
    // resource type (icon+name, own-unit total, weekly sparkline). Every card
    // is identical in structure so the grid lines up cleanly regardless of how
    // wide each amount renders. These cards are informational only — unlike the
    // Overview's, they aren't clickable — so they use their own container class.
    const cards = rows.map((r) => `
      <div class="resource-member-card">
        <div class="resource-card-head">
          ${resourceIconOnly(r.type.slug)}
          <span class="resource-card-name">${esc(r.type.name)}</span>
        </div>
        <div class="resource-card-amount">${esc(formatResourceAmount(r.type.slug, r.sent))}</div>
        ${resourceSparklineSvg(r.series)}
      </div>`).join('');
    return `
      <div class="card">
        <div class="card-header">
          <h2>Resources donated</h2>
          <span class="card-header-hint">Each in its own unit · weekly trend</span>
        </div>
        <div class="card-body"><div class="resources-cards">${cards}</div></div>
      </div>`;
  } catch (_) {
    return '';
  }
}

// Weekly Sent totals (Monday-anchored) for a compact sparkline.
function weeklySent(rows) {
  const map = new Map();
  for (const r of rows) {
    const d = new Date(r.date + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    const key = d.toISOString().slice(0, 10);
    map.set(key, (map.get(key) || 0) + r.sent);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map((e) => e[1]);
}

/**
 * The selected timeframe as a query fragment, or '' for All Time.
 *
 * Half-open [from, to) straight from computeGameWindow — the server reads it
 * the same way, so a chest on a boundary lands in exactly one period here and
 * on the leaderboard.
 */
function memberWindowQuery(prefix = '?') {
  if (currentMemberPeriod === 'all') return prefix === '?' ? '' : '';
  const w = computeGameWindow(currentMemberPeriod, currentMemberOffset);
  if (!w) return '';
  const p = new URLSearchParams({ from: w.from, to: w.to });
  return `${prefix}${p.toString()}`;
}

async function fetchMemberChests(memberId) {
  const offset = (currentMemberChestsPage - 1) * MEMBER_CHESTS_PAGE_SIZE;
  const w = memberWindowQuery('&');
  return api(`/members/${memberId}/chests?limit=${MEMBER_CHESTS_PAGE_SIZE}&offset=${offset}${w}`);
}

async function fetchMemberTriumphals(memberId) {
  const offset = (currentMemberTriumphalsPage - 1) * MEMBER_CHESTS_PAGE_SIZE;
  try {
    return await api(`/members/${memberId}/triumphal-chests?limit=${MEMBER_CHESTS_PAGE_SIZE}&offset=${offset}`);
  } catch {
    return { chests: [], total: 0 };
  }
}

/**
 * One page of this member's resource ledger — the same rows the Resources
 * Admin table shows, filtered to this player and stripped of the edit column
 * (read-only, so every clan member can see it). Returns an empty page when the
 * clan doesn't track resources, which is what hides the tab.
 */
async function fetchMemberResources(memberId, resourcesEnabled) {
  if (!resourcesEnabled) return { rows: [], total: 0 };
  const offset = (currentMemberResourcesPage - 1) * MEMBER_CHESTS_PAGE_SIZE;
  try {
    const res = await api(
      `/resources/transactions?memberId=${memberId}&sortBy=date&sortDir=desc`
      + `&limit=${MEMBER_CHESTS_PAGE_SIZE}&offset=${offset}`,
    );
    return { rows: Array.isArray(res?.rows) ? res.rows : [], total: res?.total ?? 0 };
  } catch {
    return { rows: [], total: 0 };
  }
}

export function changeMemberChestsPage(delta, memberId) {
  currentMemberChestsPage = Math.max(1, currentMemberChestsPage + delta);
  viewMember(memberId);
}

export function changeMemberTriumphalsPage(delta, memberId) {
  currentMemberTriumphalsPage = Math.max(1, currentMemberTriumphalsPage + delta);
  viewMember(memberId);
}

export function changeMemberResourcesPage(delta, memberId) {
  currentMemberResourcesPage = Math.max(1, currentMemberResourcesPage + delta);
  viewMember(memberId);
}

const MEMBER_GOAL_DAYS = { daily: 1, weekly: 7, monthly: 30, yearly: 365 };
const MEMBER_PACE_MIN_ELAPSED = 0.25;

/**
 * "Am I going to be flagged?" — the member's own half of the pace question.
 *
 * The bar is progress toward the per-member goal for the selected timeframe;
 * the tick is where they would be if they were exactly on pace right now. The
 * gap between the two is the whole message, and it is a number of points, which
 * is a number of chests, which is a decision about tonight.
 *
 * Only for the period in PROGRESS. A finished week has no pace — it has a
 * result — and drawing a pro-rata tick on it would invite the reader to think
 * they still had time.
 */
function memberPaceHtml(points) {
  // Ranked points, not profile holdings — see the call site.
  if (points === null || points === undefined) return '';
  const goal = scaleGoalForPeriod(memberWeeklyGoalPoints, currentMemberPeriod);
  if (!goal) return '';
  if (currentMemberPeriod === 'all' || currentMemberOffset !== 0) return '';
  const days = MEMBER_GOAL_DAYS[currentMemberPeriod];
  if (!days) return '';
  const w = computeGameWindow(currentMemberPeriod, 0);
  if (!w) return '';

  const elapsed = Math.min(1, Math.max(0,
    (Date.now() - Date.parse(w.from)) / (days * 86_400_000)));
  const progress = Math.min(1, goal > 0 ? points / goal : 0);
  const statusClass = goalStatusClassFor(points, goal);
  const needed = Math.max(0, goal - points);

  const line = elapsed < MEMBER_PACE_MIN_ELAPSED
    ? `${needed.toLocaleString()} points to go`
    : (points >= goal
      ? 'Goal met for this period.'
      : (points / elapsed >= goal
        ? `On pace — ${needed.toLocaleString()} points to go.`
        : `Behind pace — ${needed.toLocaleString()} points to go, and at this rate you finish around ${Math.round(points / elapsed).toLocaleString()}.`));

  return `
    <div class="member-pace">
      <div class="member-pace-head">
        <span class="member-pace-line ${statusClass ? 'has-status' : ''}">${esc(line)}</span>
        <span class="member-pace-target">${points.toLocaleString()} / ${goal.toLocaleString()}</span>
      </div>
      <div class="member-pace-track">
        <span class="member-pace-fill ${statusClass}" style="width: ${(progress * 100).toFixed(1)}%"></span>
        <span class="member-pace-tick" style="left: ${(elapsed * 100).toFixed(1)}%"
          title="Where you would be if you were exactly on pace right now"></span>
      </div>
    </div>`;
}

// Sources under this share are OCR fragments and one-off oddities. Showing
// them manufactures drama in a list whose whole job is naming where the
// points came from.
const SOURCE_MIX_FLOOR = 0.02;

/**
 * Where this member's points actually came from.
 *
 * Answers "am I farming what I think I am". Someone who believes they run
 * crypts nightly, and finds two thirds of their points came from events, has
 * learned something no total ever tells them.
 */
function memberSourceMixHtml(mix) {
  if (!Array.isArray(mix) || mix.length === 0) return '';
  const total = mix.reduce((sum, r) => sum + r.points, 0);
  if (total <= 0) return '';

  const shown = mix.filter((r) => r.points / total >= SOURCE_MIX_FLOOR);
  const restPoints = total - shown.reduce((sum, r) => sum + r.points, 0);
  const restCount = mix.length - shown.length;

  const rows = shown.map((r) => {
    const pct = Math.round((r.points / total) * 100);
    return `<div class="type-row type-row--compact type-unknown">
      <span class="type-row-name"><span class="type-row-dot"></span>${esc(r.source)}</span>
      <div class="type-row-bar"><span style="width: ${Math.max(1, pct)}%"></span></div>
      <span class="type-row-value">${r.points.toLocaleString()}</span>
      <span class="type-row-pct">${pct}%</span>
    </div>`;
  }).join('');

  return `
    <div class="card">
      <div class="card-header">
        <h2>Where the points came from</h2>
        <span class="card-header-hint">${total.toLocaleString()} pts in this timeframe</span>
      </div>
      <div class="card-body card-body-padded">
        ${rows}
        ${restCount > 0 ? `<p class="muted-copy source-mix-rest">Plus ${restCount.toLocaleString()} smaller source${restCount === 1 ? '' : 's'} worth ${restPoints.toLocaleString()} pts between them.</p>` : ''}
      </div>
    </div>`;
}

/** Timeframe control for the member profile. */
/**
 * "340 points behind #8 Karnak · 1,120 ahead of #10 Vex".
 *
 * A rank on its own tells a member nothing they can act on. The gap is a
 * number of chests, which is a decision about tonight.
 *
 * Two cases where the obvious rendering lies. On any short window most of the
 * roster is on zero, so a member sitting there is not "ahead of #40 by 0" —
 * they are tied, and the tie is what matters. And last place has nobody below,
 * so that clause is dropped rather than printed against an absent neighbour.
 */
function memberRankGapHtml(neighbours) {
  if (!neighbours) return '';
  const parts = [];

  if (neighbours.tiedWith > 0 && neighbours.points === 0) {
    parts.push(`tied with ${neighbours.tiedWith.toLocaleString()} other${neighbours.tiedWith === 1 ? '' : 's'} on 0`);
  } else if (neighbours.tiedWith > 0) {
    parts.push(`tied with ${neighbours.tiedWith.toLocaleString()} other${neighbours.tiedWith === 1 ? '' : 's'}`);
  }
  if (neighbours.above) {
    parts.push(`${neighbours.above.gap.toLocaleString()} points behind #${neighbours.above.rank} ${esc(neighbours.above.name)}`);
  }
  // Only worth saying when there is daylight; "0 ahead" is a tie, already said.
  if (neighbours.below && neighbours.below.gap > 0) {
    parts.push(`${neighbours.below.gap.toLocaleString()} ahead of #${neighbours.below.rank} ${esc(neighbours.below.name)}`);
  }
  if (parts.length === 0) return '';
  return `<p class="muted-copy member-rank-gap">${parts.join(' · ')}</p>`;
}

// ─── Consistency ───
// Every ranking in this app is a sum, and a sum pays one lucky 6,000-point
// event drop exactly what it pays five weeks of turning up. These are the
// numbers that tell the two apart — for the member, against themselves.

// Below this many days of history, "your own baseline" is not a baseline and
// the comparison sentence is withheld rather than computed from noise.
const CONSISTENCY_MIN_DAYS = 28;
const CONSISTENCY_RECENT_DAYS = 7;

/** Dense day skeleton for a member's own 90-day series. */
function denseMemberSeries(rows, fromDay, toDay) {
  const byDay = new Map((rows || []).map((r) => [r.day, r]));
  const out = [];
  const cursor = new Date(`${fromDay}T00:00:00Z`);
  const last = new Date(`${toDay}T00:00:00Z`);
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(last.getTime())) return out;
  for (let guard = 0; cursor <= last && guard < 400; guard += 1) {
    const key = cursor.toISOString().slice(0, 10);
    const hit = byDay.get(key);
    out.push({ day: key, chests: hit?.chests || 0, points: hit?.points || 0 });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

/** Longest and current runs of consecutive active days, oldest-first input. */
function streaksOf(series) {
  let longest = 0;
  let run = 0;
  for (const d of series) {
    if (d.chests > 0) {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  // The current streak counts back from the end. The final day is "today so
  // far" and may legitimately be empty at 9am, so an empty last day does not
  // break a streak — only an empty day before it does.
  let current = 0;
  for (let i = series.length - 1; i >= 0; i -= 1) {
    if (series[i].chests > 0) current += 1;
    else if (i < series.length - 1) break;
  }
  return { longest, current };
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The member's own consistency: best day, streaks, and how the last week
 * compares to their own habit rather than to the clan.
 *
 * Deliberately measured against THEMSELVES. Telling somebody they are below the
 * clan average says mostly which clan they joined; telling them they are below
 * their own eight-week median is a fact about them, and it is the one that
 * moves before a member disappears.
 */
function memberConsistencyHtml(data) {
  const raw = data.dailySeries;
  if (!Array.isArray(raw) || !data.seriesFrom || !data.seriesTo) return '';
  const series = denseMemberSeries(raw, data.seriesFrom, data.seriesTo);
  if (series.length === 0) return '';

  const activeDays = series.filter((d) => d.chests > 0).length;
  if (activeDays === 0) return '';

  const { longest, current } = streaksOf(series);
  const best = series.reduce((a, d) => (d.points > a.points ? d : a), series[0]);

  // Trailing 7-day mean, for the line over the bars.
  const trailing = series.map((_, i) => {
    const from = Math.max(0, i - (CONSISTENCY_RECENT_DAYS - 1));
    const slice = series.slice(from, i + 1);
    return slice.reduce((sum, d) => sum + d.points, 0) / slice.length;
  });

  // "Your last 7 days vs your own median day" — over the eight weeks BEFORE
  // the recent window, so the thing being measured isn't inside its own
  // baseline.
  let verdict = '';
  const baseline = series.slice(0, Math.max(0, series.length - CONSISTENCY_RECENT_DAYS));
  if (baseline.length >= CONSISTENCY_MIN_DAYS) {
    const baseMedian = median(baseline.map((d) => d.points));
    const recentMean = series.slice(-CONSISTENCY_RECENT_DAYS)
      .reduce((sum, d) => sum + d.points, 0) / CONSISTENCY_RECENT_DAYS;
    if (baseMedian > 0) {
      const change = Math.round(((recentMean - baseMedian) / baseMedian) * 100);
      if (Math.abs(change) >= 15) {
        verdict = change > 0
          ? `<p class="consistency-verdict is-up">Your last ${CONSISTENCY_RECENT_DAYS} days are ${change}% above your own recent median day.</p>`
          : `<p class="consistency-verdict is-down">Your last ${CONSISTENCY_RECENT_DAYS} days are ${Math.abs(change)}% below your own recent median day.</p>`;
      } else {
        verdict = `<p class="consistency-verdict">Your last ${CONSISTENCY_RECENT_DAYS} days are in line with your own recent median day.</p>`;
      }
    }
  }

  const peak = Math.max(1, ...series.map((d) => d.points));
  const peakTrail = Math.max(1, ...trailing);
  const bars = series.map((d, i) => {
    const h = d.points > 0 ? Math.max(2, Math.round((d.points / peak) * 100)) : 0;
    const t = Math.round((trailing[i] / peakTrail) * 100);
    return `<span class="consistency-col" title="${d.day}: ${d.points.toLocaleString()} pts">
        <span class="consistency-bar" style="height: ${h}%"></span>
        <span class="consistency-mean" style="bottom: ${t}%"></span>
      </span>`;
  }).join('');

  return `
    <div class="card">
      <div class="card-header">
        <h2>Consistency</h2>
        <span class="card-header-hint">Last ${series.length} game days, whatever the timeframe above</span>
      </div>
      <div class="card-body card-body-padded">
        <div class="stats-grid consistency-stats">
          <div class="stat-card">
            <div class="label">Days active</div>
            <div class="value">${activeDays.toLocaleString()}<span class="stat-of"> of ${series.length}</span></div>
          </div>
          <div class="stat-card">
            <div class="label">Current streak</div>
            <div class="value">${current.toLocaleString()}</div>
            <div class="sub">longest ${longest.toLocaleString()}</div>
          </div>
          <div class="stat-card">
            <div class="label">Best day</div>
            <div class="value">${best.points.toLocaleString()}</div>
            <div class="sub">${esc(best.day)}</div>
          </div>
        </div>
        ${verdict}
        <div class="consistency-chart" role="img" aria-label="Points per day over the last ${series.length} game days">${bars}</div>
        <p class="muted-copy consistency-note">
          Bars are points per game day; the line is a ${CONSISTENCY_RECENT_DAYS}-day rolling average.
          An empty day means no chests were collected — it does not mean the scanner was down.
        </p>
      </div>
    </div>`;
}

function memberPeriodControlsHtml() {
  const buttons = MEMBER_PERIODS.map((p) =>
    `<button class="btn ${currentMemberPeriod === p ? 'active' : ''}" data-mperiod="${p}">${p.charAt(0).toUpperCase()}${p.slice(1)}</button>`,
  ).join('');
  return `
    <div class="member-period-controls">
      <div class="period-selector">${buttons}</div>
      ${renderPeriodNav({
        period: currentMemberPeriod,
        offset: currentMemberOffset,
        prevAttr: 'data-mperiod-nav="prev"',
        nextAttr: 'data-mperiod-nav="next"',
        navClass: 'member-nav',
      })}
    </div>`;
}

/**
 * Re-read the profile for the current timeframe.
 *
 * Keeps the address bar in step with replaceState rather than assigning the
 * hash: assigning it re-enters the router, which would re-run viewMember and
 * refetch everything a second time.
 */
async function reloadMemberDetail() {
  const id = currentMemberId;
  if (id === null) return;
  currentMemberChestsPage = 1;
  const next = memberHash(id, currentMemberPeriod,
    periodAnchorFromOffset(currentMemberPeriod, currentMemberOffset));
  if (window.location.hash !== next) window.history.replaceState(null, '', next);
  const data = await api(`/members/${id}${memberWindowQuery()}`);
  if (!data || data.error) return;
  await loadAndRenderMemberDetail(data);
}

function wireMemberPeriodControls() {
  document.querySelectorAll('[data-mperiod]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      currentMemberPeriod = btn.dataset.mperiod;
      currentMemberOffset = 0;
      await reloadMemberDetail();
    });
  });
  document.querySelectorAll('[data-mperiod-nav]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      currentMemberOffset += btn.dataset.mperiodNav === 'next' ? -1 : 1;
      if (currentMemberOffset < 0) currentMemberOffset = 0;
      await reloadMemberDetail();
    });
  });
}

function renderMemberDetail(data, chestPage, triumphalPage = { chests: [], total: 0 }, rawOcrChests = [], rawOcrTriumphals = [], resourceCardHtml = '', mightCardHtml = '', mightStatsHtml = '', resourcePage = { rows: [], total: 0 }) {
  const content = $('#content');
  const chests = chestPage.chests || [];
  const total = chestPage.total || 0;
  const totalPages = Math.max(1, Math.ceil(total / MEMBER_CHESTS_PAGE_SIZE));
  if (currentMemberChestsPage > totalPages) currentMemberChestsPage = totalPages;

  const triumphals = triumphalPage.chests || [];
  const triumphalTotal = triumphalPage.total || 0;
  const triumphalTotalPages = Math.max(1, Math.ceil(triumphalTotal / MEMBER_CHESTS_PAGE_SIZE));
  if (currentMemberTriumphalsPage > triumphalTotalPages) currentMemberTriumphalsPage = triumphalTotalPages;
  const hasTriumphals = triumphalTotal > 0;

  const resourceRows = resourcePage.rows || [];
  const resourceTotal = resourcePage.total || 0;
  const resourceTotalPages = Math.max(1, Math.ceil(resourceTotal / MEMBER_CHESTS_PAGE_SIZE));
  if (currentMemberResourcesPage > resourceTotalPages) currentMemberResourcesPage = resourceTotalPages;
  const hasResources = resourceTotal > 0;

  // Reset to the chests tab if the operator's saved tab choice no
  // longer applies (e.g. they were on Triumphals but the underlying
  // rows are now empty after a delete).
  if (currentMemberChestsTab === 'triumphals' && !hasTriumphals) currentMemberChestsTab = 'chests';
  if (currentMemberChestsTab === 'resources' && !hasResources) currentMemberChestsTab = 'chests';

  const paginationControls = total > MEMBER_CHESTS_PAGE_SIZE
    ? `<div class="pagination">
        <button class="btn btn-tight" data-action="member-chests-page-prev" data-member-id="${data.id}" ${currentMemberChestsPage <= 1 ? 'disabled' : ''}>← Prev</button>
        <span class="pagination-info">Page ${currentMemberChestsPage} of ${totalPages} · ${total} chests</span>
        <button class="btn btn-tight" data-action="member-chests-page-next" data-member-id="${data.id}" ${currentMemberChestsPage >= totalPages ? 'disabled' : ''}>Next →</button>
      </div>`
    : '';

  const triumphalPaginationControls = triumphalTotal > MEMBER_CHESTS_PAGE_SIZE
    ? `<div class="pagination">
        <button class="btn btn-tight" data-action="member-triumphals-page-prev" data-member-id="${data.id}" ${currentMemberTriumphalsPage <= 1 ? 'disabled' : ''}>← Prev</button>
        <span class="pagination-info">Page ${currentMemberTriumphalsPage} of ${triumphalTotalPages} · ${triumphalTotal} triumphal chests</span>
        <button class="btn btn-tight" data-action="member-triumphals-page-next" data-member-id="${data.id}" ${currentMemberTriumphalsPage >= triumphalTotalPages ? 'disabled' : ''}>Next →</button>
      </div>`
    : '';

  const resourcePaginationControls = resourceTotal > MEMBER_CHESTS_PAGE_SIZE
    ? `<div class="pagination">
        <button class="btn btn-tight" data-action="member-resources-page-prev" data-member-id="${data.id}" ${currentMemberResourcesPage <= 1 ? 'disabled' : ''}>← Prev</button>
        <span class="pagination-info">Page ${currentMemberResourcesPage} of ${resourceTotalPages} · ${resourceTotal} rows</span>
        <button class="btn btn-tight" data-action="member-resources-page-next" data-member-id="${data.id}" ${currentMemberResourcesPage >= resourceTotalPages ? 'disabled' : ''}>Next →</button>
      </div>`
    : '';

  // Rank badge — top 3 get gold/silver/bronze styling
  const rank = data.rank;
  const totalRanked = data.totalRanked;
  let rankBadge = '';
  if (rank !== null && rank !== undefined) {
    const isTop3 = rank <= 3;
    const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '';
    rankBadge = `<div class="member-rank-badge${isTop3 ? ' top-3 rank-' + rank : ''}">
      ${medal ? `<span class="member-rank-medal">${medal}</span>` : ''}
      <span class="member-rank-label">Rank${MEMBER_PERIOD_NOUN[currentMemberPeriod] ? ` · this ${MEMBER_PERIOD_NOUN[currentMemberPeriod]}` : ''}</span>
      <span class="member-rank-value">#${rank}${totalRanked ? ` / ${totalRanked}` : ''}</span>
    </div>`;
  }

  // Single-day record badges: only rendered if this member is in the
  // clan's top 3 for chest count or points on a single day.
  const singleDayBadges = data.singleDayBadges || {};
  const badgeMedals = ['🥇', '🥈', '🥉'];
  const recordBadgesHtml = [
    singleDayBadges.bestChestDay ? `<span class="record-badge" title="Personal record and one of the clan's top 3 best single days for chests">
      <span class="record-badge-medal">${badgeMedals[singleDayBadges.bestChestDay.rank - 1]}</span>
      #${singleDayBadges.bestChestDay.rank} best chest day — <strong>${singleDayBadges.bestChestDay.value.toLocaleString()}</strong> chests on ${esc(singleDayBadges.bestChestDay.date || '')}
    </span>` : '',
    singleDayBadges.bestPointDay ? `<span class="record-badge" title="Personal record and one of the clan's top 3 best single days for points">
      <span class="record-badge-medal">${badgeMedals[singleDayBadges.bestPointDay.rank - 1]}</span>
      #${singleDayBadges.bestPointDay.rank} best point day — <strong>${singleDayBadges.bestPointDay.value.toLocaleString()}</strong> pts on ${esc(singleDayBadges.bestPointDay.date || '')}
    </span>` : '',
  ].filter(Boolean).join('');

  // Build chest type breakdown card
  const totalChests = data.stats?.totalChests ?? 0;
  const totalPoints = data.stats?.totalPoints ?? 0;
  const chestsByType = data.stats?.chestsByType || {};

  // First Seen and Last Seen were two cards. They're the same kind of fact
  // about one span of time, and splitting them cost a sixth of the strip —
  // enough that a clan with might tracking pushed the last card onto a row of
  // its own (the container is 1200px, so the grid fits six 160px tracks and no
  // more). Merged: the headline is the recency that actually gets read, and
  // the sub line carries the relative time plus when the player showed up.
  const seenSub = [
    data.lastSeen ? formatRelativeTime(data.lastSeen) : '—',
    data.firstSeen ? `first ${formatDateShort(data.firstSeen)}` : '',
  ].filter(Boolean).join(' · ');
  const seenTitle = [
    data.lastSeen ? `Last seen ${formatDate(data.lastSeen)}` : 'Never seen',
    data.firstSeen ? `first seen ${formatDate(data.firstSeen)}` : '',
  ].filter(Boolean).join(' · ');

  // Weekly progress
  const progress = data.progress || { thisWeek: { chests: 0, points: 0 }, lastWeek: { chests: 0, points: 0 }, chestsDelta: 0, pointsDelta: 0 };
  const formatDelta = (delta) => {
    if (delta === 0) return { text: '±0', cls: 'progress-flat' };
    if (delta > 0) return { text: `+${delta.toLocaleString()}`, cls: 'progress-up' };
    return { text: delta.toLocaleString(), cls: 'progress-down' };
  };
  const chestsDelta = formatDelta(progress.chestsDelta);
  const pointsDelta = formatDelta(progress.pointsDelta);
  const chestsArrow = progress.chestsDelta > 0 ? '▲' : progress.chestsDelta < 0 ? '▼' : '—';
  const pointsArrow = progress.pointsDelta > 0 ? '▲' : progress.pointsDelta < 0 ? '▼' : '—';

  // Order types by rarity (commonest to rarest, putting unknown last)
  const typeOrder = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'arena', 'event', 'unknown'];
  const typeBreakdown = typeOrder
    .map((type) => ({ type, count: chestsByType[type] || 0 }))
    .filter((entry) => entry.count > 0);

  const breakdownHtml = typeBreakdown.length > 0
    ? typeBreakdown.map((entry) => {
        const pct = totalChests > 0 ? Math.round((entry.count / totalChests) * 100) : 0;
        return `<div class="type-row type-row--compact type-${entry.type}">
          <span class="type-row-name"><span class="type-row-dot"></span>${entry.type}</span>
          <div class="type-row-bar"><span style="width: ${pct}%"></span></div>
          <span class="type-row-value">${entry.count}</span>
          <span class="type-row-pct">${pct}%</span>
        </div>`;
      }).join('')
    : '<div class="empty-state"><p>No chests yet.</p></div>';

  content.innerHTML = `
    <div class="card">
      <div class="card-header member-detail-header">
        <div class="member-detail-title">
          <h2>${esc(data.name)}</h2>
          ${rankBadge}
        </div>
        <button class="btn" data-action="member-back">← Back</button>
      </div>
      <div class="card-body card-body-padded">
        ${memberPeriodControlsHtml()}
        ${recordBadgesHtml ? `<div class="mb-12">${recordBadgesHtml}</div>` : ''}
        ${memberRankGapHtml(data.neighbours)}
        ${memberPaceHtml(data.neighbours ? data.neighbours.points : null)}
        <div class="stats-grid">
          <div class="stat-card">
            <div class="label">${currentMemberPeriod === 'all' ? 'Total Chests' : 'Chests'}</div>
            <div class="value">${totalChests.toLocaleString()}</div>
          </div>
          <div class="stat-card">
            <div class="label">${currentMemberPeriod === 'all' ? 'Total Points' : 'Points'}</div>
            <div class="value">${totalPoints.toLocaleString()}</div>
          </div>
          <div class="stat-card">
            <div class="label">Seen</div>
            <div class="value member-detail-date" title="${esc(seenTitle)}">${formatDateShort(data.lastSeen)}</div>
            <div class="sub stat-sub-tight" title="${esc(seenTitle)}">${esc(seenSub)}</div>
          </div>
          ${/* Might + Hero Level from the daily member-list capture. Absent
                entirely when might tracking has never run for this clan. */''}
          ${mightStatsHtml}
        </div>
      </div>
    </div>

    ${mightCardHtml}

    ${resourceCardHtml}

    ${memberConsistencyHtml(data)}

    ${memberSourceMixHtml(data.sourceMix)}

    <div class="two-col-grid">
      <div class="card">
        <div class="card-header">
          <h2>Weekly Progress</h2>
          <span class="card-header-hint">This game week vs last, whatever the timeframe above</span>
        </div>
        <div class="card-body card-body-padded">
          <div class="progress-grid">
            <div class="progress-card">
              <div class="progress-label">Chests this week</div>
              <div class="progress-value">${progress.thisWeek.chests.toLocaleString()}</div>
              <div class="progress-delta ${chestsDelta.cls}">
                <span class="progress-arrow">${chestsArrow}</span>
                ${chestsDelta.text}
                <span class="progress-vs">vs ${progress.lastWeek.chests.toLocaleString()}</span>
              </div>
            </div>
            <div class="progress-card">
              <div class="progress-label">Points this week</div>
              <div class="progress-value">${progress.thisWeek.points.toLocaleString()}</div>
              <div class="progress-delta ${pointsDelta.cls}">
                <span class="progress-arrow">${pointsArrow}</span>
                ${pointsDelta.text}
                <span class="progress-vs">vs ${progress.lastWeek.points.toLocaleString()}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-header"><h2>Chest Type Breakdown</h2></div>
        <div class="card-body card-body-padded">
          <div class="type-breakdown-list">
            ${breakdownHtml}
          </div>
        </div>
      </div>
    </div>

    ${(() => {
      // All three tab tables are width-locked (table-layout: fixed +
      // colgroup, per the leaderboard/members pattern): paging swaps the
      // whole tbody, so without it every page recomputed its columns from
      // its own longest cell and Prev/Next made the table jump.
      const chestsRows = chests.length > 0
        ? `<table class="table-responsive member-chests-table">
            <colgroup>
              <col class="col-chest">
              <col class="col-type">
              <col class="col-source">
              <col class="col-points">
              <col class="col-date">
            </colgroup>
            <thead><tr><th>Chest</th><th>Type</th><th>Source</th><th class="num">Points</th><th>Received</th></tr></thead><tbody>
            ${chests.map((c) => `<tr>
              <td data-label="Chest" data-role="primary"><span class="mrow-name"><a class="member-link" href="${chestHash(c.chestName, 'all')}">${esc(c.chestName)}</a></span><span class="mrow-sub">${formatDate(c.effectiveAt)}</span></td>
              <td data-label="Type"><span class="chest-type ${c.chestType}">${c.chestType}</span></td>
              <td data-label="Source">${esc(c.chestSource)}</td>
              <td data-label="Points" class="num" data-role="metric">${c.pointValue}</td>
              <td data-label="Received" data-role="hidden">${formatDate(c.effectiveAt)}</td>
            </tr>`).join('')}
          </tbody></table>${paginationControls}`
        : '<div class="empty-state"><p>No chests.</p></div>';

      const triumphalRows = triumphals.length > 0
        ? `<table class="table-responsive member-triumphals-table">
            <colgroup>
              <col class="col-chest">
              <col class="col-source">
              <col class="col-date">
            </colgroup>
            <thead><tr><th>Chest</th><th>Source</th><th>Received</th></tr></thead><tbody>
            ${triumphals.map((c) => `<tr>
              <td data-label="Chest" data-role="primary"><span class="mrow-name">${esc(c.chestName)}</span><span class="mrow-sub">${esc(c.chestSource)}</span></td>
              <td data-label="Source" data-role="hidden">${esc(c.chestSource)}</td>
              <td data-label="Received" data-role="metric">${formatDate(c.effectiveAt)}</td>
            </tr>`).join('')}
          </tbody></table>${triumphalPaginationControls}`
        : '<div class="empty-state"><p>No triumphal chests.</p></div>';

      // Resource ledger — this member's rows from the Clan Capital history,
      // same columns as the Resources Admin table minus Member (implied) and
      // the Edit action (editing stays on the Resources page, which is
      // admin-gated; this view is read-only for everyone).
      const resourceTableRows = resourceRows.length > 0
        ? `<table class="table-responsive member-resources-table">
            <colgroup>
              <col class="col-resource">
              <col class="col-direction">
              <col class="col-amount">
              <col class="col-date">
            </colgroup>
            <thead><tr><th>Resource</th><th>Direction</th><th class="num">Amount</th><th>Date</th></tr></thead><tbody>
            ${resourceRows.map((tx) => `<tr>
              <td data-label="Resource" data-role="primary"><span class="mrow-name">${resourceIconHtml(tx.resourceTypeSlug, tx.resourceTypeName ?? 'Unknown')}</span><span class="mrow-sub">${esc(formatGameDayShort(tx.transactionDate))}</span></td>
              <td data-label="Direction">${directionPillHtml(tx.direction)}</td>
              <td data-label="Amount" class="num" data-role="metric">${esc(formatResourceAmount(tx.resourceTypeSlug, tx.amount))}</td>
              <td data-label="Date" data-role="hidden">${esc(formatGameDayShort(tx.transactionDate))}</td>
            </tr>`).join('')}
          </tbody></table>${resourcePaginationControls}`
        : '<div class="empty-state"><p>No resources.</p></div>';

      // When the member has neither triumphal nor resource rows, fall back to
      // the unadorned "Chest History" card so the page doesn't show a
      // pointless single-tab switcher. Once either exists we switch to the
      // same tabbed layout used by the session-detail page, with the
      // operator's active tab preserved across pagination rerenders via
      // currentMemberChestsTab.
      if (!hasTriumphals && !hasResources) {
        return `<div class="card">
          <div class="card-header"><h2>Chest History</h2></div>
          <div class="card-body">${chestsRows}</div>
        </div>`;
      }

      const tabs = [
        { key: 'chests', label: `Chests (${total})`, body: chestsRows },
        ...(hasTriumphals ? [{ key: 'triumphals', label: `Triumphal Chests (${triumphalTotal})`, body: triumphalRows }] : []),
        ...(hasResources ? [{ key: 'resources', label: `Resources (${resourceTotal})`, body: resourceTableRows }] : []),
      ];
      return `<div class="card" id="memberChestsCard">
        <div class="card-header leaderboard-header">
          <div class="period-selector" id="memberChestsTabs">
            ${tabs.map((t) => `<button class="btn ${currentMemberChestsTab === t.key ? 'active' : ''}" data-member-tab="${t.key}">${t.label}</button>`).join('')}
          </div>
        </div>
        <div class="card-body">
          ${tabs.map((t) => `<div data-member-panel="${t.key}" class="${currentMemberChestsTab === t.key ? '' : 'is-hidden'}">${t.body}</div>`).join('')}
        </div>
      </div>`;
    })()}
    </div>
    ${(() => {
      // Only the two chest tabs have raw player OCR behind them — the
      // resource ledger is imported by a different pipeline, whose
      // unresolved rows are inspected via crops on the Resources page.
      if (currentMemberChestsTab === 'resources') return '';
      const isChests = currentMemberChestsTab === 'chests';
      const activeOcr = isChests ? rawOcrChests : rawOcrTriumphals;
      if (activeOcr.length === 0) return '';
      const sourceLabel = isChests ? 'gift chests' : 'triumphal chests';
      // data-section-key keeps the collapsible's open state stable
      // across renders even though the count + source label change
      // when the operator flips tabs (see feedback_collapsible_section_key).
      return `<details class="card card-collapsible" data-section-key="member-raw-ocr">
        <summary class="card-header"><h2>Captured Raw OCR — ${sourceLabel} (${activeOcr.length})</h2></summary>
        <div class="card-body">
          <p class="muted-copy mb-12">The literal OCR strings the scanner read on the ${sourceLabel} that ended up attached to this member. Useful when a member is unexpectedly accumulating chests — if you see something nothing like the player's name, the matcher misfired. Capture is gated by the "Raw OCR Capture" toggle on the System page.</p>
          <table class="table-responsive member-ocr-table">
            <colgroup>
              <col class="col-ocr">
              <col class="col-session">
              <col class="col-date">
            </colgroup>
            <thead><tr><th>Raw OCR</th><th>Session</th><th>Captured</th></tr></thead><tbody>
            ${activeOcr.map((r) => `<tr>
              <td data-label="Raw OCR" data-role="primary"><span class="mrow-name"><code>${esc(r.rawPlayerOcr)}</code></span></td>
              <td data-label="Session">#${r.sessionId}</td>
              <td data-label="Captured" data-role="metric">${formatDate(new Date(r.capturedAt).toISOString())}</td>
            </tr>`).join('')}
          </tbody></table>
        </div>
      </details>`;
    })()}`;

  // Wire up the tab switcher — mirrors the pattern in sessions.js.
  // Flipping tabs is purely client-side toggling: both datasets are
  // already in the DOM, so no round-trip required. We also flip the
  // captured-OCR section by re-rendering it from currentMemberChestsTab,
  // but since the data is in module scope we just re-call render.
  if (hasTriumphals || hasResources) {
    const tabBar = content.querySelector('#memberChestsTabs');
    tabBar?.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-member-tab]');
      if (!btn) return;
      const next = btn.dataset.memberTab;
      if (next === currentMemberChestsTab) return;
      currentMemberChestsTab = next;
      // Re-render to refresh the Captured Raw OCR card with the new
      // source's rows. The tab panels could be toggled in-place but
      // the OCR card needs a full re-render to swap its content.
      renderMemberDetail(
        data, chestPage, triumphalPage, rawOcrChests, rawOcrTriumphals,
        resourceCardHtml, mightCardHtml, mightStatsHtml, resourcePage,
      );
    });
  }

  wireMemberPeriodControls();

  // Chart.js needs a live canvas, so this runs after the HTML is mounted — on
  // the first render and again after every tab flip's re-render.
  currentMemberMightDraw();
}
