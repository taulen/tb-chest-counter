// Users + Audit Log page. Admin/superadmin gated. Lets the operator
// create / delete user accounts and review the audit log of admin
// actions.

import { api, apiPost, apiPut, apiDelete, mustOk } from '../lib/api.js';
import { $, esc, formatDate, formatRelativeTime, notify, confirmDialog, selectDialog, contentModal } from '../lib/ui.js';
import { getCurrentUser } from '../lib/state.js';
import { t, tn, tGame } from '../lib/i18n.js';

const AUDIT_PAGE_SIZE = 25;
let currentAuditPage = 1;
// From the last render, for the extra-clans editor (superadmin only).
let usersById = new Map();
let clansForEditor = [];

const HOME_ICON = '<svg class="clan-chip-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/></svg>';
const EDIT_ICON = '<svg class="clan-chips-edit" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';

// ─── Audit helpers ────────────────────────────────────────────
//
// The action_id → human-readable label map for audit-log entries.
// Anything not listed here falls back to a snake_case → Sentence-case
// transformation in formatAuditAction(), so newly-added actions
// render even before they're added here.
const AUDIT_ACTION_LABELS = {
  upload_storage_state: t('Upload session file'),
  login_session_start: t('Open remote login session'),
  login_session_save: t('Save remote login session'),
  login_session_cancel: t('Cancel remote login session'),
  restart_container: t('Restart container'),
  update_scan_interval: t('Update scan interval'),
  delete_scan_session: t('Delete scan'),
  trigger_manual_scan: t('Trigger manual scan'),
  import_backup_db: t('Restore DB backup'),
  import_json: t('Import JSON'),
  import_csv: t('Import CSV'),
  rename_member: t('Rename member'),
  delete_member: t('Remove member'),
  restore_member: t('Restore member'),
  delete_merge_rule: t('Delete merge rule'),
  merge_player: t('Merge player'),
  merge_chest: t('Merge chest'),
  merge_source: t('Merge source'),
  set_chest_type: t('Set chest type'),
  delete_chest_type_override: t('Delete chest type override'),
  set_source_points: t('Set source points'),
  delete_source_points: t('Delete source points'),
  recalculate_source_points: t('Recalculate source points'),
  acknowledge_review_queue: t('Acknowledge review queue'),
  change_password: t('Change password'),
  create_user: t('Create user'),
  delete_user: t('Delete user'),
  change_role: t('Change user role'),
  change_user_clan: t('Reassign user to clan'),
  set_user_clans: t('Set extra clans'),
  change_clan_role: t('Change guest role'),
  remove_user_clan: t('Remove guest from clan'),
  create_manual_backup: t('Create backup'),
  delete_backup: t('Delete backup'),
  restore_server_backup: t('Restore server backup'),
  reassign_unknown_chests: t('Reassign unknown chests'),
  update_scanner_settings: t('Update scanner settings'),
  update_raw_ocr_capture: t('Toggle raw OCR capture'),
  capture_calibration_screenshot: t('Capture calibration screenshot'),
  save_calibration: t('Save calibration'),
  update_external_config: t('Update ChestTracker config'),
  external_manual_fetch: t('ChestTracker manual fetch'),
  'clan.create': t('Create clan'),
  'clan.update': t('Update clan'),
  'clan.delete': t('Delete clan'),
  'clan.share_token.generate': t('Generate share link'),
  'clan.share_token.disable': t('Disable share link'),
  'clan.discord.update': t('Update Discord webhook'),
  'clan.chesttracker.update': t('Update ChestTracker integration'),
  'clan.inactivity.update': t('Update inactivity settings'),
  'member.auto_deactivate': t('Auto-mark members inactive'),
  ancient_defaults_save: t('Save Ancient planner defaults'),
  'clan.leaderboard_goal.update': t('Update leaderboard goal'),
  'clan.resources.toggle': t('Toggle resource tracking'),
  'clan.restore': t('Restore clan'),
  'clan.share_link.create': t('Create share link'),
  'clan.share_link.delete': t('Delete share link'),
  'clan.share_link.disable': t('Disable share link'),
  'clan.share_link.restore': t('Restore share link'),
  'clan.week_start.update': t('Update week start'),
  clear_last_scan_error: t('Clear last scan error'),
  copy_source_points: t('Copy source points'),
  delete_event_schedule_correction: t('Delete event schedule correction'),
  delete_triumphal_points: t('Delete triumphal points'),
  external_backfill: t('ChestTracker backfill'),
  guards_report_add: t('Add guards report'),
  guards_report_delete: t('Delete guards report'),
  'member.might_capture': t('Might capture'),
  member_levels_import: t('Import levels from chat'),
  might_recapture_requested: t('Request might recapture'),
  reset_calibration: t('Reset calibration'),
  'resources.batch.delete': t('Delete resource upload'),
  'resources.capture': t('Resource capture'),
  'resources.collect': t('Collect resources now'),
  'resources.transaction.update': t('Edit resource row'),
  'resources.upload': t('Upload resource screenshots'),
  set_event_schedule_correction: t('Set event schedule correction'),
  set_triumphal_points: t('Set triumphal points'),
  tinman_assign: t('Assign Tin Man score'),
  tinman_delete: t('Delete Tin Man upload'),
  tinman_targets: t('Set Tin Man targets'),
  tinman_targets_delete: t('Delete Tin Man targets'),
  tinman_upload: t('Upload Tin Man standings'),
  update_might_tracking: t('Update might tracking'),
  update_resource_capture: t('Update resource capture settings'),
};

