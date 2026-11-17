"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getClanScanAccount = getClanScanAccount;
exports.getClanScanAccounts = getClanScanAccounts;
exports.setClanScanAccount = setClanScanAccount;
exports.clearClanScanAccount = clearClanScanAccount;
/**
 * Which Total Battle account each clan's scanner signs in with (v118) — the
 * website user id (`tb:<n>`, the suid on the site page) and, once a scan has
 * signed in, the game player id. Clans on the same account must never scan at
 * the same time (scheduler/scan-lanes.ts).
 */
const database_js_1 = require("../database.js");
/** The clan's scanner account, or null while unknown. */
function getClanScanAccount(clanId) {
    const row = (0, database_js_1.getDb)().prepare('SELECT account FROM clan_scan_accounts WHERE clan_id = ?').get(clanId);
    return row?.account ?? null;
}
/** Every known clan → account. */
function getClanScanAccounts() {
    const rows = (0, database_js_1.getDb)().prepare('SELECT clan_id, account FROM clan_scan_accounts').all();
    return new Map(rows.map((r) => [r.clan_id, r.account]));
}
/** Record the account a clan's stored login belongs to. Returns true when it changed. */
function setClanScanAccount(clanId, account, playerId, source, now = new Date().toISOString()) {
    const db = (0, database_js_1.getDb)();
    const prev = db.prepare('SELECT account, player_id FROM clan_scan_accounts WHERE clan_id = ?').get(clanId);
    db.prepare(`INSERT INTO clan_scan_accounts (clan_id, account, player_id, source, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (clan_id) DO UPDATE SET
       account = excluded.account,
       player_id = COALESCE(excluded.player_id, CASE WHEN clan_scan_accounts.account = excluded.account THEN clan_scan_accounts.player_id END),
       source = excluded.source, updated_at = excluded.updated_at`).run(clanId, account, playerId, source, now);
    return prev?.account !== account;
}
/** Forget a clan's account (a new login was saved; it may be another account). */
function clearClanScanAccount(clanId) {
    (0, database_js_1.getDb)().prepare('DELETE FROM clan_scan_accounts WHERE clan_id = ?').run(clanId);
}
//# sourceMappingURL=scan-account-repo.js.map