// Tiny DOM helpers, the modal system, fetch wrappers, and shared
// mutable state all live under ./lib/. Keeping them here as imports
// (rather than re-declared at the top of app.js) means each page
// module added later in the C1 split can pull them directly without
// going through app.js.
import {
  $, $$,
  escapeHtml, esc,
  formatDate, formatDateShort, formatRelativeTime, formatDuration, formatTriggerSource,
  openModal, notify, confirmDialog, promptDialog,
  buildHash, parseHashRoute,
  memberHash, memberLink, sessionHash, chestHash, slugifyChestName,
  restoreDetailsState,
  attachCropPreviews,
} from './lib/ui.js';
import { api, apiPost, apiPut, apiDelete, UnauthenticatedError } from './lib/api.js';
import {
  getGameDayRolloverUtcHour,
  setCurrentUser,
  getCurrentPeriod,
  setCurrentPeriod,
  setCurrentPeriodOffset,
  getLastSeenSystemWarningAt,
  markSystemWarningsSeen,
  setPageLoadSignal,
} from './lib/state.js';
import { computeGameWindow, getCurrentGameDayKey, periodOffsetFromAnchor } from './lib/period.js';
import { applyTheme, bindThemeSwitcher } from './lib/theme.js';
import { initMobileRows } from './lib/mobile-rows.js';
// renderExternalAdminCardHtml + wireExternalAdminHandlers are
// exported by external.js but currently unused (the Admin tab
// renders its own ChestTracker card via clans-page Discord/CT
// settings, not via the legacy single-tenant external admin card).
// Importing only what we use keeps the dependency surface honest.
import { renderExternal } from './external.js';
// Page modules. Each exports its render function plus action handlers
// (changeX / setX) that take a `rerender` callback so the page can
// re-render without importing `loadPage` from app.js (which would
// create a circular import).
import {
  renderTriumphal,
  changeTriumphalPage,
  changeTriumphalRecentPage,
  setTriumphalSort,
  setTriumphalPeriod,
  changeTriumphalPeriodOffset,
} from './pages/triumphal.js';
import {
  renderSessions,
  viewSession,
  deleteScanSession,
  changeSessionsPage,
} from './pages/sessions.js';
import {
  renderUsers,
  createNewUser,
  deleteUserById,
  changeRole,
  reassignUserClan,
  changeAuditPage,
} from './pages/users.js';
import {
  renderLeaderboard,
  setLeaderboardSort,
  changeLeaderboardPage,
  setPeriod,
  changePeriodOffset,
  navigateToLeaderboard,
} from './pages/leaderboard.js';
import { renderDashboard } from './pages/dashboard.js';
import {
  renderMembers,
  renderMembersTable,
  setMembersSort,
  setMembersFilter,
  viewMember,
  viewMemberByName,
  changeMemberChestsPage,
  changeMemberTriumphalsPage,
  changeMemberResourcesPage,
} from './pages/members.js';
import { renderMight } from './pages/might.js';
import {
  renderAnalytics,
  viewChestByName,
  setChestDrillPeriod,
  setChestCollectorsSort,
  toggleChestCollectorRow,
} from './pages/analytics.js';
import {
  renderSystem,
  saveScanIntervalSetting,
  saveScannerSettings,
  toggleRawOcrCapture,
  toggleMightTracking,
  toggleResourceCapture,
  requestMightRecapture,
  restartContainer,
  startCalibrationStage,
  captureCalibrationScreenshot,
  selectCalibrationTarget,
  saveCalibration,
  cancelCalibration,
  resetCalibrationStage,
  runDbBackupImportFromFile,
  restoreServerBackup,
  createManualBackup,
  deleteServerBackup,
  inspectClanRestoreBackup,
  runClanRestore,
  restoreDeletedClan,
  refreshLogBuffer,
} from './pages/system.js';
import {
  renderClans,
  startLoginSession,
  saveLoginSession,
  cancelLoginSession,
  reloadLoginSession,
  pasteIntoLoginSession,
} from './pages/clans.js';
import {
  renderResourcesAdmin,
  changeResourcesPage,
  setResourcesFilter,
  sortResources,
  handleResourcesUpload,
  handleResourcesApplyFilters,
  handleResourcesBatchDelete,
  handleResourcesTxEdit,
  handleResourcesTxSave,
  handleResourcesTxCancel,
  handleResourcesResolveUnknowns,
} from './pages/resources.js';
import { renderResourcesOverview } from './pages/resources-overview.js';
import { renderResourcesTotals } from './pages/resources-totals.js';
import { renderEvents } from './pages/events.js';
import {
  renderAdmin,
  doMergePlayer,
  doMergeChest,
  doMergeSource,
  saveAllSourcePoints,
  saveAllTriumphalPoints,
  acknowledgeReviewQueue,
  reassignUnknownRow,
  reassignUnknownBulk,
  recalculateSourcePoints,
  deleteRule,
  setChestType,
  saveMemberName,
  deleteMemberById,
  restoreMemberById,
  promptMergePlayerById,
} from './pages/admin.js';

let currentPage = 'dashboard';
// Leaderboard state moved into ./pages/leaderboard.js (sort/page) and
// ./lib/state.js (currentPeriod / currentPeriodOffset, since the URL
// hash router writes them).
let currentUser = null; // { id, username, role }
// Cached game-day rollover hour in UTC. Populated from any /api/stats
// response and used by date helpers that need to know "what is today's
// game day" (leaderboard Today shortcut, analytics chart, etc.). Defaults
// to 17 so early calls before the first /stats fetch don't crash.
// gameDayRolloverUtcHour now lives in ./lib/state.js — read via
// getGameDayRolloverUtcHour(). The api wrapper writes it whenever a
// /stats response carries one.
// membersSort state moved into ./pages/members.js.
let nextScanAtMs = null; // Unix ms of next scheduled scan, or null
let nextScanClanInactive = false; // true when this admin's clan isn't in the active rotation
let nextScanInProgress = false; // true while a scan is running — suppress the countdown until it finishes
// Sessions page state moved into ./pages/sessions.js.
// Triumphal Gifts page state moved into ./pages/triumphal.js.
// Audit log pagination state moved to ./pages/users.js.
// Member-detail pagination state moved into ./pages/members.js.
// Analytics page state (chest types pagination, chest drill-down sort &
// cache, current period/name) moved into ./pages/analytics.js.
// Members page state moved into ./pages/members.js.
// System page state (importPreviewState, transferStatus, calibration
// schema + in-progress state) moved into ./pages/system.js.

