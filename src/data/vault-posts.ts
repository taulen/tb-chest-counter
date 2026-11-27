/**
 * Vaults members link in the clan's vault chat (v144: a picked group chat read
 * for 'vaults', e.g. CWB's "-CWB VAULTS-"; docs/battle-reports.md), matched to
 * the Vaults of the Ancients the map pass saw (game_map_objects,
 * listRaisedVaults) for Events → Ancients → Vaults.
 *
 * A link is a shared map location: `coord` with x, y, realmId and staticId —
 * the vault's T7 type, 150201–150499, whose last two digits are its level
 * (150244 = level 44; true for all 237 vaults seen by Nov 27 2026) — or the
 * battle report of attacking it (`journal` / attack on a vault type: RIDE and
 * WarChild SK posted theirs that way on Nov 26); the report, once read,
 * gives the tile (battle-report.ts targetAt). A link counts for the member
 * who posted it.
 *
 * Matching: one tile holds several vaults over a run (CWB's 790:162 held a
 * level 39, then a level 44, then another 39 within a day), so a link matches
 * a map vault on the same kingdom and tile, the same type (level), and a time
 * that fits — posted at most MATCH_SLACK_MS before the map first saw it or
 * after it last saw it. The poster's own vault wins; else the one first seen
 * nearest the post.
 */
import zlib from 'zlib';
import { getDb } from './database.js';
import { parseChatSubs } from '../game-protocol/chat-text.js';
import { parseBattleReport } from '../game-protocol/battle-report.js';
import { vaultChats } from './repositories/battle-report-repo.js';
import type { RaisedVault } from './repositories/game-protocol-repo.js';

/** A Vault of the Ancients' T7 type, or not. */
export function isVaultType(id: unknown): id is number {
  return typeof id === 'number' && Number.isInteger(id) && id >= 150201 && id <= 150499;
}

/** Its level: the type's last two digits. */
export const vaultLevel = (type: number): number => type % 100;

const MATCH_SLACK_MS = 12 * 3_600_000;

export interface VaultPost {
  messageId: number;
  chatName: string;
  /** When it was posted (ISO). */
  at: string;
  /** The poster (members.game_player_id), the member row, and their name. */
  playerId: number | null;
  memberId: number | null;
  name: string;
  realm: number | null;
  /** The tile; null for a battle report not read yet. */
  x: number | null;
  y: number | null;
  /** A location link, or the battle report of attacking the vault. */
  via: 'link' | 'report';
  objectType: number;
  level: number;
  /** The map vault it links to, or null: the map pass never saw it. */
  objectId: number | null;
}

/**
 * Pick the map vault a link points at, or null. Without a tile (a battle
 * report not read yet) only the poster's own vault of that type can match.
 */
export function matchVault(
  post: { realm: number | null; x: number | null; y: number | null; objectType: number; atMs: number; playerId: number | null },
  vaults: readonly RaisedVault[],
): RaisedVault | null {
  const onTile = (v: RaisedVault) => (post.x === null || post.y === null
    ? post.playerId !== null && v.ownerId === post.playerId
    : v.x === post.x && v.y === post.y);
  const fits = vaults.filter((v) => onTile(v) && v.objectType === post.objectType
    && (post.realm === null || v.realm === null || v.realm === post.realm)
    && post.atMs >= Date.parse(v.firstSeen) - MATCH_SLACK_MS
    && post.atMs <= Date.parse(v.lastSeen) + MATCH_SLACK_MS);
  if (!fits.length) return null;
  const own = fits.filter((v) => post.playerId !== null && v.ownerId === post.playerId);
  const pool = own.length ? own : fits;
  return [...pool].sort((a, b) => Math.abs(Date.parse(a.firstSeen) - post.atMs) - Math.abs(Date.parse(b.firstSeen) - post.atMs))[0];
}

