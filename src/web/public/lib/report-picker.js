// "Fill in from a battle report" — the dialog Tools → Citadel and → Stacks
// share (docs/battle-reports.md). A player select first (like the Costs
// tool's "Whose research"): the viewer's own players, then anyone in the
// clan who fought or posted a battle that has been read. Below it the picked
// player's newest battles, each with its target, day, whose army it is and
// who shared it. Picking one resolves to that battle's army and the player's
// other battles listed (GET /api/tools/report-armies) — the page works out
// the bonuses and fills what the battle can't show from those
// (lib/report-bonuses.js withGapsFilled).

import { api } from './api.js';
import { esc, contentModal, formatDate } from './ui.js';
import { t, tn, tGame } from './i18n.js';

/** "2026-11-07 · Elven Citadel" — the page's note names the battle with this. */
export function reportChoiceLabel(r) {
  return `${String(r.at ?? '').slice(0, 10)} · ${r.target?.name ? tGame(r.target.name) : t('Unknown target')}`;
}

async function load(player) {
  try {
    const res = await api(`/tools/report-armies${player ? `?player=${encodeURIComponent(player)}` : ''}`);
    return res && Array.isArray(res.players) && Array.isArray(res.reports) ? res : null;
  } catch {
    return null;
  }
}

function itemHtml(r, i, picked) {
  const bits = [esc(formatDate(r.at).slice(0, 16)), esc(r.won ? t('Victory') : t('Defeat'))];
  if (r.attacker?.playerId && r.attacker.playerId !== picked) bits.push(esc(t('army of {name}', { name: r.attacker.name || '—' })));
  if (r.sharedBy && r.sharedBy !== r.attacker?.name) bits.push(esc(t('shared by {name}', { name: r.sharedBy })));
  return `<button type="button" class="rp-item" data-rp-index="${i}">
      <span class="rp-title">${esc(r.target?.name ? tGame(r.target.name) : t('Unknown target'))}</span>
      <span class="rp-sub">${bits.join(' · ')}</span>
    </button>`;
}

function bodyHtml(data, intro) {
  const waiting = data.waiting > 0
    ? `<p class="rp-note muted-copy">${esc(tn(data.waiting, '{n} shared report is still being read; more battles show up as it is.', '{n} shared reports are still being read; more battles show up as they are.'))}</p>`
    : '';
  if (!data.players.length) {
    return `<p>${esc(data.linked
      ? t('None of your battle reports has been read yet. Share one in the clan chat, or send it to the scanner account in a private message; it is read within a few minutes.')
      : t('No battle report shared in this clan has been read yet.'))}</p>${waiting}`;
  }
  const options = data.players.map((p) => {
    const label = `${p.name || t('Unknown player')}${p.own ? ` (${t('you')})` : ''} · ${tn(p.battles, '{n} battle', '{n} battles')}`;
    return `<option value="${p.playerId}"${p.playerId === data.player ? ' selected' : ''}>${esc(label)}</option>`;
  }).join('');
  const who = data.players.find((p) => p.playerId === data.player);
  const list = data.reports.length
    ? `<div class="rp-list">${data.reports.map((r, i) => itemHtml(r, i, data.player)).join('')}</div>`
    : `<p class="muted-copy">${esc(t('No battle of {name} with a strike log has been read yet.', { name: who?.name || t('this player') }))}</p>`;
  return `<p class="rp-intro">${esc(intro)}</p>
    <label class="rp-player"><span>${esc(t('Player'))}</span>
      <select class="input" data-rp-player>${options}</select></label>
    ${list}${waiting}`;
}

/** Open the dialog; resolves to { report, reports } — the picked battle's army and the player's battles listed — or null. */
export async function pickBattleReport({ title, intro }) {
  let data = await load(null);
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    const modal = contentModal({
      title,
      html: data ? bodyHtml(data, intro) : `<p>${esc(t('The battle reports could not be loaded.'))}</p>`,
      className: 'rp-modal',
      onClose: () => finish(null),
    });
    if (!modal) { finish(null); return; }
    const wire = () => {
      modal.content.querySelector('[data-rp-player]')?.addEventListener('change', async (e) => {
        const next = await load(e.target.value);
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
    wire();
  });
}
