// Users + Audit Log page. Admin/superadmin gated. Lets the operator
// create / delete user accounts and review the audit log of admin
// actions.

import { api, apiPost, apiPut, apiDelete, mustOk } from '../lib/api.js';
import { $, esc, formatDate, formatRelativeTime, notify, confirmDialog, selectDialog } from '../lib/ui.js';
import { getCurrentUser } from '../lib/state.js';

const AUDIT_PAGE_SIZE = 25;
let currentAuditPage = 1;

// ─── Audit helpers ────────────────────────────────────────────
//
// The action_id → human-readable label map for audit-log entries.
// Anything not listed here falls back to a snake_case → Sentence-case
// transformation in formatAuditAction(), so newly-added actions
// render even before they're added here.
const AUDIT_ACTION_LABELS = {
  upload_storage_state: 'Upload session file',
  login_session_start: 'Open remote login session',
  login_session_save: 'Save remote login session',
  login_session_cancel: 'Cancel remote login session',
  restart_container: 'Restart container',
  update_scan_interval: 'Update scan interval',
  delete_scan_session: 'Delete scan',
  trigger_manual_scan: 'Trigger manual scan',
  import_backup_db: 'Restore DB backup',
  import_json: 'Import JSON',
  import_csv: 'Import CSV',
  rename_member: 'Rename member',
  delete_member: 'Remove member',
  restore_member: 'Restore member',
  delete_merge_rule: 'Delete merge rule',
  merge_player: 'Merge player',
  merge_chest: 'Merge chest',
  merge_source: 'Merge source',
  set_chest_type: 'Set chest type',
  delete_chest_type_override: 'Delete chest type override',
  set_source_points: 'Set source points',
  delete_source_points: 'Delete source points',
  recalculate_source_points: 'Recalculate source points',
  acknowledge_review_queue: 'Acknowledge review queue',
  change_password: 'Change password',
  create_user: 'Create user',
  delete_user: 'Delete user',
  change_role: 'Change user role',
  change_user_clan: 'Reassign user to clan',
  create_manual_backup: 'Create backup',
  delete_backup: 'Delete backup',
  restore_server_backup: 'Restore server backup',
  reassign_unknown_chests: 'Reassign unknown chests',
  update_scanner_settings: 'Update scanner settings',
  update_raw_ocr_capture: 'Toggle raw OCR capture',
  capture_calibration_screenshot: 'Capture calibration screenshot',
  save_calibration: 'Save calibration',
  update_external_config: 'Update ChestTracker config',
  external_manual_fetch: 'ChestTracker manual fetch',
  'clan.create': 'Create clan',
  'clan.update': 'Update clan',
  'clan.delete': 'Delete clan',
  'clan.share_token.generate': 'Generate share link',
  'clan.share_token.disable': 'Disable share link',
  'clan.discord.update': 'Update Discord webhook',
  'clan.chesttracker.update': 'Update ChestTracker integration',
  'clan.inactivity.update': 'Update inactivity settings',
  'member.auto_deactivate': 'Auto-mark members inactive',
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

function plural(n, singular, plur) {
  return `${n} ${n === 1 ? singular : (plur || singular + 's')}`;
}

function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatMinutes(n) {
  if (!Number.isFinite(n) || n <= 0) return plural(n ?? 0, 'minute');
  if (n < 60) return plural(n, 'minute');
  const hours = Math.floor(n / 60);
  const mins = n % 60;
  if (mins === 0) return plural(hours, 'hour');
  return `${hours}h ${mins}m`;
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
    : suffix || 'backup';
  const label = labelRaw.charAt(0).toUpperCase() + labelRaw.slice(1);
  return `${label} · ${dateStr} ${timeStr}`;
}

const REVIEW_QUEUE_LABELS = {
  member: 'Member queue',
  chest_source: 'Chest source queue',
  chest_name: 'Chest name queue',
};

/**
 * What a source-point override actually covered.
 *
 * An empty chestName is the wildcard: every chest from that source. Naming it
 * matters because "Level 25 Crypt = 5 pts" and "Level 25 Crypt · Gold Chest =
 * 5 pts" are wildly different edits that used to print the same way.
 */
function sourceScope(d) {
  const source = quoted(d.sourceKey);
  return d.chestName ? `${source} · ${quoted(d.chestName)}` : `${source} (all chests)`;
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
      const chestPart = `removed ${plural(d.deletedChests ?? 0, 'chest')}`;
      return `Scan #${d.sessionId}${when ? ` from ${when}` : ''} · ${chestPart}`;
    }
    case 'trigger_manual_scan': {
      // The User column already shows the actor — don't repeat the
      // username here. Surface the scope (all-clans vs single-clan) and
      // the target clan when known. Old entries logged before mode/
      // clanId were added fall back to a generic label.
      if (d.mode === 'all-clans') return 'All clans';
      if (d.clanId != null) return esc(clanLabel(d.clanId));
      return 'Manual scan started';
    }
    case 'merge_player':
    case 'merge_chest':
    case 'merge_source': {
      return `${quoted(d.from)} → ${quoted(d.to)}${clanSuffix(d.clanId)}`;
    }
    case 'set_source_points': {
      const backfill = d.backfilled != null ? ` · backfilled ${plural(d.backfilled, 'record')}` : '';
      // chestName has always been logged and never printed, so a wildcard
      // covering an entire source and a single-chest override rendered
      // identically — the two most different edits on the page.
      return `${sourceScope(d)} = ${d.pointValue} pts${backfill}${clanSuffix(d.clanId)}`;
    }
    case 'delete_source_points': {
      const backfill = d.backfilled != null ? ` · backfilled ${plural(d.backfilled, 'record')}` : '';
      return `Removed override for ${sourceScope(d)}${backfill}${clanSuffix(d.clanId)}`;
    }
    case 'recalculate_source_points': {
      return `Updated ${plural(d.updated ?? 0, 'record')}${clanSuffix(d.clanId)}`;
    }
    case 'set_chest_type': {
      return `${quoted(d.chestName)} → type ${quoted(d.chestType)}${clanSuffix(d.clanId)}`;
    }
    case 'delete_chest_type_override': {
      return `Override #${d.id}`;
    }
    case 'delete_merge_rule': {
      return `Rule #${d.id}`;
    }
    case 'rename_member': {
      return `Member #${d.id} → ${quoted(d.newName)}`;
    }
    case 'delete_member': {
      // New rows omit `hardDeleted` (everything is soft-delete now and
      // recoverable from "Show removed members"). Older rows that
      // recorded `hardDeleted: true` still get the explanatory suffix
      // so the historical entry doesn't lie about what happened.
      const suffix = d.hardDeleted === true ? ' — hard-deleted (no history)' : '';
      return d.name ? `Removed ${quoted(d.name)}${suffix}` : `Removed member${suffix}`;
    }
    case 'restore_member': {
      return d.name ? `Restored ${quoted(d.name)}` : 'Restored member';
    }
    case 'member.auto_deactivate': {
      const names = Array.isArray(d.members) ? d.members : [];
      const count = d.count ?? names.length;
      const reason = d.days != null ? ` (unseen ${d.days}+ days)` : '';
      const list = names.length ? `: ${names.map((n) => esc(n)).join(', ')}` : '';
      return `${plural(count, 'member')}${reason}${list}${clanSuffix(d.clanId)}`;
    }
    case 'clan.inactivity.update': {
      const state = d.enabled ? 'enabled' : 'disabled';
      const threshold = d.inactivityDays == null ? 'global default' : `${d.inactivityDays} days`;
      return `${state} · ${threshold}${clanSuffix(d.clanId)}`;
    }
    case 'update_scan_interval': {
      return `Every ${formatMinutes(d.minutes)}`;
    }
    case 'upload_storage_state': {
      const auth = d.hasTbAuth ? 'TB auth detected' : 'no TB auth';
      return `${plural(d.cookies ?? 0, 'cookie')} · ${auth}${clanSuffix(d.clanId)}`;
    }
    case 'restart_container': {
      return 'Container restarting…';
    }
    case 'import_backup_db':
    case 'restore_server_backup': {
      const size = Number.isFinite(d.bytes) ? ` · ${formatBytes(d.bytes)}` : '';
      const name = d.fileName ? esc(formatBackupName(d.fileName)) : 'backup';
      return `${name}${size}`;
    }
    case 'create_manual_backup': {
      const size = Number.isFinite(d.bytes) ? formatBytes(d.bytes) : '';
      const name = d.fileName ? esc(formatBackupName(d.fileName)) : 'Backup';
      return size ? `${name} · ${size}` : name;
    }
    case 'delete_backup': {
      return d.fileName ? esc(formatBackupName(d.fileName)) : 'Removed backup';
    }
    case 'import_json':
    case 'import_csv': {
      const parts = [];
      if (d.imported != null) parts.push(`${plural(d.imported, 'row')} imported`);
      if (d.skipped != null) parts.push(`${d.skipped} skipped`);
      if (d.backupFile) parts.push(`backup: ${esc(formatBackupName(d.backupFile))}`);
      return parts.length ? parts.join(' · ') : 'Import completed';
    }
    case 'create_user': {
      const role = d.role || 'user';
      const inClan = role !== 'superadmin' && d.clanId != null
        ? ` in ${esc(clanLabel(d.clanId))}`
        : '';
      return `${quoted(d.username)} (${esc(role)})${inClan}`;
    }
    case 'delete_user': {
      return d.username ? `Removed ${quoted(d.username)}` : 'Removed user';
    }
    case 'change_role': {
      return `${quoted(d.username)} : ${esc(d.from || '?')} → ${esc(d.to || '?')}`;
    }
    case 'change_user_clan': {
      const from = d.from != null ? esc(clanLabel(d.from)) : '?';
      const to = d.to != null ? esc(clanLabel(d.to)) : '?';
      return `${quoted(d.username)} : ${from} → ${to}`;
    }
    case 'change_password': {
      return 'Password updated';
    }
    case 'acknowledge_review_queue': {
      const label = REVIEW_QUEUE_LABELS[d.category] || `${esc(d.category || '')} queue`;
      return `${label}${clanSuffix(d.clanId)}`;
    }
    case 'reassign_unknown_chests': {
      const moved = d.moved != null ? ` · ${plural(d.moved, 'chest')} moved` : '';
      return `${quoted(d.from)} → ${quoted(d.to)}${moved}${clanSuffix(d.clanId)}`;
    }
    case 'update_scanner_settings': {
      const parts = [];
      if (d.scanMaxChests != null) parts.push(`Max ${plural(d.scanMaxChests, 'chest')}/scan`);
      if (d.scanDebugFirstN != null) parts.push(`Debug first ${plural(d.scanDebugFirstN, 'page')}`);
      return parts.length ? parts.join(' · ') : 'Updated';
    }
    case 'capture_calibration_screenshot':
    case 'save_calibration': {
      const stage = d.stage ? esc(d.stage) : '';
      const fields = Array.isArray(d.fields) && d.fields.length
        ? ` · ${d.fields.map((f) => esc(String(f))).join(', ')}`
        : '';
      return stage ? `Stage: ${stage}${fields}` : 'Calibration updated';
    }
    case 'login_session_start':
    case 'login_session_save':
    case 'login_session_cancel': {
      return d.clanId != null ? esc(clanLabel(d.clanId)) : '<span class="muted-copy">—</span>';
    }
    case 'update_external_config': {
      return 'ChestTracker config updated';
    }
    case 'external_manual_fetch': {
      const rows = d.rows != null ? `${plural(d.rows, 'row')} fetched` : 'Fetch triggered';
      return rows;
    }
    case 'clan.create': {
      return d.name ? `${quoted(d.name)} (id ${d.clanId})` : `Clan #${d.clanId}`;
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
      if (k === 'clanId') return `clan: ${esc(clanLabel(v))}`;
      return `${esc(k)}: ${esc(typeof v === 'object' ? JSON.stringify(v) : String(v))}`;
    });
  return pairs.length ? pairs.join(' · ') : '<span class="muted-copy">—</span>';
}

