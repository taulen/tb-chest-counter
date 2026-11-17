/**
 * Which Total Battle account each clan's scanner signs in with (v119) — the
 * website user id (`tb:<n>`, the suid on the site page) and, once a scan has
 * signed in, the game player id. Clans on the same account must never scan at
 * the same time (scheduler/scan-lanes.ts).
 */
import { getDb } from '../database.js';

export type ScanAccountSource = 'session-check' | 'scan';

/** The clan's scanner account, or null while unknown. */
export function getClanScanAccount(clanId: number): string | null {
  const row = getDb().prepare('SELECT account FROM clan_scan_accounts WHERE clan_id = ?').get(clanId) as { account: string } | undefined;
  return row?.account ?? null;
}

/** Every known clan → account. */
export function getClanScanAccounts(): Map<number, string> {
  const rows = getDb().prepare('SELECT clan_id, account FROM clan_scan_accounts').all() as Array<{ clan_id: number; account: string }>;
  return new Map(rows.map((r) => [r.clan_id, r.account]));
}

/** Record the account a clan's stored login belongs to. Returns true when it changed. */
export function setClanScanAccount(clanId: number, account: string, playerId: number | null, source: ScanAccountSource, now = new Date().toISOString()): boolean {
  const db = getDb();
  const prev = db.prepare('SELECT account, player_id FROM clan_scan_accounts WHERE clan_id = ?').get(clanId) as
    { account: string; player_id: number | null } | undefined;
  db.prepare(
    `INSERT INTO clan_scan_accounts (clan_id, account, player_id, source, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (clan_id) DO UPDATE SET
       account = excluded.account,
       player_id = COALESCE(excluded.player_id, CASE WHEN clan_scan_accounts.account = excluded.account THEN clan_scan_accounts.player_id END),
       source = excluded.source, updated_at = excluded.updated_at`,
  ).run(clanId, account, playerId, source, now);
  return prev?.account !== account;
}

/** Forget a clan's account (a new login was saved; it may be another account). */
export function clearClanScanAccount(clanId: number): void {
  getDb().prepare('DELETE FROM clan_scan_accounts WHERE clan_id = ?').run(clanId);
}
