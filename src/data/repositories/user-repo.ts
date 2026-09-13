import crypto from 'crypto';
import { getDb } from '../database.js';

export type UserRole = 'superadmin' | 'admin' | 'user';
export type UserTheme = 'dark' | 'light' | 'oled';

export const ALLOWED_THEMES: readonly UserTheme[] = ['dark', 'light', 'oled'];

export function isValidTheme(value: unknown): value is UserTheme {
  return typeof value === 'string' && (ALLOWED_THEMES as readonly string[]).includes(value);
}

export interface User {
  id: number;
  username: string;
  role: UserRole;
  /**
   * The clan this user is scoped to. NULL only for superadmins (cross-clan).
   * `admin` and `user` rows always carry a non-null clanId.
   */
  clanId: number | null;
  createdBy: number | null;
  createdAt: string;
  lastLogin: string | null;
  lastVisited: string | null;
  theme: UserTheme;
}

export interface PasswordPolicyResult {
  valid: boolean;
  message?: string;
}

export interface UsernamePolicyResult {
  valid: boolean;
  message?: string;
}

export function normalizeUsername(username: string): string {
  return username.trim();
}

export function validateUsernamePolicy(username: string): UsernamePolicyResult {
  const normalized = normalizeUsername(username);

  if (normalized.length < 3) {
    return { valid: false, message: 'Username must be at least 3 characters' };
  }

  if (normalized.length > 32) {
    return { valid: false, message: 'Username must be 32 characters or fewer' };
  }

  if (!/^[A-Za-z0-9_.-]+$/.test(normalized)) {
    return { valid: false, message: 'Username can only contain letters, numbers, dot, underscore, and dash' };
  }

  return { valid: true };
}

