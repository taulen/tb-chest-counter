/**
 * /api/join — redeem a code the scanner account sent in the game chat
 * (docs/account-invites.md). Public: a player without an account uses it,
 * and so does a signed-in player adding a clan or linking an old account.
 *
 *   POST /api/join/check  { code }                        → what the code would do
 *   POST /api/join/redeem { code, username?, password? }  → do it
 *
 * Every attempt counts against the caller's address, and failed ones count
 * again on their own: a code is 8 characters from a 31-letter alphabet and
 * lives 30 minutes, so guessing is hopeless, and the limits keep it so. A
 * wrong, used or expired code all answer the same.
 */
import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { clientKey } from '../client-key.js';
import * as userRepo from '../../data/repositories/user-repo.js';
import {
  JOIN_ACTIONS,
  JoinError,
  lookupCode,
  planJoin,
  redeemJoin,
  type JoinMode,
} from '../../data/repositories/account-invite-repo.js';
import {
  SESSION_COOKIE_NAME,
  denyCaching,
  optionalSessionUser,
  sessionCookieOptions,
} from '../middleware/auth.js';

const INVALID = 'This code is not valid or has expired.';

/** Why a code can't be used by this viewer (409), in the words the page shows. */
const REFUSALS: Partial<Record<JoinMode, string>> = {
  already: 'Your account is already linked to this player.',
  conflict: 'This player is already linked to another account. Ask the superadmin to unlink it.',
  'other-player': 'Your account is already linked to another player in this clan.',
  superadmin: 'Superadmin accounts are not linked to a player.',
};

/** The in-game name as a valid username, or '' when too little of it survives. */
export function suggestUsername(playerName: string): string {
  const s = String(playerName ?? '').normalize('NFKD').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 32);
  return s.length >= 3 ? s : '';
}

export function createJoinRouter(): Router {
  const router = Router();
  const common = { windowMs: 15 * 60 * 1000, standardHeaders: true, legacyHeaders: false, validate: { xForwardedForHeader: false }, keyGenerator: clientKey } as const;
  const attempts = rateLimit({ ...common, max: 20, message: { error: 'Too many attempts. Please try again later.' } });
  const failures = rateLimit({ ...common, max: 10, skipSuccessfulRequests: true, message: { error: 'Too many attempts. Please try again later.' } });

  router.use((_req, res, next) => {
    denyCaching(res);
    next();
  });

  router.post('/check', attempts, failures, (req: Request, res: Response) => {
    const info = lookupCode(String(req.body?.code ?? ''));
    if (!info) return res.status(404).json({ error: INVALID });
    const session = optionalSessionUser(req);
    const plan = planJoin(info, session?.user ?? null);
    res.json({
      mode: plan.mode,
      clan: { id: info.clanId, name: info.clanName },
      player: { name: info.playerName, rank: info.rank },
      role: plan.role,
      username: plan.username,
      viewer: session ? { username: session.user.username } : null,
      suggestedUsername: plan.mode === 'new' ? suggestUsername(info.playerName) : '',
      expiresAt: info.expiresAt,
    });
  });

  router.post('/redeem', attempts, failures, (req: Request, res: Response) => {
    const code = String(req.body?.code ?? '');
    const info = lookupCode(code);
    if (!info) return res.status(404).json({ error: INVALID });
    const session = optionalSessionUser(req);
    const viewer = session?.user ?? null;
    const plan = planJoin(info, viewer);
    if (!JOIN_ACTIONS.has(plan.mode)) {
      return res.status(409).json({ error: REFUSALS[plan.mode] ?? INVALID, mode: plan.mode });
    }

    const username = userRepo.normalizeUsername(String(req.body?.username ?? ''));
    const password = String(req.body?.password ?? '');
    if (plan.mode === 'new') {
      const u = userRepo.validateUsernamePolicy(username);
      if (!u.valid) return res.status(400).json({ error: u.message });
    }
    if (plan.mode === 'new' || plan.mode === 'recover') {
      const p = userRepo.validatePasswordPolicy(password);
      if (!p.valid) return res.status(400).json({ error: p.message });
    }

    let result: ReturnType<typeof redeemJoin>;
    try {
      result = redeemJoin(code, viewer, { username, password });
    } catch (err) {
      if (err instanceof JoinError) {
        const msg = REFUSALS[err.message as JoinMode] ?? err.message;
        return res.status(err.status).json({ error: msg });
      }
      // The username's UNIQUE constraint, raced.
      if (/UNIQUE/i.test(String(err))) return res.status(409).json({ error: 'Username already exists' });
      throw err;
    }

    // Signed out: sign them in. Either way, land on the clan the code is for.
    let token = session?.token ?? null;
    if (!token) {
      token = userRepo.createSession(result.user.id);
      res.cookie(SESSION_COOKIE_NAME, token, sessionCookieOptions(req));
    }
    if (result.user.role !== 'superadmin') userRepo.setSessionActiveClan(token, result.clanId);
    res.json({
      ok: true,
      mode: result.mode,
      user: { id: result.user.id, username: result.user.username, role: result.user.role, clanId: result.user.clanId },
    });
  });

  return router;
}
