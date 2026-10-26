// Leaderboard FAQ modal, shared by the authenticated /#leaderboard page and
// the public share page — same reasoning as leaderboard-render.js: one
// renderer, so the two can never explain the board differently.
//
// The points table comes from the server (GET /api/leaderboard/faq or
// /api/public/:token/faq), built from the live scoring table, so it is never a
// hand-kept copy that drifts. Everything else here is copy, switched by
// `mode`:
//
//  - 'member' — a signed-in user: a Contacts tab (clan admins + site admin).
//  - 'public' — an anonymous share-link visitor: a "Get full access" tab that
//    walks them to an account, naming THIS clan's admins.
//
// Keep it framework-free and its imports inside PUBLIC_SHARE_ASSETS — the
// public page loads it without a session.

import { escapeHtml, esc, contentModal } from './ui.js';
import { t, tn, tGame } from './i18n.js';

const REPO_URL = 'https://github.com/taulen/tb-chest-counter';

// Mirrors GOAL_WARN_RATIO in leaderboard-render.js, as the reader sees it.
const GOAL_WARN_PCT = 66;

const fmt = (n) => Number(n).toLocaleString();

function levelLabel(from, to) {
  return from === to ? String(from) : `${from}–${to}`;
}

// ─── Chest points tab ─────────────────────────────────────────

// Section headings, by the server's section key (points-guide.ts). A key this
// list doesn't know falls back to the server's English title.
const SECTION_TITLES = {
  crypts: t('Crypts & Citadels'),
  heroic: t('Heroic Monsters'),
  squads: t('Epic Squads'),
  runic: t('Runic Raids'),
  vault: tGame('Vault of the Ancients'),
  events: t('Events'),
  tournaments: t('Tournaments'),
  shops: t('Shops'),
  other: t('Other'),
};

function sectionTitle(section) {
  return SECTION_TITLES[section.key] || section.title;
}

function renderMatrix(section) {
  const head = section.levels.map((lvl) => `<th class="num" scope="col">${lvl}</th>`).join('');
  const body = section.rows.map((row) => `<tr>
      <th scope="row">${escapeHtml(tGame(row.label))}</th>
      ${row.cells.map((c) => (c == null
        ? `<td class="num faq-empty" title="${t('None seen at this level')}">—</td>`
        : `<td class="num">${fmt(c)}</td>`)).join('')}
    </tr>`).join('');
  return `<section class="faq-points-section faq-points-wide">
    <h3>${escapeHtml(sectionTitle(section))}</h3>
    <div class="faq-matrix-scroll">
      <table class="faq-table faq-matrix">
        <thead><tr><th scope="col">${t('Level')}</th>${head}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  </section>`;
}

function renderTiers(section) {
  return `<section class="faq-points-section">
    <h3>${escapeHtml(sectionTitle(section))}</h3>
    <table class="faq-table">
      <thead><tr><th scope="col">${t('Level')}</th><th class="num" scope="col">${t('Points')}</th></tr></thead>
      <tbody>${section.rows.map((r) => `<tr>
        <td>${levelLabel(r.from, r.to)}</td>
        <td class="num">${fmt(r.points)}</td>
      </tr>`).join('')}</tbody>
    </table>
  </section>`;
}

function renderChests(section) {
  return `<section class="faq-points-section">
    <h3>${escapeHtml(sectionTitle(section))}</h3>
    <table class="faq-table">
      <thead><tr><th scope="col">${t('Chest')}</th><th class="num" scope="col">${t('Points')}</th></tr></thead>
      <tbody>${section.rows.map((r) => `<tr>
        <td><div class="cell-stacked">
          <span class="cell-stacked-primary">${escapeHtml(tGame(r.chest))}</span>
          <span class="cell-stacked-sub">${escapeHtml(tGame(r.source))}</span>
        </div></td>
        <td class="num">${fmt(r.points)}</td>
      </tr>`).join('')}</tbody>
    </table>
  </section>`;
}

