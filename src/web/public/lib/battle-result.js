// A simulated battle's result for the Tools pages (battle-sim.js output): the
// card for one coin flip and the strike-by-strike list. Tools → Monsters uses
// it; the look is Citadel's (style.css "citadel-" classes), so the two read as
// one tool.
//
// `view` tells it how to show units: { name(id, side) → text, icon(id, side,
// size) → trusted markup or '', enemyFirst: the "If … strike first" title,
// roundEnemy(n): the round header when the enemy opens }. Side is 'you' or
// the result's enemy side.

import { esc } from './ui.js';
import { t, tn } from './i18n.js';
import { formatCompact } from './ancient-planner.js';

const fmt = (n) => Math.round(n).toLocaleString();

/** Units of the enemy army killed, of how many, and the share. */
export function enemyKilled(res) {
  const total = res.defenders.reduce((a, d) => a + d.count, 0);
  const killed = res.defenders.reduce((a, d) => a + (d.count - d.alive), 0);
  return { killed, total, share: total ? killed / total : 0 };
}

/**
 * One coin flip's card: verdict, what it cost, what it killed when it isn't
 * won, and a stretched button that picks it for the strike list.
 */
export function outcomeHtml(res, { title, opener, selected, view, action }) {
  const lostRows = res.army.filter((s) => s.lost > 0);
  const total = lostRows.reduce((x, s) => x + s.lost, 0);
  const verdict = res.won
    ? `<span class="citadel-tag is-win">✓ ${t('Victory')}</span>`
    : res.reason === 'walls'
      ? `<span class="citadel-tag is-loss">✕ ${t('The walls hold')}</span>`
      : `<span class="citadel-tag is-loss">✕ ${t('Defeat')}</span>`;
  const headline = total === 0
    ? `<div class="citadel-headline is-clean">${t('No losses')}</div>`
    : `<div class="citadel-headline">${tn(total, '{n} troop lost', '{n} troops lost', { n: total.toLocaleString() })}</div>`;
  const list = lostRows.map((s) => `<li>${view.icon(s.troopId, 'you', 22)}<span class="citadel-loss-name">${esc(view.name(s.troopId, 'you'))}</span><span class="citadel-loss-num">−${s.lost.toLocaleString()}</span><span class="citadel-loss-of">${t('of {n}', { n: s.count.toLocaleString() })}</span></li>`).join('');
  let why = '';
  if (!res.won) {
    const k = enemyKilled(res);
    const pct = k.share >= 0.001 ? `${(k.share * 100).toFixed(k.share < 0.1 ? 1 : 0)}%` : t('under 0.1%');
    why = res.reason === 'walls'
      ? t('Nothing you sent can bring the walls down in time. Siege engines strike before the walls.')
      : res.reason === 'rounds'
        ? t('The fight does not end — something can\'t be killed.')
        : t('Your army is wiped out after dealing {damage} damage and killing {killed} of {total} ({pct}).', {
          damage: formatCompact(res.dealt ?? 0), killed: fmt(k.killed), total: fmt(k.total), pct,
        });
  }
  const meta = tn(res.rounds, '{n} round', '{n} rounds', { n: res.rounds.toLocaleString() });
  const pick = selected ? t('Strikes shown below') : t('Show the strikes');
  return `
    <div class="ui-tile tool-tile citadel-outcome ${res.won ? 'is-win' : 'is-loss'} ${selected ? 'is-selected' : ''}">
      <div class="citadel-outcome-head"><h3>${esc(title)}</h3>${verdict}</div>
      ${headline}
      ${list ? `<ul class="citadel-losses">${list}</ul>` : ''}
      ${why ? `<p class="citadel-why">${why}</p>` : ''}
      <p class="citadel-meta muted-copy">${meta} · <span class="citadel-outcome-pick-hint">${esc(pick)}${selected ? ' ↓' : ''}</span></p>
      <button type="button" class="citadel-outcome-pick" data-${action}="log" data-opener="${esc(opener)}" aria-pressed="${selected}"
        aria-label="${esc(`${title}: ${t('Show the strikes')}`)}"></button>
    </div>`;
}