// --- Password Hashing ---

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function validatePasswordPolicy(password: string): PasswordPolicyResult {
  if (password.length < 10) {
    return { valid: false, message: 'Password must be at least 10 characters' };
  }

  if (!/[A-Z]/.test(password)) {
    return { valid: false, message: 'Password must include at least one uppercase letter' };
  }

  if (!/[a-z]/.test(password)) {
    return { valid: false, message: 'Password must include at least one lowercase letter' };
  }

  if (!/\d/.test(password)) {
    return { valid: false, message: 'Password must include at least one number' };
  }

  if (!/[^A-Za-z0-9]/.test(password)) {
    return { valid: false, message: 'Password must include at least one symbol' };
  }

  return { valid: true };
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;

  const result = crypto.scryptSync(password, salt, 64).toString('hex');
  const expected = Buffer.from(hash, 'hex');
  const actual = Buffer.from(result, 'hex');

  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

// --- User CRUD ---

function rowToUser(row: Record<string, unknown>): User {
  const rawTheme = row.theme as string | undefined;
  return {
    id: row.id as number,
    username: row.username as string,
    role: row.role as UserRole,
    clanId: (row.clan_id as number | null) ?? null,
    createdBy: (row.created_by as number) || null,
    createdAt: row.created_at as string,
    lastLogin: (row.last_login as string) || null,
    lastVisited: (row.last_visited as string) || null,
    theme: isValidTheme(rawTheme) ? rawTheme : 'dark',
  };
}

export function createUser(
  username: string,
  password: string,
  role: UserRole = 'user',
  createdBy?: number,
  clanId?: number | null,
): User {
  const db = getDb();
  const now = new Date().toISOString();
  const passwordHash = hashPassword(password);
  const normalizedUsername = normalizeUsername(username);

  // Superadmins are cross-clan — clan_id must be NULL. Everyone else needs
  // a clan; default to clan #1 for legacy callers that haven't been
  // updated yet (the single existing clan in pre-multi-tenant deployments).
  const resolvedClanId = role === 'superadmin'
    ? null
    : (clanId ?? 1);

  const result = db.prepare(`
    INSERT INTO users (username, password_hash, role, clan_id, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(normalizedUsername, passwordHash, role, resolvedClanId, createdBy ?? null, now);

  return {
    id: result.lastInsertRowid as number,
    username: normalizedUsername,
    role,
    clanId: resolvedClanId,
    createdBy: createdBy ?? null,
    createdAt: now,
    lastLogin: null,
    lastVisited: null,
    theme: 'dark',
  };
}

export function updateTheme(id: number, theme: UserTheme): void {
  const db = getDb();
  db.prepare('UPDATE users SET theme = ? WHERE id = ?').run(theme, id);
}

export function authenticate(username: string, password: string): User | null {
  const db = getDb();
  const normalizedUsername = normalizeUsername(username);
  const row = db.prepare(
    'SELECT * FROM users WHERE username = ?',
  ).get(normalizedUsername) as Record<string, unknown> | undefined;

  if (!row) return null;
  if (!verifyPassword(password, row.password_hash as string)) return null;

  db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(
    new Date().toISOString(),
    row.id,
  );

  return rowToUser(row);
}

export function getUserById(id: number): User | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToUser(row) : null;
}

/**
 * List users visible to the caller. Superadmins (viewerClanId=null) see
 * everyone; clan admins see only users in their own clan AND never see
 * superadmins (cross-clan accounts are an instance-level concern, not a
 * clan-admin one).
 */
export function getAllUsers(viewerClanId?: number | null): User[] {
  const db = getDb();
  if (viewerClanId === undefined || viewerClanId === null) {
    const rows = db.prepare('SELECT * FROM users ORDER BY created_at').all() as Record<string, unknown>[];
    return rows.map(rowToUser);
  }
  const rows = db.prepare(
    `SELECT * FROM users
     WHERE clan_id = ? AND role != 'superadmin'
     ORDER BY created_at`,
  ).all(viewerClanId) as Record<string, unknown>[];
  return rows.map(rowToUser);
}

/** The oldest superadmin account, or null when there is none (or no database
 *  yet). During setup that is the account the wizard just created, which is who
 *  the embedded login bridge acts as. Never throws — a call before
 *  initDatabase() reports "nobody" rather than exploding the request. */
export function firstSuperadmin(): User | null {
  try {
    const row = getDb()
      .prepare("SELECT * FROM users WHERE role = 'superadmin' ORDER BY id LIMIT 1")
      .get() as Record<string, unknown> | undefined;
    return row ? rowToUser(row) : null;
  } catch {
    return null;
  }
}

/** How many superadmin accounts exist. Used by the setup wizard to refuse a
 *  restored database nobody could administer. */
export function superadminCount(): number {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'superadmin'").get() as { c: number };
  return row.c;
}

export function deleteUser(id: number): boolean {
  const db = getDb();
  const user = getUserById(id);
  if (user?.role === 'superadmin') {
    const count = db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'superadmin'").get() as { c: number };
    if (count.c <= 1) return false;
  }
  // Six columns across five tables FK users(id). Sessions are throwaway and
  // get deleted; everything else is history or clan data that must OUTLIVE
  // the user — an audit trail you can erase by deleting the actor isn't an
  // audit trail — so those references are nulled out and render as an
  // unattributed/"deleted user" entry. Miss any one of these and the final
  // DELETE fails with "FOREIGN KEY constraint failed"; audit_log alone made
  // this unreachable for any admin who had ever performed a single action.
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(id);
    db.prepare('UPDATE audit_log SET user_id = NULL WHERE user_id = ?').run(id);
    db.prepare('UPDATE resource_upload_batches SET uploaded_by = NULL WHERE uploaded_by = ?').run(id);
    db.prepare('UPDATE clans SET created_by = NULL WHERE created_by = ?').run(id);
    db.prepare('UPDATE share_links SET created_by = NULL WHERE created_by = ?').run(id);
    db.prepare('UPDATE share_links SET revoked_by = NULL WHERE revoked_by = ?').run(id);
    // users.created_by is self-referential — other accounts this user made.
    db.prepare('UPDATE users SET created_by = NULL WHERE created_by = ?').run(id);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
  });
  tx();
  return true;
}

export function updateRole(id: number, role: UserRole): void {
  const db = getDb();
  // Superadmin promotion strips clan_id (cross-clan). The reverse —
  // demoting to admin/user — must go through updateRoleAndClan() so the
  // new clan_id lands in the same statement; otherwise a crash between
  // role update and clan update would orphan the row.
  if (role === 'superadmin') {
    db.prepare('UPDATE users SET role = ?, clan_id = NULL WHERE id = ?').run(role, id);
  } else {
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  }
}

/**
 * Atomic role + clan update. Required when demoting a superadmin to
 * admin/user — the demoted account loses its cross-clan status and
 * needs a clan in the same write so it can never be left orphaned
 * (clan_id NULL with role != 'superadmin'). Callers must validate the
 * clan exists before invoking.
 */
export function updateRoleAndClan(id: number, role: UserRole, clanId: number): void {
  const db = getDb();
  db.prepare('UPDATE users SET role = ?, clan_id = ? WHERE id = ?').run(role, clanId, id);
}

export function updateUserClan(id: number, clanId: number | null): void {
  const db = getDb();
  db.prepare('UPDATE users SET clan_id = ? WHERE id = ?').run(clanId, id);
}

export function changePassword(id: number, newPassword: string): void {
  const db = getDb();
  const passwordHash = hashPassword(newPassword);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, id);
}

export function userCount(): number {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number };
  return row.c;
}

// --- Sessions ---

export const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const SESSION_EXTEND_THRESHOLD_MS = 12 * 60 * 60 * 1000; // extend when <12h remains

export interface SessionValidation {
  user: User;
  extended: boolean;
  activeClanId: number | null;
}

export function createSession(userId: number): string {
  const db = getDb();
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_TTL_MS);

  db.prepare(`
    INSERT INTO user_sessions (user_id, token, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `).run(userId, token, expires.toISOString(), now.toISOString());

  return token;
}

export function validateSession(token: string): SessionValidation | null {
  const db = getDb();
  const now = new Date();
  const row = db.prepare(`
    SELECT u.*, s.expires_at AS session_expires_at, s.active_clan_id AS session_active_clan_id
    FROM user_sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.token = ? AND s.expires_at > ?
  `).get(token, now.toISOString()) as Record<string, unknown> | undefined;

  if (!row) return null;

  const sessionExpiresAt = new Date(row.session_expires_at as string);
  const remainingMs = sessionExpiresAt.getTime() - now.getTime();
  let extended = false;
  if (remainingMs < SESSION_EXTEND_THRESHOLD_MS) {
    const newExpires = new Date(now.getTime() + SESSION_TTL_MS);
    db.prepare('UPDATE user_sessions SET expires_at = ? WHERE token = ?')
      .run(newExpires.toISOString(), token);
    extended = true;
  }

  // Stamp last_visited, but no more than once per minute per user so we
  // don't churn the row on every API call. The audit-page poller alone
  // could otherwise hit this dozens of times per minute.
  const lastVisitedRaw = (row.last_visited as string | null) ?? null;
  const lastVisitedMs = lastVisitedRaw ? Date.parse(lastVisitedRaw) : 0;
  if (!Number.isFinite(lastVisitedMs) || now.getTime() - lastVisitedMs >= 60_000) {
    const nowIso = now.toISOString();
    db.prepare('UPDATE users SET last_visited = ? WHERE id = ?').run(nowIso, row.id);
    row.last_visited = nowIso;
  }

  return {
    user: rowToUser(row),
    extended,
    activeClanId: (row.session_active_clan_id as number | null) ?? null,
  };
}

export function setSessionActiveClan(token: string, clanId: number | null): void {
  const db = getDb();
  db.prepare('UPDATE user_sessions SET active_clan_id = ? WHERE token = ?').run(clanId, token);
}

export function deleteSession(token: string): void {
  const db = getDb();
  db.prepare('DELETE FROM user_sessions WHERE token = ?').run(token);
}

export function cleanExpiredSessions(): void {
  const db = getDb();
  db.prepare('DELETE FROM user_sessions WHERE expires_at < ?').run(new Date().toISOString());
}

// --- Audit Log ---

export function logAction(userId: number, action: string, details?: object): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO audit_log (user_id, action, details, created_at)
    VALUES (?, ?, ?, ?)
  `).run(userId, action, details ? JSON.stringify(details) : null, new Date().toISOString());
}

/**
 * Log an audit entry for a system-initiated action (no acting user), scoped
 * to a clan so the clan-admin audit view can surface it. Used by background
 * jobs like the daily member-inactivity sweep. Rendered with a "System"
 * actor in the audit log.
 */
export function logSystemAction(clanId: number, action: string, details?: object): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO audit_log (user_id, clan_id, action, details, created_at)
    VALUES (NULL, ?, ?, ?, ?)
  `).run(clanId, action, details ? JSON.stringify(details) : null, new Date().toISOString());
}

/**
 * Actions a clan admin can see even when a superadmin performed them.
 *
 * Everything here changes how that clan's OWN numbers are calculated, so
 * hiding it would leave a leaderboard that moved for no visible reason. Keep
 * this list to things with a clan-visible effect — it is an exception to the
 * rule that instance administration stays with the instance.
 */
const CLAN_VISIBLE_GLOBAL_ACTIONS = [
  'set_source_points',
  'delete_source_points',
  'recalculate_source_points',
  'set_triumphal_points',
  'delete_triumphal_points',
] as const;

/**
 * Audit-log reader.
 *
 * - viewerClanId === null/undefined → superadmin view: every audit row.
 * - viewerClanId === number → clan-admin view: rows whose actor belongs to
 *   that clan (superadmin rows hidden), plus system rows (no actor) tagged
 *   with that clan_id — so the daily inactivity sweep shows up for the clan
 *   it acted on.
 *
 * The user-action filter is applied via the actor's CURRENT clan_id, so if a
 * user was reassigned to a different clan their old audit entries follow
 * them into the new clan. This is acceptable; a clan admin viewing the log
 * gets a consistent picture of who they currently manage. System rows carry
 * their own clan_id and are unaffected by user reassignment.
 *
 * System rows have no user, so the actor renders as "System".
 */
export function getAuditLog(limit: number = 100, viewerClanId?: number | null): Array<{
  id: number;
  username: string;
  action: string;
  details: string | null;
  createdAt: string;
}> {
  const db = getDb();
  let rows: Record<string, unknown>[];
  if (viewerClanId === undefined || viewerClanId === null) {
    rows = db.prepare(`
      SELECT a.id, COALESCE(u.username, 'System') AS username, a.action, a.details, a.created_at
      FROM audit_log a LEFT JOIN users u ON a.user_id = u.id
      ORDER BY a.created_at DESC LIMIT ?
    `).all(limit) as Record<string, unknown>[];
  } else {
    // Superadmin actions are normally hidden from a clan's own audit view —
    // instance-wide administration is not that clan's business.
    //
    // Scoring is the exception, and it is a sharp one: source-point overrides
    // are superadmin-only AND global, and changing one retroactively rewrites
    // point_value on every historical chest_record in every clan. A clan admin
    // could watch their whole leaderboard move overnight with nothing anywhere
    // to explain it, because the one role allowed to cause it was the one role
    // filtered out of the log. These actions stay visible to everyone they
    // affect.
    rows = db.prepare(`
      SELECT a.id, COALESCE(u.username, 'System') AS username, a.action, a.details, a.created_at
      FROM audit_log a LEFT JOIN users u ON a.user_id = u.id
      WHERE (u.clan_id = ? AND u.role != 'superadmin')
         OR (a.user_id IS NULL AND a.clan_id = ?)
         OR a.action IN (${CLAN_VISIBLE_GLOBAL_ACTIONS.map(() => '?').join(', ')})
      ORDER BY a.created_at DESC LIMIT ?
    `).all(viewerClanId, viewerClanId, ...CLAN_VISIBLE_GLOBAL_ACTIONS, limit) as Record<string, unknown>[];
  }

  return rows.map((r) => ({
    id: r.id as number,
    username: r.username as string,
    action: r.action as string,
    details: (r.details as string) || null,
    createdAt: r.created_at as string,
  }));
}
