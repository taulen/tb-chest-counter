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

/** The treasury's Dragon Coins: the ledger's resource and amount key, and what 15019 sends. */
export const CLAN_DRAGON_COINS = 31;
/** A member's own coins arriving in the treasury — the only kind ever sent back. */
export const MEMBER_DONATION_KIND = 4;
/** Treasury → member. */
export const PAYOUT_KIND = 1;
/**
 * A send whose outcome we don't know (no clear answer, or the server stopped
 * mid-send) that the ledger still doesn't show this long after counts as not
 * sent. The ledger lists a payout within seconds (Nov 26 2026: 2 s).
 */
export const UNCONFIRMED_AFTER_MS = 15 * 60_000;
/** Sends that failed for one member's coins before they are left to a Leader. */
export const MAX_ATTEMPTS = 3;
/** The ledger's clock against ours: a payout may be stamped up to this much before we recorded sending it. */
const CLOCK_SLACK_MS = 5 * 60_000;

/** A Dragon Coins ledger entry. `occurredAt` is unix seconds, as the game writes it. */
export interface CoinEntry {
  entryId: number;
  playerId: number;
  kind: number;
  amount: number;
  occurredAt: number;
}

/** sending = reserved, the request may be in flight; unknown = no clear answer; failed = not sent. */
export type CoinReturnStatus = 'sending' | 'sent' | 'unknown' | 'failed';

export interface CoinReturn {
  id: number;
  playerId: number;
  amount: number;
  /** The member's kind-4 entries this send pays back. */
  donationEntryIds: number[];
  status: CoinReturnStatus;
  /** Epoch ms the send was reserved (just before it went out). */
  createdAt: number;
  /** The kind-1 entry that shows it went through. */
  ledgerEntryId: number | null;
}

export type HeldReason = 'paid-by-hand' | 'left-clan' | 'gave-up';

export interface ReturnPlanInput {
  /** Epoch ms the switch went on: coins that arrived before it are never sent. */
  enabledAt: number;
  /** Dragon Coins ledger entries (any kind; the planner picks). */
  entries: CoinEntry[];
  /** Every send of this clan. */
  returns: CoinReturn[];
  /** Epoch ms of the ledger read the entries come from. */
  now: number;
  /** On the clan's roster now (a send can only go to a member). */
  onRoster: (playerId: number) => boolean;
}

export interface ReturnPlan {
  /** Our sends the ledger now shows: return → its payout entry. */
  confirmed: Array<{ returnId: number; entryId: number }>;
  /** Sends past UNCONFIRMED_AFTER_MS that the ledger doesn't show: they did not go through. */
  notSent: number[];
  /** One send per member: everything they brought in that nobody has paid back. */
  sends: Array<{ playerId: number; amount: number; donationEntryIds: number[]; since: number }>;
  /** Coins left alone, and why. */
  held: Array<{ entryId: number; playerId: number; amount: number; occurredAt: number; reason: HeldReason }>;
}

const byTime = (a: CoinEntry, b: CoinEntry): number => a.occurredAt - b.occurredAt || a.entryId - b.entryId;

export function planDragonCoinReturns(input: ReturnPlanInput): ReturnPlan {
  const { enabledAt, now } = input;
  const donations = input.entries
    .filter((e) => e.kind === MEMBER_DONATION_KIND && e.amount > 0 && e.occurredAt * 1000 >= enabledAt)
    .sort(byTime);
  const payouts = input.entries.filter((e) => e.kind === PAYOUT_KIND && e.amount > 0).sort(byTime);

  // 1. Our sends ↔ the ledger's payouts: same member, same amount, not before
  //    we sent it. Live sends first, so a send that failed never takes the
  //    payout of the one that replaced it.
  const claimed = new Set<number>();
  for (const r of input.returns) if (r.ledgerEntryId !== null) claimed.add(r.ledgerEntryId);
  const confirmed: ReturnPlan['confirmed'] = [];
  const confirmedIds = new Set<number>();
  const unmatched = input.returns
    .filter((r) => r.ledgerEntryId === null)
    .sort((a, b) => Number(a.status === 'failed') - Number(b.status === 'failed') || a.createdAt - b.createdAt || a.id - b.id);
  for (const r of unmatched) {
    const p = payouts.find((e) => !claimed.has(e.entryId) && e.playerId === r.playerId && e.amount === r.amount
      && e.occurredAt * 1000 >= r.createdAt - CLOCK_SLACK_MS);
    if (!p) continue;
    claimed.add(p.entryId);
    confirmed.push({ returnId: r.id, entryId: p.entryId });
    confirmedIds.add(r.id);
  }

  // 2. A send with no clear outcome that the ledger still doesn't show did not go through.
  const notSent = unmatched
    .filter((r) => (r.status === 'sending' || r.status === 'unknown') && !confirmedIds.has(r.id) && r.createdAt < now - UNCONFIRMED_AFTER_MS)
    .map((r) => r.id);
  const notSentIds = new Set(notSent);
  const isFailed = (r: CoinReturn): boolean => !confirmedIds.has(r.id) && (r.status === 'failed' || notSentIds.has(r.id));

  // 3. Coins already covered by a send that went (or may still be going) out,
  //    and how often a send of them failed.
  const covered = new Set<number>();
  const attempts = new Map<number, number>();
  for (const r of input.returns) {
    const failed = isFailed(r);
    for (const id of r.donationEntryIds) {
      if (failed) attempts.set(id, (attempts.get(id) ?? 0) + 1);
      else covered.add(id);
    }
  }

  // 4. What's left, member by member.
  const held: ReturnPlan['held'] = [];
  const hold = (e: CoinEntry, reason: HeldReason): void => {
    held.push({ entryId: e.entryId, playerId: e.playerId, amount: e.amount, occurredAt: e.occurredAt, reason });
  };
  const pendingBy = new Map<number, CoinEntry[]>();
  for (const d of donations) {
    if (covered.has(d.entryId)) continue;
    if ((attempts.get(d.entryId) ?? 0) >= MAX_ATTEMPTS) { hold(d, 'gave-up'); continue; }
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
    if (!waiting.length) continue;
    const one = waiting.find((d) => d.amount === p.amount);
    const paid = one ? [one] : waiting.reduce((n, d) => n + d.amount, 0) === p.amount ? waiting : [];
    if (!paid.length) continue;
    for (const d of paid) hold(d, 'paid-by-hand');
    pendingBy.set(p.playerId, (pendingBy.get(p.playerId) ?? []).filter((d) => !paid.includes(d)));
  }

  const sends: ReturnPlan['sends'] = [];
  for (const [playerId, list] of pendingBy) {
    if (!list.length) continue;
    if (!input.onRoster(playerId)) { for (const d of list) hold(d, 'left-clan'); continue; }
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
export function isSendAccepted(body: unknown): boolean {
  return Array.isArray(body) && body.length === 1 && Array.isArray(body[0]) && body[0].length === 0;
}
