import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import * as userRepo from '../../data/repositories/user-repo.js';
import * as clanRepo from '../../data/repositories/clan-repo.js';
import { parseBoundedInt } from '../../utils/parse-int.js';
import { createPreActionBackup } from '../../utils/db-backup.js';
import {
  SESSION_COOKIE_NAME,
  requireAdmin,
  requireAuth,
  requireSuperAdmin,
  sessionCookieOptions,
} from '../middleware/auth.js';

export function createAuthRouter(): Router {
  const router = Router();

  const authLimiter = rateLimit({
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

    res.cookie(SESSION_COOKIE_NAME, token, sessionCookieOptions(req));

    res.json({ user: { id: user.id, username: user.username, role: user.role, clanId: user.clanId, theme: user.theme } });
  });

  // POST /api/auth/logout
  router.post('/logout', requireAuth, (req, res) => {
    const cookies = req.headers.cookie?.split(';').map((c) => c.trim()) ?? [];
    const sessionCookie = cookies.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
    if (sessionCookie) {
      const token = sessionCookie.split('=')[1];
      userRepo.deleteSession(token);
    }
    res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    res.json({ ok: true });
  });

  // GET /api/auth/me - get current user, including their clan and (for
  // superadmins) the currently active clan being viewed.
  router.get('/me', requireAuth, (req, res) => {
    const u = req.user!;
    const activeClan = req.clanId !== undefined ? clanRepo.getClanById(req.clanId) : null;
    res.json({
      user: { id: u.id, username: u.username, role: u.role, clanId: u.clanId, theme: u.theme },
      activeClan: activeClan ? {
        id: activeClan.id,
        name: activeClan.name,
        slug: activeClan.slug,
      } : null,
    });
  });

  // PUT /api/auth/theme - persist the user's preferred UI theme. The
  // dropdown in the header writes to localStorage immediately for snappy
  // switching and then fires this so the choice follows the user across
  // devices.
  router.put('/theme', requireAuth, (req, res) => {
    const { theme } = req.body ?? {};
    if (!userRepo.isValidTheme(theme)) {
      return res.status(400).json({ error: 'Invalid theme' });
    }
    userRepo.updateTheme(req.user!.id, theme);
    res.json({ ok: true, theme });
  });

  // PUT /api/auth/password - change own password
  router.put('/password', requireAuth, (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new password required' });
    }
    const pwCheck = userRepo.validatePasswordPolicy(newPassword);
    if (!pwCheck.valid) {
      return res.status(400).json({ error: pwCheck.message });
    }

    // Verify current password
    const user = userRepo.authenticate(req.user!.username, currentPassword);
    if (!user) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    userRepo.changePassword(req.user!.id, newPassword);
    userRepo.logAction(req.user!.id, 'change_password');
    res.json({ ok: true });
  });

  // --- User Management (Admin / Super Admin) ---

  // GET /api/auth/users
  // Admin sees only users in their own clan; superadmin sees everyone.
  router.get('/users', requireAdmin, (req, res) => {
    const viewerClan = req.user!.role === 'superadmin' ? null : req.user!.clanId;
    res.json(userRepo.getAllUsers(viewerClan));
  });

  // POST /api/auth/users - create user
  // Superadmin: any role, any clan (clan_id required for non-superadmin).
  // Admin: only role='user', clan_id forced to admin's own clan.
  router.post('/users', requireAdmin, (req, res) => {
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
    let resolvedClanId: number | null;
    if (req.user!.role === 'superadmin') {
      if (requestedRole === 'superadmin') {
        resolvedClanId = null;
      } else {
        const parsed = Number.parseInt(String(clanId ?? ''), 10);
        if (!Number.isFinite(parsed)) {
          return res.status(400).json({ error: 'clanId is required for non-superadmin users' });
        }
        if (!clanRepo.getClanById(parsed)) {
          return res.status(404).json({ error: 'Target clan not found' });
        }
        resolvedClanId = parsed;
      }
    } else {
      // Clan admin: forced into own clan; can create user OR admin
      // accounts but never superadmins (those are cross-clan
      // instance-level and only superadmins can mint them).
      if (requestedRole === 'superadmin') {
        return res.status(403).json({ error: 'Only superadmins can create superadmin accounts' });
      }
      if (req.user!.clanId === null) {
        return res.status(400).json({ error: 'Your account is not attached to a clan' });
      }
      resolvedClanId = req.user!.clanId;
    }

    try {
      const user = userRepo.createUser(
        normalizedUsername,
        String(password),
        requestedRole,
        req.user!.id,
        resolvedClanId,
      );
      userRepo.logAction(req.user!.id, 'create_user', {
        username: normalizedUsername,
        role: requestedRole,
        clanId: resolvedClanId,
      });
      res.json(user);
    } catch (err) {
      res.status(409).json({ error: 'Username already exists' });
    }
  });

  // DELETE /api/auth/users/:id
  // Superadmin: any user (except the last superadmin standing).
  // Clan admin: only users in their own clan, never a superadmin.
  router.delete('/users/:id', requireAdmin, async (req, res) => {
    const id = parseInt(String(req.params.id));
    if (id === req.user!.id) {
      return res.status(400).json({ error: 'Cannot delete yourself' });
    }
    const target = userRepo.getUserById(id);
    if (!target) return res.status(404).json({ error: 'User not found' });

    if (req.user!.role !== 'superadmin') {
      if (target.role === 'superadmin') {
        return res.status(403).json({ error: 'Clan admins cannot delete superadmins' });
      }
      if (target.clanId !== req.user!.clanId) {
        return res.status(403).json({ error: 'You can only delete users in your own clan' });
      }
    }

    // Take a gzipped snapshot of the live DB before deleting so the
    // action is recoverable. Failure to back up aborts the delete —
    // doing the destructive write without a snapshot defeats the
    // purpose of having one. The error middleware turns the throw into
    // a JSON 500 the dashboard can show.
    await createPreActionBackup(`pre-delete-user-${target.username}`);

    const deleted = userRepo.deleteUser(id);
    if (!deleted) {
      return res.status(400).json({ error: 'Cannot delete the last super admin' });
    }
    userRepo.logAction(req.user!.id, 'delete_user', { username: target.username });
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
  router.put('/users/:id/role', requireAdmin, (req, res) => {
    const id = parseInt(String(req.params.id));
    const { role, clanId } = req.body;
    const validRoles = ['user', 'admin', 'superadmin'];
    if (!role || !validRoles.includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    const target = userRepo.getUserById(id);
    if (!target) return res.status(404).json({ error: 'User not found' });

    if (req.user!.role !== 'superadmin') {
      if (target.role === 'superadmin' || role === 'superadmin') {
        return res.status(403).json({ error: 'Only superadmins can grant or revoke the superadmin role' });
      }
      if (target.clanId !== req.user!.clanId) {
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
      userRepo.logAction(req.user!.id, 'change_role', {
        username: target.username,
        from: target.role,
        to: role,
        clanId: parsed,
      });
      return res.json({ ok: true });
    }

    userRepo.updateRole(id, role);
    userRepo.logAction(req.user!.id, 'change_role', { username: target.username, from: target.role, to: role });
    res.json({ ok: true });
  });

  // PUT /api/auth/users/:id/clan - reassign a user to a different clan.
  // Superadmin only. Useful for moving a member from one clan to another
  // (e.g. when a player switches kingdoms) without recreating the account.
  router.put('/users/:id/clan', requireSuperAdmin, (req, res) => {
    const id = parseInt(String(req.params.id));
    const target = userRepo.getUserById(id);
    if (!target) return res.status(404).json({ error: 'User not found' });
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
    userRepo.logAction(req.user!.id, 'change_user_clan', {
      username: target.username,
      from: target.clanId,
      to: parsed,
    });
    res.json({ ok: true });
  });

  // GET /api/auth/audit-log
  // Superadmin sees every action; clan admins see only entries whose
  // actor belongs to their clan AND aren't from a superadmin.
  router.get('/audit-log', requireAdmin, (req, res) => {
    const limit = parseBoundedInt(req.query.limit, 100, { min: 1, max: 500 });
    const viewerClan = req.user!.role === 'superadmin' ? null : req.user!.clanId;
    res.json(userRepo.getAuditLog(limit, viewerClan));
  });

  return router;
}
