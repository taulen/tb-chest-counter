/**
 * Typed views of the game messages we use. Field positions were verified
 * against live captures, the in-game UI and tbclanportal's numbers — see
 * docs/game-protocol.md for the evidence behind each one.
 */
import type { Frame, Wire } from './codec.js';

const num = (v: Wire | undefined): number | null => (typeof v === 'number' ? v : null);
const id1 = (v: Wire | undefined): number | null => (Array.isArray(v) && typeof v[0] === 'number' ? v[0] : null);
const arr = (v: Wire | undefined): Wire[] => (Array.isArray(v) ? v : []);

/** Gifts live 20 h; the clan record only carries the expiry. */
export const GIFT_LIFETIME_S = 20 * 3600;

export interface ClanMember {
  playerId: number;
  /** 1 = leader … 5; the game's own clan rank. */
  role: number;
  joinedAt: number;
}

export interface ClanGift {
  giftId: number;
  senderId: number;
  giftType: number;
  expiresAt: number;
  arrivedAt: number;
  /** Chests in this entry (Triumphal bundles carry 3 or 30). */
  count: number;
  /** 1 = Gifts tab, 2 = Triumphal Gifts tab. */
  tab: number;
}

export interface ClanRecord {
  clanId: number;
  tag: string;
  name: string;
  members: ClanMember[];
  gifts: ClanGift[];
}

/** Message 15000. Only our own clan's record carries members and gifts. */
export function parseClanRecord(frame: Frame): ClanRecord | null {
  const rec = arr(arr(arr(frame.body[0])[0])[0]);
  const clanId = id1(rec[0]);
  if (clanId === null) return null;
  const info = arr(rec[1]);
  const members: ClanMember[] = [];
  for (const m of arr(rec[2])) {
    const row = arr(m);
    const playerId = id1(row[0]);
    if (playerId !== null) members.push({ playerId, role: num(row[1]) ?? 0, joinedAt: num(row[2]) ?? 0 });
  }
  const gifts: ClanGift[] = [];
  for (const g of arr(rec[13])) {
    const row = arr(g);
    const giftId = num(row[0]);
    const senderId = id1(row[1]);
    const giftType = num(row[2]);
    const expiresAt = num(row[3]);
    if (giftId === null || senderId === null || giftType === null || expiresAt === null) continue;
    gifts.push({
      giftId,
      senderId,
      giftType,
      expiresAt,
      arrivedAt: expiresAt - GIFT_LIFETIME_S,
      count: num(row[4]) ?? 1,
      tab: num(row[5]) ?? 1,
    });
  }
  return {
    clanId,
    tag: typeof info[0] === 'string' ? info[0] : '',
    name: typeof info[1] === 'string' ? info[1] : '',
    members,
    gifts,
  };
}

export interface PlayerRecord {
  playerId: number;
  name: string;
  heroAvatar: number | null;
  heroLevel: number | null;
  cityLevel: number | null;
  vip: number | null;
  might: number | null;
  clanId: number | null;
  clanTag: string;
  cityId: number | null;
  goldPass: boolean;
}

/** Message 402: player records, wherever they sit in the reply. */
export function parsePlayers(frame: Frame): PlayerRecord[] {
  const out: PlayerRecord[] = [];
  const walk = (v: Wire): void => {
    if (!Array.isArray(v)) return;
    if (id1(v[0]) !== null && Array.isArray(v[0]) && v[0].length === 1 && typeof v[1] === 'string' && typeof v[2] === 'string') {
      out.push({
        playerId: id1(v[0]) as number,
        name: v[2],
        heroAvatar: num(v[4]),
        heroLevel: num(v[7]),
        cityLevel: num(v[8]),
        vip: num(v[9]),
        might: num(v[10]),
        clanId: id1(v[11]),
        clanTag: typeof v[13] === 'string' ? v[13] : '',
        cityId: id1(v[16]),
        goldPass: Array.isArray(v[22]) && v[22][0] === 1,
      });
      return;
    }
    v.forEach(walk);
  };
  frame.body.forEach(walk);
  return out;
}

export interface LedgerEntry {
  entryId: number;
  playerId: number;
  /** 4 donation, 7 essence-type donation, 3 basic resources, 2 speed-up, 1/5 rarer kinds. */
  kind: number;
  resource: number;
  occurredAt: number;
  amounts: Record<string, number>;
}

/** Message 15031: Clan Capital ledger entries (newest-first on the wire). */
export function parseLedger(frame: Frame): LedgerEntry[] {
  let rows: Wire = frame.body;
  while (Array.isArray(rows) && rows.length === 1 && Array.isArray(rows[0]) && Array.isArray(rows[0][0])) rows = rows[0];
  const out: LedgerEntry[] = [];
  for (const e of arr(rows)) {
    const row = arr(e);
    const entryId = num(row[0]);
    const playerId = id1(row[1]);
    const occurredAt = num(row[4]);
    if (entryId === null || playerId === null || occurredAt === null) continue;
    const amounts: Record<string, number> = {};
    const a = arr(row[5])[0];
    if (a && typeof a === 'object' && !Array.isArray(a) && !('$bin' in a) && !('$pairs' in a)) {
      for (const [k, v] of Object.entries(a)) if (typeof v === 'number') amounts[k] = v;
    }
    out.push({ entryId, playerId, kind: num(row[2]) ?? 0, resource: num(row[3]) ?? 0, occurredAt, amounts });
  }
  return out;
}

/** Message 601: a city's tech levels (research + hero talents). */
export function parseCityTechs(frame: Frame): Record<string, number> {
  let best: Record<string, Wire> | null = null;
  const walk = (v: Wire): void => {
    if (!v || typeof v !== 'object') return;
    if (!Array.isArray(v) && !('$pairs' in v) && !('$bin' in v)) {
      const o = v as Record<string, Wire>;
      if ('1215' in o && (!best || Object.keys(o).length > Object.keys(best).length)) best = o;
      Object.values(o).forEach(walk);
      return;
    }
    if (Array.isArray(v)) v.forEach(walk);
  };
  frame.body.forEach(walk);
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(best ?? {})) {
    if (Array.isArray(v) && typeof v[1] === 'number') out[k] = v[1];
  }
  return out;
}
