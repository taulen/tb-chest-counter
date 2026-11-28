// "Fill in from a battle report" — the dialog Tools → Citadel and → Stacks
// share (docs/battle-reports.md). Battles of the last week only. A player
// select first (like the Costs tool's "Whose research"): it opens on the
// viewer's own players (several together as "Your accounts"); anyone in the
// clan who fought or posted a battle that has been read is listed to pick.
// Below it the battles, each with its target (a citadel with its level), day,
// whose army it is and who shared it. Tools → Citadel lists citadel battles
// only (`only: 'citadels'`). Picking one resolves to that battle's army and
// the other battles listed (GET /api/tools/report-armies) — the page works
// out the bonuses and fills what the battle can't show from the same army's
// (lib/report-bonuses.js withGapsFilled).

import { api } from './api.js';
import { esc, contentModal, formatDate } from './ui.js';
import { t, tn, tGame } from './i18n.js';

/** "Elven Citadel · Level 10", or the target's name alone. */
function targetLabel(r) {
  const name = r.target?.name ? tGame(r.target.name) : t('Unknown target');
  return r.target?.level ? `${name} · ${t('Level {n}', { n: r.target.level })}` : name;
}

/** "2026-11-07 · Elven Citadel · Level 10" — the page's note names the battle with this. */
export function reportChoiceLabel(r) {
  return `${String(r.at ?? '').slice(0, 10)} · ${targetLabel(r)}`;
}

async function load(player, only) {
  const q = new URLSearchParams();
  if (player) q.set('player', player);
  if (only) q.set('only', only);
  const qs = q.toString();
  try {
    const res = await api(`/tools/report-armies${qs ? `?${qs}` : ''}`);
    return res && Array.isArray(res.players) && Array.isArray(res.reports) ? res : null;
  } catch {
    return null;
  }
}

function itemHtml(r, i, picked) {
  const bits = [esc(formatDate(r.at).slice(0, 16)), esc(r.won ? t('Victory') : t('Defeat'))];
  // Several own accounts together ('own'): every line says whose army it is.
  if (r.attacker?.playerId && r.attacker.playerId !== picked) bits.push(esc(t('army of {name}', { name: r.attacker.name || '—' })));
  if (r.sharedBy && r.sharedBy !== r.attacker?.name) bits.push(esc(t('shared by {name}', { name: r.sharedBy })));
  return `<button type="button" class="rp-item" data-rp-index="${i}">
      <span class="rp-title">${esc(targetLabel(r))}</span>
      <span class="rp-sub">${bits.join(' · ')}</span>
    </button>`;
}

function bodyHtml(data, intro) {
  const days = data.windowDays ?? 7;
  const waiting = data.waiting > 0
    ? `<p class="rp-note muted-copy">${esc(tn(data.waiting, '{n} shared report is still being read; more battles show up as it is.', '{n} shared reports are still being read; more battles show up as they are.'))}</p>`
    : '';
  const span = `<p class="rp-note muted-copy">${esc(data.only === 'citadels'
    ? t('Citadel battles from the last {days} days.', { days })
    : t('Battles from the last {days} days.', { days }))}</p>`;
  if (!data.players.length) {
    return `<p>${esc(t('No battle shared in this clan in the last {days} days has been read yet.', { days }))}</p>${span}${waiting}`;
  }
  const mine = data.players.filter((p) => p.own);
  const label = (p) => `${p.name || t('Unknown player')}${p.own ? ` (${t('you')})` : ''} · ${tn(p.battles, '{n} battle', '{n} battles')}`;
  const option = (value, text) => `<option value="${esc(String(value))}"${String(value) === String(data.player) ? ' selected' : ''}>${esc(text)}</option>`;
  const options = [
    ...(data.player === null ? [`<option value="" selected disabled>${esc(t('Pick a player'))}</option>`] : []),
    ...(mine.length > 1 ? [option('own', t('Your accounts'))] : []),
    ...data.players.map((p) => option(p.playerId, label(p))),
  ].join('');
  const who = data.players.find((p) => p.playerId === data.player);
  let list;
  if (data.reports.length) {
    list = `<div class="rp-list">${data.reports.map((r, i) => itemHtml(r, i, data.player)).join('')}</div>`;
  } else if (data.player === null) {
    list = `<p class="muted-copy">${esc(t('Pick a player to see their battles.'))}</p>`;
  } else if (data.player === 'own' || who?.own) {
    list = `<p class="muted-copy">${esc(t('No battle of yours from the last {days} days has been read yet. Share a report in the clan chat, or send it to the scanner account in a private message; it is read within a few minutes.', { days }))}</p>`;
  } else {
    list = `<p class="muted-copy">${esc(t('No battle of {name} from the last {days} days has been read yet.', { name: who?.name || t('this player'), days }))}</p>`;
  }
  return `<p class="rp-intro">${esc(intro)}</p>
    <label class="rp-player"><span>${esc(t('Player'))}</span>
      <select class="input" data-rp-player>${options}</select></label>
    ${span}${list}${waiting}`;
}

/**
 * Open the dialog; resolves to { report, reports } — the picked battle's army
 * and the battles listed — or null. `only: 'citadels'` lists citadel battles only.
 */
export async function pickBattleReport({ title, intro, only = null }) {
  let data = null;
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    // Open at once, then fill: reading the battles can take a moment, and a
    // click that shows nothing for seconds reads as a hung page.
    const modal = contentModal({
      title,
      html: `<p class="rp-intro">${esc(intro)}</p><p class="muted-copy" role="status">${esc(t('Reading the battles…'))}</p>`,
      className: 'rp-modal',
      onClose: () => finish(null),
    });
    if (!modal) { finish(null); return; }
    const wire = () => {
      modal.content.querySelector('[data-rp-player]')?.addEventListener('change', async (e) => {
        const next = await load(e.target.value, only);
        if (done) return;
        if (!next) {
          modal.setHtml(`<p>${esc(t('The battle reports could not be loaded.'))}</p>`);
          return;
        }
        data = next;
        modal.setHtml(bodyHtml(data, intro));
        wire();
      });
      modal.content.querySelectorAll('[data-rp-index]').forEach((btn) => btn.addEventListener('click', () => {
        const r = data.reports[Number(btn.dataset.rpIndex)];
        finish(r ? { report: r, reports: data.reports } : null);
        modal.close();
      }));
    };
    load(null, only).then((first) => {
      if (done) return;
      data = first;
      modal.setHtml(data ? bodyHtml(data, intro) : `<p>${esc(t('The battle reports could not be loaded.'))}</p>`);
      wire();
    });
  });
}

/**
 * The viewer's own players and their battles of the window (the dialog's
 * opening state: GET /api/tools/report-armies), or one player's with `player`;
 * null when it can't be read. For pages that pick from the viewer's own
 * battles without the dialog (Tools → Monsters' "Suggest an army").
 */
export function loadReportArmies(player = null, only = null) {
  return load(player, only);
}
