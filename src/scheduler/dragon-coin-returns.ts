/**
 * Dragon Coins back to members (docs/dragon-coin-returns.md). Opt-in per clan
 * (Clans → Dragon Coins back to members). After a scan, on its game session:
 * every member who brought Dragon Coins into the treasury since the switch went
 * on (ledger kind 4 — their own event reward) gets them back, one send per
 * member (15019). What the CLAN won (kinds 5 and 8) is never sent.
 *
 * Safety, in order:
 *   - only while the switch is on, and DRAGON_COIN_RETURNS_DISABLED isn't set;
 *   - only when the scanner account is the clan's Leader or Superior in the
 *     roster this scan just read (the game allows nobody else);
 *   - only to members on that roster;
 *   - never more than the treasury holds (read fresh before sending);
 *   - each send reserved before it goes out, covering exactly the ledger
 *     entries it pays back — the same entry is never sent twice;
 *   - the ledger is read again after sending: it confirms each send. One with
 *     no clear answer that the ledger doesn't show after 15 minutes counts as
 *     not sent and is tried again, at most 3 times.
 * Never throws: returns one line for the log ('' when the switch is off).
 */
import type { GameClient } from '../game-protocol/client.js';
import { parseClanCapital, parseLedger, type ClanRecord } from '../game-protocol/messages.js';
import {
  CLAN_DRAGON_COINS,
  isSendAccepted,
  planDragonCoinReturns,
  type ReturnPlan,
} from '../game-protocol/dragon-coin-returns.js';
import {
  applyDragonCoinLedger,
  dragonCoinEntries,
  getDragonCoinReturnSettings,
  listDragonCoinReturns,
  markDragonCoinReturn,
  reserveDragonCoinReturn,
} from '../data/repositories/dragon-coin-return-repo.js';
import { saveLedger } from '../data/repositories/game-protocol-repo.js';
import { resolveEntries } from '../utils/log-buffer.js';
import { childLogger } from '../utils/logger.js';
import { requestGap, TREASURY_SEND_GAP } from '../utils/request-gap.js';

const log = childLogger('dragon-coin-returns');

/** Members sent to in one run; the rest go after the next scan. */
export const SENDS_PER_RUN = 30;
/** The game's clan ranks that may send from the treasury: Leader, Superior. */
export const TREASURY_RANKS: ReadonlySet<number> = new Set([1, 2]);

/** The server-wide kill switch (docker-compose passes it through). */
export function dragonCoinReturnsDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(String(env.DRAGON_COIN_RETURNS_DISABLED ?? '').trim());
}

export const rankWarningKey = (clanId: number): string => `dragon-coin-returns:rank:clan:${clanId}`;
/** Clans already warned about their scanner's rank in this process (one warning until it clears). */
const rankWarned = new Set<number>();

export interface DragonCoinReturnOptions {
  client: GameClient;
  /** The clan record this scan read: the roster (ranks) and the capital. */
  record: ClanRecord;
  now?: () => number;
  /** Between sends; tests pass a no-op. */
  gap?: () => Promise<void>;
}

/** Plan from what's stored now (the scan has just saved its ledger read). */
function planNow(clanId: number, enabledAt: number, onRoster: (id: number) => boolean, now: number): ReturnPlan {
  return planDragonCoinReturns({
    enabledAt,
    entries: dragonCoinEntries(clanId, enabledAt),
    returns: listDragonCoinReturns(clanId),
    now,
    onRoster,
  });
}

