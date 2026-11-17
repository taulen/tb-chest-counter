// Event standings read from the game (GET /api/game/events…): every running
// event's "Clan members" tab, read every scan (message 38003). Two views:
//   - the standings card on an event's page (Events → Ancients, Olympus, …),
//     for the run the selected timeframe covers;
//   - Events → In-game rankings: the latest run of every event the game
//     reported for the clan, including events the site has no tab for.
// Names the game gives an event are official names → tGame at display.

import { api } from '../lib/api.js';
import { esc, memberLink, formatDate, formatDateShort, formatRelativeTime } from '../lib/ui.js';
import { t, tn, tGame } from '../lib/i18n.js';

const PAGE_SIZE = 25;

/** The standings for an event page's window: { run, standings } or null. */
export async function fetchGameStandings(eventKey, from, to) {
  const qs = new URLSearchParams({ event: eventKey });
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  try {
    const res = await api(`/game/events/standings?${qs}`);
    return res && res.run ? res : null;
  } catch {
    return null;
  }
}

function changeCell(row) {
  if (row.previousPoints === null || row.previousPoints === undefined) return '<span class="muted-copy">—</span>';
  const d = row.points - row.previousPoints;
  if (!d) return '<span class="muted-copy">±0</span>';
  const cls = d > 0 ? 'progress-up' : 'progress-down';
  const when = row.changedAt ? ` title="${esc(t('Since the read before {time}', { time: formatDate(row.changedAt) }))}"` : '';
  return `<span class="${cls}"${when}>${d > 0 ? '▲ +' : '▼ '}${Math.abs(d).toLocaleString()}</span>`;
}

function whoCell(row) {
  if (row.memberId) return memberLink(row.memberId, row.name);
  return esc(row.name || t('Unknown player'));
}

function runStatusHtml(run) {
  if (run.live) {
    return `<span class="game-run-badge is-live">${esc(t('Live now'))}</span>${run.endsAt ? ` <span class="muted-copy">${esc(t('Ends {date}', { date: formatDate(run.endsAt).slice(0, 16) }))}</span>` : ''}`;
  }
  return `<span class="game-run-badge">${esc(t('Ended {date}', { date: run.endsAt ? formatDateShort(run.endsAt) : '—' }))}</span>`;
}

function standingsTableHtml(rows, page) {
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const p = Math.min(Math.max(1, page), pages);
  const slice = rows.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE);
  const body = slice.map((r) => `<tr>
      <td data-label="${t('Rank')}" data-role="lead"><span class="rank rank-${r.rank}">#${r.rank}</span></td>
      <td data-label="${t('Member')}" data-role="primary"><span class="mrow-name">${whoCell(r)}</span></td>
      <td data-label="${t('Points')}" class="num" data-role="metric">${Number(r.points).toLocaleString()}</td>
      <td data-label="${t('Change')}" class="num" data-role="hidden">${changeCell(r)}</td>
    </tr>`).join('');
  const pagination = pages > 1
    ? `<div class="pagination">
        <button class="btn btn-tight" data-gs-page="${p - 1}" ${p <= 1 ? 'disabled' : ''}>${t('← Prev')}</button>
        <span class="pagination-info">${t('Page {page} of {pages}', { page: p, pages })} · ${tn(rows.length, '{n} member', '{n} members', { n: rows.length })}</span>
        <button class="btn btn-tight" data-gs-page="${p + 1}" ${p >= pages ? 'disabled' : ''}>${t('Next →')}</button>
      </div>`
    : '';
  return `<div class="table-responsive">
      <table class="data-table game-standings-table">
        <colgroup><col class="col-rank"><col><col class="col-points"><col class="col-change"></colgroup>
        <thead><tr>
          <th scope="col">${t('Rank')}</th><th scope="col">${t('Member')}</th>
          <th scope="col" class="num">${t('Points')}</th><th scope="col" class="num">${t('Change')}</th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>${pagination}`;
}

