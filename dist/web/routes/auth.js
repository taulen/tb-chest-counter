"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAuthRouter = createAuthRouter;
const express_1 = require("express");
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const userRepo = __importStar(require("../../data/repositories/user-repo.js"));
const clanRepo = __importStar(require("../../data/repositories/clan-repo.js"));
const parse_int_js_1 = require("../../utils/parse-int.js");
const db_backup_js_1 = require("../../utils/db-backup.js");
const auth_js_1 = require("../middleware/auth.js");
function createAuthRouter() {
    const router = (0, express_1.Router)();
    const authLimiter = (0, express_rate_limit_1.default)({
        windowMs: 15 * 60 * 1000,
        max: 20,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Too many authentication attempts. Please try again later.' },
        validate: { xForwardedForHeader: false },
    });
    // POST /api/auth/login
    router.post('/login', authLimiter, (req, res) => {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password required' });
        }
        const normalizedUsername = userRepo.normalizeUsername(String(username));
        const usernameCheck = userRepo.validateUsernamePolicy(normalizedUsername);
        if (!usernameCheck.valid) {
            return res.status(400).json({ error: usernameCheck.message });
        }
        const user = userRepo.authenticate(normalizedUsername, String(password));
        if (!user) {
            return res.status(401).json({ error: 'Invalid username or password' });
        }
        const token = userRepo.createSession(user.id);
        res.cookie(auth_js_1.SESSION_COOKIE_NAME, token, (0, auth_js_1.sessionCookieOptions)(req));
        res.json({ user: { id: user.id, username: user.username, role: user.role, clanId: user.clanId, theme: user.theme } });
    });
    // POST /api/auth/logout
    router.post('/logout', auth_js_1.requireAuth, (req, res) => {
        const cookies = req.headers.cookie?.split(';').map((c) => c.trim()) ?? [];
        const sessionCookie = cookies.find((c) => c.startsWith(`${auth_js_1.SESSION_COOKIE_NAME}=`));
        if (sessionCookie) {
            const token = sessionCookie.split('=')[1];
            userRepo.deleteSession(token);
        }
        res.clearCookie(auth_js_1.SESSION_COOKIE_NAME, { path: '/' });
        res.json({ ok: true });
    });
    // GET /api/auth/me - get current user, including their clan and (for
    // superadmins) the currently active clan being viewed.
    router.get('/me', auth_js_1.requireAuth, (req, res) => {
        const u = req.user;
        const activeClan = req.clanId !== undefined ? clanRepo.getClanById(req.clanId) : null;
        res.json({
            // role/clanId are those of the ACTIVE clan (see validateSession).
            // multiClan tells the header to offer the switcher to a non-superadmin.
            user: {
                id: u.id,
                username: u.username,
                role: u.role,
                clanId: u.clanId,
                theme: u.theme,
                multiClan: u.role !== 'superadmin' && userRepo.listSwitchableClans(u.id).length > 1,
            },
            activeClan: activeClan ? {
                id: activeClan.id,
                name: activeClan.name,
                slug: activeClan.slug,
                weekStart: activeClan.weekStart,
            } : null,
        });
    });
    // PUT /api/auth/theme - persist the user's preferred UI theme. The
    // dropdown in the header writes to localStorage immediately for snappy
    // switching and then fires this so the choice follows the user across
    // devices.
    router.put('/theme', auth_js_1.requireAuth, (req, res) => {
        const { theme } = req.body ?? {};
        if (!userRepo.isValidTheme(theme)) {
            return res.status(400).json({ error: 'Invalid theme' });
        }
        userRepo.updateTheme(req.user.id, theme);
        res.json({ ok: true, theme });
    });
    // PUT /api/auth/password - change own password
    router.put('/password', auth_js_1.requireAuth, (req, res) => {
        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword) {
            return res.status(400).json({ error: 'Current and new password required' });
        }
        const pwCheck = userRepo.validatePasswordPolicy(newPassword);
        if (!pwCheck.valid) {
            return res.status(400).json({ error: pwCheck.message });
        }
        // Verify current password
        const user = userRepo.authenticate(req.user.username, currentPassword);
        if (!user) {
            return res.status(401).json({ error: 'Current password is incorrect' });
        }
        userRepo.changePassword(req.user.id, newPassword);
        userRepo.logAction(req.user.id, 'change_password');
        res.json({ ok: true });
    });
    // --- User Management (Admin / Super Admin) ---
    // GET /api/auth/users
    // Admin sees only users in their own clan; superadmin sees everyone.
    router.get('/users', auth_js_1.requireAdmin, (req, res) => {
        const viewerClan = req.user.role === 'superadmin' ? null : req.user.clanId;
        res.json(userRepo.getAllUsers(viewerClan));
    });
    // POST /api/auth/users - create user
    // Superadmin: any role, any clan (clan_id required for non-superadmin).
    // Admin: only role='user', clan_id forced to admin's own clan.
    router.post('/users', auth_js_1.requireAdmin, (req, res) => {
        const { username, password, role, clanId } = req.body;
        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password required' });
        }
        const normalizedUsername = userRepo.normalizeUsername(String(username));
        const usernameCheck = userRepo.validateUsernamePolicy(normalizedUsername);
        if (!usernameCheck.valid) {
            return res.status(400).json({ error: usernameCheck.message });
        }
        const pwCheck = userRepo.validatePasswordPolicy(password);
        if (!pwCheck.valid) {
            return res.status(400).json({ error: pwCheck.message });
        }
        const validRoles = ['user', 'admin', 'superadmin'];
        const requestedRole = role || 'user';
        if (!validRoles.includes(requestedRole)) {
            return res.status(400).json({ error: 'Invalid role' });
        }
        // Authorization: a clan-admin can only create user-role accounts in
        // their own clan. A superadmin can target any clan and any role.
        let resolvedClanId;
        if (req.user.role === 'superadmin') {
            if (requestedRole === 'superadmin') {
                resolvedClanId = null;
            }
            else {
                const parsed = Number.parseInt(String(clanId ?? ''), 10);
                if (!Number.isFinite(parsed)) {
                    return res.status(400).json({ error: 'clanId is required for non-superadmin users' });
                }
                if (!clanRepo.getClanById(parsed)) {
                    return res.status(404).json({ error: 'Target clan not found' });
                }
                resolvedClanId = parsed;
            }
        }
        else {
            // Clan admin: forced into own clan; can create user OR admin
            // accounts but never superadmins (those are cross-clan
            // instance-level and only superadmins can mint them).
            if (requestedRole === 'superadmin') {
                return res.status(403).json({ error: 'Only superadmins can create superadmin accounts' });
            }
            if (req.user.clanId === null) {
                return res.status(400).json({ error: 'Your account is not attached to a clan' });
            }
            resolvedClanId = req.user.clanId;
        }
        try {
            const user = userRepo.createUser(normalizedUsername, String(password), requestedRole, req.user.id, resolvedClanId);
            userRepo.logAction(req.user.id, 'create_user', {
                username: normalizedUsername,
                role: requestedRole,
                clanId: resolvedClanId,
            });
            res.json(user);
        }
        catch (err) {
            res.status(409).json({ error: 'Username already exists' });
        }
    });
    // DELETE /api/auth/users/:id
    // Superadmin: any user (except the last superadmin standing).
    // Clan admin: only users in their own clan, never a superadmin.
    router.delete('/users/:id', auth_js_1.requireAdmin, async (req, res) => {
        const id = parseInt(String(req.params.id));
        if (id === req.user.id) {
            return res.status(400).json({ error: 'Cannot delete yourself' });
        }
        const target = userRepo.getUserById(id);
        if (!target)
            return res.status(404).json({ error: 'User not found' });
        if (req.user.role !== 'superadmin') {
            if (target.role === 'superadmin') {
                return res.status(403).json({ error: 'Clan admins cannot delete superadmins' });
            }
            if (target.clanId !== req.user.clanId) {
                return res.status(403).json({ error: 'You can only delete users in your own clan' });
            }
        }
        // Take a gzipped snapshot of the live DB before deleting so the
        // action is recoverable. Failure to back up aborts the delete —
        // doing the destructive write without a snapshot defeats the
        // purpose of having one. The error middleware turns the throw into
        // a JSON 500 the dashboard can show.
        await (0, db_backup_js_1.createPreActionBackup)(`pre-delete-user-${target.username}`);
        const deleted = userRepo.deleteUser(id);
        if (!deleted) {
            return res.status(400).json({ error: 'Cannot delete the last super admin' });
        }
        userRepo.logAction(req.user.id, 'delete_user', { username: target.username });
        res.json({ ok: true });
    });
    // PUT /api/auth/users/:id/role
    // Superadmin: any role transition.
    // Clan admin: user ↔ admin within their own clan; cannot promote to or
    // demote a superadmin.
    //
    // Demoting a superadmin → admin/user requires `clanId` in the body
    // because superadmins are cross-clan (clan_id NULL); the demoted user
    // must land in a specific clan in the same write or they'd become
    // orphaned (invisible to the clan-admin users list, defaulting to
    // clan 1 in stats endpoints).
    router.put('/users/:id/role', auth_js_1.requireAdmin, (req, res) => {
        const id = parseInt(String(req.params.id));
        const { role, clanId } = req.body;
        const validRoles = ['user', 'admin', 'superadmin'];
        if (!role || !validRoles.includes(role)) {
            return res.status(400).json({ error: 'Invalid role' });
        }
        const target = userRepo.getUserById(id);
        if (!target)
            return res.status(404).json({ error: 'User not found' });
        if (req.user.role !== 'superadmin') {
            if (target.role === 'superadmin' || role === 'superadmin') {
                return res.status(403).json({ error: 'Only superadmins can grant or revoke the superadmin role' });
            }
            if (target.clanId !== req.user.clanId) {
                return res.status(403).json({ error: 'You can only change roles for users in your own clan' });
            }
        }
        const demotingSuperadmin = target.role === 'superadmin' && role !== 'superadmin';
        if (demotingSuperadmin) {
            const parsed = Number.parseInt(String(clanId ?? ''), 10);
            if (!Number.isFinite(parsed)) {
                return res.status(400).json({ error: 'clanId is required when demoting a superadmin' });
            }
            if (!clanRepo.getClanById(parsed)) {
                return res.status(404).json({ error: 'Target clan not found' });
            }
            userRepo.updateRoleAndClan(id, role, parsed);
            userRepo.logAction(req.user.id, 'change_role', {
                username: target.username,
                from: target.role,
                to: role,
                clanId: parsed,
            });
            return res.json({ ok: true });
        }
        userRepo.updateRole(id, role);
        userRepo.logAction(req.user.id, 'change_role', { username: target.username, from: target.role, to: role });
        res.json({ ok: true });
    });
    // PUT /api/auth/users/:id/clan - reassign a user to a different clan.
    // Superadmin only. Useful for moving a member from one clan to another
    // (e.g. when a player switches kingdoms) without recreating the account.
    router.put('/users/:id/clan', auth_js_1.requireSuperAdmin, (req, res) => {
        const id = parseInt(String(req.params.id));
        const target = userRepo.getUserById(id);
        if (!target)
            return res.status(404).json({ error: 'User not found' });
        if (target.role === 'superadmin') {
            return res.status(400).json({ error: 'Superadmins are cross-clan and cannot be assigned to a clan' });
        }
        const raw = req.body?.clanId;
        const parsed = Number.parseInt(String(raw ?? ''), 10);
        if (!Number.isFinite(parsed)) {
            return res.status(400).json({ error: 'clanId required' });
        }
        if (!clanRepo.getClanById(parsed)) {
            return res.status(404).json({ error: 'Target clan not found' });
        }
        userRepo.updateUserClan(id, parsed);
        userRepo.logAction(req.user.id, 'change_user_clan', {
            username: target.username,
            from: target.clanId,
            to: parsed,
        });
        res.json({ ok: true });
    });
    // --- Extra clans (user_clan_access, v88) ---
    // PUT /api/auth/users/:id/clans — replace the account's extra clans, and
    // optionally move its home clan in the same write.
    // Superadmin only: granting a clan means reaching across clans, which no
    // clan admin can do (nor even see the account to do it to).
    // Body: { clans: [{ clanId, role: 'admin' | 'user' }],
    //         home?: { clanId, role: 'admin' | 'user' } }
    router.put('/users/:id/clans', auth_js_1.requireSuperAdmin, (req, res) => {
        const id = parseInt(String(req.params.id));
        const target = userRepo.getUserById(id);
        if (!target)
            return res.status(404).json({ error: 'User not found' });
        if (target.role === 'superadmin') {
            return res.status(400).json({ error: 'Superadmins already see every clan' });
        }
        let home = null;
        if (req.body?.home !== undefined && req.body?.home !== null) {
            const homeClanId = Number.parseInt(String(req.body.home.clanId ?? ''), 10);
            if (!Number.isFinite(homeClanId) || !clanRepo.getClanById(homeClanId)) {
                return res.status(404).json({ error: 'Home clan not found' });
            }
            if (!userRepo.isClanRole(req.body.home.role)) {
                return res.status(400).json({ error: 'Home role must be admin or user' });
            }
            home = { clanId: homeClanId, role: req.body.home.role };
        }
        const homeClanId = home ? home.clanId : target.clanId;
        const raw = req.body?.clans;
        if (!Array.isArray(raw) || raw.length > 100) {
            return res.status(400).json({ error: 'clans must be a list' });
        }
        const entries = [];
        const seen = new Set();
        for (const item of raw) {
            const clanId = Number.parseInt(String(item?.clanId ?? ''), 10);
            if (!Number.isFinite(clanId) || seen.has(clanId)) {
                return res.status(400).json({ error: 'Each clan must be listed once, by id' });
            }
            if (!userRepo.isClanRole(item?.role)) {
                return res.status(400).json({ error: 'Role must be admin or user' });
            }
            if (clanId === homeClanId) {
                return res.status(400).json({ error: 'That is already the user\'s own clan' });
            }
            if (!clanRepo.getClanById(clanId)) {
                return res.status(404).json({ error: `Clan #${clanId} not found` });
            }
            seen.add(clanId);
            entries.push({ clanId, role: item.role });
        }
        const moved = home !== null && (home.clanId !== target.clanId || home.role !== target.role);
        if (home !== null && moved) {
            userRepo.setHomeAndClanAccess(id, home, entries);
        }
        else {
            userRepo.replaceClanAccess(id, entries);
        }
        userRepo.logAction(req.user.id, 'set_user_clans', {
            username: target.username,
            clans: entries,
            ...(moved ? { home: { from: target.clanId, to: home.clanId, fromRole: target.role, role: home.role } } : {}),
        });
        res.json({ ok: true, clanAccess: userRepo.listClanAccess(id) });
    });
    /**
     * Who may manage a guest's access to one clan: a superadmin, or an admin
     * currently in that clan (req.user is scoped to the active clan, so this is
     * "an admin OF that clan", never an admin of somewhere else). An admin can't
     * edit their own grant — the same reason they can't change their own role.
     */
    const guestClanTarget = (req, res) => {
        const id = parseInt(String(req.params.id));
        const clanId = parseInt(String(req.params.clanId));
        if (!Number.isFinite(id) || !Number.isFinite(clanId)) {
            res.status(400).json({ error: 'Invalid user or clan' });
            return null;
        }
        if (req.user.role !== 'superadmin') {
            if (req.user.clanId !== clanId) {
                res.status(403).json({ error: 'You can only manage access to your own clan' });
                return null;
            }
            if (id === req.user.id) {
                res.status(400).json({ error: 'You cannot change your own access' });
                return null;
            }
        }
        const target = userRepo.getUserById(id);
        if (!target || target.role === 'superadmin' || userRepo.getClanAccessRole(id, clanId) === null) {
            res.status(404).json({ error: 'That user has no extra access to this clan' });
            return null;
        }
        return { id, clanId, username: target.username };
    };
    // PUT /api/auth/users/:id/clans/:clanId — change a guest's role in a clan.
    router.put('/users/:id/clans/:clanId', auth_js_1.requireAdmin, (req, res) => {
        const role = req.body?.role;
        if (!userRepo.isClanRole(role)) {
            return res.status(400).json({ error: 'Role must be admin or user' });
        }
        const t = guestClanTarget(req, res);
        if (!t)
            return;
        const from = userRepo.getClanAccessRole(t.id, t.clanId);
        userRepo.setClanAccessRole(t.id, t.clanId, role);
        userRepo.logAction(req.user.id, 'change_clan_role', { username: t.username, clanId: t.clanId, from, to: role });
        res.json({ ok: true });
    });
    // DELETE /api/auth/users/:id/clans/:clanId — remove a guest from a clan.
    // The account itself, and its home clan, are untouched.
    router.delete('/users/:id/clans/:clanId', auth_js_1.requireAdmin, (req, res) => {
        const t = guestClanTarget(req, res);
        if (!t)
            return;
        userRepo.removeClanAccess(t.id, t.clanId);
        userRepo.logAction(req.user.id, 'remove_user_clan', { username: t.username, clanId: t.clanId });
        res.json({ ok: true });
    });
    // GET /api/auth/audit-log
    // Superadmin sees every action; clan admins see only entries whose
    // actor belongs to their clan AND aren't from a superadmin.
    router.get('/audit-log', auth_js_1.requireAdmin, (req, res) => {
        const limit = (0, parse_int_js_1.parseBoundedInt)(req.query.limit, 100, { min: 1, max: 500 });
        const viewerClan = req.user.role === 'superadmin' ? null : req.user.clanId;
        res.json(userRepo.getAuditLog(limit, viewerClan));
    });
    return router;
}
//# sourceMappingURL=auth.js.map