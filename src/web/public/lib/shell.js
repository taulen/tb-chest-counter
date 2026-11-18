/**
 * The app shell (index.html, style.css "App shell"): the sidebar and its three
 * layouts, the clan switcher, the account menu, the phone tab bar and its More
 * sheet, and the rail's tooltips. Page routing, the scanner's polling and the
 * role gating of the nav links stay in app.js; this module owns how the shell
 * shows them.
 *
 *   ≥1100px  the full sidebar, folding to an icon rail (remembered per browser
 *            in localStorage 'navRail'; the inline script in index.html reads
 *            it before first paint).
 *   641–1099 the icon rail; the fold button unfolds it over the page.
 *   ≤640px   a bottom tab bar; More opens the sidebar itself as a sheet.
 *
 * html[data-nav] is 'rail' or 'full' and is the only thing the CSS keys the
 * rail on, so the first paint and every later change agree.
 */
import { t } from './i18n.js';
import { esc, formatRelativeTime, holdDialogFocus } from './ui.js';
import { paintAvatar } from './avatar.js';

const RAIL_KEY = 'navRail';
const phoneMq = window.matchMedia('(max-width: 640px)');
const desktopMq = window.matchMedia('(min-width: 1100px)');

const byId = (id) => document.getElementById(id);

/** Tablet only: the rail unfolded over the page. */
let peek = false;
/** release() for the open sheet / unfolded rail (holdDialogFocus). */
let releaseOverlay = null;
/** The switcher's last answer, kept to re-render clan statuses between fetches. */
let clanData = { clans: [], activeClanId: null };
let canSwitch = false;
// A code adds a clan to (or links) an account; the superadmin never is one.
let canAddClan = false;
let runningClanIds = new Set();

function readRailPref() {
  try { return localStorage.getItem(RAIL_KEY) === '1'; } catch { return false; }
}
function writeRailPref(on) {
  try { localStorage.setItem(RAIL_KEY, on ? '1' : '0'); } catch { /* lasts this page only */ }
}

const isRail = () => document.documentElement.dataset.nav === 'rail';
const isPhone = () => phoneMq.matches;

/** Derive the sidebar's width from the viewport, the stored choice and a tablet peek. */
function syncNavMode() {
  const html = document.documentElement;
  if (desktopMq.matches || isPhone()) peek = false;
  html.dataset.nav = desktopMq.matches ? (readRailPref() ? 'rail' : 'full') : (peek ? 'full' : 'rail');
  html.toggleAttribute('data-nav-peek', peek);
  const folded = isRail();
  const btn = byId('shellFoldBtn');
  const label = byId('shellFoldLabel');
  const text = folded ? t('Show the full menu') : t('Fold the menu to icons');
  if (label) label.textContent = text;
  if (btn) {
    btn.setAttribute('aria-expanded', String(!folded));
    btn.dataset.tip = text;
  }
  hideTip();
}

// ─── The sheet (phone) and the unfolded rail (tablet) ───

function markDialog(side, on) {
  if (on) {
    side.setAttribute('role', 'dialog');
    side.setAttribute('aria-modal', 'true');
  } else {
    side.removeAttribute('role');
    side.removeAttribute('aria-modal');
  }
}

function showScrim(on) {
  const scrim = byId('shellScrim');
  if (scrim) scrim.hidden = !on;
}

function openSheet() {
  const side = byId('shellSide');
  const more = byId('shellMoreBtn');
  if (!side || side.classList.contains('is-open')) return;
  closePopovers();
  side.classList.add('is-open');
  markDialog(side, true);
  more?.setAttribute('aria-expanded', 'true');
  more?.classList.add('is-open');
  document.body.classList.add('shell-locked');
  showScrim(true);
  side.scrollTop = 0;
  releaseOverlay = holdDialogFocus(side, {
    initial: byId('shellSheetClose'),
    onEscape: closeShellOverlay,
    keepLive: [byId('shellScrim'), byId('shellTabbar')],
    returnTo: more,
  });
}