/** The standings card for an event page; nothing when the game gave no standings for that window. */
export function mountGameStandings(el, data) {
  if (!el) return;
  if (!data?.run) { el.innerHTML = ''; return; }
  let page = 1;
  const draw = () => {
    const { run, standings } = data;
    el.innerHTML = `<div class="card game-standings-card">
        <div class="card-header">
          <div>
            <h2>${esc(t('Standings from the game'))}</h2>
            <span class="card-header-hint">${esc(tGame(run.title || ''))} · ${runStatusHtml(run)}</span>
          </div>
          <span class="card-header-hint" title="${esc(formatDate(run.readAt))}">${esc(t('Read {time}', { time: formatRelativeTime(run.readAt) }))}</span>
        </div>
        <div class="card-body">
          <p class="muted-copy card-note">${esc(t("The event window's Clan members tab, read from the game every scan. The change is since the read before the points last moved."))}</p>
          ${standingsTableHtml(standings, page)}
        </div>
      </div>`;
    el.querySelectorAll('[data-gs-page]').forEach((b) => b.addEventListener('click', () => {
      page = Number(b.dataset.gsPage) || 1;
      draw();
    }));
  };
  draw();
}

/** Events → In-game rankings: the latest run of every event the game reported. */
export async function renderGameRankings(el) {
  el.innerHTML = `<div class="empty-state"><p>${esc(t('Loading…'))}</p></div>`;
  let res = null;
  try { res = await api('/game/events'); } catch { res = null; }
  const runs = Array.isArray(res?.runs) ? res.runs : [];
  if (!runs.length) {
    el.innerHTML = `<div class="card"><div class="card-body card-body-padded"><p class="muted-copy">${esc(t('No in-game rankings read yet. Every scan reads the standings of the events running in the game.'))}</p></div></div>`;
    return;
  }
  el.innerHTML = `<div class="card">
      <div class="card-header"><div>
        <h2>${esc(t('In-game rankings'))}</h2>
        <span class="card-header-hint">${esc(t('The latest run of every event the game reported for the clan, read every scan.'))}</span>
      </div></div>
      <div class="card-body card-body-padded">
        <ul class="game-run-list">${runs.map((r, i) => `<li class="game-run" data-gr="${i}">
            <div class="game-run-head">
              <div class="game-run-title">
                <strong>${esc(tGame(r.title || t('Event {type}', { type: r.type })))}</strong>
                ${r.eventKey ? `<a class="game-run-link" href="#events/${esc(r.eventKey)}">${esc(t('Open the event'))}</a>` : ''}
              </div>
              <div class="game-run-meta">${runStatusHtml(r)} · ${esc(tn(r.withPoints, '{n} member with points', '{n} members with points', { n: r.withPoints }))}</div>
            </div>
            ${r.top.length ? `<ol class="game-run-top">${r.top.map((p) => `<li><span class="rank rank-${p.rank}">#${p.rank}</span> ${p.memberId ? memberLink(p.memberId, p.name) : esc(p.name || t('Unknown player'))} <span class="muted-copy">${Number(p.points).toLocaleString()}</span></li>`).join('')}</ol>` : ''}
            <button class="btn btn-tight" type="button" data-gr-toggle="${i}" aria-expanded="false">${esc(t('Show standings'))}</button>
            <div class="game-run-standings" hidden></div>
          </li>`).join('')}</ul>
      </div>
    </div>`;
  el.querySelectorAll('[data-gr-toggle]').forEach((btn) => btn.addEventListener('click', async () => {
    const r = runs[Number(btn.dataset.grToggle)];
    const box = btn.parentElement.querySelector('.game-run-standings');
    const open = btn.getAttribute('aria-expanded') === 'true';
    if (open) {
      box.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
      btn.textContent = t('Show standings');
      return;
    }
    btn.setAttribute('aria-expanded', 'true');
    btn.textContent = t('Hide standings');
    box.hidden = false;
    if (!box.dataset.loaded) {
      box.innerHTML = `<p class="muted-copy">${esc(t('Loading…'))}</p>`;
      try {
        const data = await api(`/game/events/standings?type=${r.type}&run=${r.run}&occurrence=${r.occurrence}`);
        let page = 1;
        const draw = () => {
          box.innerHTML = standingsTableHtml(data.standings || [], page);
          box.querySelectorAll('[data-gs-page]').forEach((b) => b.addEventListener('click', () => { page = Number(b.dataset.gsPage) || 1; draw(); }));
        };
        draw();
        box.dataset.loaded = '1';
      } catch {
        box.innerHTML = `<p class="warning-text">${esc(t('Could not load the standings.'))}</p>`;
      }
    }
  }));
}
