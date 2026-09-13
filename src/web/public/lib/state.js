// Cross-module shared mutable state.
//
// Anything that needs to be read from one page module and written from
// another (or sniffed out of an API response) lives here. Each entry is
// exposed as a getter/setter pair instead of a raw `export let` so other
// modules see the up-to-date value — `import { x }` of a `let` binding
// would capture the value at import time and never change.
//
// Keep this list small. Local state (the current sort key inside a
// page module, a one-shot fetch result) belongs INSIDE the page
// module, not here.

let _gameDayRolloverUtcHour = 17;

/** Hour-of-day in UTC (0-23) when the game day rolls over. Sniffed
 *  from any /stats response by the api wrapper and read by the
 *  Leaderboard "Today" shortcut, the analytics chart x-axis, and
 *  Clan Records best-single-day grouping. Default 17 matches the
 *  game's real reset time. */
export function getGameDayRolloverUtcHour() {
  return _gameDayRolloverUtcHour;
}

export function setGameDayRolloverUtcHour(hour) {
  if (Number.isFinite(hour)) {
    _gameDayRolloverUtcHour = hour;
  }
}

let _currentUser = null;

/** Currently signed-in user, or null before bootstrap completes /
 *  after logout. Shape: { id, username, role, clanId }. Page modules
 *  that need to gate UI on role (e.g. "show Delete button if
 *  superadmin") read this via getCurrentUser(). app.js's auth
 *  bootstrap calls setCurrentUser() once the /api/auth/me probe
 *  succeeds. */
export function getCurrentUser() {
  return _currentUser;
}

export function setCurrentUser(user) {
  _currentUser = user;
}

// Period is persisted to localStorage so a user's choice (e.g. weekly)
// carries across page reloads AND across the Leaderboard ⇆ Triumphal pages.
// Offset is intentionally NOT persisted: the URL anchor scheme is the
// source of truth for "which week/month" the user is looking at, so a
// fresh page load lands on the current period unless the URL says otherwise.
const PERIOD_STORAGE_KEY = 'tbcc.currentPeriod';
const VALID_PERIODS = ['daily', 'weekly', 'monthly', 'yearly', 'all'];
const DEFAULT_PERIOD = 'weekly';

let _currentPeriod = null;
let _currentPeriodOffset = 0;

function loadPersistedPeriod() {
  if (_currentPeriod !== null) return;
  try {
    const stored = localStorage.getItem(PERIOD_STORAGE_KEY);
    if (stored && VALID_PERIODS.includes(stored)) {
      _currentPeriod = stored;
      return;
    }
  } catch {
    // localStorage can throw in private-mode / sandboxed iframes.
  }
  _currentPeriod = DEFAULT_PERIOD;
}

/** Leaderboard / Triumphal time-window selector. Persisted to
 *  localStorage so the user's choice survives reloads and follows them
 *  between the two pages. Defaults to 'weekly' for fresh users. */
export function getCurrentPeriod() {
  loadPersistedPeriod();
  return _currentPeriod;
}

export function setCurrentPeriod(period) {
  if (!VALID_PERIODS.includes(period)) return;
  _currentPeriod = period;
  try {
    localStorage.setItem(PERIOD_STORAGE_KEY, period);
  } catch {
    // ignore — see loadPersistedPeriod
  }
}

export function getCurrentPeriodOffset() {
  return _currentPeriodOffset;
}

export function setCurrentPeriodOffset(offset) {
  _currentPeriodOffset = offset;
}

// "Last time the user actually visited the System page." Drives the
// nav-dot indicator AND the auto-open of Recent Warnings when fresh
// entries have arrived since that visit. Per-browser via localStorage —
// no per-user server state needed.
const LAST_SEEN_SYSTEM_KEY = 'lastSeenSystemWarningAt';

export function getLastSeenSystemWarningAt() {
  try {
    const raw = localStorage.getItem(LAST_SEEN_SYSTEM_KEY);
    const n = raw ? Number.parseInt(raw, 10) : 0;
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

export function markSystemWarningsSeen() {
  try {
    localStorage.setItem(LAST_SEEN_SYSTEM_KEY, String(Date.now()));
  } catch {
    // ignore — private-mode / sandboxed iframes
  }
}

// AbortSignal for the in-flight page load. The router (app.js) installs
// a fresh one on every navigation and aborts the previous one; the api()
// wrapper attaches it to GET reads so a slow or retrying response can't
// resolve after the user has switched away and clobber the page they
// actually navigated to. Mutations never pick it up — cancelling a
// half-sent POST/PUT/DELETE could leave the server worse off than just
// letting it finish.
let _pageLoadSignal = null;

export function getPageLoadSignal() {
  return _pageLoadSignal;
}

export function setPageLoadSignal(signal) {
  _pageLoadSignal = signal;
}