function openPeek() {
  const side = byId('shellSide');
  if (!side) return;
  peek = true;
  syncNavMode();
  markDialog(side, true);
  showScrim(true);
  releaseOverlay = holdDialogFocus(side, {
    initial: byId('shellFoldBtn'),
    onEscape: closeShellOverlay,
    keepLive: [byId('shellScrim')],
  });
}

/** Close the phone sheet or the tablet's unfolded rail, whichever is open. */
export function closeShellOverlay() {
  const side = byId('shellSide');
  const more = byId('shellMoreBtn');
  closePopovers();
  if (side) {
    side.classList.remove('is-open');
    markDialog(side, false);
  }
  more?.setAttribute('aria-expanded', 'false');
  more?.classList.remove('is-open');
  document.body.classList.remove('shell-locked');
  showScrim(false);
  if (peek) {
    peek = false;
    syncNavMode();
  }
  if (releaseOverlay) {
    const release = releaseOverlay;
    releaseOverlay = null;
    release();
  }
}

function onFold() {
  if (desktopMq.matches) {
    closePopovers();
    writeRailPref(!isRail());
    syncNavMode();
    return;
  }
  if (peek) closeShellOverlay();
  else openPeek();
}

// ─── Popovers: the clan switcher and the account menu ───
// Fixed-positioned beside their button, because the sidebar scrolls and would
// clip them. In the phone sheet both are laid out inline instead (CSS), and
// never open as popovers.

function placePopover(pop, anchor, { above = false } = {}) {
  if (isPhone()) {
    pop.style.cssText = '';
    return;
  }
  const r = anchor.getBoundingClientRect();
  const margin = 12;
  const vh = window.innerHeight;
  // Rail: beside the button, aligned to its top (or its bottom when it sits
  // at the foot). Full sidebar: under the button (or above it, at the foot),
  // at least as wide as the sidebar's controls.
  const left = isRail() ? r.right + 10 : r.left;
  const width = isRail() ? 320 : Math.max(r.width, 280);
  let top = 'auto';
  let bottom = 'auto';
  let room;
  if (above) {
    const edge = isRail() ? r.bottom : r.top - 6;
    bottom = `${Math.round(vh - edge)}px`;
    room = edge - margin;
  } else {
    const edge = isRail() ? Math.max(margin, r.top) : r.bottom + 6;
    top = `${Math.round(edge)}px`;
    room = vh - edge - margin;
  }
  pop.style.position = 'fixed';
  pop.style.left = `${Math.round(Math.min(left, window.innerWidth - width - margin))}px`;
  pop.style.right = 'auto';
  pop.style.width = `${Math.round(width)}px`;
  pop.style.top = top;
  pop.style.bottom = bottom;
  pop.style.maxHeight = `${Math.max(160, Math.round(room))}px`;
}

function setPopover(btnId, popId, open, opts) {
  const btn = byId(btnId);
  const pop = byId(popId);
  if (!btn || !pop) return;
  if (open) {
    // Out of the flow BEFORE it shows. Unhidden in place, the account menu sat
    // in the sidebar's column for a moment and pushed the account button up by
    // its own height (the block is pinned to the foot with margin-top: auto);
    // the button was measured up there, so the menu opened that far above it.
    if (!isPhone()) pop.style.position = 'fixed';
    pop.hidden = false;
    placePopover(pop, btn, opts);
    btn.setAttribute('aria-expanded', 'true');
  } else {
    pop.hidden = true;
    // Its fixed placement must not follow it into the phone sheet, where the
    // same element is laid out inline.
    pop.style.cssText = '';
    btn.setAttribute('aria-expanded', 'false');
  }
}

const isOpen = (popId) => {
  const pop = byId(popId);
  return !!pop && !pop.hidden && !isPhone();
};

export function closeUserMenu() {
  if (!isPhone()) setPopover('userMenuBtn', 'userMenu', false);
}

