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
exports.suggestUsername = suggestUsername;
exports.createJoinRouter = createJoinRouter;
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
const express_1 = require("express");
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const client_key_js_1 = require("../client-key.js");
const userRepo = __importStar(require("../../data/repositories/user-repo.js"));
const account_invite_repo_js_1 = require("../../data/repositories/account-invite-repo.js");
const auth_js_1 = require("../middleware/auth.js");
const INVALID = 'This code is not valid or has expired.';
/** Why a code can't be used by this viewer (409), in the words the page shows. */
const REFUSALS = {
    already: 'Your account is already linked to this player.',
    conflict: 'This player is already linked to another account. Ask the superadmin to unlink it.',
    superadmin: 'Superadmin accounts are not linked to a player.',
};
/** The in-game name as a valid username, or '' when too little of it survives. */
function suggestUsername(playerName) {
    const s = String(playerName ?? '').normalize('NFKD').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 32);
    return s.length >= 3 ? s : '';
}
function createJoinRouter() {
    const router = (0, express_1.Router)();
    const common = { windowMs: 15 * 60 * 1000, standardHeaders: true, legacyHeaders: false, validate: { xForwardedForHeader: false }, keyGenerator: client_key_js_1.clientKey };
    const attempts = (0, express_rate_limit_1.default)({ ...common, max: 20, message: { error: 'Too many attempts. Please try again later.' } });
    const failures = (0, express_rate_limit_1.default)({ ...common, max: 10, skipSuccessfulRequests: true, message: { error: 'Too many attempts. Please try again later.' } });
    router.use((_req, res, next) => {
        (0, auth_js_1.denyCaching)(res);
        next();
    });
    router.post('/check', attempts, failures, (req, res) => {
        const info = (0, account_invite_repo_js_1.lookupCode)(String(req.body?.code ?? ''));
        if (!info)
            return res.status(404).json({ error: INVALID });
        const session = (0, auth_js_1.optionalSessionUser)(req);
        const plan = (0, account_invite_repo_js_1.planJoin)(info, session?.user ?? null);
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
    router.post('/redeem', attempts, failures, (req, res) => {
        const code = String(req.body?.code ?? '');
        const info = (0, account_invite_repo_js_1.lookupCode)(code);
        if (!info)
            return res.status(404).json({ error: INVALID });
        const session = (0, auth_js_1.optionalSessionUser)(req);
        const viewer = session?.user ?? null;
        const plan = (0, account_invite_repo_js_1.planJoin)(info, viewer);
        if (!account_invite_repo_js_1.JOIN_ACTIONS.has(plan.mode)) {
            return res.status(409).json({ error: REFUSALS[plan.mode] ?? INVALID, mode: plan.mode });
        }
        const username = userRepo.normalizeUsername(String(req.body?.username ?? ''));
        const password = String(req.body?.password ?? '');
        if (plan.mode === 'new') {
            const u = userRepo.validateUsernamePolicy(username);
            if (!u.valid)
                return res.status(400).json({ error: u.message });
        }
        if (plan.mode === 'new' || plan.mode === 'recover') {
            const p = userRepo.validatePasswordPolicy(password);
            if (!p.valid)
                return res.status(400).json({ error: p.message });
        }
        let result;
        try {
            result = (0, account_invite_repo_js_1.redeemJoin)(code, viewer, { username, password });
        }
        catch (err) {
            if (err instanceof account_invite_repo_js_1.JoinError) {
                const msg = REFUSALS[err.message] ?? err.message;
                return res.status(err.status).json({ error: msg });
            }
            // The username's UNIQUE constraint, raced.
            if (/UNIQUE/i.test(String(err)))
                return res.status(409).json({ error: 'Username already exists' });
            throw err;
        }
        // Signed out: sign them in. Either way, land on the clan the code is for —
        // unless a signed-in viewer asked to stay where they are (`stay: true`,
        // the in-app "Add a clan" dialog: it offers the switch itself, and
        // "Stay here" must not move them).
        let token = session?.token ?? null;
        if (!token) {
            token = userRepo.createSession(result.user.id);
            res.cookie(auth_js_1.SESSION_COOKIE_NAME, token, (0, auth_js_1.sessionCookieOptions)(req));
        }
        const stay = !!session && req.body?.stay === true;
        if (result.user.role !== 'superadmin' && !stay)
            userRepo.setSessionActiveClan(token, result.clanId);
        res.json({
            ok: true,
            mode: result.mode,
            clanId: result.clanId,
            user: { id: result.user.id, username: result.user.username, role: result.user.role, clanId: result.user.clanId },
        });
    });
    return router;
}
//# sourceMappingURL=join.js.map