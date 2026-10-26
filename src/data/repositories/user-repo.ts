import crypto from 'crypto';
import { getDb } from '../database.js';
import { currentRequestClanId } from '../../utils/request-context.js';

export type UserRole = 'superadmin' | 'admin' | 'user';
/** The role an account holds in an extra clan (user_clan_access, v88). */
export type ClanRole = 'admin' | 'user';

export function isClanRole(value: unknown): value is ClanRole {
  return value === 'admin' || value === 'user';
}
// 'auto' follows the device (Light in light mode, OLED in dark) — see
// resolveTheme in src/web/public/lib/theme.js. It is a PREFERENCE; the page
// always paints one of the other three.
export type UserTheme = 'auto' | 'dark' | 'light' | 'oled';

export const ALLOWED_THEMES: readonly UserTheme[] = ['auto', 'dark', 'light', 'oled'];

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
   *
   * On a user that came from validateSession (i.e. `req.user`), this and
   * `role` are the ACTIVE clan and the role held there — which is the home
   * clan unless the account has switched into an extra clan it was granted.
   * Read the users row (getUserById) when you need the home clan.
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
    INSERT INTO users (username, password_hash, role, clan_id, created_by, created_at, theme)
    VALUES (?, ?, ?, ?, ?, ?, 'auto')
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
    // A new account follows its device until its owner picks a theme. The
    // column default stays 'dark' only for rows that predate 'auto'.
    theme: 'auto',
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

export interface ClanAccess {
  clanId: number;
  role: ClanRole;
}

export interface ListedUser extends User {
  /** 'home' = the clan the account belongs to; 'guest' = an extra clan it was
   *  granted, with `clanId`/`role` reporting that clan and the role there. */
  membership: 'home' | 'guest';
  /** Every extra clan the account holds. Superadmin listing only — a clan
   *  admin is never told which OTHER clans one of their guests belongs to. */
  clanAccess?: ClanAccess[];
}

/**
 * List users visible to the caller. Superadmins (viewerClanId=null) see
 * everyone, with each account's extra clans; clan admins see the users whose
 * home is their clan plus the guests granted access to it, AND never see
 * superadmins (cross-clan accounts are an instance-level concern, not a
 * clan-admin one). A guest is reported AS a member of the viewer's clan, with
 * the role it holds there — never with its home clan.
 */
export function getAllUsers(viewerClanId?: number | null): ListedUser[] {
  const db = getDb();
  if (viewerClanId === undefined || viewerClanId === null) {
    const rows = db.prepare('SELECT * FROM users ORDER BY created_at').all() as Record<string, unknown>[];
    const access = db.prepare(
      'SELECT user_id, clan_id, role FROM user_clan_access ORDER BY clan_id',
    ).all() as { user_id: number; clan_id: number; role: ClanRole }[];
    const byUser = new Map<number, ClanAccess[]>();
    for (const a of access) {
      const list = byUser.get(a.user_id) ?? [];
      list.push({ clanId: a.clan_id, role: a.role });
      byUser.set(a.user_id, list);
    }
    return rows.map((r) => {
      const u = rowToUser(r);
      return { ...u, membership: 'home' as const, clanAccess: byUser.get(u.id) ?? [] };
    });
  }
  const home = db.prepare(
    `SELECT * FROM users
     WHERE clan_id = ? AND role != 'superadmin'
     ORDER BY created_at`,
  ).all(viewerClanId) as Record<string, unknown>[];
  const guests = db.prepare(
    `SELECT u.*, a.role AS guest_role
       FROM user_clan_access a JOIN users u ON u.id = a.user_id
      WHERE a.clan_id = ? AND u.role != 'superadmin' AND u.clan_id IS NOT a.clan_id
      ORDER BY u.created_at`,
  ).all(viewerClanId) as Record<string, unknown>[];
  return [
    ...home.map((r) => ({ ...rowToUser(r), membership: 'home' as const })),
    ...guests.map((r) => ({
      ...rowToUser(r),
      clanId: viewerClanId,
      role: r.guest_role as ClanRole,
      membership: 'guest' as const,
    })),
  ];
}

// --- Extra clan access (v88) ---
//
// An account's home clan is users.clan_id; user_clan_access lists the OTHER
// clans it may switch into, each with its own role. Granting and replacing
// is superadmin-only; a clan admin may change the role of, or remove, a guest
// of their own clan. None of these ever touch a superadmin, who is cross-clan
// already.