function closeClanPopover() {
  if (!isPhone()) setPopover('shellClanBtn', 'shellClanPop', false);
}

function closePopovers() {
  closeUserMenu();
  closeClanPopover();
}

function toggleUserMenu() {
  if (isPhone()) return;
  const open = !isOpen('userMenu');
  closeClanPopover();
  setPopover('userMenuBtn', 'userMenu', open, { above: true });
}

function toggleClanPopover() {
  if (isPhone()) return;
  const open = !isOpen('shellClanPop');
  closeUserMenu();
  setPopover('shellClanBtn', 'shellClanPop', open);
  if (open) byId('shellClanPop')?.querySelector('[aria-current="true"], button')?.focus();
}

// ─── The clan block ───

function initials(c) {
  const code = (c.shortCode || '').trim();
  if (code) return code.slice(0, 3).toUpperCase();
  const words = String(c.name || '?').replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/);
  return (words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)).toUpperCase();
}

function logoHtml(c) {
  return c.logoUrl
    ? `<img class="shell-clan-logo" src="${esc(c.logoUrl)}" alt="" width="36" height="36" decoding="async">`
    : `<span class="shell-clan-logo is-initials" aria-hidden="true">${esc(initials(c))}</span>`;
}

/**
 * "CWB - ChaosWithoutBorders" → { tag: 'CWB', name: 'ChaosWithoutBorders' }:
 * the tag goes on the small line above, so the name gets a line to itself.
 * The clan's short code wins; otherwise a leading 2–6 character tag followed
 * by a dash, bar or colon is taken as one.
 */
function splitClanName(c) {
  const full = String(c.name || '').trim();
  const code = (c.shortCode || '').trim();
  const m = full.match(/^([^\s\-–—|:]{2,6})\s*[-–—|:]\s*(.+)$/u);
  if (m && (!code || m[1].toLowerCase() === code.toLowerCase())) return { tag: code || m[1], name: m[2] };
  return { tag: code, name: full };
}

/** "<b>CWB</b> · Kingdom #260" (HTML), or '' when there is neither. */
function clanEyebrowHtml(c, tag) {
  const parts = [];
  if (tag) parts.push(`<b>${esc(tag)}</b>`);
  if (c.kingdom) parts.push(esc(t('Kingdom #{n}', { n: c.kingdom })));
  return parts.join(' · ');
}

function clanLastScan(c) {
  return c.lastScanAt ? t('Scanned {when}', { when: formatRelativeTime(c.lastScanAt) }) : t('Not scanned yet');
}

/** The one status a clan row carries: glyph + words, never colour alone. */
function clanStatus(c) {
  if (c.needsReauth) return { cls: 'is-bad', glyph: '!', text: t('Needs re-authentication') };
  if (runningClanIds.has(c.id)) return { cls: 'is-busy', glyph: '◐', text: t('Scanning') };
  if (!c.isActive) return { cls: 'is-muted', glyph: '‖', text: t('Paused') };
  return { cls: 'is-ok', glyph: '✓', text: t('Active') };
}

function statusHtml(c) {
  const s = clanStatus(c);
  return `<span class="shell-clan-status ${s.cls}"><span aria-hidden="true">${s.glyph}</span> ${esc(s.text)}</span>`;
}

/**
 * Tag + kingdom, the name, the last scan — each on its own line. The name's
 * font scales down (style.css, --fit) until its longest word fits the box, so
 * "ChaosWithoutBorders" stays whole instead of ending in "…".
 */
function clanTextHtml(c, extra = '') {
  const { tag, name } = splitClanName(c);
  const eyebrow = clanEyebrowHtml(c, tag);
  const longestWord = Math.max(...name.split(/\s+/).map((w) => [...w].length), 1);
  return `<span class="shell-clan-text">
      ${eyebrow ? `<span class="shell-clan-eyebrow">${eyebrow}</span>` : ''}
      <span class="shell-clan-name" style="--fit:${longestWord}">${esc(name)}</span>
      <span class="shell-clan-sub">${esc(clanLastScan(c))}</span>
      ${extra}
    </span>`;
}

