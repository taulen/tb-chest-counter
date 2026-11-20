// Home (redesign phase 3): the page after sign-in, shaped by who is looking.
//
//   - A member sees their own week first (points against the goal, pace, rank,
//     chests against the period before), then a small clan snapshot, the top
//     collectors, events, the latest chests and the clan's records.
//   - A leader (clan admin) sees design C's command center: clan points against
//     the clan's target with a pace line, the goal bands, top collectors and
//     movers, points by source, roster changes (plain facts), events, scan
//     health, then the same latest chests and records.
//   - The superadmin sees the leader view with every clan on top.
//
// One period scrubber (Day / Week / Month / All, the Members board's) drives
// every tile. A window is judged against the goal it was played under
// (weeklyGoalForWindow), never today's. Words: members COLLECT chests, which
// come FROM a source; notices are information, never calls to action.

import { api } from '../lib/api.js';
import { esc, memberHash, formatDate, formatDateShort, formatRelativeTime, chestHash, sourceLink } from '../lib/ui.js';
import { t, tn, tGame } from '../lib/i18n.js';
import { computeGameWindow } from '../lib/period.js';
import { scaleGoalForPeriod } from '../lib/leaderboard-render.js';
import {
  periodScrubberHtml, wirePeriodScrubber, tileHtml, tileLinkHtml, deltaHtml, bandHtml, barHtml as kitBarHtml, asList,
} from '../lib/ui-kit.js';
import { weeklyGoalForWindow } from '../lib/weekly-goal.js';
import { getCurrentUser, getGameDayRolloverUtcHour, getWeekStart } from '../lib/state.js';
import { gameRankName } from '../lib/game-facts.js';
import { avatarHtml } from '../lib/avatar.js';
import { loadGameArt, chestLabelHtml } from '../lib/game-art.js';
import { presetMembersBoard } from './members-board.js';
import { relativeUntil, timeLeftUntil } from './events.js';
import { openAddClanDialog } from '../lib/add-clan.js';

const DAY_MS = 86_400_000;
const PERIODS = ['daily', 'weekly', 'monthly', 'all'];
const DELTA_LABEL = {
  daily: { now: () => t('vs yesterday by now'), past: () => t('vs the day before') },
  weekly: { now: () => t('vs last week by now'), past: () => t('vs the week before') },
  monthly: { now: () => t('vs last month by now'), past: () => t('vs the month before') },
};
const NOTE_DAYS = 7;
const GIFT_HOURS = 21;

const state = { period: 'weekly', offset: 0 };

function leaderboardQuery(from, to) {
  const p = new URLSearchParams({ includeAll: '1' });
  if (from) p.set('from', from);
  if (to) p.set('to', to);
  return `/leaderboard?${p}`;
}

function analyticsQuery(win, limit = 5) {
  const p = new URLSearchParams({ limit: String(limit) });
  if (win) {
    p.set('from', win.from);
    p.set('to', win.to);
    p.set('compare', '1');
  }
  return `/analytics/window?${p}`;
}

const num = (n) => Number(n || 0).toLocaleString();

/** Home's bars: the kit's, stretched to the tile (.home-bar). */
function barHtml(points, goal, pace, band, max) {
  return kitBarHtml({ points, goal, pace, band, max, cls: 'home-bar' });
}

const tile = tileHtml;
const tileLink = tileLinkHtml;