// ─── Auth ───
async function checkAuth() {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) { window.location.href = '/login'; return; }
    const data = await res.json();
    currentUser = data.user;
    // Stash the active clan name on currentUser so other UI surfaces
    // can render the clan label without re-fetching.
    currentUser.activeClan = data.activeClan ?? null;

    // Sync the inline data-theme bootstrap (cached from a prior visit,
    // possibly on this device) with the server's source of truth. If
    // they differ, the server wins — but we don't echo a PUT back since
    // we just read that value.
    if (currentUser.theme) {
      applyTheme(currentUser.theme, { persist: true, syncServer: false });
    }
    bindThemeSwitcher();
    // Mirror to lib/state.js so page modules that don't share app.js's
    // module scope (pages/*.js) can read the same value via
    // getCurrentUser() without taking a hard import dependency on app.js.
    setCurrentUser(currentUser);

    // Show user info
    const userInfoEl = $('#userInfo');
    if (userInfoEl) userInfoEl.classList.remove('is-hidden');
    $('#userName').textContent = currentUser.username;
    const mobileNameEl = $('#navMobileUserName');
    if (mobileNameEl) mobileNameEl.textContent = currentUser.username;

    const navAdminEl = $('#navAdmin');
    const navUsersEl = $('#navUsers');
    const navClansEl = $('#navClans');
    const navSystemEl = $('#navSystem');
    if (navAdminEl) navAdminEl.classList.add('is-hidden');
    if (navUsersEl) navUsersEl.classList.add('is-hidden');
    if (navClansEl) navClansEl.classList.add('is-hidden');
    if (navSystemEl) navSystemEl.classList.add('is-hidden');

    // Show/hide nav based on role.
    // - Admin tab: clan admin + superadmin (per-clan content management).
    // - Clans tab: clan admin (own clan only) + superadmin (all clans).
    // - Users tab: clan admin (own clan only, no superadmins shown) +
    //   superadmin (everyone).
    // - System tab: superadmin only (instance-wide settings).
    if (currentUser.role === 'admin' || currentUser.role === 'superadmin') {
      if (navAdminEl) navAdminEl.classList.remove('is-hidden');
      if (navClansEl) navClansEl.classList.remove('is-hidden');
      if (navUsersEl) navUsersEl.classList.remove('is-hidden');
    }
    if (currentUser.role === 'superadmin') {
      if (navSystemEl) navSystemEl.classList.remove('is-hidden');
    }

    // Multi-clan: superadmins get a clan-picker dropdown in the header;
    // everyone else sees a read-only clan label so they always know
    // which clan's data they're looking at.
    await refreshClanIndicator();

    // ChestTracker tab visibility is driven by the integration's own
    // enabled flag, not by user role — any logged-in user sees it when
    // it's on, nobody sees it when it's off.
    refreshExternalNavVisibility();
    refreshResourcesNavVisibility();
    refreshMightNavVisibility();

    // Render the build SHA in the footer so the operator can verify
    // after a redeploy that the running container actually picked up
    // the latest commit. Failure here is non-fatal — the footer just
    // stays as "—" if /api/health doesn't respond.
    refreshBuildFooter();
  } catch {
    window.location.href = '/login';
  }
}

async function refreshBuildFooter() {
  const el = document.getElementById('buildInfo');
  if (!el) return;
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    if (!res.ok) {
      el.textContent = '—';
      el.title = '/api/health failed';
      return;
    }
    const data = await res.json();
    const fp = data.fingerprint || 'unknown';
    const builtAt = data.builtAt || 'unknown';
    // Format the timestamp for the visible footer; full fingerprint +
    // formatted timestamp stay in the title for hover. Use the shared
    // formatDate so both surfaces match the YYYY/MM/DD HH:MM:SS format
    // the rest of the site uses (toLocaleString defaulted to a
    // US-style M/D/YYYY which clashed with every other timestamp).
    const builtAtShort = builtAt === 'unknown' ? builtAt : formatDate(builtAt);
    el.textContent = `build ${fp} · ${builtAtShort}`;
    el.title = `fingerprint ${fp} · built ${builtAtShort}`;
  } catch {
    el.textContent = '—';
    el.title = '/api/health unreachable';
  }
}

/**
 * Populate the per-clan label or the superadmin clan-switcher dropdown
 * based on the current user. Refreshes after a clan rename or after the
 * superadmin switches active clan.
 */
async function refreshClanIndicator() {
  const indicatorEl = $('#clanIndicator');
  const indicatorNameEl = $('#clanIndicatorName');
  const switcherEl = $('#clanSwitcher');
  const switcherSelect = $('#clanSwitcherSelect');
  if (!currentUser) return;

  if (currentUser.role !== 'superadmin') {
    // Read-only clan label.
    if (indicatorEl && indicatorNameEl) {
      const label = currentUser.activeClan?.name ?? '';
      if (label) {
        indicatorNameEl.textContent = label;
        indicatorEl.classList.remove('is-hidden');
      } else {
        indicatorEl.classList.add('is-hidden');
      }
    }
    if (switcherEl) switcherEl.classList.add('is-hidden');
    return;
  }

  // Superadmin: render the dropdown with every clan, mark the active one.
  if (indicatorEl) indicatorEl.classList.add('is-hidden');
  if (!switcherEl || !switcherSelect) return;
  try {
    const res = await fetch('/api/clans');
    if (!res.ok) return;
    const data = await res.json();
    const clans = Array.isArray(data.clans) ? data.clans : [];
    const activeId = data.activeClanId ?? clans[0]?.id ?? null;
    switcherSelect.innerHTML = '';
    for (const c of clans) {
      const opt = document.createElement('option');
      opt.value = String(c.id);
      opt.textContent = c.name;
      if (c.id === activeId) opt.selected = true;
      switcherSelect.appendChild(opt);
    }
    if (clans.length > 0) {
      switcherEl.classList.remove('is-hidden');
      // Bind once.
      if (!switcherSelect.dataset.bound) {
        switcherSelect.addEventListener('change', async (ev) => {
          const newId = Number((ev.target).value);
          if (!Number.isFinite(newId)) return;
          try {
            const r = await fetch(`/api/clans/${newId}/activate`, { method: 'POST' });
            if (!r.ok) return;
            // Reload everything so analytics, members, etc. reflect the
            // newly-active clan. Cheaper than threading a clan-changed
            // event into every page.
            window.location.reload();
          } catch {
            // ignore
          }
        });
        switcherSelect.dataset.bound = '1';
      }
    } else {
      switcherEl.classList.add('is-hidden');
    }
  } catch {
    switcherEl.classList.add('is-hidden');
  }
}

/**
 * Show or hide the ChestTracker nav link based on whether the
 * integration is currently enabled. Called on bootstrap and again after
 * an admin toggles the Enable flag on the admin tab so the change
 * reflects immediately without a page reload.
 */
async function refreshExternalNavVisibility() {
  const link = $('#navExternal');
  if (!link) return;
  try {
    const status = await api('/external/status');
    const enabled = status?.settings?.enabled === true;
    link.classList.toggle('is-hidden', !enabled);
  } catch {
    // If we can't reach the endpoint (e.g. 401 during logout), keep the
    // link hidden rather than flashing a broken tab.
    link.classList.add('is-hidden');
  }
}
window.refreshExternalNavVisibility = refreshExternalNavVisibility;

/**
 * Show or hide the Resources nav link. Visible to any signed-in clan member
 * when the active clan has resourcesEnabled = true. The section's Admin
 * sub-tab is hidden separately (resourceTabsHtml) for non-admins.
 */
