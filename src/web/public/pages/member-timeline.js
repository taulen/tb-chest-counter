// Profile → Timeline: everything recorded about a member, newest first,
// grouped by game day (GET /api/game/members/:id/timeline). Dense rows like the
// Chats page: a time gutter, an icon, one line each; a day's research, talents,
// captain, gear and title changes fold into one line that opens to the list,
// and so does a run of merges of screenshot-era spellings (tagged, muted).
// Filter chips by kind; "Load older" pages by cursor.

import { api } from '../lib/api.js';
import { esc } from '../lib/ui.js';
import { t, tn, tGame } from '../lib/i18n.js';
import { gameRankName } from '../lib/game-facts.js';
import { statusIconUrl } from '../lib/game-art.js';
import { formatCompact } from '../lib/ancient-planner.js';

const PAGE = 60;

const GROUPS = [
  { key: '', label: () => t('All') },
  { key: 'clan', label: () => t('Clan') },
  { key: 'growth', label: () => t('Growth') },
  { key: 'titles', label: () => t('Titles') },
  { key: 'research', label: () => t('Research') },
  { key: 'captains', label: () => t('Captains & gear') },
  { key: 'city', label: () => t('City') },
];

/** Troop families as the Research tab names them (official game names → tGame). */
const FAMILY = { guardsmen: 'Guardsmen', specialists: 'Specialists', engineers: 'Engineer corps', monsters: 'Monsters' };

export function memberTimelinePanelHtml() {
  return `<div class="member-timeline" data-member-timeline><div class="card"><div class="card-body card-body-padded"><p class="muted-copy">${t('Loading…')}</p></div></div></div>`;
}

const timeOf = (iso) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
/** YYYY-MM-DD in local time, like the rest of the page's times. */
const isoDay = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const img = (url, cls = 'tl-img') => (url ? `<img class="${cls}" src="${esc(url)}" alt="" width="24" height="24" loading="lazy" decoding="async">` : '');
const glyph = (g, cls = '') => `<span class="tl-glyph ${cls}" aria-hidden="true">${g}</span>`;
const strong = (s) => `<strong>${esc(s)}</strong>`;
const change = (from, to) => `${esc(String(from))} → ${strong(String(to))}`;
/** " (as Endless Sky ツ)": the name on the record when it isn't the member's own. */
const asNameHtml = (e) => (e.asName ? ` <span class="rc-as">${esc(t('as {name}', { name: e.asName }))}</span>` : '');

/** A title change as one sentence: the game's name through tGame. */
function titleLine(it) {
  const name = strong(tGame(it.name));
  if (it.change === 'again') return t('Received the title {name} again', { name });
  if (it.change === 'ran_out') return t('The title {name} ran out', { name });
  if (it.change === 'gone') return t('No longer holds the title {name}', { name });
  return t('Received the title {name}', { name });
}
const titleEnded = (it) => it.change === 'ran_out' || it.change === 'gone';

/** The small "screenshot era" tag on a merge of a screenshot-reader spelling. */
const ocrTag = () => `<span class="tl-tag" title="${esc(t('This spelling only ever came from the old screenshot reader (before 2026-11-17), never from the game or an admin. Most such merges folded a misreading into the real name.'))}">${esc(t('screenshot era'))}</span>`;

