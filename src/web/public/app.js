// Tiny DOM helpers, the modal system, fetch wrappers, and shared
// mutable state all live under ./lib/. Keeping them here as imports
// (rather than re-declared at the top of app.js) means each page
// module added later in the C1 split can pull them directly without
// going through app.js.
import {
  $, $$,
  escapeHtml, esc,
  formatDate, formatDateShort, formatRelativeTime, formatDuration, formatCountdown, formatTriggerSource,
  openModal, notify, confirmDialog, promptDialog,
  buildHash, parseHashRoute,
  memberHash, memberLink, sessionHash, chestHash, slugifyChestName,
  restoreDetailsState,
  attachCropPreviews,
  holdDialogFocus,
  prefersReducedMotion,
} from './lib/ui.js';
import { api, apiPost, apiPut, apiDelete, UnauthenticatedError } from './lib/api.js';
import {
  getGameDayRolloverUtcHour,
  setCurrentUser,
  setWeekStart,
  getCurrentPeriod,
  setCurrentPeriod,
  setCurrentPeriodOffset,
  getLastSeenSystemWarningAt,
  markSystemWarningsSeen,
  setPageLoadSignal,
} from './lib/state.js';
import { computeGameWindow, getCurrentGameDayKey, periodOffsetFromAnchor } from './lib/period.js';
import { applyTheme, bindThemeSwitcher } from './lib/theme.js';
import { adoptAccountLanguage, bindLanguageSwitcher, t, tn } from './lib/i18n.js';
import { initMobileRows } from './lib/mobile-rows.js';
import { checkLiveBuild, initBuildCheck, noteLiveBuild, reloadIfNewBuild } from './lib/build-check.js';
import { initSortableHeaders } from './lib/sort-headers.js';
import { renderScanCards, tickScanCards } from './lib/scan-card.js';
import { openAvatarEditor } from './lib/avatar-editor.js';
import {
  initShell,
  closeShellOverlay,
  closeUserMenu,
  refreshClanSwitcher,
  setShellScanState,
  setShellUser,
  setScanButtonLabel,
  syncMoreDot,
} from './lib/shell.js';
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
  removeUserAvatar,
  changeRole,
  reassignUserClan,
  editUserClans,
  changeGuestClanRole,
  removeGuestFromClan,
  changeAuditPage,
} from './pages/users.js';
import {
  renderLeaderboard,
  setLeaderboardSort,
  changeLeaderboardPage,
  setPeriod,
  changePeriodOffset,
  navigateToLeaderboard,
  openLeaderboardFaqModal,
  copyLeaderboardToClipboard,
} from './pages/leaderboard.js';
import { renderDashboard } from './pages/dashboard.js';
import {
  renderMembers,
  renderMembersTable,
  membersTabsHtml,
  setMembersSort,
  setMembersFilter,
  setMembersMightWindow,
  viewMember,
  viewMemberByName,
  changeMemberChestsPage,
  changeMemberTriumphalsPage,
  changeMemberResourcesPage,
} from './pages/members.js';
import { renderMight } from './pages/might.js';
import { renderClan, setClanTab, switchClanTab } from './pages/clan.js';
import { renderChats } from './pages/chats.js';
import { renderPerformance } from './pages/performance.js';
import {
  renderAnalytics,
  viewChestByName,
  viewSourceByName,
  setChestDrillPeriod,
  setChestCollectorsSort,
  toggleChestCollectorRow,
} from './pages/analytics.js';
import {
  renderSystem,
  saveScanIntervalSetting,
  restartContainer,
  runDbBackupImportFromFile,
  restoreServerBackup,
  createManualBackup,
  deleteServerBackup,
  inspectClanRestoreBackup,
  runClanRestore,
  restoreDeletedClan,
  refreshLogBuffer,
  saveScheduleCorrection,
  deleteScheduleCorrection,
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
  handleResourcesApplyFilters,
  handleResourcesBatchDelete,
  handleResourcesTxEdit,
  handleResourcesTxSave,
  handleResourcesTxCancel,
} from './pages/resources.js';
import { renderResourcesOverview } from './pages/resources-overview.js';
import { renderResourcesTotals } from './pages/resources-totals.js';
import { renderResourcesChestRewards } from './pages/resources-chest-rewards.js';
import { renderEvents } from './pages/events.js';
import { renderTools } from './pages/tools.js';
import {
  renderAdmin,
  doMergePlayer,
  syncPlayerMergeCustom,
  doMergeChest,
  doMergeSource,
  saveAllTriumphalPoints,
  deleteRule,
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
// System page state (importPreviewState, transferStatus) moved into
// ./pages/system.js.

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
    // Before any page renders: every week window in lib/period.js reads it.
    setWeekStart(data.activeClan?.weekStart);

    // Sync the inline data-theme bootstrap (cached from a prior visit,
    // possibly on this device) with the server's source of truth. If
    // they differ, the server wins — but we don't echo a PUT back since
    // we just read that value.
    if (currentUser.theme) {
      applyTheme(currentUser.theme, { persist: true, syncServer: false });
    }
    bindThemeSwitcher();
    // Same for the language — except a change needs a reload, which
    // adoptAccountLanguage does itself (once; never when storage is blocked).
    adoptAccountLanguage(currentUser.language);
    bindLanguageSwitcher();
    // Mirror to lib/state.js so page modules that don't share app.js's
    // module scope (pages/*.js) can read the same value via
    // getCurrentUser() without taking a hard import dependency on app.js.
    setCurrentUser(currentUser);

    // The account at the sidebar's foot (and in the phone sheet).
    setShellUser(currentUser);

    const navAdminEl = $('#navAdmin');
    const navUsersEl = $('#navUsers');
    const navClansEl = $('#navClans');
    const navSystemEl = $('#navSystem');
    const navPerformanceEl = $('#navPerformance');
    if (navAdminEl) navAdminEl.classList.add('is-hidden');
    if (navUsersEl) navUsersEl.classList.add('is-hidden');
    if (navClansEl) navClansEl.classList.add('is-hidden');
    if (navSystemEl) navSystemEl.classList.add('is-hidden');
    if (navPerformanceEl) navPerformanceEl.classList.add('is-hidden');

    // Show/hide nav based on role — the sidebar, and with it the phone's More
    // sheet, which is the same element (lib/shell.js).
    // - Member (user): Overview + Clan, nothing under Manage.
    // - Admin tab: clan admin + superadmin (per-clan content management).
    // - Clans tab: clan admin (own clan only) + superadmin (all clans).
    // - Users tab: clan admin (own clan only, no superadmins shown) +
    //   superadmin (everyone).
    // - System tab: superadmin only (instance-wide settings).
    // - Performance: clan admin + superadmin (it names underachievers).
    if (currentUser.role === 'admin' || currentUser.role === 'superadmin') {
      if (navPerformanceEl) navPerformanceEl.classList.remove('is-hidden');
      if (navAdminEl) navAdminEl.classList.remove('is-hidden');
      if (navClansEl) navClansEl.classList.remove('is-hidden');
      if (navUsersEl) navUsersEl.classList.remove('is-hidden');
    }
    if (currentUser.role === 'superadmin') {
      if (navSystemEl) navSystemEl.classList.remove('is-hidden');
    }

    // Manual scans live in the sidebar's scanner card (the phone sheet is the
    // same element), superadmin only; everyone else sees the state alone.
    for (const el of document.querySelectorAll('[data-scan-controls]')) {
      el.classList.toggle('is-hidden', currentUser.role !== 'superadmin');
    }

    // The clan block at the top of the sidebar: a switcher for a superadmin
    // or an account granted extra clans, a read-only label for everyone else,
    // so they always know which clan's data they're looking at.
    await refreshClanSwitcher(currentUser);

    // ChestTracker tab visibility is driven by the integration's own
    // enabled flag, not by user role — any logged-in user sees it when
    // it's on, nobody sees it when it's off.
    refreshExternalNavVisibility();

    // Render the build SHA in the footer so the operator can verify
    // after a redeploy that the running container actually picked up
    // the latest commit. Failure here is non-fatal — the footer just
    // stays as "—" if /api/health doesn't respond.
    refreshBuildFooter();
    // A tab open across a deploy reloads into the new build at its next navigation.
    initBuildCheck();
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
      el.title = t('/api/health failed');
      return;
    }
    const data = await res.json();
    noteLiveBuild(data.fingerprint);
    const fp = data.fingerprint || t('unknown');
    const builtAt = data.builtAt || 'unknown';
    // Format the timestamp for the visible footer; full fingerprint +
    // formatted timestamp stay in the title for hover. Use the shared
    // formatDate so both surfaces match the YYYY/MM/DD HH:MM:SS format
    // the rest of the site uses (toLocaleString defaulted to a
    // US-style M/D/YYYY which clashed with every other timestamp).
    const builtAtShort = builtAt === 'unknown' ? t('unknown') : formatDate(builtAt);
    el.textContent = t('build {fingerprint} · {built}', { fingerprint: fp, built: builtAtShort });
    el.title = t('fingerprint {fingerprint} · built {built}', { fingerprint: fp, built: builtAtShort });
  } catch {
    el.textContent = '—';
    el.title = t('/api/health unreachable');
  }
}

