"use strict";
/**
 * Dragon Coins back to members (docs/dragon-coin-returns.md): which members
 * are owed Dragon Coins from the clan treasury, and which of our sends the
 * treasury history (the Clan Capital ledger, 15031) now shows. Pure: the
 * runner (scheduler/dragon-coin-returns.ts) reads the inputs and sends.
 *
 * What counts, from the ledger (verified on prod, Nov 2026):
 *   - kind 4 with Dragon Coins = ONE member's own event reward, which the game
 *     sends to the treasury the moment they collect it (CWB's 48 on Nov 4–5,
 *     21,000–200,000 each, one per member). These are the coins sent back.
 *   - kinds 5 and 8 = what the CLAN won (Dark Omens, Olympus, the Seasonal
 *     Kingdom's rewards), credited to the Leader at the reset (Nov 6 18:00:
 *     CWB 525,000, SIK 4,200,000; SIN CITY 262,500 on Nov 16 and Nov 25).
 *     Never sent: nobody brought them in.
 *   - kind 1 = a payout from the treasury to a member: ours (15019) or a
 *     Leader's / Superior's by hand.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_ATTEMPTS = exports.UNCONFIRMED_AFTER_MS = exports.PAYOUT_KIND = exports.MEMBER_DONATION_KIND = exports.CLAN_DRAGON_COINS = void 0;
exports.planDragonCoinReturns = planDragonCoinReturns;
exports.isSendAccepted = isSendAccepted;
/** The treasury's Dragon Coins: the ledger's resource and amount key, and what 15019 sends. */
exports.CLAN_DRAGON_COINS = 31;
/** A member's own coins arriving in the treasury — the only kind ever sent back. */
exports.MEMBER_DONATION_KIND = 4;
/** Treasury → member. */
exports.PAYOUT_KIND = 1;
/**
 * A send whose outcome we don't know (no clear answer, or the server stopped
 * mid-send) that the ledger still doesn't show this long after counts as not
 * sent. The ledger lists a payout within seconds (Nov 26 2026: 2 s).
 */
exports.UNCONFIRMED_AFTER_MS = 15 * 60_000;
/** Sends that failed for one member's coins before they are left to a Leader. */
exports.MAX_ATTEMPTS = 3;
/** The ledger's clock against ours: a payout may be stamped up to this much before we recorded sending it. */
const CLOCK_SLACK_MS = 5 * 60_000;
const byTime = (a, b) => a.occurredAt - b.occurredAt || a.entryId - b.entryId;
function planDragonCoinReturns(input) {
    const { enabledAt, now } = input;
    const donations = input.entries
        .filter((e) => e.kind === exports.MEMBER_DONATION_KIND && e.amount > 0 && e.occurredAt * 1000 >= enabledAt)
        .sort(byTime);
    const payouts = input.entries.filter((e) => e.kind === exports.PAYOUT_KIND && e.amount > 0).sort(byTime);
    // 1. Our sends ↔ the ledger's payouts: same member, same amount, not before
    //    we sent it. Live sends first, so a send that failed never takes the
    //    payout of the one that replaced it.
    const claimed = new Set();
    for (const r of input.returns)
        if (r.ledgerEntryId !== null)
            claimed.add(r.ledgerEntryId);
    const confirmed = [];
    const confirmedIds = new Set();
    const unmatched = input.returns
        .filter((r) => r.ledgerEntryId === null)
        .sort((a, b) => Number(a.status === 'failed') - Number(b.status === 'failed') || a.createdAt - b.createdAt || a.id - b.id);
    for (const r of unmatched) {
        const p = payouts.find((e) => !claimed.has(e.entryId) && e.playerId === r.playerId && e.amount === r.amount
            && e.occurredAt * 1000 >= r.createdAt - CLOCK_SLACK_MS);
        if (!p)
            continue;
        claimed.add(p.entryId);
        confirmed.push({ returnId: r.id, entryId: p.entryId });
        confirmedIds.add(r.id);
    }
    // 2. A send with no clear outcome that the ledger still doesn't show did not go through.
    const notSent = unmatched
        .filter((r) => (r.status === 'sending' || r.status === 'unknown') && !confirmedIds.has(r.id) && r.createdAt < now - exports.UNCONFIRMED_AFTER_MS)
        .map((r) => r.id);
    const notSentIds = new Set(notSent);
    const isFailed = (r) => !confirmedIds.has(r.id) && (r.status === 'failed' || notSentIds.has(r.id));
    // 3. Coins already covered by a send that went (or may still be going) out,
    //    and how often a send of them failed.
    const covered = new Set();
    const attempts = new Map();
    for (const r of input.returns) {
        const failed = isFailed(r);
        for (const id of r.donationEntryIds) {
            if (failed)
                attempts.set(id, (attempts.get(id) ?? 0) + 1);
            else
                covered.add(id);
        }
    }
    // 4. What's left, member by member.
    const held = [];
    const hold = (e, reason) => {
        held.push({ entryId: e.entryId, playerId: e.playerId, amount: e.amount, occurredAt: e.occurredAt, reason });
    };
    const pendingBy = new Map();
    for (const d of donations) {
        if (covered.has(d.entryId))
            continue;
        if ((attempts.get(d.entryId) ?? 0) >= exports.MAX_ATTEMPTS) {
            hold(d, 'gave-up');
            continue;
        }
        const list = pendingBy.get(d.playerId) ?? [];
        list.push(d);
        pendingBy.set(d.playerId, list);
    }
    // Paid by hand since the switch went on: a payout nobody's send claims, to
    // that member, after the coins arrived, of exactly their amount (or of all
    // they had waiting by then). Anything else (a payout of older coins, a
    // share of a clan reward) leaves the coins to be sent.
    const byHand = payouts.filter((e) => !claimed.has(e.entryId) && e.occurredAt * 1000 >= enabledAt);
    for (const p of byHand) {
        const waiting = (pendingBy.get(p.playerId) ?? []).filter((d) => d.occurredAt <= p.occurredAt);
        if (!waiting.length)
            continue;
        const one = waiting.find((d) => d.amount === p.amount);
        const paid = one ? [one] : waiting.reduce((n, d) => n + d.amount, 0) === p.amount ? waiting : [];
        if (!paid.length)
            continue;
        for (const d of paid)
            hold(d, 'paid-by-hand');
        pendingBy.set(p.playerId, (pendingBy.get(p.playerId) ?? []).filter((d) => !paid.includes(d)));
    }
    const sends = [];
    for (const [playerId, list] of pendingBy) {
        if (!list.length)
            continue;
        if (!input.onRoster(playerId)) {
            for (const d of list)
                hold(d, 'left-clan');
            continue;
        }
        sends.push({
            playerId,
            amount: list.reduce((n, d) => n + d.amount, 0),
            donationEntryIds: list.map((d) => d.entryId),
            since: list[0].occurredAt,
        });
    }
    sends.sort((a, b) => a.since - b.since || a.playerId - b.playerId);
    held.sort((a, b) => a.occurredAt - b.occurredAt || a.entryId - b.entryId);
    return { confirmed, notSent, sends, held };
}
/** 15019's reply when the send went through: `[[]]`. */
function isSendAccepted(body) {
    return Array.isArray(body) && body.length === 1 && Array.isArray(body[0]) && body[0].length === 0;
}
//# sourceMappingURL=dragon-coin-returns.js.map