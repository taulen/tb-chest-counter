"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runWithRequestClan = runWithRequestClan;
exports.currentRequestClanId = currentRequestClanId;
const node_async_hooks_1 = require("node:async_hooks");
const storage = new node_async_hooks_1.AsyncLocalStorage();
function runWithRequestClan(clanId, fn) {
    return storage.run({ clanId }, fn);
}
/** The request's clan, or null outside a request (background jobs). */
function currentRequestClanId() {
    return storage.getStore()?.clanId ?? null;
}
//# sourceMappingURL=request-context.js.map