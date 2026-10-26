"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SESSION_TTL_MS = exports.ALLOWED_THEMES = void 0;
exports.isClanRole = isClanRole;
exports.isValidTheme = isValidTheme;
exports.normalizeUsername = normalizeUsername;
exports.validateUsernamePolicy = validateUsernamePolicy;
exports.validatePasswordPolicy = validatePasswordPolicy;
exports.createUser = createUser;
exports.updateTheme = updateTheme;
exports.authenticate = authenticate;
exports.getUserById = getUserById;
exports.getAllUsers = getAllUsers;
exports.listClanAccess = listClanAccess;
exports.getClanAccessRole = getClanAccessRole;
exports.replaceClanAccess = replaceClanAccess;
exports.setHomeAndClanAccess = setHomeAndClanAccess;
exports.setClanAccessRole = setClanAccessRole;
exports.removeClanAccess = removeClanAccess;
exports.firstSuperadmin = firstSuperadmin;
exports.listSiteContacts = listSiteContacts;
exports.superadminCount = superadminCount;
exports.deleteUser = deleteUser;
exports.updateRole = updateRole;
exports.updateRoleAndClan = updateRoleAndClan;
exports.updateUserClan = updateUserClan;
exports.changePassword = changePassword;
exports.userCount = userCount;
exports.createSession = createSession;
exports.validateSession = validateSession;
exports.listSwitchableClans = listSwitchableClans;
exports.setSessionActiveClan = setSessionActiveClan;
exports.deleteSession = deleteSession;
exports.cleanExpiredSessions = cleanExpiredSessions;
exports.logAction = logAction;
exports.logSystemAction = logSystemAction;
exports.getAuditLog = getAuditLog;
const crypto_1 = __importDefault(require("crypto"));
const database_js_1 = require("../database.js");
const request_context_js_1 = require("../../utils/request-context.js");
function isClanRole(value) {
    return value === 'admin' || value === 'user';
}
exports.ALLOWED_THEMES = ['auto', 'dark', 'light', 'oled'];
function isValidTheme(value) {
    return typeof value === 'string' && exports.ALLOWED_THEMES.includes(value);
}
function normalizeUsername(username) {
    return username.trim();
}
function validateUsernamePolicy(username) {
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
function hashPassword(password) {
    const salt = crypto_1.default.randomBytes(16).toString('hex');
    const hash = crypto_1.default.scryptSync(password, salt, 64).toString('hex');
    return `${salt}:${hash}`;
}
function validatePasswordPolicy(password) {
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
function verifyPassword(password, stored) {
    const [salt, hash] = stored.split(':');
    if (!salt || !hash)
        return false;
    const result = crypto_1.default.scryptSync(password, salt, 64).toString('hex');
    const expected = Buffer.from(hash, 'hex');
    const actual = Buffer.from(result, 'hex');
    if (expected.length !== actual.length)
        return false;
    return crypto_1.default.timingSafeEqual(expected, actual);
}
// --- User CRUD ---
function rowToUser(row) {
    const rawTheme = row.theme;
    return {
        id: row.id,
        username: row.username,
        role: row.role,
        clanId: row.clan_id ?? null,
        createdBy: row.created_by || null,
        createdAt: row.created_at,
        lastLogin: row.last_login || null,
        lastVisited: row.last_visited || null,
        theme: isValidTheme(rawTheme) ? rawTheme : 'dark',
    };
}
function createUser(username, password, role = 'user', createdBy, clanId) {
    const db = (0, database_js_1.getDb)();
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
        id: result.lastInsertRowid,
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
function updateTheme(id, theme) {
    const db = (0, database_js_1.getDb)();
    db.prepare('UPDATE users SET theme = ? WHERE id = ?').run(theme, id);
}
function authenticate(username, password) {
    const db = (0, database_js_1.getDb)();
    const normalizedUsername = normalizeUsername(username);
    const row = db.prepare('SELECT * FROM users WHERE username = ?').get(normalizedUsername);
    if (!row)
        return null;
    if (!verifyPassword(password, row.password_hash))
        return null;
    db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(new Date().toISOString(), row.id);
    return rowToUser(row);
}
function getUserById(id) {
    const db = (0, database_js_1.getDb)();
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    return row ? rowToUser(row) : null;
}
/**
 * List users visible to the caller. Superadmins (viewerClanId=null) see
 * everyone, with each account's extra clans; clan admins see the users whose
 * home is their clan plus the guests granted access to it, AND never see
 * superadmins (cross-clan accounts are an instance-level concern, not a
 * clan-admin one). A guest is reported AS a member of the viewer's clan, with
 * the role it holds there — never with its home clan.
 */
function getAllUsers(viewerClanId) {
    const db = (0, database_js_1.getDb)();
    if (viewerClanId === undefined || viewerClanId === null) {
        const rows = db.prepare('SELECT * FROM users ORDER BY created_at').all();
        const access = db.prepare('SELECT user_id, clan_id, role FROM user_clan_access ORDER BY clan_id').all();
        const byUser = new Map();
        for (const a of access) {
            const list = byUser.get(a.user_id) ?? [];
            list.push({ clanId: a.clan_id, role: a.role });
            byUser.set(a.user_id, list);
        }
        return rows.map((r) => {
            const u = rowToUser(r);
            return { ...u, membership: 'home', clanAccess: byUser.get(u.id) ?? [] };
        });
    }
    const home = db.prepare(`SELECT * FROM users
     WHERE clan_id = ? AND role != 'superadmin'
     ORDER BY created_at`).all(viewerClanId);
    const guests = db.prepare(`SELECT u.*, a.role AS guest_role
       FROM user_clan_access a JOIN users u ON u.id = a.user_id
      WHERE a.clan_id = ? AND u.role != 'superadmin' AND u.clan_id IS NOT a.clan_id
      ORDER BY u.created_at`).all(viewerClanId);
    return [
        ...home.map((r) => ({ ...rowToUser(r), membership: 'home' })),
        ...guests.map((r) => ({
            ...rowToUser(r),
            clanId: viewerClanId,
            role: r.guest_role,
            membership: 'guest',
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
function listClanAccess(userId) {
    return (0, database_js_1.getDb)().prepare('SELECT clan_id, role FROM user_clan_access WHERE user_id = ? ORDER BY clan_id').all(userId).map((r) => ({ clanId: r.clan_id, role: r.role }));
}
function getClanAccessRole(userId, clanId) {
    const row = (0, database_js_1.getDb)().prepare('SELECT role FROM user_clan_access WHERE user_id = ? AND clan_id = ?').get(userId, clanId);
    return row?.role ?? null;
}
/**
 * Replace the account's extra clans with `entries`. Rows for soft-deleted
 * clans are left alone: the editor only ever shows live clans, and a restore
 * should bring the access back with the clan. Callers validate the entries
 * (live clans, not the home clan, no superadmin target).
 */
function replaceClanAccess(userId, entries) {
    const db = (0, database_js_1.getDb)();
    const now = new Date().toISOString();
    const keep = new Set(entries.map((e) => e.clanId));
    const tx = db.transaction(() => {
        const live = db.prepare(`SELECT a.clan_id FROM user_clan_access a JOIN clans c ON c.id = a.clan_id
        WHERE a.user_id = ? AND c.deleted_at = ''`).all(userId);
        const del = db.prepare('DELETE FROM user_clan_access WHERE user_id = ? AND clan_id = ?');
        for (const r of live)
            if (!keep.has(r.clan_id))
                del.run(userId, r.clan_id);
        const upsert = db.prepare(`INSERT INTO user_clan_access (user_id, clan_id, role, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, clan_id) DO UPDATE SET role = excluded.role`);
        for (const e of entries)
            upsert.run(userId, e.clanId, e.role, now);
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
function setHomeAndClanAccess(userId, home, extras) {
    const db = (0, database_js_1.getDb)();
    db.transaction(() => {
        const changed = db.prepare("UPDATE users SET clan_id = ?, role = ? WHERE id = ? AND role != 'superadmin'").run(home.clanId, home.role, userId).changes;
        if (changed === 0)
            return;
        replaceClanAccess(userId, extras);
        dropAccessToHomeClan(userId, home.clanId);
    })();
}
/** Change the role on an EXISTING grant. False when there is none. */
function setClanAccessRole(userId, clanId, role) {
    return (0, database_js_1.getDb)().prepare('UPDATE user_clan_access SET role = ? WHERE user_id = ? AND clan_id = ?').run(role, userId, clanId).changes > 0;
}
function removeClanAccess(userId, clanId) {
    return (0, database_js_1.getDb)().prepare('DELETE FROM user_clan_access WHERE user_id = ? AND clan_id = ?').run(userId, clanId).changes > 0;
}
/** The oldest superadmin account, or null when there is none (or no database
 *  yet). During setup that is the account the wizard just created, which is who
 *  the embedded login bridge acts as. Never throws — a call before
 *  initDatabase() reports "nobody" rather than exploding the request. */
function firstSuperadmin() {
    try {
        const row = (0, database_js_1.getDb)()
            .prepare("SELECT * FROM users WHERE role = 'superadmin' ORDER BY id LIMIT 1")
            .get();
        return row ? rowToUser(row) : null;
    }
    catch {
        return null;
    }
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
function listSiteContacts(clanId) {
    const rows = (0, database_js_1.getDb)().prepare(`SELECT u.username, CASE WHEN u.role = 'superadmin' THEN 'superadmin' ELSE 'admin' END AS role
       FROM users u
      WHERE ((u.role = 'admin' AND u.clan_id = ?)
             OR u.role = 'superadmin'
             OR EXISTS (SELECT 1 FROM user_clan_access a
                         WHERE a.user_id = u.id AND a.clan_id = ? AND a.role = 'admin'))
        AND (u.last_login IS NOT NULL OR u.last_visited IS NOT NULL)
      ORDER BY MAX(COALESCE(u.last_visited, ''), COALESCE(u.last_login, '')) DESC, u.id`).all(clanId, clanId);
    return {
        clanAdmins: rows.filter((r) => r.role === 'admin').map((r) => r.username),
        siteAdmins: rows.filter((r) => r.role === 'superadmin').map((r) => r.username),
    };
}
/** How many superadmin accounts exist. Used by the setup wizard to refuse a
 *  restored database nobody could administer. */
function superadminCount() {
    const db = (0, database_js_1.getDb)();
    const row = db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'superadmin'").get();
    return row.c;
}
function deleteUser(id) {
    const db = (0, database_js_1.getDb)();
    const user = getUserById(id);
    if (user?.role === 'superadmin') {
        const count = db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'superadmin'").get();
        if (count.c <= 1)
            return false;
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
function updateRole(id, role) {
    const db = (0, database_js_1.getDb)();
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
    }
    else {
        db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
    }
}
/** A home clan is never also an extra clan — drop the grant it replaces. */
function dropAccessToHomeClan(id, clanId) {
    if (clanId === null)
        return;
    (0, database_js_1.getDb)().prepare('DELETE FROM user_clan_access WHERE user_id = ? AND clan_id = ?').run(id, clanId);
}
/**
 * Atomic role + clan update. Required when demoting a superadmin to
 * admin/user — the demoted account loses its cross-clan status and
 * needs a clan in the same write so it can never be left orphaned
 * (clan_id NULL with role != 'superadmin'). Callers must validate the
 * clan exists before invoking.
 */
function updateRoleAndClan(id, role, clanId) {
    const db = (0, database_js_1.getDb)();
    db.transaction(() => {
        db.prepare('UPDATE users SET role = ?, clan_id = ? WHERE id = ?').run(role, clanId, id);
        dropAccessToHomeClan(id, clanId);
    })();
}
function updateUserClan(id, clanId) {
    const db = (0, database_js_1.getDb)();
    db.transaction(() => {
        db.prepare('UPDATE users SET clan_id = ? WHERE id = ?').run(clanId, id);
        dropAccessToHomeClan(id, clanId);
    })();
}
function changePassword(id, newPassword) {
    const db = (0, database_js_1.getDb)();
    const passwordHash = hashPassword(newPassword);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, id);
}
function userCount() {
    const db = (0, database_js_1.getDb)();
    const row = db.prepare('SELECT COUNT(*) as c FROM users').get();
    return row.c;
}
// --- Sessions ---
exports.SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const SESSION_EXTEND_THRESHOLD_MS = 12 * 60 * 60 * 1000; // extend when <12h remains
function createSession(userId) {
    const db = (0, database_js_1.getDb)();
    const token = crypto_1.default.randomBytes(32).toString('hex');
    const now = new Date();
    const expires = new Date(now.getTime() + exports.SESSION_TTL_MS);
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
function validateSession(token) {
    const db = (0, database_js_1.getDb)();
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
  `).get(token, now.toISOString());
    if (!row)
        return null;
    const sessionExpiresAt = new Date(row.session_expires_at);
    const remainingMs = sessionExpiresAt.getTime() - now.getTime();
    let extended = false;
    if (remainingMs < SESSION_EXTEND_THRESHOLD_MS) {
        const newExpires = new Date(now.getTime() + exports.SESSION_TTL_MS);
        db.prepare('UPDATE user_sessions SET expires_at = ? WHERE token = ?')
            .run(newExpires.toISOString(), token);
        extended = true;
    }
    // Stamp last_visited, but no more than once per minute per user so we
    // don't churn the row on every API call. The audit-page poller alone
    // could otherwise hit this dozens of times per minute.
    const lastVisitedRaw = row.last_visited ?? null;
    const lastVisitedMs = lastVisitedRaw ? Date.parse(lastVisitedRaw) : 0;
    if (!Number.isFinite(lastVisitedMs) || now.getTime() - lastVisitedMs >= 60_000) {
        const nowIso = now.toISOString();
        db.prepare('UPDATE users SET last_visited = ? WHERE id = ?').run(nowIso, row.id);
        row.last_visited = nowIso;
    }
    const activeClanId = row.session_active_clan_id ?? null;
    const stored = rowToUser(row);
    const guestRole = row.guest_role;
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
function listSwitchableClans(userId) {
    const db = (0, database_js_1.getDb)();
    const u = db.prepare('SELECT role, clan_id FROM users WHERE id = ?').get(userId);
    if (!u || u.role === 'superadmin')
        return [];
    const out = [];
    if (u.clan_id !== null) {
        const live = db.prepare("SELECT 1 FROM clans WHERE id = ? AND deleted_at = ''").get(u.clan_id);
        if (live)
            out.push({ clanId: u.clan_id, role: u.role, home: true });
    }
    const extras = db.prepare(`SELECT a.clan_id, a.role FROM user_clan_access a JOIN clans c ON c.id = a.clan_id
      WHERE a.user_id = ? AND c.deleted_at = '' AND a.clan_id IS NOT ?
      ORDER BY c.name COLLATE NOCASE, a.clan_id`).all(userId, u.clan_id);
    for (const e of extras)
        out.push({ clanId: e.clan_id, role: e.role, home: false });
    return out;
}
function setSessionActiveClan(token, clanId) {
    const db = (0, database_js_1.getDb)();
    db.prepare('UPDATE user_sessions SET active_clan_id = ? WHERE token = ?').run(clanId, token);
}
function deleteSession(token) {
    const db = (0, database_js_1.getDb)();
    db.prepare('DELETE FROM user_sessions WHERE token = ?').run(token);
}
function cleanExpiredSessions() {
    const db = (0, database_js_1.getDb)();
    db.prepare('DELETE FROM user_sessions WHERE expires_at < ?').run(new Date().toISOString());
}
// --- Audit Log ---
/**
 * Record an action by a signed-in user. The row is stamped with the clan the
 * request was scoped to (see utils/request-context.ts), so an account that
 * works in several clans files each action under the clan it acted in rather
 * than under its home clan.
 */
function logAction(userId, action, details) {
    const db = (0, database_js_1.getDb)();
    db.prepare(`
    INSERT INTO audit_log (user_id, clan_id, action, details, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, (0, request_context_js_1.currentRequestClanId)(), action, details ? JSON.stringify(details) : null, new Date().toISOString());
}
/**
 * Log an audit entry for a system-initiated action (no acting user), scoped
 * to a clan so the clan-admin audit view can surface it. Used by background
 * jobs like the daily member-inactivity sweep. Rendered with a "System"
 * actor in the audit log.
 */
function logSystemAction(clanId, action, details) {
    const db = (0, database_js_1.getDb)();
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
];
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
function getAuditLog(limit = 100, viewerClanId) {
    const db = (0, database_js_1.getDb)();
    let rows;
    if (viewerClanId === undefined || viewerClanId === null) {
        rows = db.prepare(`
      SELECT a.id, COALESCE(u.username, 'System') AS username, a.action, a.details, a.created_at
      FROM audit_log a LEFT JOIN users u ON a.user_id = u.id
      ORDER BY a.created_at DESC LIMIT ?
    `).all(limit);
    }
    else {
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
    `).all(viewerClanId, viewerClanId, viewerClanId, ...CLAN_VISIBLE_GLOBAL_ACTIONS, limit);
    }
    return rows.map((r) => ({
        id: r.id,
        username: r.username,
        action: r.action,
        details: r.details || null,
        createdAt: r.created_at,
    }));
}
//# sourceMappingURL=user-repo.js.map