function renderClanBlock() {
  const box = byId('shellClan');
  if (!box) return;
  const { clans, activeClanId } = clanData;
  const active = clans.find((c) => c.id === activeClanId) ?? clans[0];
  if (!active) {
    box.innerHTML = '';
    renderPhonebarClan(null);
    return;
  }
  renderPhonebarClan(active);
  // "Add a clan": a code from another clan's tracker (lib/add-clan.js, via
  // the tb:add-clan event app.js listens for). Under a one-clan label it only
  // shows in the phone's More sheet (style.css), where the label is the list.
  const addClan = (extra = '') => (canAddClan
    ? `<button type="button" class="shell-clan-add${extra}"><span aria-hidden="true">+</span> ${esc(t('Add a clan'))}</button>`
    : '');
  if (!canSwitch || clans.length < 2) {
    box.innerHTML = `<div class="shell-clan-label" data-tip="${esc(active.name)}">
        ${logoHtml(active)}${clanTextHtml(active)}
      </div>${addClan(' is-sheet-only')}`;
    return;
  }
  const manage = byId('navClans') && !byId('navClans').classList.contains('is-hidden')
    ? `<a class="shell-clan-manage" href="#clans">${esc(t('Manage clans'))}</a>`
    : '';
  box.innerHTML = `
    <button class="shell-clan-btn" id="shellClanBtn" type="button" aria-haspopup="true" aria-expanded="false" aria-controls="shellClanPop" data-tip="${esc(active.name)}">
      ${logoHtml(active)}${clanTextHtml(active)}
      <span class="visually-hidden">${esc(t('Switch clan'))}</span>
      <svg class="nav-icon shell-clan-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>
    </button>
    <div class="shell-clan-pop" id="shellClanPop" hidden>
      <div class="shell-label" id="shellClanPopLabel">${esc(t('Switch clan'))}</div>
      <ul class="shell-clan-list" aria-labelledby="shellClanPopLabel">
        ${clans.map((c) => `<li>
          <button type="button" class="shell-clan-option" data-clan-id="${c.id}"${c.id === active.id ? ' aria-current="true"' : ''}>
            ${logoHtml(c)}
            ${clanTextHtml(c, statusHtml(c))}
          </button>
        </li>`).join('')}
      </ul>
      ${addClan()}
      ${manage}
    </div>`;
}

function renderPhonebarClan(c) {
  const el = byId('phonebarClan');
  if (!el) return;
  el.innerHTML = c ? `${logoHtml(c)}<span class="shell-phonebar-clan-name">${esc(c.name)}</span>` : '';
}

/**
 * Load the clans this account may switch to (GET /api/clans/switcher) and
 * draw the clan block: a switcher for an account that can change clans — a
 * superadmin, or an account granted extra clans — and a plain label for
 * everyone else. Called at sign-in and after a clan is renamed.
 */
