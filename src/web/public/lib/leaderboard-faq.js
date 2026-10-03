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

const REPO_URL = 'https://github.com/taulen/tb-chest-counter';

// Mirrors GOAL_WARN_RATIO in leaderboard-render.js, as the reader sees it.
const GOAL_WARN_PCT = 66;

const fmt = (n) => Number(n).toLocaleString();

function levelLabel(from, to) {
  return from === to ? String(from) : `${from}–${to}`;
}

// ─── Chest points tab ─────────────────────────────────────────

function renderMatrix(section) {
  const head = section.levels.map((lvl) => `<th class="num" scope="col">${lvl}</th>`).join('');
  const body = section.rows.map((row) => `<tr>
      <th scope="row">${escapeHtml(row.label)}</th>
      ${row.cells.map((c) => (c == null
        ? '<td class="num faq-empty" title="None seen at this level">—</td>'
        : `<td class="num">${fmt(c)}</td>`)).join('')}
    </tr>`).join('');
  return `<section class="faq-points-section faq-points-wide">
    <h3>${escapeHtml(section.title)}</h3>
    <div class="faq-matrix-scroll">
      <table class="faq-table faq-matrix">
        <thead><tr><th scope="col">Level</th>${head}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  </section>`;
}

function renderTiers(section) {
  return `<section class="faq-points-section">
    <h3>${escapeHtml(section.title)}</h3>
    <table class="faq-table">
      <thead><tr><th scope="col">Level</th><th class="num" scope="col">Points</th></tr></thead>
      <tbody>${section.rows.map((r) => `<tr>
        <td>${levelLabel(r.from, r.to)}</td>
        <td class="num">${fmt(r.points)}</td>
      </tr>`).join('')}</tbody>
    </table>
  </section>`;
}

function renderChests(section) {
  return `<section class="faq-points-section">
    <h3>${escapeHtml(section.title)}</h3>
    <table class="faq-table">
      <thead><tr><th scope="col">Chest</th><th class="num" scope="col">Points</th></tr></thead>
      <tbody>${section.rows.map((r) => `<tr>
        <td><div class="cell-stacked">
          <span class="cell-stacked-primary">${escapeHtml(r.chest)}</span>
          <span class="cell-stacked-sub">${escapeHtml(r.source)}</span>
        </div></td>
        <td class="num">${fmt(r.points)}</td>
      </tr>`).join('')}</tbody>
    </table>
  </section>`;
}

