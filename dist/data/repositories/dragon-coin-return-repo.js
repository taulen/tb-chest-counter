"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDragonCoinReturnSettings = getDragonCoinReturnSettings;
exports.setDragonCoinReturnsEnabled = setDragonCoinReturnsEnabled;
exports.dragonCoinEntries = dragonCoinEntries;
exports.listDragonCoinReturns = listDragonCoinReturns;
exports.recentDragonCoinReturns = recentDragonCoinReturns;
exports.dragonCoinsSentSince = dragonCoinsSentSince;
exports.reserveDragonCoinReturn = reserveDragonCoinReturn;
exports.markDragonCoinReturn = markDragonCoinReturn;
exports.applyDragonCoinLedger = applyDragonCoinLedger;
/**
 * Dragon Coins back to members (v140; docs/dragon-coin-returns.md): the
 * per-clan switch, and one row per send from the clan treasury.
 *
 * A send is reserved (`sending`) with the ledger entries it pays back BEFORE
 * the request goes out, in a transaction that refuses entries another live
 * send already covers — so no member's coins are ever sent twice, restarts
 * and redeploys included. The ledger then confirms it (`ledger_entry_id`).
 */
const database_js_1 = require("../database.js");
const dragon_coin_returns_js_1 = require("../../game-protocol/dragon-coin-returns.js");
function getDragonCoinReturnSettings(clanId) {
    const r = (0, database_js_1.getDb)().prepare('SELECT enabled, enabled_at, updated_at FROM dragon_coin_return_settings WHERE clan_id = ?')
        .get(clanId);
    if (!r)
        return { enabled: false, enabledAt: null, updatedAt: null };
    return { enabled: r.enabled === 1, enabledAt: r.enabled_at, updatedAt: r.updated_at };
}
/**
 * Switch on or off. Every switch-on stamps the time: only coins that arrive
 * after it are sent, so switching off and on again starts from then.
 */
function setDragonCoinReturnsEnabled(clanId, enabled, nowMs = Date.now()) {
    const current = getDragonCoinReturnSettings(clanId);
    const enabledAt = enabled ? (current.enabled ? current.enabledAt ?? nowMs : nowMs) : current.enabledAt;
    (0, database_js_1.getDb)().prepare(`INSERT INTO dragon_coin_return_settings (clan_id, enabled, enabled_at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (clan_id) DO UPDATE SET enabled = excluded.enabled, enabled_at = excluded.enabled_at, updated_at = excluded.updated_at`).run(clanId, enabled ? 1 : 0, enabledAt, new Date(nowMs).toISOString());
    return getDragonCoinReturnSettings(clanId);
}
/**
 * The clan's Dragon Coins arrivals and payouts from the stored ledger
 * (game_ledger keeps every entry a scan ever read), from `sinceMs` minus an
 * hour (the planner applies the exact cut-off).
 */