function renderPointsTab(guide) {
  const sections = guide?.sections || [];
  if (sections.length === 0) {
    return `<p class="faq-lead">${t('No chests have been scanned yet, so there are no values to show.')}</p>`;
  }
  const wide = sections.filter((s) => s.kind === 'matrix').map(renderMatrix).join('');
  const rest = sections.filter((s) => s.kind !== 'matrix')
    .map((s) => (s.kind === 'tiers' ? renderTiers(s) : renderChests(s)))
    .join('');
  const notCounted = guide.notCounted?.length
    ? `<p class="faq-footnote">${t('Not counted on the leaderboard: {chests} — end-of-event clan rewards. See <em>How it works</em>.', { chests: guide.notCounted.map((name) => escapeHtml(tGame(name))).join(', ') })}</p>`
    : '';
  return `<p class="faq-lead">${t("A chest's points depend on where it came from and its level. Each clan on this site has its own values; these are this clan's.")}</p>
    ${wide}
    <div class="faq-points-grid">${rest}</div>
    ${notCounted}`;
}

// ─── How it works tab ─────────────────────────────────────────

function qa(question, answerHtml) {
  return `<div class="faq-qa"><h4>${escapeHtml(question)}</h4>${answerHtml}</div>`;
}

/** "17:00 UTC (19:00 your time)", or just "17:00 UTC" for a viewer on UTC. */
function rolloverLabel(hr) {
  const utc = `${String(hr).padStart(2, '0')}:00 UTC`;
  const d = new Date();
  d.setUTCHours(hr, 0, 0, 0);
  if (d.getHours() === hr && d.getMinutes() === 0) return utc;
  const local = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return t('{utc} ({local} your time)', { utc, local });
}

function renderHowTab({ mode, rolloverHr, board, notCounted }) {
  const { goalWeeklyPoints = null, guards = false, might = false, goldPass = false } = board || {};
  const items = [];

  items.push(qa(t('How are points counted?'), `<p>${t("When a member opens a crypt, defeats a monster or earns an event chest, the game posts a gift in the clan's Gifts tab saying who earned it and where it came from. The clan's scanner collects those gifts and credits each one to that member, worth the points shown on the <em>Chest points</em> tab.")}</p>`));

  items.push(qa(t('When does a day, week or month start?'), `<p>${t("Every timeframe follows the game's daily reset at {time}. Weeks start on Sunday at that time, months on the 1st.", { time: escapeHtml(rolloverLabel(rolloverHr)) })}</p>`));

  items.push(qa(t('How up to date is it?'), `<p>${t('The board updates after every scan of the Gifts tab, so a chest earned in the last little while may not be on it yet.')}</p>`));

  const excluded = [];
  if (notCounted.length) {
    excluded.push(`<li>${t("<strong>End-of-event clan rewards</strong> — {chests}. The game hands these to one account for the whole clan's placement, so counting them would rank whoever happened to receive them.", { chests: notCounted.map((name) => escapeHtml(tGame(name))).join(', ') })}</li>`);
  }
  // Both modes: a share-link visitor opens triumphal chests too, and "why don't
  // mine count?" is theirs to ask as much as a member's.
  excluded.push(mode === 'member'
    ? `<li>${t('<strong>Triumphal chests</strong> — they have their own ranking on the Triumphal Chests page.')}</li>`
    : `<li>${t("<strong>Triumphal chests</strong> — they're tracked separately, on their own page on the full site (see <em>Get full access</em>).")}</li>`);
  if (excluded.length) items.push(qa(t("What doesn't count?"), `<ul>${excluded.join('')}</ul>`));

  if (Number.isFinite(goalWeeklyPoints) && goalWeeklyPoints > 0) {
    items.push(qa(t('What do the row colours mean?'), `<p>${tn(
      goalWeeklyPoints,
      "The clan's goal is <strong>{n}</strong> point a week, scaled to the timeframe you're viewing. ✓ Green: goal reached. ◐ Amber: at least {pct}% of it. ↓ Red: below that. The symbol in front of each member's points says the same as the colour.",
      "The clan's goal is <strong>{n}</strong> points a week, scaled to the timeframe you're viewing. ✓ Green: goal reached. ◐ Amber: at least {pct}% of it. ↓ Red: below that. The symbol in front of each member's points says the same as the colour.",
      { n: fmt(goalWeeklyPoints), pct: GOAL_WARN_PCT },
    )}</p>`));
  }
  if (guards) {
    items.push(qa(t('What is the Guards column?'), `<p>${t("An estimate of each member's Guardsmen level, worked out from their {essence} and {tractates} donations — it isn't read from the game. Hover a value to see how sure it is and how recent; a <strong>?</strong> means a single ambiguous donation is all it rests on.", { essence: tGame('Omen Essence'), tractates: tGame('Scientific Tractates') })}</p>`));
  }
  if (goldPass) {
    items.push(qa(t('What does GP mean?'), `<p>${t('A Gold Pass holder this Triumphal cycle, spotted from a pass-reward {chest} plus the 250k {tractates} that come with it. A faded GP was seen last cycle but not yet this one.', { chest: tGame('Union Chest'), tractates: tGame('Scientific Tractates') })}</p>`));
  }
  if (might) {
    items.push(qa(t('Where do Level and Might come from?'), `<p>${t("The hero level and Might on each member's in-game profile, as of the latest daily snapshot.")}</p>`));
  }

  return `<div class="faq-qa-list">${items.join('')}</div>`;
}