/** Every extra clan the account holds, deleted clans included. */
export function listClanAccess(userId: number): ClanAccess[] {
  return (getDb().prepare(
    'SELECT clan_id, role FROM user_clan_access WHERE user_id = ? ORDER BY clan_id',
  ).all(userId) as { clan_id: number; role: ClanRole }[]).map((r) => ({ clanId: r.clan_id, role: r.role }));
}

export function getClanAccessRole(userId: number, clanId: number): ClanRole | null {
  const row = getDb().prepare(
    'SELECT role FROM user_clan_access WHERE user_id = ? AND clan_id = ?',
  ).get(userId, clanId) as { role: ClanRole } | undefined;
  return row?.role ?? null;
}

/**
 * Replace the account's extra clans with `entries`. Rows for soft-deleted
 * clans are left alone: the editor only ever shows live clans, and a restore
 * should bring the access back with the clan. Callers validate the entries
 * (live clans, not the home clan, no superadmin target).
 */
export function replaceClanAccess(userId: number, entries: ClanAccess[]): void {
  const db = getDb();
  const now = new Date().toISOString();
  const keep = new Set(entries.map((e) => e.clanId));
  const tx = db.transaction(() => {
    const live = db.prepare(
      `SELECT a.clan_id FROM user_clan_access a JOIN clans c ON c.id = a.clan_id
        WHERE a.user_id = ? AND c.deleted_at = ''`,
    ).all(userId) as { clan_id: number }[];
    const del = db.prepare('DELETE FROM user_clan_access WHERE user_id = ? AND clan_id = ?');
    for (const r of live) if (!keep.has(r.clan_id)) del.run(userId, r.clan_id);
    const upsert = db.prepare(
      `INSERT INTO user_clan_access (user_id, clan_id, role, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, clan_id) DO UPDATE SET role = excluded.role`,
    );
    for (const e of entries) upsert.run(userId, e.clanId, e.role, now);
  });
  tx();
}

/**
 * Move an account's home clan and set its extra clans in one write: the home
 * (users.clan_id + users.role) and the grants change together, so there is no
 * moment where the account holds its new home both ways or neither. The old
 * home survives only if `extras` lists it. Refuses a superadmin (no change).
 * Callers validate the clans exist and that `extras` excludes `home`.
 */
export function setHomeAndClanAccess(userId: number, home: ClanAccess, extras: ClanAccess[]): void {
  const db = getDb();
  db.transaction(() => {
    const changed = db.prepare(
      "UPDATE users SET clan_id = ?, role = ? WHERE id = ? AND role != 'superadmin'",
    ).run(home.clanId, home.role, userId).changes;
    if (changed === 0) return;
    replaceClanAccess(userId, extras);
    dropAccessToHomeClan(userId, home.clanId);
  })();
}

/** Change the role on an EXISTING grant. False when there is none. */
export function setClanAccessRole(userId: number, clanId: number, role: ClanRole): boolean {
  return getDb().prepare(
    'UPDATE user_clan_access SET role = ? WHERE user_id = ? AND clan_id = ?',
  ).run(role, userId, clanId).changes > 0;
}