/** Draw Home into `el`. */
export async function renderHome(el) {
  // /stats first: it caches the clan's rollover hour the windows below need.
  const stats = await api('/stats');
  const user = getCurrentUser() || {};
  const role = user.role || 'user';
  const isAdmin = role === 'admin' || role === 'superadmin';
  const isSuper = role === 'superadmin';
  const rolloverHr = getGameDayRolloverUtcHour();
  const weekStart = getWeekStart();
  const { period, offset } = state;
  const win = computeGameWindow(period, offset, rolloverHr, weekStart);
  const now = Date.now();
  const running = !!win && offset === 0;
  let prevQuery = null;
  if (win) {
    const prev = computeGameWindow(period, offset + 1, rolloverHr, weekStart);
    const elapsed = now - Date.parse(win.from);
    const prevTo = running ? new Date(Math.min(Date.parse(prev.from) + elapsed, Date.parse(prev.to))).toISOString() : prev.to;
    prevQuery = leaderboardQuery(prev.from, prevTo);
  }
  // Scan health is about now: this game week's coverage, whatever period is shown.
  const thisWeek = computeGameWindow('weekly', 0, rolloverHr, weekStart);
  const analyticsIsThisWeek = period === 'weekly' && offset === 0;

  const [entries, prevEntries, goal, roster, analytics, events, recent, records,
    changes, ranks, weekCover, clans, overview, status] = await Promise.all([
    api(leaderboardQuery(win?.from, win?.to)),
    prevQuery ? api(prevQuery).catch(() => []) : Promise.resolve([]),
    api('/leaderboard/goal').catch(() => null),
    api('/game/roster').catch(() => ({ members: {} })),
    api(analyticsQuery(win)).catch(() => null),
    api('/events').catch(() => ({ events: [] })),
    api('/chests?limit=8').catch(() => []),
    api('/analytics/single-day-records').catch(() => null),
    isAdmin ? api('/game/clan/roster-changes?limit=40').catch(() => ({ entries: [] })) : Promise.resolve(null),
    isAdmin ? api('/game/clan/rank-changes?days=7').catch(() => ({ entries: [] })) : Promise.resolve(null),
    isAdmin && !analyticsIsThisWeek && thisWeek
      ? api(analyticsQuery(thisWeek, 1)).then((r) => r?.coverage ?? null).catch(() => null)
      : Promise.resolve(null),
    isSuper ? api('/clans/switcher').catch(() => null) : Promise.resolve(null),
    isSuper ? api('/clans/overview').catch(() => null) : Promise.resolve(null),
    isSuper ? api('/status').catch(() => null) : Promise.resolve(null),
    // The chests' pictures (never rejects).
    loadGameArt(),
  ]);
  // A later click (another period) already started its own draw.
  if (state.period !== period || state.offset !== offset) return;

  const weekly = period === 'all' ? null : weeklyGoalForWindow(goal, period, offset, rolloverHr, weekStart);
  const goalPts = period === 'all' ? null : scaleGoalForPeriod(weekly, period, weekStart);
  const fraction = running ? Math.min(1, Math.max(0, (now - Date.parse(win.from)) / (Date.parse(win.to) - Date.parse(win.from)))) : 1;
  const pacePts = goalPts && running ? Math.round(goalPts * fraction) : null;

  const prevByMember = new Map(asList(prevEntries).map((e) => [e.memberId, e.totalPoints || 0]));
  const prevChestsByMember = new Map(asList(prevEntries).map((e) => [e.memberId, e.totalChests || 0]));
  const game = roster?.members || {};
  const rows = asList(entries).map((e) => {
    const g = game[e.memberId] || {};
    const points = e.totalPoints || 0;
    return {
      id: e.memberId,
      name: e.memberName,
      rank: e.rank,
      points,
      chests: e.totalChests || 0,
      prevChests: win ? prevChestsByMember.get(e.memberId) || 0 : null,
      delta: win ? points - (prevByMember.get(e.memberId) || 0) : null,
      band: !goalPts ? null : points >= goalPts ? 'ok' : pacePts !== null && points >= pacePts ? 'pace' : 'behind',
      role: g.role ?? null,
      isYou: g.isYou === true,
      avatar: g.avatar ?? null,
      burning: g.burning === true,
      mapSeenAt: g.mapSeenAt ?? null,
    };
  });

  const ctx = {
    stats, role, isAdmin, isSuper, period, offset, win, running, rolloverHr, weekStart, fraction,
    goalPts, pacePts, rows, prevEntries: asList(prevEntries), analytics,
    events: asList(events?.events), recent: asList(recent), records,
    changes: asList(changes?.entries), ranks: asList(ranks?.entries),
    coverage: analyticsIsThisWeek ? analytics?.coverage ?? null : weekCover,
    clans: asList(clans?.clans), overview: asList(overview?.clans), status,
    you: rows.find((r) => r.isYou) || null,
  };

  const tiles = isAdmin ? leaderTiles(ctx) : memberTiles(ctx);
  el.innerHTML = `<div class="home">
      ${periodScrubberHtml({ periods: PERIODS, period: ctx.period, offset: ctx.offset, rolloverHr: ctx.rolloverHr, weekStart: ctx.weekStart, win: ctx.win })}
      <div class="ui-grid">${tiles.join('')}</div>
    </div>`;
  wire(el, ctx);
}

// ─── Layouts per role ───

function memberTiles(ctx) {
  return [
    ctx.you ? youTile(ctx, 8) : unlinkedTile(ctx),
    clanSnapshotTile(ctx),
    topTile(ctx, 4),
    eventsTile(ctx, 4),
    recentTile(ctx, 4),
    recordsTile(ctx, 12),
  ];
}

function leaderTiles(ctx) {
  return [
    ctx.isSuper ? clansTile(ctx) : '',
    clanPointsTile(ctx),
    goalStatusTile(ctx),
    topTile(ctx, 4),
    moversTile(ctx),
    sourcesTile(ctx),
    rosterTile(ctx),
    eventsTile(ctx, 6),
    scanHealthTile(ctx),
    ctx.you ? youTile(ctx, 6) : '',
    recentTile(ctx, 6),
    recordsTile(ctx, 12),
  ].filter(Boolean);
}

// ─── Tiles ───