function parseAuditDetails(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function formatAuditAction(action) {
  if (!action) return '';
  if (AUDIT_ACTION_LABELS[action]) return AUDIT_ACTION_LABELS[action];
  return action.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

function formatAuditDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}/${mm}/${dd} ${hh}:${min}`;
}

// Show a relative timestamp ("2h ago") with the full local date+time
// as the hover tooltip. Returns a plain dash when the value is missing
// so empty cells don't pick up a misleading tooltip.
function relativeWithTooltip(iso) {
  if (!iso) return '-';
  return `<span title="${esc(formatDate(iso))}">${esc(formatRelativeTime(iso))}</span>`;
}

function quoted(value) {
  if (value === null || value === undefined || value === '') return '';
  return `&ldquo;${esc(String(value))}&rdquo;`;
}

function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return t('{size} B', { size: n });
  if (n < 1024 * 1024) return t('{size} KB', { size: (n / 1024).toFixed(1) });
  if (n < 1024 * 1024 * 1024) return t('{size} MB', { size: (n / 1024 / 1024).toFixed(1) });
  return t('{size} GB', { size: (n / 1024 / 1024 / 1024).toFixed(2) });
}

function formatMinutes(n) {
  if (!Number.isFinite(n) || n <= 0) return tn(n ?? 0, '{n} minute', '{n} minutes');
  if (n < 60) return tn(n, '{n} minute', '{n} minutes');
  const hours = Math.floor(n / 60);
  const mins = n % 60;
  if (mins === 0) return tn(hours, '{n} hour', '{n} hours');
  return t('{hours}h {mins}m', { hours, mins });
}

const ROLE_LABELS = {
  user: t('user'),
  admin: t('admin'),
  superadmin: t('superadmin'),
};

// The Create User picker names roles in title case.
const CREATE_ROLE_LABELS = {
  user: t('User'),
  admin: t('Admin'),
  superadmin: t('Super Admin'),
};

/** Display name for a role value; the value itself stays as the API sends it. */
function roleLabel(role) {
  return ROLE_LABELS[role] ?? role;
}

// Backup files come in three flavors:
//   2026-05-09T01-30-01-225Z-manual.db.gz       (scheduled/manual snapshot)
//   pre-import-2026-04-08T05-07-25-238Z.db      (pre-action safety snapshot)
//   pre-delete-user-foo-2026-05-09T...Z.db.gz   (ditto, with extra context)
// Pull out the timestamp + label so the row reads as e.g.
// "Manual · 2026/05/09 01:30" or "Pre import · 2026/04/08 05:07"
// instead of dumping the raw filename, which duplicates the Time column.
function formatBackupName(fileName) {
  if (!fileName) return '';
  const base = String(fileName).replace(/\.db(\.gz)?$/i, '');
  const m = base.match(/^(?:(.*?)-)?(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-\d+)?Z(?:-([a-z0-9_-]+))?$/i);
  if (!m) return fileName;
  const prefix = (m[1] || '').replace(/-+$/, '');
  // Embedded timestamp is UTC (matches the trailing Z in the filename).
  // Convert through Date so the displayed time matches the audit
  // row's Time column, which is also rendered in local time.
  const utcIso = `${m[2]}T${m[3]}:${m[4]}:${m[5]}Z`;
  const dt = new Date(utcIso);
  let dateStr;
  let timeStr;
  if (Number.isFinite(dt.getTime())) {
    const yyyy = dt.getFullYear();
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    const dd = String(dt.getDate()).padStart(2, '0');
    const hh = String(dt.getHours()).padStart(2, '0');
    const min = String(dt.getMinutes()).padStart(2, '0');
    dateStr = `${yyyy}/${mm}/${dd}`;
    timeStr = `${hh}:${min}`;
  } else {
    dateStr = m[2].replace(/-/g, '/');
    timeStr = `${m[3]}:${m[4]}`;
  }
  const suffix = m[6] || '';
  const labelRaw = prefix
    ? prefix.replace(/-/g, ' ')
    : suffix;
  const label = labelRaw ? labelRaw.charAt(0).toUpperCase() + labelRaw.slice(1) : t('Backup');
  return `${label} · ${dateStr} ${timeStr}`;
}

const REVIEW_QUEUE_LABELS = {
  member: t('Member queue'),
  chest_source: t('Chest source queue'),
  chest_name: t('Chest name queue'),
};

/**
 * What a source-point override actually covered.
 *
 * An empty chestName is the wildcard: every chest from that source. Naming it
 * matters because "Level 25 Crypt = 5 pts" and "Level 25 Crypt · Gold Chest =
 * 5 pts" are wildly different edits that used to print the same way.
 */
function sourceScope(d) {
  const source = quoted(tGame(d.sourceKey));
  return d.chestName ? `${source} · ${quoted(tGame(d.chestName))}` : t('{source} (all chests)', { source });
}

function formatAuditDetails(action, d, ctx) {
  if (!d) return '<span class="muted-copy">—</span>';
  const clanLabel = ctx?.clanLabel ?? ((id) => (id == null ? '' : `#${id}`));
  // The User and Time columns already show who/when, so the Details
  // cell tries to add net-new context (what target, what changed) and
  // skip anything that just repeats those columns.
  const clanSuffix = (id) => (id == null ? '' : ` · ${esc(clanLabel(id))}`);

  switch (action) {
    case 'delete_scan_session': {
      const when = formatAuditDate(d.startedAt);
      const chestPart = tn(d.deletedChests ?? 0, 'removed {n} chest', 'removed {n} chests');
      const scan = when
        ? t('Scan #{id} from {when}', { id: d.sessionId, when })
        : t('Scan #{id}', { id: d.sessionId });
      return `${scan} · ${chestPart}`;
    }
    case 'trigger_manual_scan': {
      // The User column already shows the actor — don't repeat the
      // username here. Surface the scope (all-clans vs single-clan) and
      // the target clan when known. Old entries logged before mode/
      // clanId were added fall back to a generic label.
      if (d.mode === 'all-clans') return t('All clans');
      if (d.clanId != null) return esc(clanLabel(d.clanId));
      return t('Manual scan started');
    }
    case 'merge_player':
    case 'merge_chest':
    case 'merge_source': {
      return `${quoted(d.from)} → ${quoted(d.to)}${clanSuffix(d.clanId)}`;
    }
    case 'set_source_points': {
      const backfill = d.backfilled != null ? ` · ${tn(d.backfilled, 'backfilled {n} record', 'backfilled {n} records')}` : '';
      // chestName has always been logged and never printed, so a wildcard
      // covering an entire source and a single-chest override rendered
      // identically — the two most different edits on the page.
      return `${t('{scope} = {points} pts', { scope: sourceScope(d), points: d.pointValue })}${backfill}${clanSuffix(d.clanId)}`;
    }
    case 'delete_source_points': {
      const backfill = d.backfilled != null ? ` · ${tn(d.backfilled, 'backfilled {n} record', 'backfilled {n} records')}` : '';
      return `${t('Removed override for {scope}', { scope: sourceScope(d) })}${backfill}${clanSuffix(d.clanId)}`;
    }
    case 'recalculate_source_points': {
      return `${tn(d.updated ?? 0, 'Updated {n} record', 'Updated {n} records')}${clanSuffix(d.clanId)}`;
    }
    case 'set_chest_type': {
      return `${t('{chest} → type {type}', { chest: quoted(tGame(d.chestName)), type: quoted(d.chestType) })}${clanSuffix(d.clanId)}`;
    }
    case 'delete_chest_type_override': {
      return t('Override #{id}', { id: d.id });
    }
    case 'delete_merge_rule': {
      return t('Rule #{id}', { id: d.id });
    }
    case 'rename_member': {
      return t('Member #{id} → {name}', { id: d.id, name: quoted(d.newName) });
    }
    case 'delete_member': {
      // New rows omit `hardDeleted` (everything is soft-delete now and
      // recoverable from "Show removed members"). Older rows that
      // recorded `hardDeleted: true` still get the explanatory suffix
      // so the historical entry doesn't lie about what happened.
      const suffix = d.hardDeleted === true ? ` — ${t('hard-deleted (no history)')}` : '';
      return d.name ? `${t('Removed {name}', { name: quoted(d.name) })}${suffix}` : `${t('Removed member')}${suffix}`;
    }
    case 'restore_member': {
      return d.name ? t('Restored {name}', { name: quoted(d.name) }) : t('Restored member');
    }
    case 'member.auto_deactivate': {
      const names = Array.isArray(d.members) ? d.members : [];
      const count = d.count ?? names.length;
      const reason = d.days != null ? ` ${tn(d.days, '(unseen {n}+ days)', '(unseen {n}+ days)')}` : '';
      const list = names.length ? `: ${names.map((n) => esc(n)).join(', ')}` : '';
      return `${tn(count, '{n} member', '{n} members')}${reason}${list}${clanSuffix(d.clanId)}`;
    }
    case 'clan.inactivity.update': {
      const state = d.enabled ? t('enabled') : t('disabled');
      const threshold = d.inactivityDays == null ? t('global default') : tn(d.inactivityDays, '{n} day', '{n} days');
      return `${state} · ${threshold}${clanSuffix(d.clanId)}`;
    }
    case 'update_scan_interval': {
      return t('Every {interval}', { interval: formatMinutes(d.minutes) });
    }
    case 'upload_storage_state': {
      const auth = d.hasTbAuth ? t('TB auth detected') : t('no TB auth');
      return `${tn(d.cookies ?? 0, '{n} cookie', '{n} cookies')} · ${auth}${clanSuffix(d.clanId)}`;
    }
    case 'restart_container': {
      return t('Container restarting…');
    }
    case 'import_backup_db':
    case 'restore_server_backup': {
      const size = Number.isFinite(d.bytes) ? ` · ${formatBytes(d.bytes)}` : '';
      const name = d.fileName ? esc(formatBackupName(d.fileName)) : t('backup');
      return `${name}${size}`;
    }
    case 'create_manual_backup': {
      const size = Number.isFinite(d.bytes) ? formatBytes(d.bytes) : '';
      const name = d.fileName ? esc(formatBackupName(d.fileName)) : t('Backup');
      return size ? `${name} · ${size}` : name;
    }
    case 'delete_backup': {
      return d.fileName ? esc(formatBackupName(d.fileName)) : t('Removed backup');
    }
    case 'import_json':
    case 'import_csv': {
      const parts = [];
      if (d.imported != null) parts.push(tn(d.imported, '{n} row imported', '{n} rows imported'));
      if (d.skipped != null) parts.push(tn(d.skipped, '{n} skipped', '{n} skipped', { n: d.skipped }));
      if (d.backupFile) parts.push(t('backup: {name}', { name: esc(formatBackupName(d.backupFile)) }));
      return parts.length ? parts.join(' · ') : t('Import completed');
    }
    case 'create_user': {
      const role = d.role || 'user';
      return role !== 'superadmin' && d.clanId != null
        ? t('{user} ({role}) in {clan}', { user: quoted(d.username), role: esc(roleLabel(role)), clan: esc(clanLabel(d.clanId)) })
        : `${quoted(d.username)} (${esc(roleLabel(role))})`;
    }
    case 'delete_user': {
      return d.username ? t('Removed {name}', { name: quoted(d.username) }) : t('Removed user');
    }
    case 'change_role': {
      return `${quoted(d.username)} : ${esc(d.from ? roleLabel(d.from) : '?')} → ${esc(d.to ? roleLabel(d.to) : '?')}`;
    }
    case 'change_user_clan': {
      const from = d.from != null ? esc(clanLabel(d.from)) : '?';
      const to = d.to != null ? esc(clanLabel(d.to)) : '?';
      return `${quoted(d.username)} : ${from} → ${to}`;
    }
    case 'set_user_clans': {
      const list = Array.isArray(d.clans) ? d.clans : [];
      const what = list.length
        ? list.map((c) => `${esc(clanLabel(c.clanId))} (${esc(roleLabel(c.role))})`).join(', ')
        : t('none');
      const moved = d.home
        ? ` · ${t('home {from} → {to} ({role})', { from: esc(clanLabel(d.home.from)), to: esc(clanLabel(d.home.to)), role: esc(roleLabel(d.home.role)) })}`
        : '';
      return `${t('{user} : extra {clans}', { user: quoted(d.username), clans: what })}${moved}`;
    }
    case 'change_clan_role': {
      return `${quoted(d.username)} : ${esc(d.from ? roleLabel(d.from) : '?')} → ${esc(d.to ? roleLabel(d.to) : '?')}${clanSuffix(d.clanId)}`;
    }
    case 'remove_user_clan': {
      return `${quoted(d.username)}${clanSuffix(d.clanId)}`;
    }
    case 'change_password': {
      return t('Password updated');
    }
    case 'acknowledge_review_queue': {
      const label = REVIEW_QUEUE_LABELS[d.category] || t('{category} queue', { category: esc(d.category || '') });
      return `${label}${clanSuffix(d.clanId)}`;
    }
    case 'reassign_unknown_chests': {
      const moved = d.moved != null ? ` · ${tn(d.moved, '{n} chest moved', '{n} chests moved')}` : '';
      return `${quoted(d.from)} → ${quoted(d.to)}${moved}${clanSuffix(d.clanId)}`;
    }
    case 'update_scanner_settings': {
      const parts = [];
      if (d.scanMaxChests != null) parts.push(tn(d.scanMaxChests, 'Max {n} chest/scan', 'Max {n} chests/scan'));
      if (d.scanDebugFirstN != null) parts.push(tn(d.scanDebugFirstN, 'Debug first {n} page', 'Debug first {n} pages'));
      return parts.length ? parts.join(' · ') : t('Updated');
    }
    case 'capture_calibration_screenshot':
    case 'save_calibration': {
      const stage = d.stage ? esc(d.stage) : '';
      const fields = Array.isArray(d.fields) && d.fields.length
        ? ` · ${d.fields.map((f) => esc(String(f))).join(', ')}`
        : '';
      return stage ? `${t('Stage: {stage}', { stage })}${fields}` : t('Calibration updated');
    }
    case 'login_session_start':
    case 'login_session_save':
    case 'login_session_cancel': {
      return d.clanId != null ? esc(clanLabel(d.clanId)) : '<span class="muted-copy">—</span>';
    }
    case 'update_external_config': {
      return t('ChestTracker config updated');
    }
    case 'external_manual_fetch': {
      const rows = d.rows != null ? tn(d.rows, '{n} row fetched', '{n} rows fetched') : t('Fetch triggered');
      return rows;
    }
    case 'clan.create': {
      return d.name ? t('{name} (id {id})', { name: quoted(d.name), id: d.clanId }) : t('Clan #{id}', { id: d.clanId });
    }
    case 'clan.update':
    case 'clan.delete':
    case 'clan.share_token.generate':
    case 'clan.share_token.disable':
    case 'clan.discord.update':
    case 'clan.chesttracker.update': {
      return d.clanId != null ? esc(clanLabel(d.clanId)) : '<span class="muted-copy">—</span>';
    }
  }

  // Unknown action — render any non-trivial keys as "key: value" pairs.
  // clanId is special-cased: resolve it to the clan name when possible
  // so the table never shows a bare numeric id.
  const pairs = Object.entries(d)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => {
      if (k === 'clanId') return t('clan: {clan}', { clan: esc(clanLabel(v)) });
      return `${esc(k)}: ${esc(typeof v === 'object' ? JSON.stringify(v) : String(v))}`;
    });
  return pairs.length ? pairs.join(' · ') : '<span class="muted-copy">—</span>';
}

