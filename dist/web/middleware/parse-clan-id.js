"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseClanIdParam = parseClanIdParam;
/**
 * Express `router.param()` handler that parses a `:clanId` path param
 * once per request and stashes the result on `req.parsedClanId`.
 * Returns 400 on a non-numeric input without ever entering the route
 * handler. Routes drop the boilerplate `Number.parseInt + isFinite +
 * 400` dance that was duplicated 12+ times across clans.ts.
 *
 * Usage:
 *   const router = Router();
 *   router.param('clanId', parseClanIdParam);
 *   router.get('/:clanId', (req, res) => { const id = req.parsedClanId!; ... });
 */
function parseClanIdParam(req, res, next, value) {
    const id = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(id)) {
        res.status(400).json({ error: 'Invalid clanId' });
        return;
    }
    req.parsedClanId = id;
    next();
}
//# sourceMappingURL=parse-clan-id.js.map