/**
 * Vault links posted in the clan's vault chats in [fromIso, toIso), oldest
 * first, each matched to `vaults` (the map's, any owner). Empty when the clan
 * has no vault chat.
 */
export function listVaultPosts(clanId: number, fromIso: string | null, toIso: string | null, vaults: readonly RaisedVault[]): VaultPost[] {
  const chats = vaultChats(clanId);
  if (!chats.length) return [];
  const names = new Map(chats.map((c) => [c.url, c.name]));
  const ph = chats.map(() => '?').join(',');
  const fromMs = fromIso ? Date.parse(fromIso) : null;
  const toMs = toIso ? Date.parse(toIso) : null;
  const db = getDb();
  const rows = db.prepare(
    `SELECT channel_url, message_id, created_at, sender_player_id, sender_name, data FROM chat_messages
     WHERE clan_id = ? AND channel_url IN (${ph}) AND (data LIKE '%"coord"%' OR data LIKE '%"journal"%')
       AND (? IS NULL OR created_at >= ?) AND (? IS NULL OR created_at < ?)
     ORDER BY created_at, message_id`,
  ).all(clanId, ...chats.map((c) => c.url), fromMs, fromMs, toMs, toMs) as Array<{
    channel_url: string; message_id: number; created_at: number; sender_player_id: number | null; sender_name: string; data: string;
  }>;
  const posters = [...new Set(rows.map((r) => r.sender_player_id).filter((p): p is number => p !== null))];
  const members = new Map<number, { id: number; name: string }>();
  if (posters.length) {
    for (const m of db.prepare(`SELECT id, name, game_player_id FROM members WHERE clan_id = ? AND game_player_id IN (${posters.map(() => '?').join(',')})`)
      .all(clanId, ...posters) as Array<{ id: number; name: string; game_player_id: number }>) {
      members.set(m.game_player_id, { id: m.id, name: m.name });
    }
  }
  const reportAt = db.prepare("SELECT raw FROM battle_reports WHERE entry_id = ? AND status = 'ok' AND raw IS NOT NULL");
  const out: VaultPost[] = [];
  for (const r of rows) {
    for (const sub of Object.values(parseChatSubs(r.data))) {
      if (!isVaultType(sub.staticId)) continue;
      let realm: number | null = null;
      let x: number | null = null;
      let y: number | null = null;
      let via: VaultPost['via'];
      if (sub.type === 'coord' && typeof sub.x === 'number' && typeof sub.y === 'number') {
        via = 'link';
        realm = typeof sub.realmId === 'number' ? sub.realmId : null;
        x = sub.x;
        y = sub.y;
      } else if (sub.type === 'journal' && sub.entryType === 'attack') {
        // The report of attacking the vault: its tile once the report is read.
        via = 'report';
        const id = typeof sub.journalV2EntryId === 'string' ? sub.journalV2EntryId.toLowerCase() : '';
        const raw = id ? (reportAt.get(id) as { raw: Buffer } | undefined)?.raw : undefined;
        if (raw) {
          try {
            const at = parseBattleReport(zlib.gunzipSync(raw))?.targetAt;
            if (at) ({ realm, x, y } = at);
          } catch { /* unreadable: matched by owner */ }
        }
      } else {
        continue;
      }
      const m = r.sender_player_id !== null ? members.get(r.sender_player_id) : undefined;
      const hit = matchVault({ realm, x, y, objectType: sub.staticId, atMs: r.created_at, playerId: r.sender_player_id }, vaults);
      out.push({
        messageId: r.message_id,
        chatName: names.get(r.channel_url) ?? '',
        at: new Date(r.created_at).toISOString(),
        playerId: r.sender_player_id,
        memberId: m?.id ?? null,
        name: m?.name ?? r.sender_name,
        realm,
        x,
        y,
        via,
        objectType: sub.staticId,
        level: vaultLevel(sub.staticId),
        objectId: hit?.objectId ?? null,
      });
    }
  }
  return out;
}