function dragonCoinEntries(clanId, sinceMs) {
    const rows = (0, database_js_1.getDb)().prepare(`SELECT entry_id, player_id, kind, amounts, occurred_at FROM game_ledger
      WHERE clan_id = ? AND resource = ? AND kind IN (?, ?) AND occurred_at >= ?`).all(clanId, dragon_coin_returns_js_1.CLAN_DRAGON_COINS, dragon_coin_returns_js_1.MEMBER_DONATION_KIND, dragon_coin_returns_js_1.PAYOUT_KIND, Math.floor(sinceMs / 1000) - 3600);
    const out = [];
    for (const r of rows) {
        let amount = 0;
        try {
            amount = Number(JSON.parse(r.amounts)[String(dragon_coin_returns_js_1.CLAN_DRAGON_COINS)]) || 0;
        }
        catch {
            amount = 0;
        }
        if (amount > 0)
            out.push({ entryId: r.entry_id, playerId: r.player_id, kind: r.kind, amount, occurredAt: r.occurred_at });
    }
    return out;
}
function toReturn(r) {
    let ids = [];
    try {
        ids = JSON.parse(r.donation_entry_ids).filter((n) => typeof n === 'number');
    }
    catch {
        ids = [];
    }
    return {
        id: r.id,
        playerId: r.player_id,
        amount: r.amount,
        donationEntryIds: ids,
        status: r.status,
        createdAt: r.created_at,
        ledgerEntryId: r.ledger_entry_id,
        reason: r.reason,
        sentAt: r.sent_at,
    };
}
const RETURN_COLS = 'id, player_id, amount, donation_entry_ids, status, reason, created_at, sent_at, ledger_entry_id';
/** Every send of the clan (the planner needs them all: coverage and attempts). */
function listDragonCoinReturns(clanId) {
    return (0, database_js_1.getDb)().prepare(`SELECT ${RETURN_COLS} FROM dragon_coin_returns WHERE clan_id = ? ORDER BY id`).all(clanId).map(toReturn);
}
/** The newest sends, newest first. */
function recentDragonCoinReturns(clanId, limit) {
    return (0, database_js_1.getDb)().prepare(`SELECT ${RETURN_COLS} FROM dragon_coin_returns WHERE clan_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`)
        .all(clanId, limit).map(toReturn);
}
/** Sends since `sinceMs` that went through (or may have): count and coins. */
function dragonCoinsSentSince(clanId, sinceMs) {
    const r = (0, database_js_1.getDb)().prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS coins FROM dragon_coin_returns
      WHERE clan_id = ? AND created_at >= ? AND status IN ('sent', 'unknown', 'sending')`).get(clanId, sinceMs);
    return { sends: r.n, coins: r.coins };
}
/**
 * Reserve a send before it goes out. Null when any of its entries is already
 * covered by a send that isn't `failed` — then nothing is sent.
 */
function reserveDragonCoinReturn(clanId, send, nowMs = Date.now()) {
    const db = (0, database_js_1.getDb)();
    return db.transaction(() => {
        const live = db.prepare(`SELECT donation_entry_ids FROM dragon_coin_returns WHERE clan_id = ? AND status != 'failed'`).all(clanId);
        const taken = new Set();
        for (const r of live) {
            try {
                for (const id of JSON.parse(r.donation_entry_ids))
                    taken.add(id);
            }
            catch { /* unreadable row covers nothing */ }
        }
        if (send.donationEntryIds.some((id) => taken.has(id)))
            return null;
        const res = db.prepare(`INSERT INTO dragon_coin_returns (clan_id, player_id, amount, donation_entry_ids, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'sending', ?, ?)`).run(clanId, send.playerId, send.amount, JSON.stringify(send.donationEntryIds), nowMs, new Date(nowMs).toISOString());
        return Number(res.lastInsertRowid);
    })();
}
/** The outcome of a reserved send. */
function markDragonCoinReturn(id, status, reason, nowMs = Date.now()) {
    (0, database_js_1.getDb)().prepare(`UPDATE dragon_coin_returns SET status = ?, reason = ?, sent_at = CASE WHEN ? = 'sent' THEN ? ELSE sent_at END, updated_at = ? WHERE id = ?`).run(status, reason, status, nowMs, new Date(nowMs).toISOString(), id);
}
/**
 * Apply what the ledger showed: confirmed sends get their payout entry (and
 * count as sent, whatever the reply said); sends it never showed are failed.
 */
function applyDragonCoinLedger(confirmed, notSent, nowMs = Date.now()) {
    const db = (0, database_js_1.getDb)();
    const at = new Date(nowMs).toISOString();
    const confirm = db.prepare(`UPDATE dragon_coin_returns SET ledger_entry_id = ?, status = 'sent', reason = NULL, sent_at = COALESCE(sent_at, ?), updated_at = ? WHERE id = ?`);
    const fail = db.prepare(`UPDATE dragon_coin_returns SET status = 'failed', reason = 'not-in-ledger', updated_at = ? WHERE id = ? AND ledger_entry_id IS NULL`);
    db.transaction(() => {
        for (const c of confirmed)
            confirm.run(c.entryId, nowMs, at, c.returnId);
        for (const id of notSent)
            fail.run(at, id);
    })();
}
//# sourceMappingURL=dragon-coin-return-repo.js.map