/** One sub-line of a folded entry. */
function itemHtml(kind, it) {
  if (kind === 'titles') {
    return `<li class="${titleEnded(it) ? 'is-ended' : ''}">${img(it.iconUrl, 'tl-img is-small is-round')}<span>${titleLine(it)}</span><time class="tl-item-time" datetime="${esc(it.at)}">${timeOf(it.at)}</time></li>`;
  }
  if (kind === 'merged') {
    // A spelling and when it was merged in: its days (more than three: first – last), and how often.
    const ats = it.ats || [];
    const days = [...new Set(ats.map(isoDay))];
    const span = days.length <= 3 ? days.join(', ') : `${days[0]} – ${days[days.length - 1]}`;
    const when = esc(ats.length > 1 ? `${span} · ${ats.length}×` : span);
    return `<li class="is-spelling"><span>“${esc(it.name)}”</span><span class="tl-item-time">${when}</span></li>`;
  }
  if (kind === 'research' || kind === 'talents') {
    return `<li>${img(it.iconUrl, 'tl-img is-small')}<span>${esc(tGame(it.name))} ${it.prevLevel === null ? strong(`${t('level')} ${it.level}`) : change(it.prevLevel, it.level)}</span></li>`;
  }
  if (kind === 'captains') {
    const bits = [];
    if (it.prevLevel === null) bits.push(t('new captain, level {n}', { n: it.level }));
    else if (it.level !== it.prevLevel) bits.push(`${t('level')} ${change(it.prevLevel, it.level)}`);
    if (it.prevStars !== null && it.stars !== it.prevStars) bits.push(`★ ${change(it.prevStars, it.stars)}`);
    return `<li>${img(it.iconUrl, 'tl-img is-small')}<span>${strong(tGame(it.name))} ${bits.join(' · ')}</span></li>`;
  }
  // gear
  const who = it.captainName ? tGame(it.captainName) : t('Hero');
  const line = it.change === 'taken_off'
    ? t('{captain} took off {item}', { captain: strong(who), item: esc(tGame(it.prevName || '')) })
    : it.change === 'reworked'
      ? t('{captain}: {item} — enchantment or gems changed', { captain: strong(who), item: esc(tGame(it.name || '')) })
      : t('{captain} put on {item}', { captain: strong(who), item: esc(tGame(it.name || '')) });
  return `<li>${img(it.change === 'taken_off' ? it.prevIconUrl : it.iconUrl, 'tl-img is-small')}<span>${line}</span></li>`;
}

