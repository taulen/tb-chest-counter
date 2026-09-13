// Tiny DOM + modal utilities shared by every page module.
//
// `$` and `$$` are deliberately one-liners — they exist for brevity in
// page render code, not to add behaviour. They return null / an empty
// NodeList for missing selectors; callers should null-check or use
// optional chaining.

export const $ = (sel) => document.querySelector(sel);
export const $$ = (sel) => document.querySelectorAll(sel);

/**
 * HTML-escape a value for safe interpolation into innerHTML body
 * content. Escapes <, >, &. null / undefined collapse to ''.
 *
 * For ATTRIBUTE values use `esc()` instead — that one also escapes
 * `"` and `'` so an OCR'd quote in a title="…" attribute doesn't
 * break out of context.
 */
export function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

/**
 * HTML-escape a value for interpolation into attribute values.
 * Escapes the same set as escapeHtml plus `"` and `'`, so a string
 * containing a quote can't close an attribute context early. Used in
 * places like `<button title="${esc(error.message)}">` where the
 * scan-failure tooltip used to truncate at the first quote.
 */
export function esc(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Build a hash-route URL for the SPA's history-based navigation.
 *
 * Accepts an optional params object whose truthy values become query
 * params on the hash (e.g. `buildHash('member', { id: 7 })` →
 * `#member?id=7`). Falsy values are dropped so callers can spread an
 * unfiltered options bag.
 */
export function buildHash(page, params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) {
      search.set(key, value);
    }
  }
  const queryString = search.toString();
  return `#${page}${queryString ? `?${queryString}` : ''}`;
}

/**
 * Inverse of buildHash. Reads `window.location.hash` and returns the
 * decoded page name + URLSearchParams. Empty hash → dashboard route.
 */
export function parseHashRoute() {
  const rawHash = window.location.hash.replace(/^#/, '');
  if (!rawHash) {
    return { page: 'dashboard', params: new URLSearchParams() };
  }
  const [pagePart, queryString = ''] = rawHash.split('?');
  return {
    page: decodeURIComponent(pagePart || 'dashboard'),
    params: new URLSearchParams(queryString),
  };
}

/**
 * Hash for the per-member detail page, optionally carrying a timeframe.
 *
 * `anchor` is an ABSOLUTE slot from periodAnchorFromOffset ({key, value}),
 * never a numeric offset — "two weeks ago" in a copied link means a different
 * fortnight tomorrow. Called with just an id everywhere a link only wants the
 * member (memberLink, the leaderboard, the podiums), which lands on the page's
 * All Time default.
 */
export function memberHash(memberId, period, anchor) {
  const params = {};
  if (period && period !== 'all') {
    params.period = period;
    if (anchor && anchor.key) params[anchor.key] = anchor.value;
  }
  return buildHash(`member/${memberId}`, params);
}

/**
 * Render a player name as a link to their detail page. If the row's
 * member id is null (OCR couldn't match a known member), the name
 * comes back as plain text — there's nothing to link to.
 */
export function memberLink(memberId, memberName) {
  const safeName = esc(memberName);
  if (!memberId) return safeName;
  return `<a class="member-link" href="${memberHash(memberId)}">${safeName}</a>`;
}

/**
 * Format an ISO date string as `YYYY/MM/DD HH:MM:SS` in the viewer's
 * local timezone. Empty/null returns '-' so callers can drop it
 * straight into a table cell.
 */
export function formatDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const seconds = String(d.getSeconds()).padStart(2, '0');
  return `${year}/${month}/${day} ${hours}:${minutes}:${seconds}`;
}