export function removeClanAccess(userId: number, clanId: number): boolean {
  return getDb().prepare(
    'DELETE FROM user_clan_access WHERE user_id = ? AND clan_id = ?',
  ).run(userId, clanId).changes > 0;
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

export interface SiteContacts {
  /** The clan's admins, by username. */
  clanAdmins: string[];
  /** The site's superadmins, by username. */
  siteAdmins: string[];
}

/**
 * Who to ask for an account or for help, as the leaderboard FAQ lists them —
 * including on the PUBLIC share page, so this returns usernames and nothing
 * else. A username is the only name a site account has.
 *
 * Only accounts that have signed in at least once: an admin account nobody has
 * ever used belongs to someone who may not know it exists, and pointing a
 * visitor at them is a dead end. Most recently active first, so the person
 * likeliest to answer leads.
 *
 * A clan admin is anyone who holds admin IN THIS CLAN: a home admin, or a
 * guest granted admin here. An account that is admin at home but a plain
 * guest here is not one.
 */
export function listSiteContacts(clanId: number): SiteContacts {
  const rows = getDb().prepare(
    `SELECT u.username, CASE WHEN u.role = 'superadmin' THEN 'superadmin' ELSE 'admin' END AS role
       FROM users u
      WHERE ((u.role = 'admin' AND u.clan_id = ?)
             OR u.role = 'superadmin'
             OR EXISTS (SELECT 1 FROM user_clan_access a
                         WHERE a.user_id = u.id AND a.clan_id = ? AND a.role = 'admin'))
        AND (u.last_login IS NOT NULL OR u.last_visited IS NOT NULL)
      ORDER BY MAX(COALESCE(u.last_visited, ''), COALESCE(u.last_login, '')) DESC, u.id`,
  ).all(clanId, clanId) as { username: string; role: UserRole }[];
  return {
    clanAdmins: rows.filter((r) => r.role === 'admin').map((r) => r.username),
    siteAdmins: rows.filter((r) => r.role === 'superadmin').map((r) => r.username),
  };
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
  // Eight columns across seven tables FK users(id). Sessions are throwaway and
  // get deleted; everything else is history or clan data that must OUTLIVE
  // the user — an audit trail you can erase by deleting the actor isn't an
  // audit trail — so those references are nulled out and render as an
  // unattributed/"deleted user" entry. Miss any one of these and the final
  // DELETE fails with "FOREIGN KEY constraint failed"; audit_log alone made
  // this unreachable for any admin who had ever performed a single action.
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM user_clan_access WHERE user_id = ?').run(id);
    db.prepare('UPDATE audit_log SET user_id = NULL WHERE user_id = ?').run(id);
    db.prepare('UPDATE resource_upload_batches SET uploaded_by = NULL WHERE uploaded_by = ?').run(id);
    db.prepare('UPDATE clans SET created_by = NULL WHERE created_by = ?').run(id);
    db.prepare('UPDATE share_links SET created_by = NULL WHERE created_by = ?').run(id);
    db.prepare('UPDATE share_links SET revoked_by = NULL WHERE revoked_by = ?').run(id);
    db.prepare('UPDATE member_guards_reports SET created_by = NULL WHERE created_by = ?').run(id);
    db.prepare('UPDATE event_schedule_corrections SET created_by = NULL WHERE created_by = ?').run(id);
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
  // A superadmin is cross-clan, so any extra-clan grants go with the clan:
  // left in place they would silently come back if the account were ever
  // demoted again.
  if (role === 'superadmin') {
    db.transaction(() => {
      db.prepare('UPDATE users SET role = ?, clan_id = NULL WHERE id = ?').run(role, id);
      db.prepare('DELETE FROM user_clan_access WHERE user_id = ?').run(id);
    })();
  } else {
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  }
}

/** A home clan is never also an extra clan — drop the grant it replaces. */
function dropAccessToHomeClan(id: number, clanId: number | null): void {
  if (clanId === null) return;
  getDb().prepare('DELETE FROM user_clan_access WHERE user_id = ? AND clan_id = ?').run(id, clanId);
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
  db.transaction(() => {
    db.prepare('UPDATE users SET role = ?, clan_id = ? WHERE id = ?').run(role, clanId, id);
    dropAccessToHomeClan(id, clanId);
  })();
}

export function updateUserClan(id: number, clanId: number | null): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare('UPDATE users SET clan_id = ? WHERE id = ?').run(clanId, id);
    dropAccessToHomeClan(id, clanId);
  })();
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

/**
 * Resolve a session token to the user it belongs to, SCOPED TO THE ACTIVE CLAN.
 *
 * For an account that has switched into an extra clan (user_clan_access) the
 * returned user carries that clan as `clanId` and the role held there as
 * `role`. This is the whole security model of multi-clan accounts: every
 * existing gate compares `req.user.clanId` / `req.user.role`, so by answering
 * with the active clan here, each of them already confines the account to the
 * one clan it is looking at, with the rights it holds in that clan — an admin
 * at home who is a plain user next door gets no admin rights next door, and no
 * :clanId route reaches the clan it is NOT looking at.
 *
 * The grant is re-read on every request, so revoking it (or soft-deleting the
 * clan) drops the account back to its home clan on its very next call. Any
 * session pointer that isn't a live grant is ignored, never trusted.
 * Superadmins are untouched; resolveActiveClanId handles them.
 */