/** [icon html, text html, folded items html] for an entry (also the profile feed). */
export function entryParts(e) {
  switch (e.kind) {
    // The clan's Joins & leaves list, this member's part of it (same rules).
    case 'joined': return [glyph(e.returned || e.restored ? '↻' : '↪', e.restored ? '' : e.returned ? 'is-gold' : 'is-good'),
      (e.restored ? t('Restored on the site') : e.returned ? t('Came back to the clan') : t('Joined the clan')) + asNameHtml(e), ''];
    case 'left': return [glyph('↩', 'is-bad'), (e.site ? t('Marked as left on the site') : t('Left the clan')) + asNameHtml(e), ''];
    case 'renamed': return [glyph('✎'), e.by === 'game'
      ? t('Renamed in the game: {from} → {to}', { from: esc(e.from), to: strong(e.to) })
      : t('Renamed on the site to {to}', { to: strong(e.to) }), ''];
    case 'merged': {
      if (!e.ocr) return [glyph('⇄'), t('Merged “{from}” into this member', { from: esc(e.from) }), ''];
      // Screenshot-era spellings: the site's own tidying, tagged; a run of them folds.
      const spellings = Array.isArray(e.items) ? e.items : [];
      if (spellings.length === 1 && spellings[0].ats?.length === 1) {
        return [glyph('⇄'), `${t('Merged “{from}” into this member', { from: esc(spellings[0].name) })} ${ocrTag()}`, ''];
      }
      return [glyph('⇄'), `${tn(spellings.length, 'Merged {n} spelling into this member', 'Merged {n} spellings into this member')} ${ocrTag()}`,
        spellings.map((s) => itemHtml('merged', s)).join('')];
    }
    case 'titles': {
      // One title change: its sentence. Several on a day: counts, folded.
      const items = Array.isArray(e.items) ? e.items : [];
      const icon = img(items.find((it) => !titleEnded(it) && it.iconUrl)?.iconUrl ?? items.find((it) => it.iconUrl)?.iconUrl, 'tl-img is-round') || glyph('♔', 'is-gold');
      if (items.length === 1) return [icon, titleLine(items[0]), ''];
      const ended = items.filter(titleEnded).length;
      const received = items.length - ended;
      const bits = [];
      if (received) bits.push(tn(received, 'Received {n} title', 'Received {n} titles'));
      if (ended) bits.push(tn(ended, '{n} title ended', '{n} titles ended'));
      return [icon, bits.join(' · '), items.map((it) => itemHtml('titles', it)).join('')];
    }
    case 'rank': return [glyph(e.promoted ? '▲' : '▼', e.promoted ? 'is-good' : 'is-bad'),
      (e.promoted ? t('Promoted to {rank}', { rank: strong(gameRankName(e.to)) }) : t('Demoted to {rank}', { rank: strong(gameRankName(e.to)) })), ''];
    case 'hero_level': return [glyph('⬆', 'is-good'), `${t('Hero level')} ${change(e.from, e.to)}`, ''];
    case 'city_level': return [glyph('⬆', 'is-good'), `${t('City level')} ${change(e.from, e.to)}`, ''];
    case 'vip': return [glyph('★'), `${t('VIP')} ${change(e.from, e.to)}`, ''];
    case 'gold_pass': return [glyph('G', 'is-gold'), e.on ? t('Gold Pass started') : t('Gold Pass ended'), ''];
    case 'hero': return [img(e.avatarUrl) || glyph('☺'), e.name ? t('Changed hero to {name}', { name: strong(tGame(e.name)) }) : t('Changed hero'), ''];
    case 'might': {
      const pct = Math.round(((e.to - e.from) / e.from) * 100);
      return [glyph(pct >= 0 ? '▲' : '▼', pct >= 0 ? 'is-good' : 'is-bad'),
        `${t('Might')} ${esc(formatCompact(e.from))} → ${strong(formatCompact(e.to))} (${pct >= 0 ? '+' : ''}${pct}%)`, ''];
    }
    case 'dragon': {
      // "Dragon level 236 → 237", "Dragon evolution 5 → 6", or both.
      const bits = [];
      if (e.to != null) bits.push(`${t('Dragon level')} ${change(e.from, e.to)}`);
      if (e.stageTo != null) bits.push(`${t('Dragon evolution')} ${change(e.stageFrom, e.stageTo)}`);
      return [img(e.iconUrl) || glyph('⬆', 'is-good'), bits.join(' · '), ''];
    }
    case 'tier': return [glyph('⚔', 'is-good'), e.family === 'crypts'
      ? t('Crypt level {n} reached', { n: strong(String(e.to)) })
      : t('{family} tier {n} reached', { family: esc(tGame(FAMILY[e.family] || e.family)), n: strong(String(e.to)) }), ''];
    case 'research':
    case 'talents': {
      const n = e.items.length;
      const label = e.kind === 'research' ? tn(n, '{n} research upgrade', '{n} research upgrades') : tn(n, '{n} talent upgrade', '{n} talent upgrades');
      return [img(e.items[0]?.iconUrl) || glyph('⚗'), label, e.items.map((it) => itemHtml(e.kind, it)).join('')];
    }
    case 'captains': return [img(e.items[0]?.iconUrl) || glyph('♞'),
      tn(e.items.length, '{n} captain change', '{n} captain changes'), e.items.map((it) => itemHtml('captains', it)).join('')];
    case 'gear': return [img(e.items.find((it) => it.iconUrl)?.iconUrl) || glyph('⛨'),
      tn(e.items.length, '{n} gear change', '{n} gear changes'), e.items.map((it) => itemHtml('gear', it)).join('')];
    case 'artifact': {
      let text;
      if (e.intoLineup) text = t('{name} into the line-up', { name: strong(tGame(e.name)) });
      else {
        const bits = [];
        if (e.prevLevel !== null && e.level !== e.prevLevel) bits.push(`${t('level')} ${change(e.prevLevel, e.level)}`);
        if (e.prevStar !== null && e.star !== e.prevStar) bits.push(`${t('star level')} ${change(e.prevStar, e.star)}`);
        if (e.rerolled) bits.push(t('new rolls'));
        text = `${strong(tGame(e.name))} ${bits.join(' · ')}`;
      }
      return [img(e.iconUrl) || glyph('✦'), text, ''];
    }
    case 'shield': return [img(statusIconUrl('shield')) || glyph('🛡'), e.on ? t('Shield up') : t('Shield down'), ''];
    case 'burning': return [img(statusIconUrl(e.on ? 'burning' : 'city')) || glyph('🔥'), e.on ? t('City burning (walls down)') : t('Walls repaired'), ''];
    default: return [glyph('•'), esc(e.kind), ''];
  }
}

