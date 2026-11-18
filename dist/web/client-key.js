"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.clientAddress = clientAddress;
exports.clientKey = clientKey;
const express_rate_limit_1 = require("express-rate-limit");
function clientAddress(req) {
    const cf = req.headers['cf-connecting-ip'];
    const fromCloudflare = (Array.isArray(cf) ? cf[0] : cf)?.trim();
    return fromCloudflare || req.ip || req.socket?.remoteAddress || 'unknown';
}
/** keyGenerator for every express-rate-limit limiter in the app. */
function clientKey(req) {
    return (0, express_rate_limit_1.ipKeyGenerator)(clientAddress(req));
}
//# sourceMappingURL=client-key.js.map