/** Like formatDate but without the time portion. */
export function formatDateShort(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}/${month}/${day}`;
}

/**
 * Format a bare game-day date string (`YYYY-MM-DD` — how resource
 * transaction dates and screenshot upload dates are stored) as
 * `YYYY/MM/DD` to match the site's date style. These are already
 * game-day dates, so — unlike formatDateShort — we must NOT round-trip
 * them through `new Date()`: its local-time getters would shift the day
 * for viewers west of UTC (e.g. `2026-07-09` → `2026/07/08`). Empty /
 * null → '-'. */
export function formatGameDayShort(dateStr) {
  if (!dateStr) return '-';
  return String(dateStr).slice(0, 10).replace(/-/g, '/');
}

/**
 * Human-readable "X minutes ago" style timestamp. Every caller passes a
 * "last seen / first seen / started" value that is semantically always
 * in the past, so a future reading is clock skew between the server
 * (which stamps the time) and the browser's Date.now() — most visible
 * on the current user's own row, whose visit was logged a beat ago.
 * Clamp negatives to 0 so skew reads "just now" instead of abruptly
 * showing the absolute timestamp while every other row stays relative.
 */
export function formatRelativeTime(iso) {
  if (!iso) return '-';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return formatDate(iso);
  const diffSec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  const diffWk = Math.floor(diffDay / 7);
  if (diffWk < 5) return `${diffWk}w ago`;
  const diffMo = Math.floor(diffDay / 30);
  if (diffMo < 12) return `${diffMo}mo ago`;
  const diffYr = Math.floor(diffDay / 365);
  return `${diffYr}y ago`;
}

/**
 * Format a span between two ISO timestamps as `Xh Ym Zs`. Used for
 * scan duration displays. Returns '-' when either bound is missing or
 * the range is degenerate.
 */
export function formatDuration(startIso, endIso) {
  if (!startIso || !endIso) return '-';
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '-';
  const totalSec = Math.round((end - start) / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * HTML pill rendering for a scan_sessions.trigger_source value. Manual
 * scans get the epic-rare colour; scheduled is the boring baseline.
 * Imports (CSV/JSON dumps replayed into the DB) get a muted pill so
 * they're easy to tell apart from real scans.
 */
export function formatTriggerSource(source) {
  if (source === 'manual') return '<span class="chest-type epic">Manual</span>';
  if (source === 'import') return '<span class="chest-type unknown">Import</span>';
  return '<span class="chest-type common">Scheduled</span>';
}

/** Hash for a per-session detail page. */
export function sessionHash(sessionId) {
  return buildHash(`session/${sessionId}`);
}

/**
 * URL-safe slug for a chest name. Mirrors the server's resolveChestName
 * — it accepts either the slug or the canonical name, so shared links
 * and the live URL bar both stay human-friendly (no %20 escapes).
 */
export function slugifyChestName(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Hash for a per-chest drill-down page. Carries an optional period
 * filter (`weekly`, `monthly`, etc.) so deep-links from the analytics
 * tab preserve which window the user was looking at.
 */
export function chestHash(chestName, period) {
  const p = period && period !== 'all' ? period : '';
  const slug = slugifyChestName(chestName);
  return buildHash(`chest/${slug}`, p ? { period: p } : {});
}

/** Format a JS Date as YYYY-MM-DD using its UTC components. Used as
 *  the canonical "game day key" — the leaderboard URL anchor, the
 *  analytics chart's x-axis labels, and the Clan Records best-day
 *  grouping all key off this. */
export function formatUtcDateKey(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Today's date as YYYY-MM-DD in the VIEWER's own timezone — deliberately not a
 * game day and not UTC.
 *
 * Almost everything on this site is keyed to the game day (17:00 UTC rollover),
 * so reach for `getCurrentGameDayKey` by default. This exists for the one case
 * that genuinely isn't: reading back a relative day label ("Today",
 * "Yesterday") that the game rendered in the viewer's browser, where the only
 * date that resolves it correctly is the viewer's local calendar date. Used by
 * the resource screenshot upload; see the note there.
 */
export function localDateKey(now = new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Backing implementation for notify / confirmDialog / promptDialog.
 * Renders into #modalRoot and resolves with the user's choice:
 *  - info:    resolves to true on OK
 *  - confirm: true on confirm, false on cancel/escape/backdrop
 *  - prompt:  the input value on confirm, null on cancel/escape/backdrop
 *
 * Falls back to native `alert`/`confirm`/`prompt` if #modalRoot is
 * missing (shouldn't happen in production, but handy for setup-only
 * pages that don't include the root element).
 */
export function openModal({ title, message, type = 'info', defaultValue = null, confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    const root = document.getElementById('modalRoot');
    if (!root) {
      if (type === 'prompt') return resolve(window.prompt(message, defaultValue || ''));
      if (type === 'confirm') return resolve(window.confirm(message));
      window.alert(message);
      return resolve(true);
    }

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const isPrompt = type === 'prompt';
    const isConfirm = type === 'confirm' || type === 'prompt';

    overlay.innerHTML = `
      <div class="modal-card" role="dialog" aria-modal="true">
        ${title ? `<div class="modal-title">${escapeHtml(title)}</div>` : ''}
        <div class="modal-body">${escapeHtml(message)}</div>
        ${isPrompt ? `<input type="text" class="input modal-input" value="${escapeHtml(defaultValue || '')}">` : ''}
        <div class="modal-actions">
          ${isConfirm ? `<button class="btn modal-cancel">${escapeHtml(cancelLabel)}</button>` : ''}
          <button class="btn ${danger ? 'btn-danger-solid' : 'btn-primary'} modal-confirm">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>
    `;

    root.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('visible'));

    const input = overlay.querySelector('.modal-input');
    const confirmBtn = overlay.querySelector('.modal-confirm');
    const cancelBtn = overlay.querySelector('.modal-cancel');

    const cleanup = (result) => {
      overlay.classList.remove('visible');
      setTimeout(() => overlay.remove(), 180);
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };

    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cleanup(isPrompt ? null : false);
      } else if (e.key === 'Enter' && (!isPrompt || document.activeElement === input)) {
        e.preventDefault();
        cleanup(isPrompt ? input.value : true);
      }
    };
    document.addEventListener('keydown', onKey);

    confirmBtn.addEventListener('click', () => cleanup(isPrompt ? input.value : true));
    if (cancelBtn) cancelBtn.addEventListener('click', () => cleanup(isPrompt ? null : false));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) cleanup(isPrompt ? null : false);
    });

    if (input) {
      input.focus();
      input.select();
    } else {
      confirmBtn.focus();
    }
  });
}

/**
 * Classify a toast by its title so success/error/info get distinct
 * accent colours. Falls back to 'info' when the title is empty or
 * doesn't match a keyword.
 */
function classifyToast(title) {
  if (!title) return 'info';
  const t = String(title).toLowerCase();
  if (/(fail|error|invalid|not allowed|cannot|incomplete|nothing|no member|no stage|partial)/.test(t)) return 'error';
  if (/(saved|success|complete|started|deleted|calibrated|merge complete)/.test(t)) return 'success';
  return 'info';
}

function ensureToastRoot() {
  let root = document.getElementById('toastRoot');
  if (!root) {
    root = document.createElement('div');
    root.id = 'toastRoot';
    root.className = 'toast-root';
    document.body.appendChild(root);
  }
  return root;
}

/**
 * Non-blocking toast in the bottom-right. Replaces the old `notify()`
 * modal — informational popups don't need to steal focus or block
 * interaction. Errors linger longer than success/info so the operator
 * has time to read them; click anywhere on the toast to dismiss early.
 *
 * Returns a Promise that resolves immediately (the toast lifecycle is
 * decoupled from the caller) so existing `await notify(...)` sites
 * keep working without changes.
 */
// ─── Collapsible <details> state preservation ───
//
// Pages re-render by replacing the contents of #content, which throws
// away any <details open> state the user had set. Several admin
// actions (delete a backup, save a setting) call `rerender(page)` and
// every collapsible above silently snaps shut.
//
// We track the user's explicit open/closed choice in a Map keyed by
// either `data-section-key` (explicit) or the `<summary>` text content
// (default — stable across re-renders since the headings don't move).
// Recording closes as well as opens lets us defeat an inline `open`
// attribute that would otherwise re-pop the section after a rerender
// (e.g. System's "Recent Warnings" renders `<details open>` whenever
// there are entries, ignoring that the user just collapsed it).
//
// State is scoped to the current page — switching tabs clears it, so
// expanding "Server-Side Backups" on System doesn't auto-expand a
// like-named section on a different page. `restoreDetailsState` is
// called by the page router after each render with the page id; a
// scope change drops the map.
const userDetailsState = new Map();
let detailsScope = null;

function detailsKey(d) {
  if (d.dataset.sectionKey) return `key:${d.dataset.sectionKey}`;
  const summary = d.querySelector(':scope > summary');
  if (!summary) return null;
  // Strip every digit + comma from the summary text. Counts and
  // numbered prefixes appear in many summaries across the site —
  // "Server-Side Backups (5)", "5 active player merge rules",
  // "Show recent chests (1,234)" — and they change whenever an
  // in-section action mutates the underlying data. Removing the
  // numbers altogether keeps the key stable across renders without
  // having to enumerate each variation. Multiple summaries that
  // differ only in their numeric contents would alias here, but
  // pages that need to disambiguate can set data-section-key
  // explicitly.
  const text = summary.textContent
    .replace(/[\d,]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return `summary:${text}`;
}

if (typeof document !== 'undefined') {
  document.addEventListener('toggle', (e) => {
    const d = e.target;
    if (!(d instanceof HTMLDetailsElement)) return;
    const key = detailsKey(d);
    if (!key) return;
    userDetailsState.set(key, d.open);
  }, true);
}

// ─── Screenshot evidence: hover preview + zoomable lightbox ───────────────────
// Shared by every "hover a row to see the screenshot it came from" affordance:
// OCR-missing-player-name chests, unresolved resource-import rows and first-seen
// members. Driven by a URL rather than an id so any endpoint can feed it.
//
// Markup contract: give the trigger `class="unknown-crop-hover"` and
// `data-crop-url="..."`. Add `data-crop-wide` when the image is wide and short (a
// full history row) so it gets more horizontal room than a square chest crop.
//
// Two tiers on purpose. Hover is a glance — capped by the viewport, so on a
// narrow window it can still land below 1:1. Clicking opens the lightbox, which
// is where the crop is actually *read*: it magnifies past natural size, which a
// hover panel anchored to a table row can never do.

const CROP_UNAVAILABLE = 'Screenshot no longer available (aged out of retention).';

let cropPreviewEl = null;

export function showCropPreview(url, trigger, { wide = false } = {}) {
  hideCropPreview();
  if (!url) return;
  const pop = document.createElement('div');
  pop.className = `unknown-crop-preview${wide ? ' unknown-crop-preview-wide' : ''}`;
  const img = document.createElement('img');
  // Assigned as a property, not interpolated into innerHTML, so a crafted URL
  // can't inject markup here.
  img.src = url;
  img.alt = 'Screenshot of the row this entry came from';
  // Chest batch crops age out with screenshotRetentionDays while the DB row keeps
  // pointing at them, so a hover on an old entry can 404. Say so instead of showing
  // a broken-image icon.
  img.addEventListener('error', () => {
    pop.textContent = CROP_UNAVAILABLE;
    pop.classList.add('unknown-crop-preview-empty');
    placeCropPreview(pop, trigger);
  });
  // The panel is sized in viewport units, so its real box isn't known until the
  // image has decoded and laid out. Re-place it then, or a big preview next to a
  // row near the right/bottom edge opens clipped.
  img.addEventListener('load', () => placeCropPreview(pop, trigger));
  pop.appendChild(img);
  document.body.appendChild(pop);
  cropPreviewEl = pop;
  placeCropPreview(pop, trigger);
}

/**
 * Park the panel beside its trigger, clamped to the viewport on both axes.
 * Measures the rendered panel rather than assuming a width, so the CSS caps stay
 * the single source of truth for how big a preview gets.
 */
function placeCropPreview(pop, trigger) {
  if (pop !== cropPreviewEl) return; // a later hover already replaced it
  const rect = trigger.getBoundingClientRect();
  const viewW = document.documentElement.clientWidth;
  const viewH = document.documentElement.clientHeight;
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  const gap = 12;

  // Prefer the right of the trigger, flip to its left when that overflows, and
  // only then clamp — a preview wider than the gap has nowhere else to go.
  let left = rect.right + gap;
  if (left + w > viewW - 8) left = rect.left - gap - w;
  left = Math.min(Math.max(8, left), Math.max(8, viewW - w - 8));

  let top = rect.top;
  if (top + h > viewH - 8) top = viewH - h - 8;
  top = Math.max(8, top);

  pop.style.left = `${window.scrollX + left}px`;
  pop.style.top = `${window.scrollY + top}px`;
}

export function hideCropPreview() {
  if (cropPreviewEl) {
    cropPreviewEl.remove();
    cropPreviewEl = null;
  }
}

let cropLightbox = null;

/**
 * Full-screen zoomable view of one evidence crop. Opens scaled to fit and zooms
 * freely past 1:1 — the crops are ~1000px-wide game screenshots whose player
 * names are exactly the thing OCR couldn't read, so magnifying beyond natural
 * size is the whole point.
 */
export function openCropLightbox(url, { returnFocusTo = null } = {}) {
  if (!url) return;
  hideCropPreview();
  closeCropLightbox();

  const overlay = document.createElement('div');
  overlay.className = 'crop-lightbox';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Screenshot evidence');
  overlay.innerHTML = `
    <div class="crop-lightbox-bar" role="toolbar" aria-label="Screenshot zoom">
      <span class="crop-lightbox-zoom" aria-live="polite">…</span>
      <button class="btn btn-tight" data-zoom="out" title="Zoom out (−)" aria-label="Zoom out">−</button>
      <button class="btn btn-tight" data-zoom="in" title="Zoom in (+)" aria-label="Zoom in">+</button>
      <button class="btn btn-tight" data-zoom="fit" title="Fit to screen (0)">Fit</button>
      <button class="btn btn-tight" data-zoom="one" title="Actual pixel size (1)">1:1</button>
      <a class="btn btn-tight crop-lightbox-raw" target="_blank" rel="noopener">Open original ↗</a>
      <button class="btn btn-tight crop-lightbox-close" title="Close (Esc)" aria-label="Close">✕</button>
    </div>
    <div class="crop-lightbox-stage" tabindex="-1"></div>
  `;
  const stage = overlay.querySelector('.crop-lightbox-stage');
  const zoomLabel = overlay.querySelector('.crop-lightbox-zoom');
  // Set as a property for the same reason as img.src above.
  overlay.querySelector('.crop-lightbox-raw').href = url;

  const img = document.createElement('img');
  img.alt = 'Full-size screenshot of the row this entry came from';
  img.draggable = false;
  stage.appendChild(img);

  const MIN_SCALE = 0.2;
  const MAX_SCALE = 8;
  let scale = 1;

  const fitScale = () => {
    const w = stage.clientWidth - 24;
    const h = stage.clientHeight - 24;
    if (!img.naturalWidth || !img.naturalHeight || w <= 0 || h <= 0) return 1;
    return Math.min(w / img.naturalWidth, h / img.naturalHeight);
  };

  const apply = () => {
    img.style.width = `${Math.round(img.naturalWidth * scale)}px`;
    zoomLabel.textContent = `${Math.round(scale * 100)}%`;
    stage.classList.toggle('is-pannable', img.offsetWidth > stage.clientWidth
      || img.offsetHeight > stage.clientHeight);
  };
  const setScale = (next) => {
    scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
    apply();
  };

  img.addEventListener('load', () => {
    // A history row is ~1000×90: fitting it would stretch it to the full stage
    // height and turn it to mush. Cap the *opening* zoom only — the ceiling for
    // manual zooming stays high.
    setScale(Math.min(fitScale(), 3));
    stage.scrollLeft = (stage.scrollWidth - stage.clientWidth) / 2;
  });
  img.addEventListener('error', () => {
    stage.textContent = CROP_UNAVAILABLE;
    stage.classList.add('crop-lightbox-empty');
  });
  img.src = url;

  // Drag-to-pan, mouse only: touch already pans and pinch-zooms natively, and
  // hijacking it there would break both. Pointer capture keeps the drag alive
  // when the cursor runs off the stage mid-gesture.
  let panFrom = null;
  let dragged = false;
  stage.addEventListener('pointerdown', (event) => {
    if (event.pointerType !== 'mouse' || event.button !== 0) return;
    panFrom = { x: event.clientX, y: event.clientY, left: stage.scrollLeft, top: stage.scrollTop };
    dragged = false;
    stage.setPointerCapture(event.pointerId);
  });
  stage.addEventListener('pointermove', (event) => {
    if (!panFrom) return;
    const dx = event.clientX - panFrom.x;
    const dy = event.clientY - panFrom.y;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragged = true;
    stage.scrollLeft = panFrom.left - dx;
    stage.scrollTop = panFrom.top - dy;
  });
  const endPan = () => { panFrom = null; };
  stage.addEventListener('pointerup', endPan);
  stage.addEventListener('pointercancel', endPan);

  overlay.addEventListener('click', (event) => {
    const zoomBtn = event.target.closest?.('[data-zoom]');
    if (zoomBtn) {
      const mode = zoomBtn.dataset.zoom;
      if (mode === 'in') setScale(scale * 1.25);
      else if (mode === 'out') setScale(scale / 1.25);
      else setScale(mode === 'fit' ? fitScale() : 1);
      return;
    }
    if (event.target.closest?.('a')) return; // let "Open original" through
    // Releasing a pan gesture fires a click; don't read that as "dismiss".
    if (dragged) { dragged = false; return; }
    if (event.target.closest?.('.crop-lightbox-close')
      || event.target === overlay || event.target === stage) closeCropLightbox();
  });

  // Ctrl/⌘+wheel zooms; a bare wheel keeps scrolling the stage so panning a
  // zoomed-in crop still works the way every other scroll container does.
  stage.addEventListener('wheel', (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    setScale(event.deltaY < 0 ? scale * 1.15 : scale / 1.15);
  }, { passive: false });

  // Capture phase + stopPropagation: the lightbox can open on top of a dialog
  // that has its own document-level Escape handler (the resource-unknowns modal),
  // and one Escape must only close the topmost layer.
  const onKey = (event) => {
    // Ctrl/⌘ combinations stay the browser's — notably Ctrl+− / Ctrl+0, which
    // collide with these shortcuts and must keep zooming the page itself.
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (!['Escape', '+', '=', '-', '_', '0', '1'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') closeCropLightbox();
    else if (event.key === '+' || event.key === '=') setScale(scale * 1.25);
    else if (event.key === '-' || event.key === '_') setScale(scale / 1.25);
    else setScale(event.key === '0' ? fitScale() : 1);
  };
  document.addEventListener('keydown', onKey, true);

  cropLightbox = { overlay, onKey, returnFocusTo };
  document.body.appendChild(overlay);
  requestAnimationFrame(() => {
    overlay.classList.add('visible');
    // The stage, not the ✕ — landing on the close button makes a stray Enter
    // dismiss the thing the operator just opened. Arrow keys scroll it instead.
    stage.focus({ preventScroll: true });
  });
}

export function closeCropLightbox() {
  if (!cropLightbox) return;
  const { overlay, onKey, returnFocusTo } = cropLightbox;
  cropLightbox = null;
  document.removeEventListener('keydown', onKey, true);
  overlay.classList.remove('visible');
  setTimeout(() => overlay.remove(), 180);
  // The trigger may have been re-rendered away underneath us.
  if (returnFocusTo?.isConnected) returnFocusTo.focus();
}

/**
 * Wire hover/focus previews and click-to-enlarge for every
 * `.unknown-crop-hover` inside `root`. Delegated, so it survives rerenders of
 * the subtree. Needed for containers outside #content (the resource modal lives
 * in #modalRoot).
 */
export function attachCropPreviews(root) {
  if (!root) return;
  const triggerFor = (event) => event.target.closest?.('.unknown-crop-hover');
  const show = (event) => {
    const trigger = triggerFor(event);
    if (!trigger) return;
    showCropPreview(trigger.dataset.cropUrl, trigger, {
      wide: trigger.dataset.cropWide !== undefined,
    });
  };
  const hide = (event) => {
    if (triggerFor(event)) hideCropPreview();
  };
  const enlarge = (event) => {
    const trigger = triggerFor(event);
    if (!trigger) return;
    event.preventDefault();
    openCropLightbox(trigger.dataset.cropUrl, { returnFocusTo: trigger });
  };
  root.addEventListener('mouseover', show);
  root.addEventListener('mouseout', hide);
  // Keyboard parity — the triggers are tabindex="0".
  root.addEventListener('focusin', show);
  root.addEventListener('focusout', hide);
  root.addEventListener('click', enlarge);
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') enlarge(event);
  });
}

// Drop a single section's persisted state. Pages call this when they
// want a fresh inline `open` attribute to win even if the user had
// previously collapsed the section in the same scope (e.g. Recent
// Warnings auto-opening when new warnings have arrived since the last
// visit).
export function forgetDetailsState(key) {
  if (!key) return;
  userDetailsState.delete(`key:${key}`);
}

export function restoreDetailsState(container, scope = null) {
  if (scope !== detailsScope) {
    userDetailsState.clear();
    detailsScope = scope;
    return;
  }
  const root = container ?? document;
  const list = root.querySelectorAll('details');
  for (const d of list) {
    const key = detailsKey(d);
    if (key && userDetailsState.has(key)) {
      d.open = userDetailsState.get(key);
    }
  }
}

export function notify(message, title = '') {
  if (typeof document === 'undefined' || !document.body) {
    if (typeof window !== 'undefined' && window.alert) window.alert(message);
    return Promise.resolve(true);
  }
  const root = ensureToastRoot();
  const kind = classifyToast(title);
  const ttl = kind === 'error' ? 6000 : 3500;

  const toast = document.createElement('div');
  toast.className = `toast toast-${kind}`;
  toast.innerHTML = `
    ${title ? `<div class="toast-title">${escapeHtml(title)}</div>` : ''}
    <div class="toast-message">${escapeHtml(message)}</div>
  `;
  root.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('visible'));

  let timer;
  const dismiss = () => {
    clearTimeout(timer);
    if (!toast.parentNode) return;
    toast.classList.remove('visible');
    setTimeout(() => toast.remove(), 200);
  };
  toast.addEventListener('click', dismiss);
  timer = setTimeout(dismiss, ttl);

  return Promise.resolve(true);
}

export function confirmDialog(message, { title = '', confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false } = {}) {
  return openModal({ title, message, type: 'confirm', confirmLabel, cancelLabel, danger });
}

export function promptDialog(message, { title = '', defaultValue = '', confirmLabel = 'OK', cancelLabel = 'Cancel' } = {}) {
  return openModal({ title, message, type: 'prompt', defaultValue, confirmLabel, cancelLabel });
}

/**
 * Modal with a <select> dropdown. Resolves to the selected option's
 * value on confirm, or null on cancel/escape/backdrop. Used by the
 * users page to force the operator to pick a destination clan when
 * demoting a superadmin (and when reassigning an orphaned member).
 *
 * Options must be an array of { value, label } pairs. The structure
 * mirrors promptDialog so the modal renders against the same shared
 * theme tokens — body + form-label + input + actions, all themed via
 * --bg-card / --text-primary / --accent-blue.
 */
export function selectDialog(message, options, {
  title = '',
  defaultValue = '',
  fieldLabel = '',
  confirmLabel = 'OK',
  cancelLabel = 'Cancel',
} = {}) {
  return new Promise((resolve) => {
    const root = document.getElementById('modalRoot');
    if (!root || !Array.isArray(options) || options.length === 0) {
      return resolve(null);
    }

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const optionsHtml = options.map((opt) => {
      const v = String(opt.value);
      const selected = v === String(defaultValue) ? ' selected' : '';
      return `<option value="${escapeHtml(v)}"${selected}>${escapeHtml(opt.label)}</option>`;
    }).join('');

    const selectId = `modal-select-${Math.random().toString(36).slice(2, 10)}`;

    overlay.innerHTML = `
      <div class="modal-card" role="dialog" aria-modal="true">
        ${title ? `<div class="modal-title">${escapeHtml(title)}</div>` : ''}
        ${message ? `<div class="modal-body">${escapeHtml(message)}</div>` : ''}
        <div class="modal-form">
          ${fieldLabel ? `<label class="modal-form-label" for="${selectId}">${escapeHtml(fieldLabel)}</label>` : ''}
          <select id="${selectId}" class="input modal-input">${optionsHtml}</select>
        </div>
        <div class="modal-actions">
          <button class="btn modal-cancel">${escapeHtml(cancelLabel)}</button>
          <button class="btn btn-primary modal-confirm">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>
    `;

    root.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('visible'));

    const select = overlay.querySelector('.modal-input');
    const confirmBtn = overlay.querySelector('.modal-confirm');
    const cancelBtn = overlay.querySelector('.modal-cancel');

    const cleanup = (result) => {
      overlay.classList.remove('visible');
      setTimeout(() => overlay.remove(), 180);
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };

    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cleanup(null);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        cleanup(select.value);
      }
    };
    document.addEventListener('keydown', onKey);

    confirmBtn.addEventListener('click', () => cleanup(select.value));
    cancelBtn.addEventListener('click', () => cleanup(null));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) cleanup(null);
    });

    select.focus();
  });
}

/**
 * Rich-content modal for read-mostly panels (e.g. the share-link analytics
 * + recovery view). Unlike openModal/confirmDialog, this renders *trusted*
 * caller-built HTML — the caller is responsible for escaping any dynamic
 * values (via escapeHtml) before passing them in.
 *
 * Returns a handle so the opener can wire up interactive controls inside the
 * body and re-render it in place:
 *   - `content`  — the .modal-content element (attach listeners here)
 *   - `setHtml(html)` — replace the body (e.g. after a recover action)
 *   - `close()`  — dismiss programmatically
 * Returns null if #modalRoot is missing.
 */
export function contentModal({ title = '', html = '', wide = false } = {}) {
  const root = document.getElementById('modalRoot');
  if (!root) return null;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-card${wide ? ' modal-card-wide' : ''}" role="dialog" aria-modal="true">
      <div class="modal-head">
        <div class="modal-title">${escapeHtml(title)}</div>
        <button class="modal-close" type="button" aria-label="Close">&times;</button>
      </div>
      <div class="modal-content"></div>
    </div>
  `;

  const contentEl = overlay.querySelector('.modal-content');
  contentEl.innerHTML = html;

  root.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('visible'));

  const close = () => {
    overlay.classList.remove('visible');
    setTimeout(() => overlay.remove(), 180);
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };
  document.addEventListener('keydown', onKey);

  overlay.querySelector('.modal-close').addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  return {
    overlay,
    content: contentEl,
    close,
    setHtml: (h) => { contentEl.innerHTML = h; },
  };
}