async function refreshResourcesNavVisibility() {
  const link = $('#navResources');
  if (!link) return;
  try {
    if (!currentUser) {
      link.classList.add('is-hidden');
      return;
    }
    const res = await fetch('/api/clans');
    if (!res.ok) { link.classList.add('is-hidden'); return; }
    const data = await res.json();
    const clans = Array.isArray(data.clans) ? data.clans : [];
    const activeId = data.activeClanId ?? null;
    const activeClan = clans.find((c) => c.id === activeId) ?? clans[0] ?? null;
    link.classList.toggle('is-hidden', activeClan?.resourcesEnabled !== true);
  } catch {
    link.classList.add('is-hidden');
  }
}
window.refreshResourcesNavVisibility = refreshResourcesNavVisibility;

/**
 * Show or hide the Might nav link.
 *
 * Visible when the feature is on OR when snapshots already exist — so turning
 * tracking off doesn't hide the history it already collected, while an instance
 * that has never enabled it doesn't carry a tab leading to an empty page.
 */
async function refreshMightNavVisibility() {
  const link = $('#navMight');
  if (!link) return;
  try {
    if (!currentUser) { link.classList.add('is-hidden'); return; }
    const overview = await api('/might/overview');
    const hasData = (overview?.daysCollected ?? 0) > 0;
    link.classList.toggle('is-hidden', overview?.enabled !== true && !hasData);
  } catch {
    link.classList.add('is-hidden');
  }
}
window.refreshMightNavVisibility = refreshMightNavVisibility;

async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login';
}

// ─── Mobile Nav ───
const hamburgerBtn = $('#hamburgerBtn');
const navOverlay = $('#navOverlay');
const navBar = $('#navBar');

function openMobileNav() {
  if (navBar) navBar.classList.add('open');
  if (navOverlay) navOverlay.classList.add('visible');
}

function closeMobileNav() {
  if (navBar) navBar.classList.remove('open');
  if (navOverlay) navOverlay.classList.remove('visible');
}

if (hamburgerBtn) {
  hamburgerBtn.addEventListener('click', () => {
    navBar.classList.contains('open') ? closeMobileNav() : openMobileNav();
  });
}

if (navOverlay) {
  navOverlay.addEventListener('click', closeMobileNav);
}

const statusErrorBtn = $('#statusErrorBtn');
const statusErrorPanel = $('#statusErrorDetails');
if (statusErrorBtn && statusErrorPanel) {
  statusErrorBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    statusErrorPanel.classList.toggle('is-hidden');
  });
  document.addEventListener('click', (e) => {
    if (statusErrorPanel.classList.contains('is-hidden')) return;
    if (statusErrorPanel.contains(e.target) || statusErrorBtn.contains(e.target)) return;
    statusErrorPanel.classList.add('is-hidden');
  });
}

// ─── Navigation ───
$$('nav a').forEach((link) => {
  link.addEventListener('click', (e) => {
    e.preventDefault();
    closeMobileNav();
    navigateTo(link.dataset.page);
  });
});

// Mobile-only account buttons inside the slide-out nav
const logoutBtnMobile = $('#logoutBtnMobile');
if (logoutBtnMobile) {
  logoutBtnMobile.addEventListener('click', () => {
    closeMobileNav();
    logout();
  });
}

const navBarEl = $('#navBar');
if (navBarEl) {
  navBarEl.addEventListener('click', (e) => {
    const target = e.target.closest('[data-action="open-change-password-mobile"]');
    if (!target) return;
    closeMobileNav();
    openChangePasswordModal();
  });
}