/** The signed-in member's own period: points against the goal, pace, rank, chests. */
function youTile(ctx, span) {
  const r = ctx.you;
  const total = ctx.rows.length;
  const deltaLabel = ctx.win ? DELTA_LABEL[ctx.period][ctx.running ? 'now' : 'past']() : '';
  const chestDelta = r.prevChests === null ? null : r.chests - r.prevChests;
  const goalLine = ctx.goalPts
    ? `<p class="ui-sub">${t('Goal {n}', { n: num(ctx.goalPts) })}${ctx.pacePts ? ` · ${t('pace now {n}', { n: num(ctx.pacePts) })}` : ''} · ${bandHtml(r.band)}</p>`
    : `<p class="ui-sub">${ctx.period === 'all' ? esc(t('All time: ranked by points, no goal applies.')) : esc(t('No points goal is set for this clan, so the board ranks by points only.'))}</p>`;
  const body = `
    <div class="home-you">
      ${avatarHtml({ avatar: r.avatar, username: r.name }, { size: 'lg' })}
      <div class="home-you-who">
        <a class="home-you-name" href="${memberHash(r.id)}">${esc(r.name)}</a>
        <span class="ui-sub">${r.role ? esc(gameRankName(r.role)) : ''}</span>
      </div>
    </div>
    <div class="ui-big-row">
      <div><div class="ui-big">${num(r.points)}${ctx.goalPts ? `<span class="ui-big-of"> / ${num(ctx.goalPts)}</span>` : ''}</div>
        <div class="ui-stat-label">${t('Points')}</div></div>
      <div><div class="ui-big">#${num(r.rank)}</div><div class="ui-stat-label">${t('of {n} in the clan', { n: num(total) })}</div></div>
      <div><div class="ui-big">${num(r.chests)}</div><div class="ui-stat-label">${t('Chests collected')}</div>
        ${chestDelta !== null ? `<div>${deltaHtml(chestDelta, deltaLabel)}</div>` : ''}</div>
    </div>
    ${ctx.goalPts ? barHtml(r.points, ctx.goalPts, ctx.pacePts, r.band, ctx.goalPts * 1.25) : ''}
    ${goalLine}`;
  return tile('you', t('Your week'), body, { span, link: tileLink(memberHash(r.id), t('Your profile')), cls: 'is-you' });
}

/** An old account not yet linked to its player: how linking works. Information, not a nag. */
function unlinkedTile() {
  // Plain information, not a nag: what's missing and how to fix it. The
  // button opens the in-app code dialog (lib/add-clan.js), never /join.
  const body = `<p class="ui-copy">${t('Your account is not linked to your player in this clan yet, so this page cannot show your own week. Send the word code to the clan’s tracker account in the game chat, then enter the code here.')}</p>`;
  const link = `<button type="button" class="ui-tile-link" data-home-add-clan>${esc(t('Add a clan with a code'))} <span aria-hidden="true">→</span></button>`;
  return tile('you', t('Your week'), body, { span: 8, link });
}

/**
 * The clan's points for the window, and for the period before (cut at the same
 * point while this one runs; null for all time): every chest the clan
 * collected, from the analytics rollup — chests of members who have since left
 * and end-of-event clan rewards included, the same figure as the Analytics
 * page's Points. The board rows are today's roster only (includeAll keeps
 * is_active = 1), so adding them up dropped whatever departed members
 * collected. Falls back to those rows only if the analytics read failed.
 */
function clanPoints(ctx) {
  const cur = ctx.analytics?.current?.totals;
  if (!cur) {
    return {
      points: ctx.rows.reduce((s, r) => s + r.points, 0),
      prev: ctx.win ? ctx.prevEntries.reduce((s, e) => s + (e.totalPoints || 0), 0) : null,
    };
  }
  const basis = ctx.analytics.previousToDate?.totals ?? ctx.analytics.previous?.totals ?? null;
  return { points: cur.points || 0, prev: ctx.win && basis ? basis.points || 0 : null };
}

/** The clan total against its target (goal × today's members) and the bands, for members. */
function clanSnapshotTile(ctx) {
  const total = clanPoints(ctx).points;
  const target = ctx.goalPts ? ctx.goalPts * ctx.rows.length : null;
  const counts = bandCounts(ctx.rows);
  const body = `
    <div class="ui-big">${num(total)}${target ? `<span class="ui-big-of"> / ${num(target)}</span>` : ''}</div>
    <div class="ui-stat-label">${t('Clan points')}</div>
    ${target ? barHtml(total, target, ctx.pacePts ? ctx.pacePts * ctx.rows.length : null, null, target * 1.25) : ''}
    ${ctx.goalPts ? `<ul class="home-bands">${['ok', 'pace', 'behind'].map((b) => `<li>${bandHtml(b)} <span class="ui-band-n">${num(counts[b].length)}</span></li>`).join('')}</ul>` : ''}`;
  return tile('clan', t('The clan'), body, { span: 4, link: tileLink('#members', t('Members')) });
}

/**
 * Clan points against the clan target, with a cumulative chart: this period, the one before, target pace.
 * The points are every chest collected (clanPoints); the target is the goal for each of today's members.
 */