export async function runDragonCoinReturns(clanId: number, opts: DragonCoinReturnOptions): Promise<string> {
  const now = opts.now ?? Date.now;
  const gap = opts.gap ?? (() => requestGap(TREASURY_SEND_GAP[0], TREASURY_SEND_GAP[1]));
  try {
    const settings = getDragonCoinReturnSettings(clanId);
    if (!settings.enabled || settings.enabledAt === null) return '';
    if (dragonCoinReturnsDisabled()) return 'Dragon Coins back to members: sending is off on this server (DRAGON_COIN_RETURNS_DISABLED)';

    const { client, record } = opts;
    const rank = record.members.find((m) => m.playerId === client.playerId)?.role ?? null;
    if (rank === null || !TREASURY_RANKS.has(rank)) {
      if (!rankWarned.has(clanId)) {
        rankWarned.add(clanId);
        log.warn({ resolveKey: rankWarningKey(clanId) },
          `Clan #${clanId}: Dragon Coins back to members is on, but the scanner account is ${rank === null ? 'not on the clan roster' : `rank ${rank}`} — only a Leader or Superior can send from the treasury, so nothing is sent.`);
      }
      return 'Dragon Coins back to members: the scanner account is not Leader or Superior — nothing sent';
    }
    if (rankWarned.delete(clanId)) resolveEntries(rankWarningKey(clanId));

    const roster = new Set(record.members.map((m) => m.playerId));
    const onRoster = (id: number): boolean => roster.has(id);
    const enabledAt = settings.enabledAt;

    // The ledger this scan read: confirm earlier sends, then what's owed.
    let plan = planNow(clanId, enabledAt, onRoster, now());
    applyDragonCoinLedger(plan.confirmed, plan.notSent, now());
    if (plan.confirmed.length || plan.notSent.length) plan = planNow(clanId, enabledAt, onRoster, now());
    const notes: string[] = [];
    if (plan.notSent.length) notes.push(`${plan.notSent.length} earlier send(s) never reached the ledger (tried again)`);
    if (!plan.sends.length) return notes.length ? `Dragon Coins back to members: ${notes.join('; ')}` : '';

    // The treasury, read fresh: never ask for more than it holds.
    let balance: number | null = null;
    if (record.capitalId !== null) {
      try {
        balance = parseClanCapital(await client.city(record.capitalId))?.treasury[String(CLAN_DRAGON_COINS)] ?? null;
      } catch (err) {
        log.info(`Clan #${clanId}: treasury read before Dragon Coins sends failed (${String(err)}); the game refuses an overdraft itself`);
      }
    }

    const startedAt = now();
    let sent = 0;
    let coins = 0;
    let unclear = 0;
    let short = 0;
    for (const s of plan.sends.slice(0, SENDS_PER_RUN)) {
      if (balance !== null && s.amount > balance) { short++; continue; }
      const id = reserveDragonCoinReturn(clanId, s, now());
      if (id === null) continue;
      try {
        const reply = await client.sendFromTreasury(s.playerId, CLAN_DRAGON_COINS, s.amount);
        if (isSendAccepted(reply.body)) {
          markDragonCoinReturn(id, 'sent', null, now());
          sent++;
          coins += s.amount;
          if (balance !== null) balance -= s.amount;
        } else {
          // An answer we haven't seen: the ledger decides.
          markDragonCoinReturn(id, 'unknown', `reply ${JSON.stringify(reply.body, (_k, x) => (typeof x === 'bigint' ? String(x) : x)).slice(0, 200)}`, now());
          unclear++;
        }
      } catch (err) {
        // The request may or may not have reached the game: the ledger decides.
        markDragonCoinReturn(id, 'unknown', String(err).slice(0, 200), now());
        unclear++;
      }
      await gap();
    }

    // Read the ledger again, as the game's own window does after a send: it confirms them.
    if (sent || unclear) {
      try {
        saveLedger(clanId, parseLedger(await client.ledger(record.clanId, Math.floor(startedAt / 1000) - 600)));
        const after = planNow(clanId, enabledAt, onRoster, now());
        applyDragonCoinLedger(after.confirmed, [], now());
      } catch (err) {
        log.info(`Clan #${clanId}: ledger re-read after Dragon Coins sends failed (${String(err)}); the next scan confirms them`);
      }
    }

    if (sent) notes.unshift(`sent ${coins.toLocaleString('en-US')} to ${sent} member(s)`);
    if (unclear) {
      notes.push(`${unclear} send(s) without a clear answer (the ledger decides)`);
      log.warn({ noAlert: true }, `Clan #${clanId}: ${unclear} Dragon Coins send(s) got no clear answer from the game; the next scans check the treasury history before anything is sent again.`);
    }
    if (short) notes.push(`${short} member(s) waiting: the treasury holds too few Dragon Coins`);
    const left = plan.sends.length - Math.min(plan.sends.length, SENDS_PER_RUN);
    if (left) notes.push(`${left} member(s) after the next scan`);
    return `Dragon Coins back to members: ${notes.join('; ')}`;
  } catch (err) {
    log.warn({ noAlert: true }, `Clan #${clanId}: Dragon Coins back to members failed: ${String(err)}`);
    return `Dragon Coins back to members failed: ${String(err)}`;
  }
}