const contentEl = $('#content');
if (contentEl) {
  // Mobile compact-row expand/collapse (delegated; survives re-renders).
  initMobileRows(contentEl);
  contentEl.addEventListener('click', async (event) => {
    const target = event.target.closest('[data-action]');
    if (!target) return;

    const action = target.dataset.action;

    if (action === 'trigger-scan') return triggerScan(target.dataset.scope);
    if (action === 'set-period') return setPeriod(target.dataset.period, navigateTo);
    if (action === 'set-chest-drill-period') return setChestDrillPeriod(target.dataset.period, navigateTo);
    if (action === 'toggle-chest-collector') {
      // Ignore clicks that land on the member link so the user can still
      // navigate to the profile page without toggling the row.
      if (event.target.closest('a')) return;
      return toggleChestCollectorRow(target);
    }
    if (action === 'leaderboard-period-prev') return changePeriodOffset(1, navigateTo);
    if (action === 'leaderboard-period-next') return changePeriodOffset(-1, navigateTo);
    if (action === 'leaderboard-page-prev') return changeLeaderboardPage(-1, loadPage);
    if (action === 'leaderboard-page-next') return changeLeaderboardPage(1, loadPage);
    if (action === 'sort-leaderboard') return setLeaderboardSort(target.dataset.sortKey, loadPage);
    if (action === 'sort-triumphal') return setTriumphalSort(target.dataset.sortKey, loadPage);
    if (action === 'triumphal-page-prev') return changeTriumphalPage(-1, loadPage);
    if (action === 'triumphal-page-next') return changeTriumphalPage(1, loadPage);
    if (action === 'triumphal-recent-page-prev') return changeTriumphalRecentPage(-1, loadPage);
    if (action === 'triumphal-recent-page-next') return changeTriumphalRecentPage(1, loadPage);
    if (action === 'triumphal-set-period') return setTriumphalPeriod(target.dataset.period, navigateTo);
    if (action === 'triumphal-period-prev') return changeTriumphalPeriodOffset(1, navigateTo);
    if (action === 'triumphal-period-next') return changeTriumphalPeriodOffset(-1, navigateTo);
    if (action === 'sort-chest-collectors') return setChestCollectorsSort(target.dataset.sortKey);
    if (action === 'sessions-page-prev') return changeSessionsPage(-1, loadPage);
    if (action === 'sessions-page-next') return changeSessionsPage(1, loadPage);
    if (action === 'delete-session') return deleteScanSession(
      Number.parseInt(target.dataset.sessionId || '0', 10),
      Number.parseInt(target.dataset.sessionChests || '0', 10),
      navigateTo,
    );
    if (action === 'audit-page-prev') return changeAuditPage(-1, loadPage);
    if (action === 'audit-page-next') return changeAuditPage(1, loadPage);
    if (action === 'member-chests-page-prev') return changeMemberChestsPage(-1, Number.parseInt(target.dataset.memberId || '0', 10));
    if (action === 'member-chests-page-next') return changeMemberChestsPage(1, Number.parseInt(target.dataset.memberId || '0', 10));
    if (action === 'member-triumphals-page-prev') return changeMemberTriumphalsPage(-1, Number.parseInt(target.dataset.memberId || '0', 10));
    if (action === 'member-triumphals-page-next') return changeMemberTriumphalsPage(1, Number.parseInt(target.dataset.memberId || '0', 10));
    if (action === 'member-resources-page-prev') return changeMemberResourcesPage(-1, Number.parseInt(target.dataset.memberId || '0', 10));
    if (action === 'member-resources-page-next') return changeMemberResourcesPage(1, Number.parseInt(target.dataset.memberId || '0', 10));
    if (action === 'member-back') {
      // Use browser history to go back to whatever page brought us here
      // (leaderboard, dashboard, members, etc.). Fall back to members list
      // if there's no history (e.g. user landed directly on the URL).
      if (window.history.length > 1) {
        window.history.back();
      } else {
        navigateTo('members');
      }
      return;
    }
    if (action === 'sort-members') return setMembersSort(target.dataset.sortKey, loadPage);
    if (action === 'save-scan-interval') return saveScanIntervalSetting(loadPage);
    if (action === 'login-session-start') {
      // Per-clan login: a button on each clan's card carries
      // data-clan-id; the legacy global button has no clan-id.
      const cidAttr = target.getAttribute('data-clan-id');
      const cid = cidAttr ? Number.parseInt(cidAttr, 10) : NaN;
      return startLoginSession(Number.isFinite(cid) ? cid : undefined);
    }
    if (action === 'login-session-save') return saveLoginSession();
    if (action === 'login-session-cancel') return cancelLoginSession();
    if (action === 'login-session-reload') return reloadLoginSession();
    if (action === 'login-session-paste') return pasteIntoLoginSession();
    if (action === 'restart-container') return restartContainer();
    if (action === 'save-scanner-settings') return saveScannerSettings(loadPage);
    if (action === 'raw-ocr-capture-enable') return toggleRawOcrCapture(true, loadPage);
    if (action === 'raw-ocr-capture-disable') return toggleRawOcrCapture(false, loadPage);
    if (action === 'resource-capture-enable') return toggleResourceCapture(true, loadPage);
    if (action === 'resource-capture-disable') return toggleResourceCapture(false, loadPage);
    if (action === 'might-tracking-enable') return toggleMightTracking(true, loadPage);
    if (action === 'might-tracking-disable') return toggleMightTracking(false, loadPage);
    if (action === 'might-recapture') return requestMightRecapture();
    if (action === 'calibrate-stage') return startCalibrationStage(target.dataset.stage);
    if (action === 'capture-calibration-screenshot') return captureCalibrationScreenshot();
    if (action === 'save-calibration') return saveCalibration(loadPage);
    if (action === 'cancel-calibration') return cancelCalibration();
    if (action === 'reset-calibration-stage') return resetCalibrationStage(loadPage);
    if (action === 'refresh-log-buffer') return refreshLogBuffer(loadPage);
    if (action === 'select-calibration-target') return selectCalibrationTarget(target.dataset.target);
    if (action === 'prompt-merge-member') return promptMergePlayerById(Number.parseInt(target.dataset.memberId || '0', 10), loadPage);
    if (action === 'save-member') return saveMemberName(Number.parseInt(target.dataset.memberId || '0', 10));
    if (action === 'delete-member') return deleteMemberById(Number.parseInt(target.dataset.memberId || '0', 10), target.dataset.memberName, loadPage);
    if (action === 'restore-member') return restoreMemberById(Number.parseInt(target.dataset.memberId || '0', 10), target.dataset.memberName, loadPage);
    if (action === 'do-merge-player') return doMergePlayer(loadPage);
    if (action === 'delete-rule') return deleteRule(Number.parseInt(target.dataset.ruleId || '0', 10), loadPage);
    if (action === 'do-merge-chest') return doMergeChest(loadPage);
    if (action === 'do-merge-source') return doMergeSource(loadPage);
    if (action === 'save-all-source-points') return saveAllSourcePoints(loadPage);
    if (action === 'save-all-triumphal-points') return saveAllTriumphalPoints(loadPage);
    if (action === 'recalculate-source-points') return recalculateSourcePoints(loadPage);
    if (action === 'acknowledge-review') return acknowledgeReviewQueue(target.dataset.reviewCategory || '', loadPage);
    if (action === 'reassign-unknown-row') return reassignUnknownRow(Number.parseInt(target.dataset.chestId || '0', 10), loadPage);
    if (action === 'reassign-unknown-bulk') return reassignUnknownBulk(Number.parseInt(target.dataset.sessionId || '0', 10), loadPage);
    if (action === 'change-password') return openChangePasswordModal();
    if (action === 'create-user') return createNewUser(loadPage);
    if (action === 'delete-user') return deleteUserById(Number.parseInt(target.dataset.userId || '0', 10), loadPage, target.dataset.username);
    if (action === 'reassign-user-clan') return reassignUserClan(Number.parseInt(target.dataset.userId || '0', 10), target.dataset.username, loadPage);
    if (action === 'import-db-backup') return runDbBackupImportFromFile(loadPage);
    if (action === 'restore-server-backup') return restoreServerBackup(target.dataset.fileName, loadPage);
    if (action === 'create-manual-backup') return createManualBackup(loadPage);
    if (action === 'delete-server-backup') return deleteServerBackup(target.dataset.fileName, loadPage);
    if (action === 'clan-restore-inspect') return inspectClanRestoreBackup(loadPage);
    if (action === 'restore-clan') return restoreDeletedClan(Number.parseInt(target.dataset.clanId || '0', 10), target.dataset.clanName, loadPage);
    if (action === 'clan-restore-run') return runClanRestore(target.dataset.fileName, Number.parseInt(target.dataset.clanId || '0', 10), loadPage);
    if (action === 'resources-page-prev') return changeResourcesPage(-1, loadPage);
    if (action === 'resources-page-next') return changeResourcesPage(1, loadPage);
    if (action === 'resources-set-filter') return setResourcesFilter(target.dataset.filterKey, target.dataset.filterValue, loadPage);
    if (action === 'resources-sort') return sortResources(target.dataset.sortKey, loadPage);
    if (action === 'resources-apply-filters') return handleResourcesApplyFilters(loadPage);
    if (action === 'resources-upload') return handleResourcesUpload(loadPage);
    if (action === 'resources-batch-delete') return handleResourcesBatchDelete(Number.parseInt(target.dataset.batchId || '0', 10), loadPage);
    if (action === 'resources-tx-edit') return handleResourcesTxEdit(Number.parseInt(target.dataset.txId || '0', 10));
    if (action === 'resources-tx-save') return handleResourcesTxSave(Number.parseInt(target.dataset.txId || '0', 10), loadPage);
    if (action === 'resources-tx-cancel') return handleResourcesTxCancel(loadPage);
    if (action === 'resources-resolve-unknowns') return handleResourcesResolveUnknowns(loadPage);
  });

  // Hover preview + click-to-enlarge for any row that kept the screenshot it came
  // from: unreadable chest player names, unresolved resource-import rows and
  // first-seen members. The trigger carries the image URL in data-crop-url, so this
  // stays agnostic about which page it serves.
  attachCropPreviews(contentEl);

  contentEl.addEventListener('change', (event) => {
    const select = event.target;
    if (!(select instanceof HTMLSelectElement)) return;

    if (select.classList.contains('chest-type-select')) {
      const chestName = select.dataset.chestName;
      if (!chestName) return;
      return setChestType(chestName, select.value);
    }

    if (select.classList.contains('user-role-select')) {
      const userId = Number.parseInt(select.dataset.userId || '0', 10);
      if (!userId) return;
      return changeRole(userId, select.value, loadPage);
    }

    // When picking an OCR misread on any of the merge forms, prefill
    // the "or type custom" field with the same value so the user only
    // needs to edit the casing/typo instead of retyping it.
    if (select.id === 'mergePlayerFrom') {
      const customInput = $('#mergePlayerToCustom');
      if (customInput) customInput.value = select.value;
    }
    if (select.id === 'mergeChestFrom') {
      const customInput = $('#mergeChestToCustom');
      if (customInput) customInput.value = select.value;
    }
    if (select.id === 'mergeSourceFrom') {
      const customInput = $('#mergeSourceToCustom');
      if (customInput) customInput.value = select.value;
    }

    if (select.classList.contains('resource-filter-select')) {
      return setResourcesFilter(select.dataset.filterKey, select.value, loadPage);
    }
  });

  // Delegated input listener so inputs re-created via innerHTML still work
  // (the members filter re-renders the table on every keystroke, which
  // replaced the old per-input listener before any subsequent keystroke
  // could fire on the original element).
  contentEl.addEventListener('input', (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;

    if (input.id === 'membersFilter') {
      setMembersFilter(input.value);
      const next = $('#membersFilter');
      if (next) {
        next.focus();
        const len = next.value.length;
        next.setSelectionRange(len, len);
      }
    }
  });
}