export async function refreshClanSwitcher(user) {
  canSwitch = !!user && (user.role === 'superadmin' || !!user.multiClan);
  canAddClan = !!user && user.role !== 'superadmin';
  try {
    const res = await fetch('/api/clans/switcher', { cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    clanData = {
      clans: Array.isArray(data.clans) ? data.clans : [],
      activeClanId: data.activeClanId ?? null,
    };
  } catch {
    // Keep the name /auth/me gave, so the shell still says which clan this is.
    const name = user?.activeClan?.name;
    clanData = name
      ? { clans: [{ id: user.activeClan.id ?? 0, name, shortCode: '', kingdom: null, logoUrl: null, lastScanAt: null, isActive: true }], activeClanId: user.activeClan.id ?? 0 }
      : { clans: [], activeClanId: null };
  }
  renderClanBlock();
}

async function switchClan(id) {
  if (!Number.isFinite(id) || id === clanData.activeClanId) {
    closeClanPopover();
    return;
  }
  try {
    const r = await fetch(`/api/clans/${id}/activate`, { method: 'POST' });
    if (!r.ok) return;
    // Every page reads the active clan; a reload is cheaper than threading a
    // clan-changed event through all of them.
    window.location.reload();
  } catch {
    // Stay on this clan; the switcher is still there to try again.
  }
}

// ─── The scanner's state, as the shell shows it ───

const GLYPHS = { idle: '✓', scanning: '◐', error: '!', offline: '!', loading: '·' };

/**
 * app.js's status poll hands the shell what it decided: `kind` is idle /
 * scanning / error / offline, `text` the state line, `next` the countdown
 * line, `runningClanIds` the clans being scanned (for the switcher rows).
 */
export function setShellScanState({ kind, text, next = '', runningClanIds: ids = [] }) {
  const scanner = byId('shellScanner');
  if (scanner) scanner.dataset.state = kind;
  const glyph = byId('statusGlyph');
  if (glyph) glyph.textContent = GLYPHS[kind] ?? '·';
  const state = scanner?.querySelector('.shell-scanner-state');
  if (state) state.dataset.tip = next ? `${text} · ${next}` : text;

  const phone = byId('phonebarStatus');
  if (phone) {
    const show = kind === 'scanning' || kind === 'error' || kind === 'offline';
    phone.className = `shell-phonebar-status is-${kind}`;
    phone.innerHTML = show ? `<span aria-hidden="true">${GLYPHS[kind]}</span> ${esc(kind === 'scanning' ? t('Scanning') : text)}` : '';
  }

  const nextIds = new Set(ids);
  const changed = nextIds.size !== runningClanIds.size || [...nextIds].some((id) => !runningClanIds.has(id));
  if (changed) {
    runningClanIds = nextIds;
    // Only the rows' status words change; a fresh render would close an open
    // popover under the reader's pointer.
    for (const btn of document.querySelectorAll('.shell-clan-option')) {
      const c = clanData.clans.find((x) => x.id === Number(btn.dataset.clanId));
      const old = btn.querySelector('.shell-clan-status');
      if (c && old) old.outerHTML = statusHtml(c);
    }
  }
}

/** Light the More tab's dot while any nav entry behind it has one. */
export function syncMoreDot() {
  const lit = !!document.querySelector('#navBar .nav-dot:not(.is-hidden)');
  byId('shellMoreDot')?.classList.toggle('is-hidden', !lit);
}

/**
 * Name, role and picture in the account button and the phone sheet. The
 * picture is the account's photo, else its game hero, else its initial
 * (lib/avatar.js); called again after the photo changes.
 */
export function setShellUser(user) {
  if (!user) return;
  const role = user.role === 'superadmin' ? t('Super Admin') : user.role === 'admin' ? t('Admin') : t('Member');
  const name = byId('userName');
  if (name) name.textContent = user.username;
  const roleEl = byId('userRole');
  if (roleEl) roleEl.textContent = role;
  paintAvatar(byId('userInitial'), user);
  // The phone sheet's account heading shows it too (the button is hidden there).
  paintAvatar(byId('userMenuAvatar'), user);
  const who = byId('userMenuWho');
  if (who) who.textContent = `${user.username} · ${role}`;
  const btn = byId('userMenuBtn');
  if (btn) btn.dataset.tip = `${user.username} · ${role}`;
}

// ─── Rail tooltips ───
// One fixed element beside whatever is hovered or focused in the rail. The
// label stays in the link (visually hidden), so this is for sighted mouse and
// keyboard users only and is aria-hidden.

function hideTip() {
  const tip = byId('shellTip');
  if (tip) tip.hidden = true;
}

function showTip(target) {
  const tip = byId('shellTip');
  if (!tip || !isRail() || isPhone() || !target?.dataset.tip) {
    hideTip();
    return;
  }
  tip.textContent = target.dataset.tip;
  tip.hidden = false;
  const r = target.getBoundingClientRect();
  tip.style.left = `${Math.round(r.right + 10)}px`;
  tip.style.top = `${Math.round(r.top + r.height / 2)}px`;
}

function labelNavTips() {
  for (const a of document.querySelectorAll('#navBar a[data-page]')) {
    const label = a.querySelector('.nav-label')?.textContent.trim();
    if (label) a.dataset.tip = label;
  }
  const scanBtns = document.querySelectorAll('#shellScanner [data-action="trigger-scan"]');
  for (const b of scanBtns) b.dataset.tip = b.querySelector('.btn-label')?.textContent.trim() ?? '';
}

/** Keep a scan button's visible label and its rail tooltip in step. */
export function setScanButtonLabel(btn, text) {
  const label = btn.querySelector('.btn-label');
  if (label) label.textContent = text;
  else btn.textContent = text;
  btn.dataset.tip = text;
}

// ─── Wiring ───

export function initShell() {
  const side = byId('shellSide');
  if (!side) return;
  syncNavMode();
  labelNavTips();

  byId('shellFoldBtn')?.addEventListener('click', onFold);
  byId('shellMoreBtn')?.addEventListener('click', () => {
    if (side.classList.contains('is-open')) closeShellOverlay();
    else openSheet();
  });
  byId('shellSheetClose')?.addEventListener('click', closeShellOverlay);
  byId('shellScrim')?.addEventListener('click', closeShellOverlay);
  byId('userMenuBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleUserMenu();
  });

  // The clan block is re-rendered, so its controls are delegated.
  byId('shellClan')?.addEventListener('click', (e) => {
    if (e.target.closest('#shellClanBtn')) {
      e.stopPropagation();
      toggleClanPopover();
      return;
    }
    const option = e.target.closest('.shell-clan-option');
    if (option) {
      switchClan(Number(option.dataset.clanId));
      return;
    }
    if (e.target.closest('.shell-clan-add')) {
      closeClanPopover();
      closeShellOverlay();
      document.dispatchEvent(new CustomEvent('tb:add-clan'));
      return;
    }
    if (e.target.closest('.shell-clan-manage')) closeShellOverlay();
  });

  // Outside click closes a popover (the phone lays them out inline).
  document.addEventListener('click', (e) => {
    if (isOpen('userMenu') && !byId('userInfo')?.contains(e.target)) closeUserMenu();
    if (isOpen('shellClanPop') && !byId('shellClan')?.contains(e.target)) closeClanPopover();
  });

  // Escape closes an open popover and hands focus back to its button. The
  // sheet and the unfolded rail take Escape themselves (holdDialogFocus).
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (isOpen('userMenu')) {
      closeUserMenu();
      byId('userMenuBtn')?.focus();
    } else if (isOpen('shellClanPop')) {
      closeClanPopover();
      byId('shellClanBtn')?.focus();
    }
  });

  // Any navigation closes the sheet, the unfolded rail and the popovers.
  window.addEventListener('hashchange', closeShellOverlay);

  // A sheet or peek left open across a breakpoint would keep the page inert
  // behind a menu that is no longer an overlay.
  const onBreakpoint = () => {
    closeShellOverlay();
    syncNavMode();
  };
  phoneMq.addEventListener('change', onBreakpoint);
  desktopMq.addEventListener('change', onBreakpoint);
  window.addEventListener('resize', () => {
    closePopovers();
    hideTip();
  }, { passive: true });

  side.addEventListener('mouseover', (e) => showTip(e.target.closest('[data-tip]')));
  side.addEventListener('mouseleave', hideTip);
  side.addEventListener('focusin', (e) => showTip(e.target.closest('[data-tip]')));
  side.addEventListener('focusout', hideTip);
  // A popover follows its button while the sidebar scrolls under it.
  side.addEventListener('scroll', () => {
    hideTip();
    if (isOpen('userMenu')) placePopover(byId('userMenu'), byId('userMenuBtn'), { above: true });
    if (isOpen('shellClanPop')) placePopover(byId('shellClanPop'), byId('shellClanBtn'));
  }, { passive: true });
}