// ─── Page ──────────────────────────────────────────────────────

export async function renderUsers(el) {
  const currentUser = getCurrentUser();
  if (currentUser?.role !== 'admin' && currentUser?.role !== 'superadmin') {
    el.innerHTML = `<div class="empty-state"><p>${t('Admin access required.')}</p></div>`;
    return;
  }
  const isSuperAdmin = currentUser.role === 'superadmin';
  const [allFetchedUsers, audit] = await Promise.all([
    api('/auth/users'), api('/auth/audit-log?limit=500'),
  ]);

  // Superadmins see every user across every clan from the API; the
  // page honors the header clan-switcher by trimming that down to
  // superadmins + the active clan's users so the table doesn't get
  // cluttered when you're focused on one clan.
  //
  // Orphaned accounts (role != superadmin AND clanId == null) are
  // *always* included for superadmins so the operator can spot and fix
  // them no matter which clan is selected — otherwise the very bug we
  // patched (demotion without a clan) would hide its own victims.
  //
  // An account granted the active clan as an EXTRA clan shows up too, as a
  // guest, with the role it holds here. (A clan admin's listing already comes
  // back from the server in that shape, without the guest's home clan.)
  const activeClanId = currentUser.activeClan?.id ?? null;
  const users = isSuperAdmin && activeClanId !== null
    ? allFetchedUsers.flatMap((u) => {
        if (u.role === 'superadmin' || u.clanId === activeClanId || u.clanId === null) return [u];
        const access = (u.clanAccess || []).find((a) => a.clanId === activeClanId);
        return access
          ? [{ ...u, membership: 'guest', homeClanId: u.clanId, homeRole: u.role, clanId: activeClanId, role: access.role }]
          : [];
      })
    : allFetchedUsers;
  usersById = new Map(allFetchedUsers.map((u) => [u.id, u]));

  const totalAudit = audit.length;
  const auditTotalPages = Math.max(1, Math.ceil(totalAudit / AUDIT_PAGE_SIZE));
  if (currentAuditPage > auditTotalPages) currentAuditPage = auditTotalPages;
  if (currentAuditPage < 1) currentAuditPage = 1;
  const auditStartIdx = (currentAuditPage - 1) * AUDIT_PAGE_SIZE;
  const auditPageEntries = audit.slice(auditStartIdx, auditStartIdx + AUDIT_PAGE_SIZE);

  const auditPaginationControls = totalAudit > AUDIT_PAGE_SIZE
    ? `<div class="pagination">
        <button class="btn btn-tight" data-action="audit-page-prev" ${currentAuditPage <= 1 ? 'disabled' : ''}>${t('← Prev')}</button>
        <span class="pagination-info">${tn(totalAudit, 'Page {page} of {pages} · {n} entries', 'Page {page} of {pages} · {n} entries', { page: currentAuditPage, pages: auditTotalPages, n: totalAudit })}</span>
        <button class="btn btn-tight" data-action="audit-page-next" ${currentAuditPage >= auditTotalPages ? 'disabled' : ''}>${t('Next →')}</button>
      </div>`
    : '';

  // Multi-clan: superadmin can place the new user in any clan; the
  // dropdown is hidden when role=superadmin (cross-clan). Clan admins
  // are forced to their own clan and never see the picker.
  // We build a clanId → name map either way so the table can show the
  // clan label instead of a raw numeric id.
  let allClans = [];
  try {
    const r = await fetch('/api/clans');
    if (r.ok) {
      const d = await r.json();
      allClans = Array.isArray(d.clans) ? d.clans : [];
    }
  } catch { /* ignore — single-clan deployments still work */ }
  const clanNameById = new Map(allClans.map((c) => [c.id, c.name]));
  const clanLabel = (id) => {
    if (id === null || id === undefined) return '—';
    return clanNameById.get(id) ?? `#${id}`;
  };
  clansForEditor = allClans;
  // "SIK - SINful Knights" → "SIK": the chips only have room for the tag.
  // Names without one are used whole and ellipsize.
  const clanShort = (id) => {
    const name = clanLabel(id);
    const cut = name.indexOf(' - ');
    return cut > 0 ? name.slice(0, cut) : name;
  };

  /**
   * Superadmin Clan cell: one fixed-width chip per clan the account is in,
   * each with the role it holds THERE, so "admin here, user there" reads at a
   * glance. Always in the site's clan order — never home-first — so a clan
   * sits in the same column on every row; the house icon marks the home clan.
   * The chip of the clan picked in the header is outlined: that's the clan
   * the Role column edits. The whole group opens the editor.
   */
  const clanOrder = new Map(allClans.map((c, i) => [c.id, i]));
  const clanChips = (u) => {
    const homeClanId = u.membership === 'guest' ? u.homeClanId : u.clanId;
    const homeRole = u.membership === 'guest' ? u.homeRole : u.role;
    const all = [
      { clanId: homeClanId, role: homeRole, home: true },
      ...(u.clanAccess || []).map((a) => ({ ...a, home: false })),
    ].sort((a, b) => (clanOrder.get(a.clanId) ?? Infinity) - (clanOrder.get(b.clanId) ?? Infinity)
      || a.clanId - b.clanId);
    const described = all.map((m) => (m.home
      ? t('{clan}: {role} (home clan)', { clan: clanLabel(m.clanId), role: roleLabel(m.role) })
      : t('{clan}: {role}', { clan: clanLabel(m.clanId), role: roleLabel(m.role) }))).join(', ');
    const chips = all.map((m) => {
      const cls = ['clan-chip', m.home ? 'is-home' : '', m.clanId === activeClanId ? 'is-current' : ''].filter(Boolean).join(' ');
      const title = m.home
        ? t('{clan} · home clan · {role}', { clan: clanLabel(m.clanId), role: roleLabel(m.role) })
        : `${clanLabel(m.clanId)} · ${roleLabel(m.role)}`;
      // Every chip keeps the icon slot, so names line up whether or not it's home.
      return `<span class="${cls}" title="${esc(title)}">${m.home ? HOME_ICON : '<span class="clan-chip-icon" aria-hidden="true"></span>'}<span class="clan-chip-name">${esc(clanShort(m.clanId))}</span><span class="clan-chip-role role-${esc(m.role)}">${esc(roleLabel(m.role))}</span></span>`;
    }).join('');
    return `<button type="button" class="clan-chips" data-action="edit-user-clans" data-user-id="${u.id}" aria-label="${esc(t('Edit clans for {user}. {clans}', { user: u.username, clans: described }))}" title="${t('Edit clans')}">${chips}${EDIT_ICON}</button>`;
  };

  // Role options visible in dropdowns. Clan admins can grant user/admin
  // within their clan; only superadmins can mint or demote superadmins.
  const roleOptions = isSuperAdmin
    ? ['user', 'admin', 'superadmin']
    : ['user', 'admin'];

  el.innerHTML = `
    <h2 class="page-section-title">${t('User Accounts')}</h2>
    <p class="page-section-intro">${isSuperAdmin
      ? t("Create, modify, and remove user accounts. Roles control which pages a user can access.")
      : t("Manage user accounts for your clan. You can grant the User and Admin roles; only superadmins manage instance-wide accounts.")}</p>

    <div class="card">
      <div class="card-header"><h2>${t('Create User')}</h2></div>
      <div class="card-body card-body-padded">
        <div class="inline-form-row">
          <div><label>${t('Username')}</label><input type="text" id="newUsername" class="input"></div>
          <div><label>${t('Password')}</label><input type="password" id="newPassword" class="input"></div>
          <div><label>${t('Role')}</label><select id="newRole" class="input">
            ${roleOptions.map((r) => `<option value="${r}">${CREATE_ROLE_LABELS[r] ?? r}</option>`).join('')}
          </select></div>
          ${isSuperAdmin ? `
          <div id="newUserClanField"><label>${t('Clan')}</label>
            <input type="text" class="input" id="newUserClanLabel" value="${esc(currentUser.activeClan?.name ?? '—')}" readonly>
            <input type="hidden" id="newUserClanId" value="${activeClanId ?? ''}">
          </div>
          ` : ''}
          <button class="btn btn-primary" data-action="create-user">${t('Create User')}</button>
        </div>
        ${isSuperAdmin
          ? `<p class="muted-copy">${t('New accounts are created in the clan selected in the header. Choosing role <strong>Super Admin</strong> drops the clan — superadmins are cross-clan.')}</p>`
          : `<p class="muted-copy">${t('New accounts are created in your clan automatically.')}</p>`}
      </div>
    </div>

    <div class="card">
      <div class="card-header"><h2>${t('All Users ({count})', { count: users.length })}</h2></div>
      <div class="card-body">
        <table class="table-responsive users-table">
          <colgroup>
            <col class="col-user-name">
            <col class="col-user-role">
            <col class="col-user-clan">
            <col class="col-user-date">
            <col class="col-user-date">
            <col class="col-user-date">
            <col class="col-actions">
          </colgroup>
          <thead><tr><th>${t('Username')}</th><th>${t('Role')}</th><th>${t('Clan')}</th><th>${t('Created')}</th><th>${t('Last Login')}</th><th>${t('Last Visited')}</th><th>${t('Actions')}</th></tr></thead>
          <tbody>
            ${users.map((u) => {
              const isOrphan = u.role !== 'superadmin' && u.clanId === null;
              const isGuest = u.membership === 'guest';
              const isSelf = u.id === currentUser.id;
              let clanCell;
              if (isGuest && isSuperAdmin) {
                clanCell = clanChips(u);
              } else if (isGuest) {
                // A clan admin is told only that this is a guest — never
                // which other clans the account belongs to.
                clanCell = `<span class="badge-guest" title="${t('Belongs to another clan and was given access to this one.')}">${t('Guest')}</span>`;
              } else if (u.role === 'superadmin') {
                clanCell = `<span class="muted-copy">${t('(cross-clan)')}</span>`;
              } else if (isOrphan) {
                const assignBtn = isSuperAdmin
                  ? `<button class="btn btn-tight btn-primary" data-action="reassign-user-clan" data-user-id="${u.id}" data-username="${esc(u.username)}">${t('Assign')}</button>`
                  : '';
                clanCell = `<span class="clan-cell-orphan">
                  <span class="badge-warn" title="${t('This user has no clan and is blocked from clan-scoped pages.')}">⚠ ${t('No clan')}</span>
                  ${assignBtn}
                </span>`;
              } else if (isSuperAdmin) {
                clanCell = clanChips(u);
              } else {
                clanCell = esc(clanLabel(u.clanId));
              }
              let actionButtons = '';
              if (!isSelf && isGuest) {
                actionButtons = `<button class="btn btn-tight btn-danger" data-action="remove-guest-clan" data-user-id="${u.id}" data-clan-id="${u.clanId}" data-username="${esc(u.username)}">${t('Remove')}</button>`;
              } else if (!isSelf) {
                actionButtons = `<button class="btn btn-tight btn-danger" data-action="delete-user" data-user-id="${u.id}" data-username="${esc(u.username)}">${t('Delete')}</button>`;
              }
              // A guest's role is the one held in THIS clan — user or admin.
              const rowRoles = isGuest ? ['user', 'admin'] : roleOptions;
              return `<tr${isOrphan ? ' class="user-row-orphan"' : ''}>
              <td data-label="${t('Username')}" data-role="primary"><span class="mrow-name">${esc(u.username)}${isSelf ? ` <span class="muted-copy">${t('(you)')}</span>` : ''}</span></td>
              <td data-label="${t('Role')}">
                <select class="input user-role-select" data-user-id="${u.id}" data-username="${esc(u.username)}" data-current-role="${esc(u.role)}"${isGuest ? ` data-guest-clan-id="${u.clanId}"` : ''} ${isSelf ? 'disabled' : ''}>
                  ${rowRoles.map((r) => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${roleLabel(r)}</option>`).join('')}
                </select>
              </td>
              <td data-label="${t('Clan')}">${clanCell}</td>
              <td data-label="${t('Created')}">${formatDate(u.createdAt)}</td>
              <td data-label="${t('Last Login')}" data-role="metric">${relativeWithTooltip(u.lastLogin)}</td>
              <td data-label="${t('Last Visited')}">${relativeWithTooltip(u.lastVisited)}</td>
              <td class="col-actions">${actionButtons}</td>
            </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <h2 class="page-section-title">${t('Audit Log')}</h2>
    <p class="page-section-intro">${t('Record of administrative actions taken by users.')}</p>

    <details class="card card-collapsible">
      <summary class="card-header"><h2>${t('Recent Actions ({count})', { count: totalAudit })}</h2></summary>
      <div class="card-body">
        ${auditPageEntries.length > 0 ? `<table class="table-responsive audit-table">
          <colgroup>
            <col class="col-audit-time">
            <col class="col-audit-user">
            <col class="col-audit-action">
            <col>
          </colgroup>
          <thead><tr><th>${t('Time')}</th><th>${t('User')}</th><th>${t('Action')}</th><th>${t('Details')}</th></tr></thead>
          <tbody>
            ${auditPageEntries.map((a) => {
              const parsed = parseAuditDetails(a.details);
              return `<tr>
                <td data-label="${t('Time')}" data-role="hidden">${formatDate(a.createdAt)}</td>
                <td data-label="${t('User')}" data-role="primary"><span class="mrow-name">${esc(a.username)}</span><span class="mrow-sub">${formatDate(a.createdAt)}</span></td>
                <td data-label="${t('Action')}" data-role="metric">${esc(formatAuditAction(a.action))}</td>
                <td data-label="${t('Details')}" class="audit-details">${formatAuditDetails(a.action, parsed, { clanLabel })}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>` : `<div class="empty-state"><p>${t('No audit log entries yet.')}</p></div>`}
        ${auditPaginationControls}
      </div>
    </details>
  `;

  // Superadmins picking the Super Admin role drop the clan picker —
  // superadmins are cross-clan so the active clan doesn't apply to them.
  if (isSuperAdmin) {
    const roleSel = $('#newRole');
    const clanField = $('#newUserClanField');
    const sync = () => {
      if (!clanField) return;
      clanField.classList.toggle('is-hidden', roleSel?.value === 'superadmin');
    };
    if (roleSel) roleSel.addEventListener('change', sync);
    sync();
  }
}

// ─── Action handlers ──────────────────────────────────────────

export async function createNewUser(rerender) {
  const username = $('#newUsername').value;
  const password = $('#newPassword').value;
  const role = $('#newRole').value;
  const clanIdEl = $('#newUserClanId');
  const clanIdRaw = clanIdEl?.value;
  if (!username || !password) return notify(t('Username and password required'), t('Create user'));
  const body = { username, password, role };
  if (role !== 'superadmin' && clanIdRaw) {
    body.clanId = Number(clanIdRaw);
  }
  const res = await apiPost('/auth/users', body);
  if (res.error) return notify(res.error, t('Create user failed'));
  rerender('users');
}

export async function deleteUserById(id, rerender, username) {
  const label = username ? `"${username}"` : t('this user');
  // Deleting the account takes every clan with it, not just the one in the
  // header. Superadmins get the list; a clan admin is never shown another
  // clan's name, so they get the general warning.
  const user = usersById.get(id);
  const clanNames = user && user.role !== 'superadmin' && Array.isArray(user.clanAccess) && user.clanAccess.length > 0
    ? [user.clanId, ...user.clanAccess.map((a) => a.clanId)].map(clanNameFor)
    : null;
  const lost = clanNames
    ? t("They lose access to every clan they're in: {clans}.", { clans: clanNames.join(', ') })
    : t('They lose access to the site entirely, in every clan they belong to.');
  const ok = await confirmDialog(
    t('Delete user {user}? {lost} Their login is removed permanently and they will be signed out of any active session. This cannot be undone.', { user: label, lost }),
    {
      title: t('Delete user'),
      confirmLabel: t('Delete'),
      cancelLabel: t('Cancel'),
      danger: true,
    },
  );
  if (!ok) return;
  if (!await mustOk(apiDelete(`/auth/users/${id}`), t('Delete user failed'))) return;
  rerender('users');
}

async function fetchClanOptions() {
  try {
    const r = await fetch('/api/clans');
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d.clans) ? d.clans : [];
  } catch {
    return [];
  }
}

function findRoleSelect(id) {
  return document.querySelector(`select.user-role-select[data-user-id="${id}"]`);
}

export async function changeRole(id, role, rerender) {
  const select = findRoleSelect(id);
  const prevRole = select?.dataset.currentRole ?? null;

  // Demoting a superadmin (cross-clan, clan_id NULL) into admin/user
  // requires the operator to pick a destination clan in the same
  // request. The server rejects the change otherwise — this modal is
  // the path that produces a valid body. On cancel we revert the
  // <select> so it doesn't claim a transition that never happened.
  if (prevRole === 'superadmin' && role !== 'superadmin') {
    const clans = await fetchClanOptions();
    if (clans.length === 0) {
      if (select) select.value = prevRole;
      notify(t('Create a clan first before demoting this superadmin.'), t('Change role'));
      return;
    }
    const username = select?.dataset.username || t('this user');
    const clanId = await selectDialog(
      t('Pick a clan for "{user}". Without one they\'ll be blocked from every clan-scoped page.', { user: username }),
      clans.map((c) => ({ value: c.id, label: c.name })),
      {
        title: t('Assign clan on demotion'),
        fieldLabel: t('Clan'),
        confirmLabel: t('Save change'),
        cancelLabel: t('Cancel'),
      },
    );
    if (clanId === null) {
      if (select) select.value = prevRole;
      return;
    }
    const ok = await mustOk(apiPut(`/auth/users/${id}/role`, { role, clanId: Number(clanId) }), t('Change role failed'));
    if (!ok) {
      if (select) select.value = prevRole;
      return;
    }
    if (rerender) rerender('users');
    return;
  }

  const ok = await mustOk(apiPut(`/auth/users/${id}/role`, { role }), t('Change role failed'));
  if (!ok) {
    if (select && prevRole) select.value = prevRole;
    return;
  }
  // Rerender so the Clan column reflects the change (promotion to
  // superadmin drops the clan to "(cross-clan)") and the select's
  // data-current-role attribute is refreshed for the next operation.
  if (rerender) rerender('users');
}

export async function reassignUserClan(id, username, rerender) {
  const clans = await fetchClanOptions();
  if (clans.length === 0) {
    notify(t('No clans exist to assign this user to.'), t('Assign clan'));
    return;
  }
  const clanId = await selectDialog(
    t('Pick a clan for "{user}". They\'ll regain access to clan-scoped pages.', { user: username }),
    clans.map((c) => ({ value: c.id, label: c.name })),
    {
      title: t('Assign user to clan'),
      fieldLabel: t('Clan'),
      confirmLabel: t('Assign'),
      cancelLabel: t('Cancel'),
    },
  );
  if (clanId === null) return;
  if (!await mustOk(apiPut(`/auth/users/${id}/clan`, { clanId: Number(clanId) }), t('Assign clan failed'))) return;
  if (rerender) rerender('users');
}

/**
 * Superadmin editor for every clan an account is in: its role in each, and
 * which one is home. Lists every live clan; "No access" drops one. Picking a
 * different Home moves the account there in the same save — the old home
 * stays as an extra clan with its role unless set to No access. The home row
 * can't be No access: an account always has a home.
 */
export function editUserClans(id, rerender) {
  const user = usersById.get(id);
  if (!user) return;
  if (clansForEditor.length === 0) {
    notify(t('There are no clans to assign.'), t('Clans'));
    return;
  }
  const current = new Map((user.clanAccess || []).map((a) => [a.clanId, a.role]));
  if (user.clanId !== null) current.set(user.clanId, user.role);
  const option = (value, label, selected) =>
    `<option value="${value}"${selected ? ' selected' : ''}>${label}</option>`;
  const rows = clansForEditor.map((c) => {
    const role = current.get(c.id) ?? '';
    const isHome = c.id === user.clanId;
    return `<div class="user-clans-row">
      <input type="radio" name="userClansHome" value="${c.id}" ${isHome ? 'checked' : ''}
        aria-label="${esc(t('Make {clan} the home clan', { clan: c.name }))}">
      <span class="user-clans-name">${esc(c.name)}</span>
      <select class="input" data-clan-id="${c.id}" aria-label="${esc(t('Role in {clan}', { clan: c.name }))}">
        ${option('', t('No access'), role === '')}
        ${option('user', t('User'), role === 'user')}
        ${option('admin', t('Admin'), role === 'admin')}
      </select>
    </div>`;
  }).join('');
  const modal = contentModal({
    title: t('Clans for {user}', { user: user.username }),
    html: `
      <p class="muted-copy">${t('Clans {user} can switch to from the header, and their role in each. <strong>Home</strong> is the clan the account belongs to — pick another to move it.', { user: esc(user.username) })}</p>
      <div class="user-clans-editor">
        <div class="user-clans-row user-clans-head" aria-hidden="true"><span>${t('Home')}</span><span class="user-clans-name">${t('Clan')}</span><span>${t('Role')}</span></div>
        ${rows}
      </div>
      <div class="modal-actions">
        <button class="btn" type="button" data-user-clans="cancel">${t('Cancel')}</button>
        <button class="btn btn-primary" type="button" data-user-clans="save">${t('Save')}</button>
      </div>`,
  });
  if (!modal) return;
  const root = modal.content;
  const selectFor = (clanId) => root.querySelector(`select[data-clan-id="${clanId}"]`);
  const homeId = () => Number(root.querySelector('input[name="userClansHome"]:checked')?.value ?? NaN);

  // The home row can't be No access. Moving home keeps the role the account
  // already had in that clan, else the role it had at the old home.
  let prevHome = homeId();
  const syncHome = () => {
    const next = homeId();
    for (const s of root.querySelectorAll('select[data-clan-id]')) {
      const isHome = Number(s.dataset.clanId) === next;
      s.querySelector('option[value=""]').disabled = isHome;
      if (isHome && !s.value) s.value = selectFor(prevHome)?.value || 'user';
    }
    prevHome = next;
  };
  for (const r of root.querySelectorAll('input[name="userClansHome"]')) r.addEventListener('change', syncHome);
  syncHome();

  root.querySelector('[data-user-clans="cancel"]').addEventListener('click', () => modal.close());
  root.querySelector('[data-user-clans="save"]').addEventListener('click', async () => {
    const home = homeId();
    if (!Number.isFinite(home)) return notify(t('Pick a home clan.'), t('Clans'));
    const clans = [...root.querySelectorAll('select[data-clan-id]')]
      .filter((s) => s.value && Number(s.dataset.clanId) !== home)
      .map((s) => ({ clanId: Number(s.dataset.clanId), role: s.value }));
    const body = { clans, home: { clanId: home, role: selectFor(home).value } };
    if (!await mustOk(apiPut(`/auth/users/${id}/clans`, body), t('Saving clans failed'))) return;
    modal.close();
    rerender('users');
  });
}

export async function changeGuestClanRole(id, clanId, role, rerender) {
  const select = document.querySelector(`select.user-role-select[data-user-id="${id}"][data-guest-clan-id="${clanId}"]`);
  const prevRole = select?.dataset.currentRole ?? null;
  if (!await mustOk(apiPut(`/auth/users/${id}/clans/${clanId}`, { role }), t('Change role failed'))) {
    if (select && prevRole) select.value = prevRole;
    return;
  }
  rerender('users');
}

/** Clan name from the last render's clan list, or "#id" when unknown. */
function clanNameFor(id) {
  if (id === null || id === undefined) return '—';
  return clansForEditor.find((c) => c.id === id)?.name ?? `#${id}`;
}

export async function removeGuestFromClan(id, clanId, username, rerender) {
  // Only this one clan goes. Superadmins see what the account keeps; a clan
  // admin isn't told where else the guest belongs.
  const user = usersById.get(id);
  const kept = user && Array.isArray(user.clanAccess)
    ? [user.clanId, ...user.clanAccess.map((a) => a.clanId).filter((c) => c !== clanId)].map(clanNameFor)
    : null;
  const keeps = kept
    ? t('They keep their account and access to {clans}.', { clans: kept.join(', ') })
    : t('Their account is not deleted and keeps access to their own clan.');
  const ok = await confirmDialog(
    t('Remove "{user}" from {clan} only? {keeps} They just can no longer switch to this clan.', { user: username, clan: clanNameFor(clanId), keeps }),
    { title: t('Remove from clan'), confirmLabel: t('Remove'), cancelLabel: t('Cancel'), danger: true },
  );
  if (!ok) return;
  if (!await mustOk(apiDelete(`/auth/users/${id}/clans/${clanId}`), t('Remove failed'))) return;
  rerender('users');
}

export function changeAuditPage(delta, rerender) {
  currentAuditPage = Math.max(1, currentAuditPage + delta);
  rerender('users');
}