// ─── Page ──────────────────────────────────────────────────────

export async function renderUsers(el) {
  const currentUser = getCurrentUser();
  if (currentUser?.role !== 'admin' && currentUser?.role !== 'superadmin') {
    el.innerHTML = '<div class="empty-state"><p>Admin access required.</p></div>';
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
  const activeClanId = currentUser.activeClan?.id ?? null;
  const users = isSuperAdmin && activeClanId !== null
    ? allFetchedUsers.filter((u) =>
        u.role === 'superadmin'
        || u.clanId === activeClanId
        || (u.role !== 'superadmin' && u.clanId === null))
    : allFetchedUsers;

  const totalAudit = audit.length;
  const auditTotalPages = Math.max(1, Math.ceil(totalAudit / AUDIT_PAGE_SIZE));
  if (currentAuditPage > auditTotalPages) currentAuditPage = auditTotalPages;
  if (currentAuditPage < 1) currentAuditPage = 1;
  const auditStartIdx = (currentAuditPage - 1) * AUDIT_PAGE_SIZE;
  const auditPageEntries = audit.slice(auditStartIdx, auditStartIdx + AUDIT_PAGE_SIZE);

  const auditPaginationControls = totalAudit > AUDIT_PAGE_SIZE
    ? `<div class="pagination">
        <button class="btn btn-tight" data-action="audit-page-prev" ${currentAuditPage <= 1 ? 'disabled' : ''}>← Prev</button>
        <span class="pagination-info">Page ${currentAuditPage} of ${auditTotalPages} · ${totalAudit} entries</span>
        <button class="btn btn-tight" data-action="audit-page-next" ${currentAuditPage >= auditTotalPages ? 'disabled' : ''}>Next →</button>
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

  // Role options visible in dropdowns. Clan admins can grant user/admin
  // within their clan; only superadmins can mint or demote superadmins.
  const roleOptions = isSuperAdmin
    ? ['user', 'admin', 'superadmin']
    : ['user', 'admin'];

  el.innerHTML = `
    <h2 class="page-section-title">User Accounts</h2>
    <p class="page-section-intro">${isSuperAdmin
      ? "Create, modify, and remove user accounts. Roles control which pages a user can access."
      : "Manage user accounts for your clan. You can grant the User and Admin roles; only superadmins manage instance-wide accounts."}</p>

    <div class="card">
      <div class="card-header"><h2>Create User</h2></div>
      <div class="card-body card-body-padded">
        <div class="inline-form-row">
          <div><label>Username</label><input type="text" id="newUsername" class="input"></div>
          <div><label>Password</label><input type="password" id="newPassword" class="input"></div>
          <div><label>Role</label><select id="newRole" class="input">
            ${roleOptions.map((r) => `<option value="${r}">${r === 'superadmin' ? 'Super Admin' : (r.charAt(0).toUpperCase() + r.slice(1))}</option>`).join('')}
          </select></div>
          ${isSuperAdmin ? `
          <div id="newUserClanField"><label>Clan</label>
            <input type="text" class="input" id="newUserClanLabel" value="${esc(currentUser.activeClan?.name ?? '—')}" readonly>
            <input type="hidden" id="newUserClanId" value="${activeClanId ?? ''}">
          </div>
          ` : ''}
          <button class="btn btn-primary" data-action="create-user">Create User</button>
        </div>
        ${isSuperAdmin
          ? '<p class="muted-copy">New accounts are created in the clan selected in the header. Choosing role <strong>Super Admin</strong> drops the clan — superadmins are cross-clan.</p>'
          : '<p class="muted-copy">New accounts are created in your clan automatically.</p>'}
      </div>
    </div>

    <div class="card">
      <div class="card-header"><h2>All Users (${users.length})</h2></div>
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
          <thead><tr><th>Username</th><th>Role</th><th>Clan</th><th>Created</th><th>Last Login</th><th>Last Visited</th><th>Actions</th></tr></thead>
          <tbody>
            ${users.map((u) => {
              const isOrphan = u.role !== 'superadmin' && u.clanId === null;
              let clanCell;
              if (u.role === 'superadmin') {
                clanCell = '<span class="muted-copy">(cross-clan)</span>';
              } else if (isOrphan) {
                const assignBtn = isSuperAdmin
                  ? `<button class="btn btn-tight btn-primary" data-action="reassign-user-clan" data-user-id="${u.id}" data-username="${esc(u.username)}">Assign</button>`
                  : '';
                clanCell = `<span class="clan-cell-orphan">
                  <span class="badge-warn" title="This user has no clan and is blocked from clan-scoped pages.">⚠ No clan</span>
                  ${assignBtn}
                </span>`;
              } else {
                clanCell = esc(clanLabel(u.clanId));
              }
              const actionButtons = u.id === currentUser.id
                ? ''
                : `<button class="btn btn-tight btn-danger" data-action="delete-user" data-user-id="${u.id}" data-username="${esc(u.username)}">Delete</button>`;
              return `<tr${isOrphan ? ' class="user-row-orphan"' : ''}>
              <td data-label="Username" data-role="primary"><span class="mrow-name">${esc(u.username)}${u.id === currentUser.id ? ' <span class="muted-copy">(you)</span>' : ''}</span></td>
              <td data-label="Role">
                <select class="input user-role-select" data-user-id="${u.id}" data-current-role="${esc(u.role)}" ${u.id === currentUser.id ? 'disabled' : ''}>
                  ${roleOptions.map((r) => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${r}</option>`).join('')}
                </select>
              </td>
              <td data-label="Clan">${clanCell}</td>
              <td data-label="Created">${formatDate(u.createdAt)}</td>
              <td data-label="Last Login" data-role="metric">${relativeWithTooltip(u.lastLogin)}</td>
              <td data-label="Last Visited">${relativeWithTooltip(u.lastVisited)}</td>
              <td class="col-actions">${actionButtons}</td>
            </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <h2 class="page-section-title">Audit Log</h2>
    <p class="page-section-intro">Record of administrative actions taken by users.</p>

    <details class="card card-collapsible">
      <summary class="card-header"><h2>Recent Actions (${totalAudit})</h2></summary>
      <div class="card-body">
        ${auditPageEntries.length > 0 ? `<table class="table-responsive audit-table">
          <colgroup>
            <col class="col-audit-time">
            <col class="col-audit-user">
            <col class="col-audit-action">
            <col>
          </colgroup>
          <thead><tr><th>Time</th><th>User</th><th>Action</th><th>Details</th></tr></thead>
          <tbody>
            ${auditPageEntries.map((a) => {
              const parsed = parseAuditDetails(a.details);
              return `<tr>
                <td data-label="Time" data-role="hidden">${formatDate(a.createdAt)}</td>
                <td data-label="User" data-role="primary"><span class="mrow-name">${esc(a.username)}</span><span class="mrow-sub">${formatDate(a.createdAt)}</span></td>
                <td data-label="Action" data-role="metric">${esc(formatAuditAction(a.action))}</td>
                <td data-label="Details" class="audit-details">${formatAuditDetails(a.action, parsed, { clanLabel })}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>` : '<div class="empty-state"><p>No audit log entries yet.</p></div>'}
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
  if (!username || !password) return notify('Username and password required', 'Create user');
  const body = { username, password, role };
  if (role !== 'superadmin' && clanIdRaw) {
    body.clanId = Number(clanIdRaw);
  }
  const res = await apiPost('/auth/users', body);
  if (res.error) return notify(res.error, 'Create user failed');
  rerender('users');
}

export async function deleteUserById(id, rerender, username) {
  const label = username ? `"${username}"` : 'this user';
  const ok = await confirmDialog(
    `Delete user ${label}? Their login is removed permanently and they will be signed out of any active session. This cannot be undone.`,
    {
      title: 'Delete user',
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      danger: true,
    },
  );
  if (!ok) return;
  if (!await mustOk(apiDelete(`/auth/users/${id}`), 'Delete user failed')) return;
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
      notify('Create a clan first before demoting this superadmin.', 'Change role');
      return;
    }
    const username = select?.closest('tr')?.querySelector('[data-label="Username"]')?.textContent?.trim() || 'this user';
    const clanId = await selectDialog(
      `Pick a clan for "${username}". Without one they'll be blocked from every clan-scoped page.`,
      clans.map((c) => ({ value: c.id, label: c.name })),
      {
        title: 'Assign clan on demotion',
        fieldLabel: 'Clan',
        confirmLabel: 'Save change',
        cancelLabel: 'Cancel',
      },
    );
    if (clanId === null) {
      if (select) select.value = prevRole;
      return;
    }
    const ok = await mustOk(apiPut(`/auth/users/${id}/role`, { role, clanId: Number(clanId) }), 'Change role failed');
    if (!ok) {
      if (select) select.value = prevRole;
      return;
    }
    if (rerender) rerender('users');
    return;
  }

  const ok = await mustOk(apiPut(`/auth/users/${id}/role`, { role }), 'Change role failed');
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
    notify('No clans exist to assign this user to.', 'Assign clan');
    return;
  }
  const clanId = await selectDialog(
    `Pick a clan for "${username}". They'll regain access to clan-scoped pages.`,
    clans.map((c) => ({ value: c.id, label: c.name })),
    {
      title: 'Assign user to clan',
      fieldLabel: 'Clan',
      confirmLabel: 'Assign',
      cancelLabel: 'Cancel',
    },
  );
  if (clanId === null) return;
  if (!await mustOk(apiPut(`/auth/users/${id}/clan`, { clanId: Number(clanId) }), 'Assign clan failed')) return;
  if (rerender) rerender('users');
}

export function changeAuditPage(delta, rerender) {
  currentAuditPage = Math.max(1, currentAuditPage + delta);
  rerender('users');
}