// ─── Access / contacts tab ────────────────────────────────────

const PERSON_ICON = `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><circle cx="8" cy="5.2" r="2.7" fill="currentColor"/><path d="M2.6 14c.5-2.9 2.7-4.6 5.4-4.6s4.9 1.7 5.4 4.6z" fill="currentColor"/></svg>`;

function chipsHtml(names) {
  return `<div class="faq-chips">${names.map((n) =>
    `<span class="faq-chip">${PERSON_ICON}${escapeHtml(n)}</span>`).join('')}</div>`;
}

function siteAdminCard(siteAdmins, reason) {
  if (!siteAdmins.length) return '';
  return `<div class="faq-contact-card">
    <div class="faq-contact-head">${t('Site admin')}</div>
    <p>${t('Runs this site and sets the chest values for every clan.')}${reason ? ` ${reason}` : ''}</p>
    ${chipsHtml(siteAdmins)}
  </div>`;
}

function renderAccessTab({ clanName, contacts }) {
  const clan = escapeHtml(clanName || t('your clan'));
  const admins = contacts?.clanAdmins || [];
  const site = contacts?.siteAdmins || [];
  const loginHref = `${window.location.origin}/login`;
  const loginLabel = `${window.location.host}/login`;

  const askStep = admins.length
    ? `<li>
        <div class="faq-step-title">${t('Ask a {clan} admin for an account', { clan })}</div>
        <p>${t("Message one of them in-game or on your clan's Discord. These are their names on this site:")}</p>
        ${chipsHtml(admins)}
      </li>`
    : `<li>
        <div class="faq-step-title">${t('Ask the site admin for an account')}</div>
        <p>${site.length
          ? t('{clan} has no admins on this site yet, so the site admin is the one to ask:', { clan })
          : t('{clan} has no admins on this site yet, so the site admin is the one to ask.', { clan })}</p>
        ${site.length ? chipsHtml(site) : ''}
      </li>`;

  return `<p class="faq-lead">${t("This page is a read-only view of {clan}'s leaderboard. With an account you also get each member's chest history and profile, analytics, events and more.", { clan })}</p>
    <ol class="faq-steps">
      ${askStep}
      <li>
        <div class="faq-step-title">${t('Get your login')}</div>
        <p>${t('They create your account and send you a username and password.')}</p>
      </li>
      <li>
        <div class="faq-step-title">${t('Sign in')}</div>
        <p>${t('Go to {link} and sign in.', { link: `<a href="${esc(loginHref)}">${escapeHtml(loginLabel)}</a>` })}</p>
      </li>
    </ol>
    ${admins.length ? siteAdminCard(site, t("Contact them if you can't reach your clan's admins, or want the tracker for another clan.")) : ''}`;
}