/** The strike list shows this many strikes; a longer fight says how many more there were. */
export const LOG_LIMIT = 600;

/** One coin flip's strikes, grouped by round, each headed by who opened it. */
export function strikeLogHtml(res, { title, view, sectionKey }) {
  const side = (s) => (s.side === 'you' ? 'you' : 'enemy');
  const groups = [];
  for (const s of res.strikes.slice(0, LOG_LIMIT)) {
    const key = s.phase === 'siege' ? 'siege' : `r${s.round}`;
    let g = groups[groups.length - 1];
    if (!g || g.key !== key) {
      let head;
      if (s.phase === 'siege') head = t('Siege — breaking the walls');
      else if (s.side === 'you') head = t('Round {n} — you strike first', { n: s.round });
      else head = view.roundEnemy(s.round);
      g = { key, head, items: [] };
      groups.push(g);
    }
    g.items.push(s);
  }
  const unit = (id, sd) => `${view.icon(id, sd, 22)}<span>${esc(view.name(id, sd))}</span>`;
  const result = (s) => {
    if (s.side !== 'you') {
      return s.unitsLost > 0
        ? `<span class="citadel-log-result is-loss">${t('−{n} lost', { n: s.unitsLost.toLocaleString() })}</span>`
        : `<span class="citadel-log-result is-free">${t('no loss')}</span>`;
    }
    if (s.killed) return `<span class="citadel-log-result is-kill">${t('destroyed')}</span>`;
    return `<span class="citadel-log-result">${t('{n} left', { n: s.unitsLeft.toLocaleString() })}</span>`;
  };
  const body = groups.map((g) => `
    <li class="citadel-log-group">
      <div class="citadel-log-head">${esc(g.head)}</div>
      <ol class="citadel-log-lines">
        ${g.items.map((s) => {
          const tgtSide = s.side === 'you' ? res.enemySide ?? 'enemy' : 'you';
          const luck = [s.double ? t('double damage') : '', s.second ? t('second squad') : '']
            .filter(Boolean).map((x) => `<span class="citadel-log-tag">${esc(x)}</span>`).join('');
          return `
            <li class="citadel-log-item is-${side(s) === 'you' ? 'you' : 'citadel'}">
              <span class="citadel-log-actor">${unit(s.actor, s.side)}</span>
              <span class="citadel-log-arrow" aria-label="${esc(t('hits'))}">→</span>
              <span class="citadel-log-target">${unit(s.target, tgtSide)}</span>
              <span class="citadel-log-dmg" title="${fmt(s.damage)}">${formatCompact(s.damage)}${luck}</span>
              ${result(s)}
            </li>`;
        }).join('')}
      </ol>
    </li>`).join('');
  const more = res.strikes.length > LOG_LIMIT
    ? `<p class="citadel-log-legend muted-copy">${tn(res.strikes.length - LOG_LIMIT, '… and {n} more strike, to round {round}.', '… and {n} more strikes, to round {round}.', { round: res.rounds.toLocaleString() })}</p>`
    : '';
  return `
    <details class="ui-fold citadel-log" data-section-key="${esc(sectionKey)}">
      <summary class="ui-fold-head"><h2 class="ui-tile-title">${t('Strike by strike')}<span class="citadel-log-which">${esc(title)}</span></h2></summary>
      <div class="ui-fold-body">
        <div class="citadel-log-bar">
          <p class="citadel-log-legend">${t('Each line is one stack hitting another, in the order the game plays them. Red lines are the enemy hitting you; the last column is what each hit cost or left.')}</p>
        </div>
        <div class="citadel-log-cols" aria-hidden="true">
          <span>${t('Attacker')}</span><span></span><span>${t('Target')}</span><span>${t('Damage')}</span><span>${t('Result')}</span>
        </div>
        <ol class="citadel-log-list">${body}</ol>
        ${more}
      </div>
    </details>`;
}