/** Redraw the sidebar's clan block — after a clan is renamed on the Clans page. */
function refreshClanIndicator() {
  return refreshClanSwitcher(currentUser);
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


async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login';
}

// ─── The shell ───
// Sidebar, rail, phone tab bar + More sheet, clan switcher, account menu:
// lib/shell.js. Wired before the first await so its controls work while the
// first page is still loading.
initShell();

const statusErrorBtn = $('#statusErrorBtn');
const statusErrorPanel = $('#statusErrorDetails');
if (statusErrorBtn && statusErrorPanel) {
  statusErrorBtn.setAttribute('aria-expanded', 'false');
  statusErrorBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    statusErrorPanel.classList.toggle('is-hidden');
    statusErrorBtn.setAttribute('aria-expanded', String(!statusErrorPanel.classList.contains('is-hidden')));
  });
  document.addEventListener('click', (e) => {
    if (statusErrorPanel.classList.contains('is-hidden')) return;
    if (statusErrorPanel.contains(e.target) || statusErrorBtn.contains(e.target)) return;
    statusErrorPanel.classList.add('is-hidden');
    statusErrorBtn.setAttribute('aria-expanded', 'false');
  });
}

// Escape closes the scan-error details and hands focus back to their button
// (lib/shell.js does the same for the account menu and the clan switcher).
// Dialogs never see this: their own Escape is taken in the capture phase
// (holdDialogFocus).
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (statusErrorPanel && !statusErrorPanel.classList.contains('is-hidden')) {
    statusErrorPanel.classList.add('is-hidden');
    statusErrorBtn?.setAttribute('aria-expanded', 'false');
    statusErrorBtn?.focus();
  }
});