function renderPointsTab(guide) {
  const sections = guide?.sections || [];
  if (sections.length === 0) {
    return '<p class="faq-lead">No chests have been scanned yet, so there are no values to show.</p>';
  }
  const wide = sections.filter((s) => s.kind === 'matrix').map(renderMatrix).join('');
  const rest = sections.filter((s) => s.kind !== 'matrix')
    .map((s) => (s.kind === 'tiers' ? renderTiers(s) : renderChests(s)))
    .join('');
  const notCounted = guide.notCounted?.length
    ? `<p class="faq-footnote">Not counted on the leaderboard: ${guide.notCounted.map(escapeHtml).join(', ')} — end-of-event clan rewards. See <em>How it works</em>.</p>`
    : '';
  return `<p class="faq-lead">A chest's points depend on where it came from and its level. Every clan on this site uses the same values.</p>
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
  return `${utc} (${local} your time)`;
}

function renderHowTab({ mode, rolloverHr, goalWeeklyPoints, columns, notCounted }) {
  const items = [];

  items.push(qa('How are points counted?', `<p>When a member opens a crypt, defeats a monster or
    earns an event chest, the game posts a gift in the clan's Gifts tab saying who earned it and
    where it came from. The clan's scanner collects those gifts and credits each one to that
    member, worth the points shown on the <em>Chest points</em> tab.</p>`));

  items.push(qa('When does a day, week or month start?', `<p>Every timeframe follows the game's
    daily reset at ${escapeHtml(rolloverLabel(rolloverHr))}. Weeks start on Sunday at that time,
    months on the 1st.</p>`));

  items.push(qa('How up to date is it?', `<p>The board updates after every scan of the Gifts tab,
    so a chest earned in the last little while may not be on it yet.</p>`));

  const excluded = [];
  if (notCounted.length) {
    excluded.push(`<li><strong>End-of-event clan rewards</strong> — ${notCounted.map(escapeHtml).join(', ')}.
      The game hands these to one account for the whole clan's placement, so counting them would
      rank whoever happened to receive them.</li>`);
  }
  if (mode === 'member') {
    excluded.push(`<li><strong>Triumphal chests</strong> — they have their own ranking on the
      Triumphal Chests page.</li>`);
  }
  if (excluded.length) items.push(qa("What doesn't count?", `<ul>${excluded.join('')}</ul>`));

  if (Number.isFinite(goalWeeklyPoints) && goalWeeklyPoints > 0) {
    items.push(qa('What do the row colours mean?', `<p>The clan's goal is
      <strong>${fmt(goalWeeklyPoints)}</strong> points a week, scaled to the timeframe you're
      viewing. Green: goal reached. Amber: at least ${GOAL_WARN_PCT}% of it. Red: below that.</p>`));
  }
  if (columns.guards) {
    items.push(qa('What is the Guards column?', `<p>An estimate of each member's Guardsmen level,
      worked out from their Omen Essence and Scientific Tractates donations — it isn't read from
      the game. Hover a value to see how sure it is and how recent; a <strong>?</strong> means a
      single ambiguous donation is all it rests on.</p>`));
  }
  if (columns.goldPass) {
    items.push(qa('What does GP mean?', `<p>A Gold Pass holder this Triumphal cycle, spotted from a
      pass-reward Union Chest plus the 250k Scientific Tractates that come with it. A faded GP was
      seen last cycle but not yet this one.</p>`));
  }
  if (columns.might) {
    items.push(qa('Where do Level and Might come from?', `<p>The hero level and Might on each
      member's in-game profile, as of the latest daily snapshot.</p>`));
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
    <div class="faq-contact-head">Site admin</div>
    <p>Runs this site and sets the chest values for every clan.${reason ? ` ${reason}` : ''}</p>
    ${chipsHtml(siteAdmins)}
  </div>`;
}

function renderAccessTab({ clanName, contacts }) {
  const clan = escapeHtml(clanName || 'your clan');
  const admins = contacts?.clanAdmins || [];
  const site = contacts?.siteAdmins || [];
  const loginHref = `${window.location.origin}/login`;
  const loginLabel = `${window.location.host}/login`;

  const askStep = admins.length
    ? `<li>
        <div class="faq-step-title">Ask a ${clan} admin for an account</div>
        <p>Message one of them in-game or on your clan's Discord. These are their names on this site:</p>
        ${chipsHtml(admins)}
      </li>`
    : `<li>
        <div class="faq-step-title">Ask the site admin for an account</div>
        <p>${clan} has no admins on this site yet, so the site admin is the one to ask${site.length ? ':' : '.'}</p>
        ${site.length ? chipsHtml(site) : ''}
      </li>`;

  return `<p class="faq-lead">This page is a read-only view of ${clan}'s leaderboard. With an account
      you also get each member's chest history and profile, analytics, events and more.</p>
    <ol class="faq-steps">
      ${askStep}
      <li>
        <div class="faq-step-title">Get your login</div>
        <p>They create your account and send you a username and password.</p>
      </li>
      <li>
        <div class="faq-step-title">Sign in</div>
        <p>Go to <a href="${esc(loginHref)}">${escapeHtml(loginLabel)}</a> and sign in.</p>
      </li>
    </ol>
    ${admins.length ? siteAdminCard(site, "Contact them if you can't reach your clan's admins, or want the tracker for another clan.") : ''}`;
}

function renderContactsTab({ contacts }) {
  const admins = contacts?.clanAdmins || [];
  const site = contacts?.siteAdmins || [];
  return `<p class="faq-lead">Missing chests, a value that looks wrong, or a clanmate who needs an
      account? Here's who to ask.</p>
    <div class="faq-contact-card">
      <div class="faq-contact-head">Clan admins</div>
      <p>Manage your clan's members and site accounts.</p>
      ${admins.length ? chipsHtml(admins) : '<p class="faq-none">No clan admins on the site yet.</p>'}
    </div>
    ${siteAdminCard(site, 'Ask them about chest values, or if your clan admins are unavailable.')}`;
}

// ─── Modal ────────────────────────────────────────────────────

function renderFaqHtml(data, opts) {
  const guide = data?.pointsGuide || { sections: [], notCounted: [] };
  const tabs = [
    ['points', 'Chest points', renderPointsTab(guide)],
    ['how', 'How it works', renderHowTab({ ...opts, notCounted: guide.notCounted || [] })],
    opts.mode === 'public'
      ? ['access', 'Get full access', renderAccessTab({ clanName: opts.clanName, contacts: data?.contacts })]
      : ['contacts', 'Contacts', renderContactsTab({ contacts: data?.contacts })],
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
    <div class="faq-footer">TB Chest Counter is open source —
      <a href="${REPO_URL}" target="_blank" rel="noopener noreferrer">see it on GitHub ↗</a></div>`;
}

/**
 * Open the FAQ modal.
 *
 *  - `load`    — () => Promise<{ pointsGuide, contacts }>, the page's own fetch
 *                (authenticated api() or the public token endpoint).
 *  - `mode`    — 'member' | 'public'.
 *  - `clanName`, `rolloverHr`, `goalWeeklyPoints` — copy inputs the page has.
 *  - `columns` — { guards, might, goldPass }: which extras the board on screen
 *                shows, so the FAQ only explains what the reader can see.
 *  - `initialTab` — 'points' (default) | 'how' | 'access' | 'contacts'.
 */
export async function openLeaderboardFaq({
  load,
  mode = 'member',
  clanName = '',
  rolloverHr = 17,
  goalWeeklyPoints = null,
  columns = {},
  initialTab = 'points',
}) {
  const modal = contentModal({
    title: 'Leaderboard FAQ',
    html: '<p class="is-loading">Loading…</p>',
    wide: true,
    className: 'faq-modal',
  });
  if (!modal) return;

  let data;
  try {
    data = await load();
  } catch {
    modal.setHtml('<p class="faq-lead">Couldn\'t load the FAQ. Close this and try again in a moment.</p>');
    return;
  }
  modal.setHtml(renderFaqHtml(data, { mode, clanName, rolloverHr, goalWeeklyPoints, columns, initialTab }));

  modal.content.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-faq-tab]');
    if (!tab) return;
    const key = tab.dataset.faqTab;
    modal.content.querySelectorAll('[data-faq-tab]').forEach((t) => {
      const on = t.dataset.faqTab === key;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', String(on));
    });
    modal.content.querySelectorAll('[data-faq-panel]').forEach((p) => {
      p.hidden = p.dataset.faqPanel !== key;
    });
    const panels = modal.content.querySelector('.faq-panels');
    if (panels) panels.scrollTop = 0;
  });
}