function clanPointsTile(ctx) {
  const { points: total, prev: prevTotal } = clanPoints(ctx);
  const target = ctx.goalPts ? ctx.goalPts * ctx.rows.length : null;
  const paceNow = ctx.pacePts ? ctx.pacePts * ctx.rows.length : null;
  const deltaLabel = ctx.win ? DELTA_LABEL[ctx.period][ctx.running ? 'now' : 'past']() : '';
  const chests = ctx.analytics?.current?.totals?.chests;
  const facts = [];
  if (target) facts.push(`<dt>${t('Target')}</dt><dd>${num(target)}</dd>`);
  if (paceNow) facts.push(`<dt>${t('Target pace now')}</dt><dd>${num(paceNow)}</dd>`);
  if (paceNow) {
    const ahead = total - paceNow;
    facts.push(`<dt>${t('Clan vs pace')}</dt><dd>${ahead >= 0
      ? `<span class="ui-band band-ok"><span aria-hidden="true">✓</span> ${t('{n} ahead', { n: num(ahead) })}</span>`
      : `<span class="ui-band band-behind"><span aria-hidden="true">↓</span> ${t('{n} behind', { n: num(-ahead) })}</span>`}</dd>`);
  }
  if (Number.isFinite(chests)) facts.push(`<dt>${t('Chests collected')}</dt><dd>${num(chests)}</dd>`);
  if (ctx.period === 'all') facts.push(`<dt>${t('Members')}</dt><dd>${num(ctx.rows.length)}</dd>`);
  const body = `
    <div class="home-points-head">
      <div>
        <div class="ui-big is-xl">${num(total)}</div>
        ${prevTotal !== null ? `<div>${deltaHtml(total - prevTotal, deltaLabel)}</div>` : ''}
      </div>
      ${facts.length ? `<dl class="home-facts">${facts.join('')}</dl>` : ''}
    </div>
    ${chartHtml(ctx, target)}`;
  return tile('points', t('Clan points'), body, { span: 8, link: tileLink('#analytics', t('Analytics')) });
}

/**
 * Cumulative points by game day: this period (gold), the one before (grey), target pace (dotted).
 *
 * The x axis is time through the window, the same axis the target-pace line is
 * drawn on (0 at the window's start, 1 at its end). Every line starts at 0 at
 * the start, a finished day's running total sits at that day's END, and today's
 * partial total sits at now — so where the gold line stops, the dotted line is
 * at "Target pace now". Plotting day i's total at i/(days-1) instead put the
 * first day's whole total at the window's start and drew every line a day
 * ahead of the pace line.
 */