const logoutBtn = $('#logoutBtn');
if (logoutBtn) {
  logoutBtn.addEventListener('click', () => logout());
}

const userMenuBtn = $('#userMenuBtn');
if (userMenuBtn) {
  userMenuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleUserMenu();
  });
}

const userMenu = $('#userMenu');
if (userMenu) {
  userMenu.addEventListener('click', (e) => {
    const target = e.target.closest('[data-action]');
    if (!target) return;
    if (target.dataset.action === 'open-change-password') {
      openChangePasswordModal();
    }
  });
}

// ─── Scroll position across navigation ───
// Hash routing never leaves the document, so the browser keeps the scroll
// offset: clicking a member/chest link from halfway down the leaderboard
// opened the next page already scrolled that far, past its header.
//
// Reset on a real route change only — the page part of the hash changing. A
// re-render of the *same* page has to keep the offset (members filter typed,
// leaderboard timeframe switched, an admin form saved, several of which
// restore it explicitly), which is why this keys on the route and not on
// loadPage itself.
//
// The first attempt exempted back/forward by way of a popstate flag, on the
// assumption that popstate only fires on a traversal. It doesn't: a
// same-document fragment navigation fires popstate too, so the flag was set
// on *every* navigation and suppressed the reset entirely. Back/forward
// therefore also lands at the top now, which is no loss — the page re-renders
// from scratch on arrival, so there was never a preserved offset to return to,
// and scrollRestoration is pinned to manual to stop the browser trying.
if ('scrollRestoration' in window.history) {
  window.history.scrollRestoration = 'manual';
}

/** Set by the router when the *next* render lands on a different page. */
let resetScrollAfterRender = false;

window.addEventListener('hashchange', () => {
  const previousPage = currentPage;
  syncRouteFromHash();
  if (currentPage !== previousPage) {
    // Twice, deliberately. Now, so the outgoing page doesn't sit at its old
    // offset for however long the new page's fetches take; and again once the
    // render has written to #content, because the document is at its old
    // height until then and a browser that clamps the offset to the shorter
    // incoming page would otherwise leave us part-way down it.
    window.scrollTo(0, 0);
    resetScrollAfterRender = true;
  }
  updateNavState();
  loadPage(currentPage).catch((err) => {
    if (err?.name !== 'UnauthenticatedError') throw err;
  });
});

// Global safety net for fire-and-forget API calls. Pages that don't
// wrap `await apiPost(...)` in try/catch (or use mustOk) lose their
// errors to the unhandledrejection event by default — the user sees
// nothing and the action looks like it silently succeeded. Surface
// them as a toast so failures are at least visible.
window.addEventListener('unhandledrejection', (event) => {
  const err = event.reason;
  if (!err) return;
  if (err.name === 'UnauthenticatedError') {
    event.preventDefault();
    return;
  }
  // Aborts come from the router cancelling a superseded page's reads
  // (or a background poll caught mid-navigation). They're expected and
  // not actionable — never surface them as an error toast.
  if (err.name === 'AbortError') {
    event.preventDefault();
    return;
  }
  const msg = err.message || String(err);
  notify(msg, 'Unexpected error');
  event.preventDefault();
  // eslint-disable-next-line no-console
  console.error('Unhandled promise rejection:', err);
});

// API helpers (api / apiPost / apiPut / apiDelete) and the
// UnauthenticatedError class moved to ./lib/api.js. Imported at the
// top of this file.

// ─── Page Router ───
// Navigation generation + abort plumbing. Page renders fetch their data
// and only then write into #content; a slow render (made slower by the
// api() empty-body retry) can resolve *after* the user has switched
// tabs and overwrite the page they actually navigated to. Two guards
// stop that:
//   1. We abort the previous load's in-flight GETs (api() attaches this
//      signal), so most stale renders never reach their DOM write.
//   2. A monotonic token catches anything the abort can't — e.g. a page
//      that fetches with raw fetch() (clans) and ignores the signal: if
//      it writes stale content anyway, we re-render the live page so the
//      wrong one can't stick.
let navToken = 0;
let pageLoadController = null;

async function loadPage(page) {
  const myToken = ++navToken;
  pageLoadController?.abort();
  pageLoadController = new AbortController();
  setPageLoadSignal(pageLoadController.signal);

  const content = $('#content');
  try {
    await renderRoute(page, content);
  } catch (err) {
    // A newer navigation aborted this load (or otherwise superseded it).
    // Its response is moot — swallow it instead of surfacing an error
    // toast for a page the user already left. Drop the pending scroll reset
    // with it: the navigation that superseded us arms its own, and leaving
    // this set would fire it on whatever re-render happens to come next.
    if (err?.name === 'AbortError' || myToken !== navToken) {
      resetScrollAfterRender = false;
      return;
    }
    throw err;
  }

  // Superseded after the render had already written to #content (a page
  // that didn't honour the abort signal). Re-render whatever the user is
  // actually on so the stale page can't stick.
  if (myToken !== navToken) {
    loadPage(currentPage);
    return;
  }

  // Re-apply any remembered <details> open/closed state. Pages re-render
  // by replacing #content's HTML, which would otherwise close every
  // collapsible the user had expanded — including the section they were
  // just clicking inside. State is scoped to `page` so that switching
  // tabs clears it; we only persist across re-renders of the same page.
  restoreDetailsState(content, page);
  // Second half of the navigation scroll reset (see the hashchange handler).
  // Consumed rather than read so an in-place re-render — which comes through
  // this same function — can never inherit it.
  if (resetScrollAfterRender) {
    resetScrollAfterRender = false;
    window.scrollTo(0, 0);
  }
  // Visiting System counts as "I've seen the warnings" — bump the
  // local timestamp so the System dot clears after this refresh.
  if (page === 'system') {
    markSystemWarningsSeen();
  }
  // Refresh dots after every page load so admin actions (acknowledging
  // the review queue, reassigning unknown chests) clear the Admin dot
  // immediately, and so the System dot updates after a System visit.
  refreshNavDots();
}