// The global reduced-motion rule in base.css can't reach a canvas: Chart.js
// tweens every chart in, and the charts are rebuilt on each period or metric
// switch, so the motion replays constantly. Follow the OS setting live.
const chartAnimationDefault = window.Chart ? window.Chart.defaults.animation : undefined;
function syncChartMotion() {
  if (!window.Chart) return;
  window.Chart.defaults.animation = prefersReducedMotion() ? false : chartAnimationDefault;
}
syncChartMotion();
window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', syncChartMotion);

// ─── Navigation ───
// The sidebar's links and the phone tab bar's (both are <nav>s).
$$('nav a[data-page]').forEach((link) => {
  link.addEventListener('click', (e) => {
    e.preventDefault();
    closeShellOverlay();
    navigateTo(link.dataset.page);
  });
});

// Manual scan buttons sit in the shell's scanner card, outside #content, so
// they get their own listener.
for (const el of document.querySelectorAll('[data-scan-controls]')) {
  el.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-action="trigger-scan"]');
    if (btn) triggerScan(btn.dataset.scope, btn);
  });
}

const contentEl = $('#content');
if (contentEl) {
  // Mobile compact-row expand/collapse (delegated; survives re-renders).
  initMobileRows(contentEl);
  // Keep focus on a sort header across the re-render its sort triggers.
  initSortableHeaders(contentEl);
  contentEl.addEventListener('click', async (event) => {
    const target = event.target.closest('[data-action]');
    if (!target) return;

    const action = target.dataset.action;

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
    if (action === 'open-leaderboard-faq') return openLeaderboardFaqModal();
    if (action === 'leaderboard-copy-data') return copyLeaderboardToClipboard(target);
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
    if (action === 'members-might-window') return setMembersMightWindow(target.dataset.window);
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
    if (action === 'refresh-log-buffer') return refreshLogBuffer(loadPage);
    if (action === 'prompt-merge-member') return promptMergePlayerById(Number.parseInt(target.dataset.memberId || '0', 10), loadPage);
    if (action === 'save-member') return saveMemberName(Number.parseInt(target.dataset.memberId || '0', 10));
    if (action === 'delete-member') return deleteMemberById(Number.parseInt(target.dataset.memberId || '0', 10), target.dataset.memberName, loadPage);
    if (action === 'restore-member') return restoreMemberById(Number.parseInt(target.dataset.memberId || '0', 10), target.dataset.memberName, loadPage);
    if (action === 'do-merge-player') return doMergePlayer(loadPage);
    if (action === 'delete-rule') return deleteRule(Number.parseInt(target.dataset.ruleId || '0', 10), loadPage);
    if (action === 'do-merge-chest') return doMergeChest(loadPage);
    if (action === 'do-merge-source') return doMergeSource(loadPage);
    if (action === 'save-all-triumphal-points') return saveAllTriumphalPoints(loadPage);
    if (action === 'save-schedule-correction') return saveScheduleCorrection(loadPage);
    if (action === 'delete-schedule-correction') return deleteScheduleCorrection(Number.parseInt(target.dataset.correctionId || '0', 10), loadPage);
    if (action === 'change-password') return openChangePasswordModal();
    if (action === 'create-user') return createNewUser(loadPage);
    if (action === 'delete-user') return deleteUserById(Number.parseInt(target.dataset.userId || '0', 10), loadPage, target.dataset.username);
    if (action === 'remove-user-avatar') return removeUserAvatar(Number.parseInt(target.dataset.userId || '0', 10), target.dataset.username, loadPage);
    if (action === 'reassign-user-clan') return reassignUserClan(Number.parseInt(target.dataset.userId || '0', 10), target.dataset.username, loadPage);
    if (action === 'edit-user-clans') return editUserClans(Number.parseInt(target.dataset.userId || '0', 10), loadPage);
    if (action === 'remove-guest-clan') return removeGuestFromClan(Number.parseInt(target.dataset.userId || '0', 10), Number.parseInt(target.dataset.clanId || '0', 10), target.dataset.username, loadPage);
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
    if (action === 'resources-batch-delete') return handleResourcesBatchDelete(Number.parseInt(target.dataset.batchId || '0', 10), loadPage);
    if (action === 'resources-tx-edit') return handleResourcesTxEdit(Number.parseInt(target.dataset.txId || '0', 10));
    if (action === 'resources-tx-save') return handleResourcesTxSave(Number.parseInt(target.dataset.txId || '0', 10), loadPage);
    if (action === 'resources-tx-cancel') return handleResourcesTxCancel(loadPage);
  });

  // Hover preview + click-to-enlarge for any row that kept the screenshot it came
  // from (rows recorded by the retired screenshot reader): unreadable chest
  // player names, unresolved resource rows and first-seen members. The trigger carries the image URL in data-crop-url, so this
  // stays agnostic about which page it serves.
  attachCropPreviews(contentEl);

  contentEl.addEventListener('change', (event) => {
    const select = event.target;
    if (!(select instanceof HTMLSelectElement)) return;

    if (select.classList.contains('user-role-select')) {
      const userId = Number.parseInt(select.dataset.userId || '0', 10);
      if (!userId) return;
      // A guest row's select sets the role IN THIS CLAN, not the account's.
      const guestClanId = Number.parseInt(select.dataset.guestClanId || '0', 10);
      if (guestClanId) return changeGuestClanRole(userId, guestClanId, select.value, loadPage);
      return changeRole(userId, select.value, loadPage);
    }

    // When picking a misread on any of the merge forms, prefill
    // the "or type custom" field with the same value so the user only
    // needs to edit the casing/typo instead of retyping it.
    // For players the text field is also what gets merged (see
    // syncPlayerMergeCustom), so a misread must not overwrite a Correct
    // Name already picked.
    if (select.id === 'mergePlayerFrom' && !$('#mergePlayerTo')?.value) {
      const customInput = $('#mergePlayerToCustom');
      if (customInput) customInput.value = select.value;
    }
    if (select.id === 'mergePlayerTo') syncPlayerMergeCustom(select, $('#mergePlayerToCustom'));
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

// The account menu's own toggle lives in lib/shell.js; its actions here.
const userMenu = $('#userMenu');
if (userMenu) {
  userMenu.addEventListener('click', (e) => {
    const target = e.target.closest('[data-action]');
    if (!target) return;
    if (target.dataset.action === 'open-change-password') {
      // Out of the phone sheet first, so the dialog isn't stacked on a menu.
      closeShellOverlay();
      openChangePasswordModal();
    } else if (target.dataset.action === 'open-avatar-editor') {
      closeShellOverlay();
      closeUserMenu();
      openAvatarEditor(currentUser, (avatar) => {
        // In place: pages hold this same object (lib/state.js).
        currentUser.avatar = avatar;
        setShellUser(currentUser);
      });
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
  // A newer build went live while this tab was open: load it, on this route.
  if (reloadIfNewBuild()) return;
  void checkLiveBuild();
  const previousPage = currentPage;
  syncRouteFromHash();
  // My Clan's tabs have their own addresses (#clan/<tab>, #triumphal) but are
  // one page: moving between them keeps the scroll position.
  const pageGroup = (p) => (p === 'clan' || p === 'triumphal' || p.startsWith('clan/') ? 'clan' : p);
  if (pageGroup(currentPage) !== pageGroup(previousPage)) {
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
  notify(msg, t('Unexpected error'));
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

// With no page it redraws the current route — what a page's action handlers
// want when the page has sub-routes (Admin's tabs) and they don't know which
// one is showing.
async function loadPage(page = currentPage) {
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
  if (page.startsWith('source/')) {
    const source = decodeURIComponent(page.slice('source/'.length));
    if (source) {
      await viewSourceByName(source, navigateTo);
      return;
    }
  }
  // Resources is a three-tab page: #resources = Overview (landing),
  // #resources/totals = per-member totals, #resources/admin = the ledger.
  // Chest rewards has its own menu entry (#chest-rewards); its old address
  // under Resources still opens it.
  if (page === 'resources/admin') {
    await renderResourcesAdmin(content);
    return;
  }
  if (page === 'resources/totals') {
    await renderResourcesTotals(content);
    return;
  }
  // My Clan on a section: #clan/research, #clan/rankings, …
  if (page.startsWith('clan/')) {
    const tab = decodeURIComponent(page.slice('clan/'.length));
    // My Clan already on screen (a tab click): switch the panel in place.
    if (!(await switchClanTab(content, tab))) {
      setClanTab(tab);
      await renderClan(content);
    }
    return;
  }
  if (page === 'chest-rewards' || page === 'resources/chests') {
    await renderResourcesChestRewards(content);
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
  // Tools: #tools = the first tool, #tools/<key> = a specific one.
  if (page === 'tools' || page.startsWith('tools/')) {
    await renderTools(content, page.startsWith('tools/') ? decodeURIComponent(page.slice('tools/'.length)) : '');
    return;
  }
  // Admin: #admin = Review while anything needs it, else Members;
  // #admin/<tab> = a specific tab.
  if (page === 'admin' || page.startsWith('admin/')) {
    await renderAdmin(content, page.startsWith('admin/') ? decodeURIComponent(page.slice('admin/'.length)) : '');
    return;
  }

  switch (page) {
    case 'dashboard': await renderDashboard(content); break;
    case 'analytics': await renderAnalytics(content); break;
    case 'leaderboard': await renderLeaderboard(content); break;
    case 'triumphal': {
      // A tab of My Clan with its own address (the period selector lives in
      // it): with My Clan on screen only the tab's panel changes.
      if (!(await switchClanTab(content, 'triumphal'))) {
        setClanTab('triumphal');
        await renderClan(content);
      }
      break;
    }
    case 'members': await renderMembers(content); break;
    case 'might': {
      // A tab of Members (its strip on top), still its own page.
      content.innerHTML = `${membersTabsHtml('might')}<div data-might-body></div>`;
      await renderMight(content.querySelector('[data-might-body]'));
      break;
    }
    case 'clan': await renderClan(content); break;
    case 'chats': await renderChats(content); break;
    case 'performance': await renderPerformance(content); break;
    case 'sessions': await renderSessions(content); break;
    case 'external':
      await renderExternal(content, navigateTo);
      break;
    case 'resources': await renderResourcesOverview(content); break;
    case 'users': await renderUsers(content); break;
    case 'clans': await renderClans(content, refreshClanIndicator); break;
    case 'system': await renderSystem(content); break;
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
        <div class="modal-title">${t('Change Password')}</div>
        <div class="modal-form">
          <label class="modal-form-label" for="modalPwCurrent">${t('Current Password')}</label>
          <input type="password" class="input modal-input" id="modalPwCurrent" autocomplete="current-password">
          <label class="modal-form-label" for="modalPwNew">${t('New Password')}</label>
          <input type="password" class="input modal-input" id="modalPwNew" autocomplete="new-password">
          <p class="modal-form-hint">${t('Must be at least 10 characters with uppercase, lowercase, number, and symbol.')}</p>
        </div>
        <div class="modal-actions">
          <button class="btn modal-cancel">${t('Cancel')}</button>
          <button class="btn btn-primary modal-confirm">${t('Change Password')}</button>
        </div>
      </div>
    `;

    root.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('visible'));

    const currentInput = overlay.querySelector('#modalPwCurrent');
    const newInput = overlay.querySelector('#modalPwNew');
    const confirmBtn = overlay.querySelector('.modal-confirm');
    const cancelBtn = overlay.querySelector('.modal-cancel');

    let release = () => {};
    const cleanup = (result) => {
      overlay.classList.remove('visible');
      setTimeout(() => overlay.remove(), 180);
      overlay.removeEventListener('keydown', onKey);
      release();
      resolve(result);
    };

    const submit = async () => {
      const current = currentInput.value;
      const newPw = newInput.value;
      if (!current || !newPw) {
        await notify(t('Fill in both fields'), t('Change Password'));
        currentInput.focus();
        return;
      }
      confirmBtn.disabled = true;
      confirmBtn.textContent = t('Changing...');
      try {
        const res = await apiPut('/auth/password', { currentPassword: current, newPassword: newPw });
        if (res.error) {
          confirmBtn.disabled = false;
          confirmBtn.textContent = t('Change Password');
          await notify(res.error, t('Change Password'));
          return;
        }
        cleanup(true);
        await notify(t('Password changed successfully.'), t('Success'));
      } catch (err) {
        confirmBtn.disabled = false;
        confirmBtn.textContent = t('Change Password');
        await notify(t('Failed to change password: {error}', { error: String(err) }), t('Error'));
      }
    };

    const onKey = (e) => {
      if (e.key === 'Enter' && (e.target === currentInput || e.target === newInput)) {
        e.preventDefault();
        submit();
      }
    };
    overlay.addEventListener('keydown', onKey);

    confirmBtn.addEventListener('click', submit);
    cancelBtn.addEventListener('click', () => cleanup(false));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) cleanup(false);
    });

    // Opened from the account menu, which has closed by now: hand focus back
    // to what opened that — the account button, or More in the phone sheet.
    const phone = window.matchMedia('(max-width: 640px)').matches;
    release = holdDialogFocus(overlay, {
      card: overlay.querySelector('.modal-card'),
      initial: currentInput,
      onEscape: () => cleanup(false),
      returnTo: document.getElementById(phone ? 'shellMoreBtn' : 'userMenuBtn'),
    });
  });
}

// createNewUser moved to ./pages/users.js — imported above.


// changeRole + deleteUserById moved to ./pages/users.js — imported above.

async function triggerScan(scope, btn) {
  // `scope` is 'clan' (default; superadmin's selected clan) or 'all'
  // (iterate every active clan). The clicked button gets the busy
  // state; status polling later disables every copy via [data-action=trigger-scan].
  const allClans = scope === 'all';
  if (!btn) return;
  const labelOf = () => (btn.querySelector('.btn-label') ?? btn).textContent;
  const originalLabel = labelOf();
  btn.dataset.localBusy = '1';
  setScanButtonLabel(btn, t('Starting scan...'));
  btn.disabled = true;
  try {
    const result = await apiPost('/scan', allClans ? { allClans: true } : {});
    if (result.alreadyRunning) {
      await notify(t('A scan is already in progress. Please wait for it to finish.'), t('Scan in progress'));
      return;
    }
    if (result.error) {
      await notify(result.error, t('Scan failed to start'));
      return;
    }
    // Scan now runs in the background. The status poll shows it in the
    // sidebar's scanner card while it runs and clears when it finishes.
    notify(
      allClans
        ? t('Scan started for all active clans. The scanner card in the menu shows its progress.')
        : t('Scan started for the selected clan. The scanner card in the menu shows its progress.'),
      t('Scan started'),
    );
  } catch (err) {
    await notify(t('Failed to start scan: {error}', { error: err.message }), t('Error'));
  }
  finally {
    delete btn.dataset.localBusy;
    // If the request never produced a status update (e.g. validation
    // error before the scan even started), restore the original label
    // so the button doesn't get stuck on "Starting scan...". Status
    // polling overrides this when a scan actually begins.
    if (labelOf() === t('Starting scan...')) {
      setScanButtonLabel(btn, originalLabel);
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
  else if (currentPage.startsWith('chest/') || currentPage.startsWith('source/')) navPage = 'analytics';
  else if (currentPage === 'resources/chests') navPage = 'chest-rewards';
  else if (currentPage === 'triumphal' || currentPage.startsWith('clan/')) navPage = 'clan';
  else if (currentPage === 'might') navPage = 'members';
  else if (currentPage.startsWith('resources')) navPage = 'resources';
  else if (currentPage.startsWith('events')) navPage = 'events';
  else if (currentPage.startsWith('tools')) navPage = 'tools';
  else if (currentPage.startsWith('admin/')) navPage = 'admin';
  else if (currentPage.startsWith('system')) navPage = 'system';
  // The sidebar's link and the phone tab bar's both say where you are.
  $$('nav a[data-page]').forEach((a) => {
    const here = a.dataset.page === navPage;
    a.classList.toggle('active', here);
    if (here) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  updatePageHead(navPage);
}

// One line under each page's title. Kept to what the page is FOR — the page
// itself carries the detail.
const PAGE_SUBTITLES = {
  dashboard: t('The clan at a glance'),
  analytics: t('Trends, breakdowns and who carries the clan'),
  leaderboard: t('Points and chests, ranked'),
  performance: t('Who beats their goals, and who falls short'),
  might: t('Power over time, member by member'),
  resources: t('Clan Capital donations'),
  'chest-rewards': t("What the clan's opened chests paid out"),
  events: t('Event runs and who took part'),
  tools: t('Calculators for planning events'),
  triumphal: t('Bank gifts and triumphal packages'),
  members: t('Everyone in the clan'),
  clan: t('The clan as the game shows it: research, treasury, wealth'),
  chats: t('The clan chat, kept for good'),
  sessions: t('Every scan the bot has run'),
  external: t('Imported from ChestTracker'),
  admin: t('Corrections, review and scoring'),
  users: t('Accounts and roles'),
  clans: t('Clans, Discord and sharing'),
  system: t('Scanner, warnings and backups'),
};

/** The page title is the active nav entry's own label, so the two never disagree. */
function updatePageHead(navPage) {
  const link = $(`nav a[data-page="${navPage}"]`);
  const title = link?.querySelector('.nav-label')?.textContent || '';
  const titleEl = $('#pageTitle');
  const subEl = $('#pageSubtitle');
  if (titleEl) titleEl.textContent = title;
  if (subEl) subEl.textContent = PAGE_SUBTITLES[navPage] || '';
  if (title) document.title = `${title} · TB Chest Counter`;
}

// ─── Nav "needs attention" dots ───
// Polls /api/admin/nav-status to decide whether to light the dot on
// Admin (review queue, unknown chests or unresolved resource rows
// outstanding — each one a section on the Admin page that only renders
// while it has entries) and System (warn/error log entries newer than the
// user's last visit). The
// getLastSeenSystemWarningAt / markSystemWarningsSeen pair lives in
// lib/state.js so the System page can also read it (to badge the
// Recent Warnings card with what is new since the last visit).
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
    const adminNeeds = (status?.admin?.reviewQueueCount ?? 0) > 0;
    adminDot.classList.toggle('is-hidden', !adminNeeds);
  }
  const systemDot = document.getElementById('navSystemDot');
  if (systemDot) {
    const latest = status?.system?.latestWarningAt ?? null;
    const lastSeen = getLastSeenSystemWarningAt();
    const systemNeeds = typeof latest === 'number' && latest > lastSeen;
    systemDot.classList.toggle('is-hidden', !systemNeeds);
  }
  // On a phone those entries sit behind More: light its dot too.
  syncMoreDot();
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
// "Disconnected" on one failure made the status flap constantly. Only show it
// after several consecutive failures (≈6s of silence); until then keep the
// last-known state so momentary blips are invisible. Each poll is also bounded
// by a timeout so a hung request fails fast instead of stacking up.
const STATUS_MAX_FAILURES = 3;
const STATUS_POLL_TIMEOUT_MS = 4000;
let statusFailures = 0;

// The scanner's state names, as the scanner card shows them.
const STATUS_STATE_LABELS = {
  idle: t('idle'),
  scanning: t('scanning'),
  processing: t('processing'),
  exporting: t('exporting'),
  error: t('error'),
  cooldown: t('cooldown'),
};
const statusStateLabel = (state) => STATUS_STATE_LABELS[state] ?? state;

async function updateStatus() {
  try {
    // AbortSignal.timeout is available in all browsers this app targets;
    // guard anyway so an older engine just polls without a timeout.
    const timeoutOpts = typeof AbortSignal !== 'undefined' && AbortSignal.timeout
      ? { signal: AbortSignal.timeout(STATUS_POLL_TIMEOUT_MS) }
      : undefined;
    const status = await api('/status', timeoutOpts);
    statusFailures = 0;
    const text = $('#statusText');
    const errBtn = $('#statusErrorBtn');
    const errPanel = $('#statusErrorDetails');
    // `activity` also covers the moment between two clans of a cycle, where
    // nothing is "in progress" but the cycle is still running.
    const activity = status.activity ?? null;
    const isScanning = status.state === 'scanning' || status.state === 'processing'
      || activity !== null;
    // The placeholder's italic "loading" look must not outlive the first poll.
    text.classList.remove('is-loading');
    if (isScanning && status.progressMessage) {
      text.textContent = status.progressMessage;
    } else if (isScanning && status.liveChestCount > 0) {
      text.textContent = tn(status.liveChestCount, '{state} · {n} chests', '{state} · {n} chests', { state: statusStateLabel(status.state), n: status.liveChestCount });
    } else if (status.lastScanError && (status.state === 'error' || status.state === 'cooldown' || status.state === 'idle')) {
      // Show the failure phase inline so the user knows WHERE it broke
      // without needing to open the details panel.
      text.textContent = `${statusStateLabel(status.state)} · ${status.lastScanError.phase}`;
    } else {
      text.textContent = statusStateLabel(status.state);
    }
    // The glyph beside the state line (lib/shell.js): ✓ idle, ◐ scanning,
    // ! a failure — the line itself always says which in words.
    const kind = isScanning ? 'scanning'
      : (status.state === 'error' || status.state === 'cooldown' || status.lastScanError) ? 'error'
        : 'idle';

    renderScanCards(activity, {
      detail: status.progressMessage
        || (activity?.phase === 'scan' ? statusStateLabel(status.state) : ''),
    });

    if (errBtn && errPanel) {
      if (status.lastScanError) {
        errBtn.classList.remove('is-hidden');
        const when = formatRelativeTime(status.lastScanError.at);
        errPanel.innerHTML = [
          `<div class="err-phase">${esc(status.lastScanError.phase)}</div>`,
          `<div>${esc(status.lastScanError.message)}</div>`,
          `<div class="err-when">${t('Failed {when}', { when: esc(when) })}</div>`,
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
    nextScanInProgress = !!status.scanInProgress || activity !== null;
    renderNextScanCountdown();
    setShellScanState({
      kind,
      text: text.textContent,
      next: $('#nextScan')?.textContent ?? '',
      runningClanIds: (activity?.clans ?? (activity ? [activity] : [])).map((c) => c.clanId),
    });

    // Disable the manual scan buttons (Scan This Clan / Scan All Clans)
    // while a scan is running. They live in the sidebar's scanner card (the
    // phone sheet is the same element), superadmin only. The scan card hides
    // them meanwhile; disabled is the backstop, and it holds through the gap
    // between two clans of a cycle too.
    const scanBtns = document.querySelectorAll('[data-action="trigger-scan"]');
    scanBtns.forEach((btn) => {
      if (btn.dataset.localBusy) return;
      if (status.scanInProgress || activity !== null) {
        btn.disabled = true;
        setScanButtonLabel(btn, t('Scan in progress...'));
      } else {
        btn.disabled = false;
        setScanButtonLabel(btn, btn.dataset.scope === 'all' ? t('Scan All Clans') : t('Scan This Clan'));
      }
    });
  } catch (err) {
    // Redirecting to /login — not a connectivity problem.
    if (err && err.name === 'UnauthenticatedError') return;
    // Tolerate transient blips: only surface "Disconnected" once several
    // polls in a row have failed. Below the threshold, leave the last-known
    // status in place so a one-off failed poll doesn't flap the shell.
    statusFailures++;
    if (statusFailures >= STATUS_MAX_FAILURES) {
      $('#statusText').textContent = t('Disconnected');
      setShellScanState({ kind: 'offline', text: t('Disconnected') });
      // The card hides the status line; drop it so "Disconnected" shows
      // instead of a frozen scan.
      renderScanCards(null);
    }
  }
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
    el.textContent = t('Scanning…');
    return;
  }
  if (!nextScanAtMs) {
    el.textContent = nextScanClanInactive ? t('This clan is inactive — no scheduled scans') : '';
    return;
  }
  const remainingMs = nextScanAtMs - Date.now();
  if (remainingMs <= 0) {
    el.textContent = t('Next scan: now');
    return;
  }
  el.textContent = t('Next scan in {time}', { time: formatCountdown(remainingMs) });
}

// ─── Init ───
(async () => {
  await checkAuth();

  // On first login (no scans yet but members exist), go straight to Admin →
  // Members so the super admin can review/fix member names before first scan
  const stats = await api('/stats');
  const members = await api('/members');
  if (stats.totalSessions === 0 && members.length > 0 && (currentUser?.role === 'admin' || currentUser?.role === 'superadmin') && !window.location.hash) {
    navigateTo('admin/members');
  } else {
    syncRouteFromHash();
  }

  updateNavState();
  loadPage(currentPage);
  setInterval(updateStatus, 2000);
  setInterval(renderNextScanCountdown, 1000);
  setInterval(tickScanCards, 1000);
  // Re-poll nav-dot state every 60s so a warning logged while the user
  // sits on (say) the Dashboard still lights the System dot without a
  // page navigation. Cheap counts-only endpoint.
  setInterval(refreshNavDots, 60_000);
  updateStatus();
})();