function chartHtml(ctx, target) {
  const cur = ctx.analytics?.current;
  const prev = ctx.analytics?.previous;
  if (!ctx.win || ctx.period === 'daily' || !cur?.fromDay || !cur?.toDay) return '';
  const days = dayList(cur.fromDay, cur.toDay);
  if (days.length < 2) return '';
  const n = days.length;
  // `points`, not `earnedPoints`: the clan's line is every chest collected, so it ends on the headline.
  const byDay = new Map((cur.days || []).map((d) => [d.day, d.points ?? 0]));
  const today = ctx.running ? new Date(Date.now() - ctx.rolloverHr * 3_600_000).toISOString().slice(0, 10) : null;
  let acc = 0;
  const thisSeries = [[0, 0]];
  for (const [i, d] of days.entries()) {
    if (today && d > today) break;
    acc += byDay.get(d) || 0;
    thisSeries.push([d === today ? ctx.fraction : (i + 1) / n, acc]);
  }
  const prevDays = prev?.fromDay && prev?.toDay ? dayList(prev.fromDay, prev.toDay) : [];
  const prevByDay = new Map((prev?.days || []).map((d) => [d.day, d.points ?? 0]));
  let pacc = 0;
  const prevSeries = [[0, 0], ...prevDays.slice(0, n).map((d, i) => [(i + 1) / n, (pacc += prevByDay.get(d) || 0)])];
  // A period before with nothing in it (the clan wasn't tracked yet) is no line to compare with.
  const showPrev = pacc > 0;
  const top = Math.max(target || 0, ...thisSeries.map((p) => p[1]), ...(showPrev ? prevSeries.map((p) => p[1]) : []), 1);
  const W = 600;
  const H = 150;
  const x = (f) => f * W;
  const y = (v) => H - (v / top) * (H - 6) - 3;
  const line = (s) => s.map(([f, v], i) => `${i ? 'L' : 'M'}${x(f).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const last = thisSeries[thisSeries.length - 1];
  const area = thisSeries.length > 1 ? `${line(thisSeries)} L${x(last[0]).toFixed(1)},${H} L0,${H} Z` : '';
  const aria = t('Clan points by game day: {n} so far this period', { n: num(last[1]) });
  return `<figure class="home-chart">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(aria)}">
        ${area ? `<path class="home-chart-area" d="${area}"></path>` : ''}
        ${target ? `<path class="home-chart-target" d="M0,${y(0).toFixed(1)} L${W},${y(target).toFixed(1)}"></path>` : ''}
        ${showPrev ? `<path class="home-chart-prev" d="${line(prevSeries)}"></path>` : ''}
        ${thisSeries.length > 1 ? `<path class="home-chart-this" d="${line(thisSeries)}"></path>` : ''}
      </svg>
      <figcaption class="home-chart-key">
        <span><span class="home-key is-this" aria-hidden="true"></span>${t('This period')}</span>
        ${showPrev ? `<span><span class="home-key is-prev" aria-hidden="true"></span>${t('The period before')}</span>` : ''}
        ${target ? `<span><span class="home-key is-target" aria-hidden="true"></span>${t('Target pace')}</span>` : ''}
      </figcaption>
    </figure>`;
}

function dayList(from, to) {
  const out = [];
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end && out.length < 400) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function bandCounts(rows) {
  const out = { ok: [], pace: [], behind: [] };
  for (const r of rows) if (r.band) out[r.band].push(r);
  return out;
}

/** The goal bands with the first names in each; each band opens the Members board filtered to it. */
function goalStatusTile(ctx) {
  if (!ctx.goalPts) {
    const body = `<p class="ui-copy">${ctx.period === 'all' ? esc(t('All time: ranked by points, no goal applies.')) : esc(t('No points goal is set for this clan, so the board ranks by points only.'))}</p>`;
    return tile('goal', t('Goal status'), body, { span: 4 });
  }
  const counts = bandCounts(ctx.rows);
  const body = `<ul class="home-goal-list">${['ok', 'pace', 'behind'].map((b) => {
    const list = counts[b];
    const names = list.slice(0, 3).map((r) => r.name);
    const more = list.length > 3 ? t('{names} and {n} more', { names: names.join(', '), n: list.length - 3 }) : names.join(', ');
    return `<li><button type="button" class="home-goal-btn" data-home-band="${b}">
        <span class="home-goal-top">${bandHtml(b)}<span class="home-goal-n">${num(list.length)}</span></span>
        <span class="home-goal-names">${list.length ? esc(more) : esc(t('Nobody'))}</span>
      </button></li>`;
  }).join('')}</ul>
    <p class="ui-sub">${t('Goal {n}', { n: num(ctx.goalPts) })}${ctx.pacePts ? ` · ${t('pace now {n}', { n: num(ctx.pacePts) })}` : ''}</p>`;
  return tile('goal', t('Goal status'), body, { span: 4 });
}

/** The top collectors of the period, with their bars. */
function topTile(ctx, span) {
  const top = ctx.rows.filter((r) => r.points > 0).slice(0, 5);
  const max = top[0]?.points || 1;
  const body = top.length
    ? `<ol class="ui-rows">${top.map((r) => `<li class="ui-row">
        <span class="ui-rank">#${num(r.rank)}</span>
        ${avatarHtml({ avatar: r.avatar, username: r.name }, { size: 'sm' })}
        <span class="ui-row-main"><a class="ui-row-name" href="${memberHash(r.id)}">${esc(r.name)}</a>
          ${barHtml(r.points, null, null, r.band, max)}</span>
        <span class="ui-row-n">${num(r.points)}</span>
      </li>`).join('')}</ol>`
    : `<p class="ui-copy">${esc(t('Nobody collected a chest in this timeframe.'))}</p>`;
  return tile('top', t('Top collectors'), body, { span, link: tileLink('#members', t('Members')) });
}

/** Biggest changes in points against the period before (cut at the same point while it runs). */
function moversTile(ctx) {
  if (!ctx.win) {
    return tile('movers', t('Biggest movers'), `<p class="ui-copy">${esc(t('All time has no period before it to compare with.'))}</p>`, { span: 4 });
  }
  const withDelta = ctx.rows.filter((r) => r.delta !== null && r.delta !== 0);
  const up = [...withDelta].sort((a, b) => b.delta - a.delta).filter((r) => r.delta > 0).slice(0, 3);
  const down = [...withDelta].sort((a, b) => a.delta - b.delta).filter((r) => r.delta < 0).slice(0, 2);
  const label = DELTA_LABEL[ctx.period][ctx.running ? 'now' : 'past']();
  const row = (r) => `<li class="ui-row">
      ${avatarHtml({ avatar: r.avatar, username: r.name }, { size: 'sm' })}
      <span class="ui-row-main"><a class="ui-row-name" href="${memberHash(r.id)}">${esc(r.name)}</a></span>
      <span class="ui-row-n">${deltaHtml(r.delta)}</span>
    </li>`;
  const body = up.length || down.length
    ? `<p class="ui-sub">${esc(label)}</p><ul class="ui-rows">${up.map(row).join('')}${down.map(row).join('')}</ul>`
    : `<p class="ui-copy">${esc(t('No changes against the period before yet.'))}</p>`;
  return tile('movers', t('Biggest movers'), body, { span: 4 });
}

/** Points by source for the period: where the clan's chests came from. */
function sourcesTile(ctx) {
  const list = [...(ctx.analytics?.current?.bySource || [])].sort((a, b) => (b.points || 0) - (a.points || 0)).slice(0, 6);
  const max = list[0]?.points || 1;
  const body = list.length
    ? `<ul class="ui-rows">${list.map((s) => `<li class="ui-row is-source">
        <span class="ui-row-main"><span class="ui-row-name">${sourceLink(s.chest_source, { period: ctx.period })}</span>
          ${barHtml(s.points || 0, null, null, null, max)}</span>
        <span class="ui-row-n">${num(s.points)}<span class="ui-row-sub">${tn(s.count, '{n} chest', '{n} chests', { n: num(s.count) })}</span></span>
      </li>`).join('')}</ul>`
    : `<p class="ui-copy">${esc(t('Nobody collected a chest in this timeframe.'))}</p>`;
  return tile('sources', t('Points by source'), body, { span: 4, link: tileLink('#analytics', t('Analytics')) });
}

/**
 * "Today 07:14", "Yesterday 04:12", else the date ("2026-11-15") — the
 * viewer's own clock, 24-hour, the full stamp in the title.
 */
function rosterWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const day = (x) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  const now = new Date();
  const yesterday = new Date(now.getTime() - DAY_MS);
  if (day(d) === day(now)) return t('Today {time}', { time });
  if (day(d) === day(yesterday)) return t('Yesterday {time}', { time });
  return formatDateShort(iso);
}

/**
 * Joins, leaves and rank changes as rows like the other tiles — picture,
 * name, what changed, when — newest first; burning cities as one summary
 * line above them. Plain facts: no alerts, no advice.
 */
function rosterTile(ctx) {
  const avatarOf = new Map(ctx.rows.map((r) => [r.id, r.avatar]));
  const items = [];
  const since = Date.now() - NOTE_DAYS * DAY_MS;
  for (const c of ctx.changes) {
    if (Date.parse(c.at) < since) continue;
    const joined = c.kind === 'joined' || c.kind === 'returned' || c.kind === 'restored';
    const left = c.kind === 'left';
    if (!joined && !left) continue;
    items.push({
      at: c.at, memberId: c.memberId, name: c.name,
      kind: joined ? 'joined' : 'left',
      what: joined ? `<span aria-hidden="true">+</span> ${esc(t('Joined the clan'))}` : `<span aria-hidden="true">−</span> ${esc(t('Left the clan'))}`,
    });
  }
  for (const r of ctx.ranks) {
    const rank = esc(gameRankName(r.to));
    const from = r.from ? esc(gameRankName(r.from)) : '';
    items.push({
      at: r.at, memberId: r.memberId, name: r.name,
      kind: r.promoted ? 'up' : 'down',
      what: r.promoted
        ? `<span aria-hidden="true">▲</span> ${t('Promoted to {rank}', { rank })}`
        : `<span aria-hidden="true">▼</span> ${from ? t('Now {rank}, was {from}', { rank, from }) : t('Now {rank}', { rank })}`,
    });
  }
  items.sort((a, b) => String(b.at).localeCompare(String(a.at)));

  const burning = ctx.rows.filter((r) => r.burning);
  let burningHtml = '';
  if (burning.length) {
    const seen = burning.map((r) => r.mapSeenAt).filter(Boolean).sort().pop();
    const first = burning.slice(0, 3).map((r) => `<a href="${memberHash(r.id)}">${esc(r.name)}</a>`).join(', ');
    const more = burning.length > 3 ? ` <span class="roster-more">+${num(burning.length - 3)}</span>` : '';
    burningHtml = `<div class="roster-burning">
        <span class="roster-burning-head"><span aria-hidden="true">🔥</span> ${esc(tn(burning.length, '{n} city burning', '{n} cities burning', { n: num(burning.length) }))}</span>
        <span class="roster-burning-names">${first}${more}</span>
        ${seen ? `<span class="roster-when">${esc(t('map read {when}', { when: formatRelativeTime(seen) }))}</span>` : ''}
      </div>`;
  }

  const rows = items.slice(0, 8).map((it) => {
    const name = it.memberId
      ? `<a class="ui-row-name" href="${memberHash(it.memberId)}">${esc(it.name)}</a>`
      : `<span class="ui-row-name">${esc(it.name)}</span>`;
    return `<li class="ui-row roster-row">
        ${avatarHtml({ avatar: avatarOf.get(it.memberId) ?? null, username: it.name }, { size: 'sm' })}
        <span class="ui-row-main">${name}<span class="roster-what is-${it.kind}">${it.what}</span></span>
        <time class="roster-when" datetime="${esc(it.at)}" title="${esc(formatDate(it.at))}">${esc(rosterWhen(it.at))}</time>
      </li>`;
  }).join('');
  const body = burningHtml || rows
    ? `${burningHtml}${rows ? `<ul class="ui-rows roster-list">${rows}</ul>` : ''}`
    : `<p class="ui-copy">${esc(t('No joins, leaves or rank changes in the last 7 days.'))}</p>`;
  return tile('roster', t('Roster changes'), body, { span: 6, link: tileLink('#clan', t('My Clan')) });
}

/** Events running now and coming up. */
function eventsTile(ctx, span) {
  const list = ctx.events
    .map((e) => {
      if (e.endsAt) return { e, sort: 0, text: t('Resets in {time}', { time: timeLeftUntil(e.endsAt) }), live: true };
      if (e.live) return { e, sort: 0, text: t('Live now'), live: true };
      if (e.nextFrom && e.nextLabel) return { e, sort: Date.parse(e.nextFrom) || Infinity, text: `${e.nextLabel} · ${relativeUntil(e.nextFrom)}`, live: false };
      return null;
    })
    .filter(Boolean)
    .sort((a, b) => a.sort - b.sort)
    .slice(0, 6);
  const body = list.length
    ? `<ul class="ui-rows">${list.map(({ e, text, live }) => `<li class="ui-row is-event">
        <span class="ui-row-main"><a class="ui-row-name" href="#events/${encodeURIComponent(e.key)}">${esc(tGame(e.name))}</a></span>
        <span class="home-event-when${live ? ' is-live' : ''}">${live ? '<span aria-hidden="true">● </span>' : ''}${esc(text)}</span>
      </li>`).join('')}</ul>`
    : `<p class="ui-copy">${esc(t('No event dates are known right now.'))}</p>`;
  return tile('events', t('Events'), body, { span, link: tileLink('#events', t('Events')) });
}

/** This clan's scans: the last one, this week's coverage and any gap long enough for gifts to expire. */
function scanHealthTile(ctx) {
  const s = ctx.stats || {};
  const cov = ctx.coverage;
  const facts = [
    `<dt>${t('Last Scan')}</dt><dd>${s.lastScanCompletedAt ? esc(formatRelativeTime(s.lastScanCompletedAt)) : esc(t('never'))}${s.lastScanChests !== null && s.lastScanChests !== undefined ? ` · ${tn(s.lastScanChests, '{n} chest', '{n} chests', { n: num(s.lastScanChests) })}` : ''}</dd>`,
  ];
  if (cov) facts.push(`<dt>${t('Scans this week')}</dt><dd>${num(cov.scans)}</dd>`);
  facts.push(`<dt>${t('Total Scans')}</dt><dd>${num(s.totalSessions)}</dd>`);
  facts.push(`<dt>${t('Avg Chests/Scan')}</dt><dd>${Number(s.avgChestsPerScan || 0).toLocaleString()}</dd>`);
  let verdict = '';
  if (cov) {
    verdict = cov.gaps?.length
      ? `<p class="ui-band band-behind"><span aria-hidden="true">↓</span> ${tn(cov.gaps.length, 'One gap longer than {hours} h this week (longest {worst} h). Gifts last about 21 h, so chests from then may be missing.', '{n} gaps longer than {hours} h this week (longest {worst} h). Gifts last about 21 h, so chests from then may be missing.', { n: cov.gaps.length, hours: GIFT_HOURS, worst: Math.round(cov.worstGapHours) })}</p>`
      : `<p class="ui-band band-ok"><span aria-hidden="true">✓</span> ${t('No gap longer than {hours} h this week: every gift was read before it could expire.', { hours: GIFT_HOURS })}</p>`;
  }
  const body = `${verdict}<dl class="home-facts">${facts.join('')}</dl>`;
  return tile('scans', t('Scan health'), body, { span: 6, link: tileLink('#sessions', t('Scan History')) });
}

/** Every clan (superadmin): last scan, next scan, status, today's chests; one click switches. */
function clansTile(ctx) {
  const byId = new Map(ctx.overview.map((o) => [o.id, o]));
  const runningIds = new Set((ctx.status?.activity?.clans ?? (ctx.status?.activity ? [ctx.status.activity] : [])).map((c) => c.clanId));
  const activeId = getCurrentUser()?.activeClan?.id ?? getCurrentUser()?.clanId ?? null;
  // A future time: formatRelativeTime is for the past and turned every future
  // moment into "just now" (beside a scanner card saying "in 47m").
  const nextMs = Date.parse(ctx.status?.nextScanAt ?? '');
  const next = runningIds.size
    ? t('A scan cycle is running')
    : Number.isFinite(nextMs) && nextMs > Date.now()
      ? t('Next scan cycle in {time}', { time: timeLeftUntil(ctx.status.nextScanAt) })
      : null;
  const rows = ctx.clans.map((c) => {
    const o = byId.get(c.id) || {};
    const st = c.needsReauth ? { cls: 'is-bad', glyph: '!', text: t('Needs re-authentication') }
      : runningIds.has(c.id) ? { cls: 'is-busy', glyph: '◐', text: t('Scanning') }
        : !c.isActive ? { cls: 'is-muted', glyph: '‖', text: t('Paused') }
          : { cls: 'is-ok', glyph: '✓', text: t('Active') };
    const logo = c.logoUrl
      ? `<img class="home-clan-logo" src="${esc(c.logoUrl)}" alt="" width="32" height="32" decoding="async">`
      : `<span class="home-clan-logo is-initials" aria-hidden="true">${esc((c.shortCode || c.name || '?').slice(0, 3).toUpperCase())}</span>`;
    const here = c.id === activeId;
    return `<li><button type="button" class="home-clan${here ? ' is-here' : ''}" data-home-clan="${c.id}"${here ? ' aria-current="true"' : ''}>
        ${logo}
        <span class="home-clan-text">
          <span class="home-clan-name">${esc(c.name)}</span>
          <span class="ui-sub">${c.kingdom ? `${esc(t('Kingdom #{n}', { n: c.kingdom }))} · ` : ''}${c.lastScanAt ? esc(t('Scanned {when}', { when: formatRelativeTime(c.lastScanAt) })) : esc(t('Not scanned yet'))}</span>
        </span>
        <span class="home-clan-today"><span class="home-clan-n">${num(o.chestsToday)}</span><span class="ui-sub">${t('chests today')}</span></span>
        <span class="shell-clan-status ${st.cls}"><span aria-hidden="true">${st.glyph}</span> ${esc(st.text)}</span>
      </button></li>`;
  });
  const body = `${next ? `<p class="ui-sub">${esc(next)}</p>` : ''}
    <ul class="home-clans">${rows.join('')}</ul>`;
  return tile('clans', t('Clans'), body, { span: 12, link: tileLink('#clans', t('Manage clans')) });
}

/** The latest chests collected, with where each came from. */
function recentTile(ctx, span) {
  const body = ctx.recent.length
    ? `<ul class="ui-rows">${ctx.recent.map((c) => `<li class="ui-row is-chest">
        <span class="ui-row-main">${chestLabelHtml(c.chestName, `<span class="cell-stacked"><a class="member-link cell-stacked-primary" href="${chestHash(c.chestName, 'all')}">${esc(tGame(c.chestName))}</a><span class="cell-stacked-sub">${t('from {source}', { source: sourceLink(c.chestSource) })}</span></span>`, { size: 28, cls: 'is-block' })}</span>
        <span class="ui-row-who">${c.memberId ? `<a href="${memberHash(c.memberId)}">${esc(c.playerName)}</a>` : esc(c.playerName)}</span>
      </li>`).join('')}</ul>`
    : `<p class="ui-copy">${esc(t('No chests yet.'))}</p>`;
  return tile('recent', t('Recent Chests'), body, { span });
}

/** The clan's best single days, all time (members appear once per podium). */
function recordsTile(ctx, span) {
  const medals = ['🥇', '🥈', '🥉'];
  const podium = (label, list, fmt) => `<div class="home-podium">
      <h3 class="home-podium-title">${label}</h3>
      ${list?.length ? `<ol class="ui-rows">${list.map((e, i) => `<li class="ui-row">
          <span class="home-medal" aria-hidden="true">${medals[i] || ''}</span>
          <span class="ui-row-main"><a class="ui-row-name" href="${memberHash(e.memberId)}">${esc(e.memberName)}</a><span class="ui-row-sub">${esc(e.date || '')}</span></span>
          <span class="ui-row-n">${fmt(e.value)}</span>
        </li>`).join('')}</ol>` : `<p class="ui-copy">${t('No data yet.')}</p>`}
    </div>`;
  const body = `<div class="home-podiums">
      ${podium(t('Most Chests in a Day'), ctx.records?.byChests, (v) => tn(v, '{n} chest', '{n} chests', { n: num(v) }))}
      ${podium(t('Most Points in a Day'), ctx.records?.byPoints, (v) => t('{n} pts', { n: num(v) }))}
    </div>
    <p class="ui-sub">${t('All-time best days. Excludes end-of-event clan rewards.')}</p>`;
  return tile('records', t('Clan records'), body, { span });
}

// ─── Events ───

function wire(el, ctx) {
  wirePeriodScrubber(el, {
    onPeriod: (p) => { state.period = p; state.offset = 0; void renderHome(el); },
    onStep: (delta) => {
      const next = state.offset + delta;
      if (next < 0) return;
      state.offset = next;
      void renderHome(el);
    },
  });
  for (const b of el.querySelectorAll('[data-home-band]')) {
    b.addEventListener('click', () => {
      presetMembersBoard({ band: b.dataset.homeBand, period: ctx.period, offset: ctx.offset });
      window.location.hash = '#members';
    });
  }
  el.querySelector('[data-home-add-clan]')?.addEventListener('click', () => openAddClanDialog());
  for (const b of el.querySelectorAll('[data-home-clan]')) {
    b.addEventListener('click', async () => {
      const id = Number(b.dataset.homeClan);
      if (b.getAttribute('aria-current') === 'true' || !Number.isFinite(id)) return;
      try {
        const r = await fetch(`/api/clans/${id}/activate`, { method: 'POST' });
        if (r.ok) window.location.reload();
      } catch { /* stay on this clan */ }
    });
  }
}