async function renderRoute(page, content) {
  if (page.startsWith('member/')) {
    const memberId = parseInt(page.slice('member/'.length), 10);
    if (Number.isFinite(memberId)) {
      await viewMember(memberId, navigateTo);
      return;
    }
  }
  if (page.startsWith('session/')) {
    const sessionId = parseInt(page.slice('session/'.length), 10);
    if (Number.isFinite(sessionId)) {
      await viewSession(sessionId, navigateTo);
      return;
    }
  }
  if (page.startsWith('chest/')) {
    const chestName = decodeURIComponent(page.slice('chest/'.length));
    if (chestName) {
      await viewChestByName(chestName, navigateTo);
      return;
    }
  }
  // Resources is a two-tab page: #resources = Overview (landing),
  // #resources/admin = the ledger + upload. Both bounce to the dashboard
  // when the active clan doesn't have resources enabled.
  if (page === 'resources/admin') {
    await renderResourcesAdmin(content, navigateTo);
    return;
  }
  if (page === 'resources/totals') {
    await renderResourcesTotals(content, navigateTo);
    return;
  }
  // Events is a multi-sub-tab page: #events = the currently live event (or the
  // first one when nothing is running), #events/<key> = a specific event —
  // every sub-tab links to that explicit form. Timeframe lives in the page module
  // (repaints in place) so switching it never changes the selected event.
  if (page === 'events' || page.startsWith('events/')) {
    const eventKey = page.startsWith('events/')
      ? decodeURIComponent(page.slice('events/'.length))
      : '';
    await renderEvents(content, navigateTo, eventKey);
    return;
  }

  switch (page) {
    case 'dashboard': await renderDashboard(content, updateStatus); break;
    case 'analytics': await renderAnalytics(content); break;
    case 'leaderboard': await renderLeaderboard(content); break;
    case 'triumphal': await renderTriumphal(content); break;
    case 'members': await renderMembers(content); break;
    case 'might': await renderMight(content); break;
    case 'sessions': await renderSessions(content); break;
    case 'external':
      await renderExternal(content, navigateTo);
      break;
    case 'resources': await renderResourcesOverview(content, navigateTo); break;
    case 'admin': await renderAdmin(content); break;
    case 'users': await renderUsers(content); break;
    case 'clans': await renderClans(content, refreshClanIndicator); break;
    case 'system': await renderSystem(content); break;
    case 'system/calibration': await renderSystem(content, { focus: 'calibration' }); break;
    default:
      // Try as a member name
      if (page && page !== 'undefined') {
        await viewMemberByName(decodeURIComponent(page), navigateTo);
      }
      break;
  }
}

// ─── Dashboard moved to ./pages/dashboard.js — imported above. ───
// ─── Analytics + Chest Drill-Down moved to ./pages/analytics.js — imported above. ───
// ─── Leaderboard moved to ./pages/leaderboard.js — imported above. ───
// ─── Members moved to ./pages/members.js — imported above. ───
// ─── Sessions moved to ./pages/sessions.js — imported above. ───


// formatDuration moved to ./lib/ui.js — imported above.


// ─── Users moved to ./pages/users.js — imported above. ───

// ─── Member Detail moved to ./pages/members.js — imported above. ───


// fetchMemberChests + changeMemberChestsPage + renderMemberDetail moved to ./pages/members.js — imported above.