export function validateSession(token: string): SessionValidation | null {
  const db = getDb();
  const now = new Date();
  const row = db.prepare(`
    SELECT u.*, s.expires_at AS session_expires_at, s.active_clan_id AS session_active_clan_id,
           ga.role AS guest_role
    FROM user_sessions s
    JOIN users u ON s.user_id = u.id
    LEFT JOIN user_clan_access ga
           ON ga.user_id = u.id
          AND ga.clan_id = s.active_clan_id
          AND u.role != 'superadmin'
          AND ga.clan_id IS NOT u.clan_id
          AND EXISTS (SELECT 1 FROM clans c WHERE c.id = ga.clan_id AND c.deleted_at = '')
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

  const activeClanId = (row.session_active_clan_id as number | null) ?? null;
  const stored = rowToUser(row);
  const guestRole = row.guest_role as unknown;
  const user = activeClanId !== null && stored.role !== 'superadmin' && isClanRole(guestRole)
    ? { ...stored, clanId: activeClanId, role: guestRole }
    : stored;

  return { user, extended, activeClanId };
}

/**
 * Every clan the account may switch into: its home clan first, then its
 * extra clans, each with the role held there. Live clans only. Empty for a
 * superadmin (they see every clan by other means).
 */
export function listSwitchableClans(userId: number): Array<ClanAccess & { home: boolean }> {
  const db = getDb();
  const u = db.prepare('SELECT role, clan_id FROM users WHERE id = ?').get(userId) as
    { role: UserRole; clan_id: number | null } | undefined;
  if (!u || u.role === 'superadmin') return [];
  const out: Array<ClanAccess & { home: boolean }> = [];
  if (u.clan_id !== null) {
    const live = db.prepare("SELECT 1 FROM clans WHERE id = ? AND deleted_at = ''").get(u.clan_id);
    if (live) out.push({ clanId: u.clan_id, role: u.role, home: true });
  }
  const extras = db.prepare(
    `SELECT a.clan_id, a.role FROM user_clan_access a JOIN clans c ON c.id = a.clan_id
      WHERE a.user_id = ? AND c.deleted_at = '' AND a.clan_id IS NOT ?
      ORDER BY c.name COLLATE NOCASE, a.clan_id`,
  ).all(userId, u.clan_id) as { clan_id: number; role: ClanRole }[];
  for (const e of extras) out.push({ clanId: e.clan_id, role: e.role, home: false });
  return out;
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

/**
 * Record an action by a signed-in user. The row is stamped with the clan the
 * request was scoped to (see utils/request-context.ts), so an account that
 * works in several clans files each action under the clan it acted in rather
 * than under its home clan.
 */
export function logAction(userId: number, action: string, details?: object): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO audit_log (user_id, clan_id, action, details, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, currentRequestClanId(), action, details ? JSON.stringify(details) : null, new Date().toISOString());
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
 * - viewerClanId === number → clan-admin view: user rows filed under that
 *   clan (superadmin rows hidden), plus system rows (no actor) tagged
 *   with that clan_id — so the daily inactivity sweep shows up for the clan
 *   it acted on.
 *
 * A user row names its clan in audit_log.clan_id — the clan the request was
 * scoped to (logAction). That is what keeps a multi-clan account's work in
 * clan B out of clan A's log. Rows written before that stamp existed carry
 * NULL and fall back to the actor's CURRENT home clan, so a reassigned user's
 * old entries follow them into the new clan, as they always did.
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
      WHERE (u.role != 'superadmin' AND (a.clan_id = ? OR (a.clan_id IS NULL AND u.clan_id = ?)))
         OR (a.user_id IS NULL AND a.clan_id = ?)
         OR a.action IN (${CLAN_VISIBLE_GLOBAL_ACTIONS.map(() => '?').join(', ')})
      ORDER BY a.created_at DESC LIMIT ?
    `).all(viewerClanId, viewerClanId, viewerClanId, ...CLAN_VISIBLE_GLOBAL_ACTIONS, limit) as Record<string, unknown>[];
  }

  return rows.map((r) => ({
    id: r.id as number,
    username: r.username as string,
    action: r.action as string,
    details: (r.details as string) || null,
    createdAt: r.created_at as string,
  }));
}