function renderContactsTab({ contacts }) {
  const admins = contacts?.clanAdmins || [];
  const site = contacts?.siteAdmins || [];
  return `<p class="faq-lead">${t("Missing chests, a value that looks wrong, or a clanmate who needs an account? Here's who to ask.")}</p>
    <div class="faq-contact-card">
      <div class="faq-contact-head">${t('Clan admins')}</div>
      <p>${t("Manage your clan's members and site accounts.")}</p>
      ${admins.length ? chipsHtml(admins) : `<p class="faq-none">${t('No clan admins on the site yet.')}</p>`}
    </div>
    ${siteAdminCard(site, t('Ask them about chest values, or if your clan admins are unavailable.'))}`;
}

// ─── Modal ────────────────────────────────────────────────────

function renderFaqHtml(data, opts) {
  const guide = data?.pointsGuide || { sections: [], notCounted: [] };
  const tabs = [
    ['points', t('Chest points'), renderPointsTab(guide)],
    ['how', t('How it works'), renderHowTab({
      mode: opts.mode,
      rolloverHr: opts.rolloverHr,
      board: data?.board,
      notCounted: guide.notCounted || [],
    })],
    opts.mode === 'public'
      ? ['access', t('Get full access'), renderAccessTab({ clanName: opts.clanName, contacts: data?.contacts })]
      : ['contacts', t('Contacts'), renderContactsTab({ contacts: data?.contacts })],
  ];
  const active = tabs.some(([key]) => key === opts.initialTab) ? opts.initialTab : tabs[0][0];
  return `<div class="resources-tabs faq-tabs" role="tablist">
      ${tabs.map(([key, label]) => `<button type="button" role="tab"
        class="resources-tab${key === active ? ' is-active' : ''}" aria-selected="${key === active}"
        data-faq-tab="${key}">${label}</button>`).join('')}
    </div>
    <div class="faq-panels">
      ${tabs.map(([key, , html]) => `<div class="faq-panel" role="tabpanel" data-faq-panel="${key}"${key === active ? '' : ' hidden'}>${html}</div>`).join('')}
    </div>
    <div class="faq-footer">${t('TB Chest Counter is open source — {link}', { link: `<a href="${REPO_URL}" target="_blank" rel="noopener noreferrer">${t('see it on GitHub ↗')}</a>` })}</div>`;
}

/**
 * Open the FAQ modal.
 *
 *  - `load`    — () => Promise<{ pointsGuide, contacts, board }>, the page's
 *                own fetch (authenticated api() or the public token endpoint).
 *  - `mode`    — 'member' | 'public'.
 *  - `clanName`, `rolloverHr` — copy inputs the page already holds from init.
 *  - `initialTab` — 'points' (default) | 'how' | 'access' | 'contacts'.
 *
 * Which goal / Guards / GP / Might answers appear is decided by the SERVER
 * (`board`), never by what the opening page happens to have rendered: the
 * FAQ can open before the board has, and it must read the same either way.
 */
export async function openLeaderboardFaq({
  load,
  mode = 'member',
  clanName = '',
  rolloverHr = 17,
  initialTab = 'points',
}) {
  const modal = contentModal({
    title: t('Leaderboard FAQ'),
    html: `<p class="is-loading">${t('Loading…')}</p>`,
    wide: true,
    className: 'faq-modal',
  });
  if (!modal) return;

  let data;
  try {
    data = await load();
  } catch {
    modal.setHtml(`<p class="faq-lead">${t('Couldn\'t load the FAQ. Close this and try again in a moment.')}</p>`);
    return;
  }
  modal.setHtml(renderFaqHtml(data, { mode, clanName, rolloverHr, initialTab }));

  modal.content.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-faq-tab]');
    if (!tab) return;
    const key = tab.dataset.faqTab;
    modal.content.querySelectorAll('[data-faq-tab]').forEach((tabBtn) => {
      const on = tabBtn.dataset.faqTab === key;
      tabBtn.classList.toggle('is-active', on);
      tabBtn.setAttribute('aria-selected', String(on));
    });
    modal.content.querySelectorAll('[data-faq-panel]').forEach((p) => {
      p.hidden = p.dataset.faqPanel !== key;
    });
    const panels = modal.content.querySelector('.faq-panels');
    if (panels) panels.scrollTop = 0;
  });
}