function openChangePasswordModal() {
  closeUserMenu();
  return new Promise((resolve) => {
    const root = document.getElementById('modalRoot');
    if (!root) return resolve(false);

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-card" role="dialog" aria-modal="true">
        <div class="modal-title">Change Password</div>
        <div class="modal-form">
          <label class="modal-form-label">Current Password</label>
          <input type="password" class="input modal-input" id="modalPwCurrent" autocomplete="current-password">
          <label class="modal-form-label">New Password</label>
          <input type="password" class="input modal-input" id="modalPwNew" autocomplete="new-password">
          <p class="modal-form-hint">Must be at least 10 characters with uppercase, lowercase, number, and symbol.</p>
        </div>
        <div class="modal-actions">
          <button class="btn modal-cancel">Cancel</button>
          <button class="btn btn-primary modal-confirm">Change Password</button>
        </div>
      </div>
    `;

    root.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('visible'));

    const currentInput = overlay.querySelector('#modalPwCurrent');
    const newInput = overlay.querySelector('#modalPwNew');
    const confirmBtn = overlay.querySelector('.modal-confirm');
    const cancelBtn = overlay.querySelector('.modal-cancel');

    const cleanup = (result) => {
      overlay.classList.remove('visible');
      setTimeout(() => overlay.remove(), 180);
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };

    const submit = async () => {
      const current = currentInput.value;
      const newPw = newInput.value;
      if (!current || !newPw) {
        await notify('Fill in both fields', 'Change Password');
        currentInput.focus();
        return;
      }
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Changing...';
      try {
        const res = await apiPut('/auth/password', { currentPassword: current, newPassword: newPw });
        if (res.error) {
          confirmBtn.disabled = false;
          confirmBtn.textContent = 'Change Password';
          await notify(res.error, 'Change Password');
          return;
        }
        cleanup(true);
        await notify('Password changed successfully.', 'Success');
      } catch (err) {
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Change Password';
        await notify('Failed to change password: ' + String(err), 'Error');
      }
    };

    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cleanup(false);
      } else if (e.key === 'Enter' && (document.activeElement === currentInput || document.activeElement === newInput)) {
        e.preventDefault();
        submit();
      }
    };
    document.addEventListener('keydown', onKey);

    confirmBtn.addEventListener('click', submit);
    cancelBtn.addEventListener('click', () => cleanup(false));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) cleanup(false);
    });

    setTimeout(() => currentInput.focus(), 0);
  });
}

function toggleUserMenu() {
  const menu = document.getElementById('userMenu');
  const btn = document.getElementById('userMenuBtn');
  if (!menu || !btn) return;
  const isOpen = !menu.hidden;
  if (isOpen) {
    closeUserMenu();
  } else {
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    setTimeout(() => document.addEventListener('click', onDocumentClickForUserMenu), 0);
  }
}

function closeUserMenu() {
  const menu = document.getElementById('userMenu');
  const btn = document.getElementById('userMenuBtn');
  if (!menu || !btn) return;
  menu.hidden = true;
  btn.setAttribute('aria-expanded', 'false');
  document.removeEventListener('click', onDocumentClickForUserMenu);
}

function onDocumentClickForUserMenu(e) {
  const userInfo = document.getElementById('userInfo');
  if (userInfo && !userInfo.contains(e.target)) {
    closeUserMenu();
  }
}

// createNewUser moved to ./pages/users.js — imported above.


// changeRole + deleteUserById moved to ./pages/users.js — imported above.

async function triggerScan(scope) {
  // `scope` is 'clan' (default; superadmin's selected clan) or 'all'
  // (iterate every active clan). The clicked button gets the busy
  // state; status polling later disables both via [data-action=trigger-scan].
  const allClans = scope === 'all';
  const btn = document.querySelector(`[data-action="trigger-scan"][data-scope="${allClans ? 'all' : 'clan'}"]`);
  if (!btn) return;
  const originalLabel = btn.textContent;
  btn.dataset.localBusy = '1';
  btn.textContent = 'Starting scan...';
  btn.disabled = true;
  try {
    const result = await apiPost('/scan', allClans ? { allClans: true } : {});
    if (result.alreadyRunning) {
      await notify('A scan is already in progress. Please wait for it to finish.', 'Scan in progress');
      return;
    }
    if (result.error) {
      await notify(result.error, 'Scan failed to start');
      return;
    }
    // Scan now runs in the background. The header status poll will show
    // "scanning · N chests" while it runs and clear when it finishes.
    notify(
      allClans
        ? 'Scan started for all active clans. Watch the header for progress.'
        : 'Scan started for the selected clan. Watch the header for progress.',
      'Scan started',
    );
  } catch (err) {
    await notify('Failed to start scan: ' + err.message, 'Error');
  }
  finally {
    delete btn.dataset.localBusy;
    // If the request never produced a status update (e.g. validation
    // error before the scan even started), restore the original label
    // so the button doesn't get stuck on "Starting scan...". Status
    // polling overrides this when a scan actually begins.
    if (btn.textContent === 'Starting scan...') {
      btn.textContent = originalLabel;
      btn.disabled = false;
    }
  }
}



// Leaderboard helpers moved to ./pages/leaderboard.js — imported above.
// Period math helpers moved to ./lib/period.js.


function syncRouteFromHash() {
  const { page, params } = parseHashRoute();
  currentPage = page;

  // Leaderboard and Triumphal share the same period state + URL anchor
  // scheme. URL takes precedence; if no period param is present, fall
  // back to the persisted choice (default 'weekly') so a fresh visit
  // honours the user's preference.
  if (page === 'leaderboard' || page === 'triumphal') {
    const rawPeriod = params.get('period');
    const period = ['daily', 'weekly', 'monthly', 'yearly', 'all'].includes(rawPeriod)
      ? rawPeriod
      : getCurrentPeriod();
    setCurrentPeriod(period);
    setCurrentPeriodOffset(periodOffsetFromAnchor(period, params));
    return;
  }

  // Non-period pages don't read these, but reset offset so we don't
  // leak a stale "two weeks ago" anchor onto the next leaderboard visit.
  // Period itself is left alone — it's the user's persisted preference.
  setCurrentPeriodOffset(0);
}

function updateNavState() {
  let navPage = currentPage;
  if (currentPage.startsWith('member/')) navPage = 'members';
  else if (currentPage.startsWith('session/')) navPage = 'sessions';
  else if (currentPage.startsWith('chest/')) navPage = 'analytics';
  else if (currentPage.startsWith('resources')) navPage = 'resources';
  else if (currentPage.startsWith('events')) navPage = 'events';
  else if (currentPage.startsWith('system')) navPage = 'system';
  $$('nav a').forEach((a) => a.classList.toggle('active', a.dataset.page === navPage));
}

// ─── Nav "needs attention" dots ───
// Polls /api/admin/nav-status to decide whether to light the dot on
// Admin (review queue + unknown chests outstanding) and System (warn/
// error log entries newer than the user's last visit). The
// getLastSeenSystemWarningAt / markSystemWarningsSeen pair lives in
// lib/state.js so the System page can also read it (to auto-open the
// Recent Warnings card when fresh entries are present).
async function refreshNavDots() {
  // Only admins/superadmins can hit /admin/nav-status. For everyone else
  // the relevant tabs are hidden anyway, so skip the request.
  if (currentUser?.role !== 'admin' && currentUser?.role !== 'superadmin') return;
  let status;
  try {
    status = await api('/admin/nav-status');
  } catch {
    return;
  }
  const adminDot = document.getElementById('navAdminDot');
  if (adminDot) {
    const adminNeeds =
      (status?.admin?.reviewQueueCount ?? 0) > 0 ||
      (status?.admin?.unknownChestsCount ?? 0) > 0;
    adminDot.classList.toggle('is-hidden', !adminNeeds);
  }
  // Resource rows whose resource the reader couldn't identify. Worth a dot
  // because the automated daily capture means nobody is watching an upload
  // finish any more — without this, unresolved rows would sit unnoticed until
  // someone happened to open the Resources admin tab.
  const resourcesDot = document.getElementById('navResourcesDot');
  if (resourcesDot) {
    const needs = (status?.resources?.unresolvedCount ?? 0) > 0;
    resourcesDot.classList.toggle('is-hidden', !needs);
  }
  const systemDot = document.getElementById('navSystemDot');
  if (systemDot) {
    const latest = status?.system?.latestWarningAt ?? null;
    const lastSeen = getLastSeenSystemWarningAt();
    const systemNeeds = typeof latest === 'number' && latest > lastSeen;
    systemDot.classList.toggle('is-hidden', !systemNeeds);
  }
}

function navigateTo(page, params = {}) {
  const nextHash = buildHash(page, params);
  if (window.location.hash === nextHash) {
    syncRouteFromHash();
    updateNavState();
    loadPage(currentPage);
    return;
  }
  window.location.hash = nextHash;
}

// navigateToLeaderboard moved to ./pages/leaderboard.js — imported above.

// parseHashRoute and buildHash moved to ./lib/ui.js — imported above.
// buildTypeSegments / fillDailySeries / formatGameDayLabel moved to
// ./pages/analytics.js — they're only used by that page.

// formatUtcDateKey, memberHash, memberLink moved to ./lib/ui.js — imported above.


// formatDate moved to ./lib/ui.js — imported above.

// formatDateShort and formatRelativeTime moved to ./lib/ui.js — imported above.

// esc moved to ./lib/ui.js — imported above.

// The header polls /api/status every 2s. A single failed poll is almost
// always transient — a scan briefly pinning the event loop, or an upstream
// proxy (Cloudflare) blip — not a real outage. Flipping straight to
// "Disconnected" on one failure made the header flap constantly. Only show it
// after several consecutive failures (≈6s of silence); until then keep the
// last-known state so momentary blips are invisible. Each poll is also bounded
// by a timeout so a hung request fails fast instead of stacking up.
const STATUS_MAX_FAILURES = 3;
const STATUS_POLL_TIMEOUT_MS = 4000;
let statusFailures = 0;

async function updateStatus() {
  try {
    // AbortSignal.timeout is available in all browsers this app targets;
    // guard anyway so an older engine just polls without a timeout.
    const timeoutOpts = typeof AbortSignal !== 'undefined' && AbortSignal.timeout
      ? { signal: AbortSignal.timeout(STATUS_POLL_TIMEOUT_MS) }
      : undefined;
    const status = await api('/status', timeoutOpts);
    statusFailures = 0;
    const dot = $('#statusDot');
    const text = $('#statusText');
    const errBtn = $('#statusErrorBtn');
    const errPanel = $('#statusErrorDetails');
    // The might snapshot and the resource-history capture both run AFTER the scan
    // is finalised, so the state machine already reads 'idle' while the browser is
    // still working — 20-40s for might, up to half an hour for a full resource
    // backfill. Treat both as busy, or the header claims "idle" through all of it
    // and throws away the progress messages those phases are producing.
    const isScanning = status.state === 'scanning' || status.state === 'processing'
      || status.mightInProgress === true
      || status.resourceInProgress === true;
    if (isScanning && status.progressMessage) {
      text.textContent = status.progressMessage;
    } else if (isScanning && status.liveChestCount > 0) {
      text.textContent = `${status.state} · ${status.liveChestCount} chests`;
    } else if (status.lastScanError && (status.state === 'error' || status.state === 'cooldown' || status.state === 'idle')) {
      // Show the failure phase inline so the user knows WHERE it broke
      // without needing to open the details panel.
      text.textContent = `${status.state} · ${status.lastScanError.phase}`;
    } else {
      text.textContent = status.state;
    }
    dot.className = 'dot';
    if (isScanning) dot.classList.add('scanning');
    else if (status.state === 'error' || status.state === 'cooldown') dot.classList.add('error');

    if (errBtn && errPanel) {
      if (status.lastScanError) {
        errBtn.classList.remove('is-hidden');
        const when = formatRelativeTime(status.lastScanError.at);
        errPanel.innerHTML = [
          `<div class="err-phase">${esc(status.lastScanError.phase)}</div>`,
          `<div>${esc(status.lastScanError.message)}</div>`,
          `<div class="err-when">Failed ${esc(when)}</div>`,
        ].join('');
      } else {
        errBtn.classList.add('is-hidden');
        errPanel.classList.add('is-hidden');
      }
    }

    nextScanAtMs = status.nextScanAt ? new Date(status.nextScanAt).getTime() : null;
    // `clanInactive` is set by /api/status when a regular admin's clan is
    // not in the active scan rotation — distinct from "scanner stopped".
    // Render a clear message instead of an empty header.
    nextScanClanInactive = !!status.clanInactive;
    nextScanInProgress = !!status.scanInProgress;
    renderNextScanCountdown();

    renderOnboardingBanner(status.onboarding);

    // Disable both manual scan buttons (Scan This Clan / Scan All Clans)
    // while a scan is running. The buttons live in the dashboard header
    // and only render for superadmins.
    const scanBtns = document.querySelectorAll('[data-action="trigger-scan"]');
    scanBtns.forEach((btn) => {
      if (btn.dataset.localBusy) return;
      if (status.scanInProgress) {
        btn.disabled = true;
        btn.textContent = 'Scan in progress...';
      } else {
        btn.disabled = false;
        btn.textContent = btn.dataset.scope === 'all' ? 'Scan All Clans' : 'Scan This Clan';
      }
    });
  } catch (err) {
    // Redirecting to /login — not a connectivity problem.
    if (err && err.name === 'UnauthenticatedError') return;
    // Tolerate transient blips: only surface "Disconnected" once several
    // polls in a row have failed. Below the threshold, leave the last-known
    // status in place so a one-off failed poll doesn't flap the header.
    statusFailures++;
    if (statusFailures >= STATUS_MAX_FAILURES) {
      $('#statusText').textContent = 'Disconnected';
      $('#statusDot').className = 'dot error';
    }
  }
}

/**
 * Render the top-of-page onboarding banner from /api/status's
 * `onboarding` block. Visible whenever the next step isn't 'ready':
 *   - calibrate: link to /system (the calibration wizard)
 *   - capture-members: link to /clans (the per-clan onboard buttons)
 * Hidden once the instance is fully provisioned.
 */
function renderOnboardingBanner(onboarding) {
  const el = $('#onboardingBanner');
  if (!el) return;
  if (!onboarding || onboarding.nextStep === 'ready') {
    el.classList.add('is-hidden');
    el.innerHTML = '';
    return;
  }
  if (onboarding.nextStep === 'calibrate') {
    el.classList.remove('is-hidden');
    // Say how far along they are and which stage is next — "not calibrated" on
    // its own sent people to a System page where the wizard is one collapsed
    // card among many, with nothing marking the stage to run.
    const progress = onboarding.calibrationProgress;
    const done = Number.isFinite(progress?.done) ? progress.done : 0;
    const total = Number.isFinite(progress?.total) ? progress.total : 4;
    const stageNumber = done + 1;
    el.innerHTML = `
      <div class="onboarding-banner-icon">⚙</div>
      <div class="onboarding-banner-body">
        <div class="onboarding-banner-title">Calibrate the scanner — step ${stageNumber} of ${total}</div>
        <div class="onboarding-banner-text">
          Scans stay paused until the scanner knows where to click on your game UI.
          ${done > 0 ? `${done} of ${total} stages done.` : 'Four short stages, once per install.'}
        </div>
        <div class="onboarding-banner-progress" role="img" aria-label="${done} of ${total} stages complete">
          ${Array.from({ length: total }, (_, i) => `<span class="onboarding-pip${i < done ? ' is-done' : (i === done ? ' is-next' : '')}"></span>`).join('')}
        </div>
      </div>
      <a class="btn btn-primary" href="#system/calibration">${done > 0 ? 'Continue calibration' : 'Start calibration'}</a>
    `;
    return;
  }
  if (onboarding.nextStep === 'capture-members') {
    el.classList.remove('is-hidden');
    el.innerHTML = `
      <div class="onboarding-banner-icon">👥</div>
      <div class="onboarding-banner-body">
        <div class="onboarding-banner-title">Capture the clan member list</div>
        <div class="onboarding-banner-text">
          Calibration is done. Now the scanner needs to learn who's in your clan before it can attribute chests to members.
        </div>
      </div>
      <a class="btn btn-primary" href="#clans">Open Clans page</a>
    `;
    return;
  }
  el.classList.add('is-hidden');
  el.innerHTML = '';
}

function renderNextScanCountdown() {
  const el = $('#nextScan');
  if (!el) return;
  // While a scan is running the next-scan time isn't meaningful yet — the
  // real countdown is (re)scheduled only when the whole cycle finishes. On
  // a boot-time scan nextScanAt is even seeded a full interval ahead, which
  // showed a misleading "Next scan in 1h 53m" mid-scan. Show the scan state
  // instead until the cycle ends and the timer is reset.
  if (nextScanInProgress) {
    el.textContent = 'Scanning…';
    return;
  }
  if (!nextScanAtMs) {
    el.textContent = nextScanClanInactive ? 'This clan is inactive — no scheduled scans' : '';
    return;
  }
  const remainingMs = nextScanAtMs - Date.now();
  if (remainingMs <= 0) {
    el.textContent = 'Next scan: now';
    return;
  }
  const totalSec = Math.floor(remainingMs / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  const formatted = hours > 0
    ? `${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`
    : `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  el.textContent = `Next scan in ${formatted}`;
}

// ─── Init ───
(async () => {
  await checkAuth();

  // On first login (no scans yet but members exist), go straight to admin page
  // so the super admin can review/fix member names before first scan
  const stats = await api('/stats');
  const members = await api('/members');
  if (stats.totalSessions === 0 && members.length > 0 && (currentUser?.role === 'admin' || currentUser?.role === 'superadmin') && !window.location.hash) {
    navigateTo('admin');
  } else {
    syncRouteFromHash();
  }

  updateNavState();
  loadPage(currentPage);
  setInterval(updateStatus, 2000);
  setInterval(renderNextScanCountdown, 1000);
  // Re-poll nav-dot state every 60s so a warning logged while the user
  // sits on (say) the Dashboard still lights the System dot without a
  // page navigation. Cheap counts-only endpoint.
  setInterval(refreshNavDots, 60_000);
  updateStatus();
})();