function entryHtml(e) {
  const [icon, text, items] = entryParts(e);
  const time = `<time class="tl-time" datetime="${esc(e.at)}" title="${esc(new Date(e.at).toLocaleString())}">${timeOf(e.at)}</time>`;
  const body = items
    ? `<details class="tl-fold"><summary>${text}</summary><ul class="tl-items">${items}</ul></details>`
    : `<span class="tl-text">${text}</span>`;
  return `<li class="tl-entry is-${esc(e.group)}${e.ocr ? ' is-ocr' : ''}">${time}<span class="tl-icon">${icon}</span><div class="tl-body">${body}</div></li>`;
}

/** Day separators between game days; `lastDay` continues a previous page. */
function listHtml(entries, lastDay) {
  let html = '';
  let day = lastDay;
  for (const e of entries) {
    if (e.day !== day) {
      day = e.day;
      html += `<li class="tl-day" role="separator"><span>${esc(day)}</span></li>`;
    }
    html += entryHtml(e);
  }
  return { html, lastDay: day };
}

export async function mountMemberTimeline(root, memberId) {
  const el = root.querySelector('[data-member-timeline]');
  if (!el || el.dataset.mounted === String(memberId)) return;
  el.dataset.mounted = String(memberId);
  const state = { group: '', next: null, lastDay: null, total: 0, loading: false };

  el.innerHTML = `<div class="card">
      <div class="card-header"><h2>${t('Timeline')}</h2><span class="card-header-hint tl-count"></span></div>
      <div class="tl-chips" role="group" aria-label="${esc(t('Show'))}">
        ${GROUPS.map((g) => `<button type="button" class="btn btn-sm tl-chip${g.key === '' ? ' active' : ''}" data-tl-group="${g.key}" aria-pressed="${g.key === '' ? 'true' : 'false'}">${esc(g.label())}</button>`).join('')}
      </div>
      <ol class="tl-list" aria-live="polite"></ol>
      <div class="tl-foot"></div>
    </div>`;
  const list = el.querySelector('.tl-list');
  const foot = el.querySelector('.tl-foot');
  const count = el.querySelector('.tl-count');

  const load = async (more) => {
    if (state.loading) return;
    state.loading = true;
    const q = new URLSearchParams({ limit: String(PAGE) });
    if (state.group) q.set('groups', state.group);
    if (more && state.next) q.set('before', state.next);
    let res;
    try {
      res = await api(`/game/members/${memberId}/timeline?${q}`);
    } catch {
      foot.innerHTML = `<p class="muted-copy">${t("Couldn't load this member's timeline.")}</p>`;
      state.loading = false;
      return;
    }
    const entries = Array.isArray(res?.entries) ? res.entries : [];
    if (!more) {
      list.innerHTML = '';
      state.lastDay = null;
      state.total = res?.total ?? entries.length;
      count.textContent = tn(state.total, '{n} event', '{n} events');
    }
    const { html, lastDay } = listHtml(entries, state.lastDay);
    list.insertAdjacentHTML('beforeend', html);
    state.lastDay = lastDay;
    state.next = res?.next ?? null;
    foot.innerHTML = state.next
      ? `<button type="button" class="btn btn-sm" data-tl-more>${esc(t('Load older'))}</button>`
      : (state.total === 0 ? `<p class="muted-copy">${esc(t('Nothing recorded yet — changes appear here as the scans see them.'))}</p>` : '');
    state.loading = false;
  };

  el.addEventListener('click', (ev) => {
    const chip = ev.target.closest('[data-tl-group]');
    if (chip) {
      state.group = chip.dataset.tlGroup;
      el.querySelectorAll('[data-tl-group]').forEach((b) => {
        const on = b === chip;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      load(false);
      return;
    }
    if (ev.target.closest('[data-tl-more]')) load(true);
  });
  await load(false);
}
