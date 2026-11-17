/**
 * Typed views of the game messages we use. Field positions were verified
 * against live captures, the in-game UI and tbclanportal's numbers — see
 * docs/game-protocol.md for the evidence behind each one.
 */
import type { Frame, Wire } from './codec.js';
import type { CityEffect } from './artifacts.js';

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
  /** Clan-owned map objects (f5); each reads in full through 601 like a city. */
  objects: number[];
  /** The Clan Capital's object id (f1[6]); its 601 reply holds the clan's research (f17) and treasury (f5). */
  capitalId: number | null;
  /** Member limit (f6): 60 + 10 per "Number of Clan members" tech the clan holds. */
  memberLimit: number | null;
  /** The clan's might (f7) — the in-game Information tab's figure; ≈ the members' might summed. */
  might: number | null;
  /** When the clan was founded (f1[8], unix s) — the Information tab's "Date founded". */
  foundedAt: number | null;
  /** The clan's language (f1[13], "en_US"). */
  language: string;
  /** The clan logo (f1[2]): background << 16 | frame << 8 | emblem — see game-art/clan-logo.ts. */
  logo: number | null;
  /** Fields not decoded yet (f9, f11 move by the minute; f12 a `[1018,1] → [n]` pair) — stored raw. */
  extra: { f9: number | null; f11: number | null; f12: Wire | null };
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
    objects: arr(rec[5]).map(id1).filter((v): v is number => v !== null),
    capitalId: id1(info[6]),
    memberLimit: num(rec[6]),
    might: num(rec[7]),
    foundedAt: num(info[8]),
    language: typeof info[13] === 'string' ? info[13] : '',
    logo: num(info[2]),
    extra: { f9: num(rec[9]), f11: num(rec[11]), f12: rec[12] ?? null },
  };
}

/** Unwrap one-element arrays (the reply envelopes) down to the payload. */
function unwrap(v: Wire | undefined): Wire | undefined {
  let out = v;
  while (Array.isArray(out) && out.length === 1) out = out[0];
  return out;
}

const isPlainObject = (v: Wire | undefined): v is Record<string, Wire> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && !('$pairs' in v) && !('$bin' in v);

/** Big game numbers decode as bigint past 2^53; anything we keep raw goes through this. */
export function plainWire(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
}

export interface ClanCapital {
  capitalId: number;
  /** The clan's research: `{techId: level}` (f17, the same shape as a city's). */
  techs: Record<string, number>;
  /** The clan treasury (f5): `{resourceId: amount}` — ids name through the gift-type names. */
  treasury: Record<string, number>;
  /** Where the capital stands (f1[13]): [realm (= kingdom), x, y]. */
  position: [number, number, number] | null;
}

/**
 * 601 reply for the Clan Capital object: a 36-field record shaped like a
 * city's. Its f17 is the clan's research (Clan territories / Allies /
 * Fortifications), f5 the clan treasury.
 */
export function parseClanCapital(frame: Frame): ClanCapital | null {
  const city = parseCityRecord(frame);
  if (!city) return null;
  let root: Wire = frame.body;
  while (Array.isArray(root) && root.length === 1) root = root[0];
  const r = arr(arr(arr(root)[0])[0]);
  const treasury: Record<string, number> = {};
  const t = r[5];
  if (isPlainObject(t)) {
    for (const [k, v] of Object.entries(t)) {
      const row = arr(v);
      if (typeof row[1] === 'number') treasury[k] = row[1];
    }
  }
  const pos = arr(arr(r[1])[13]);
  return {
    capitalId: city.cityId,
    techs: city.techs,
    treasury,
    position: pos.length >= 3 && pos.every((n) => typeof n === 'number') ? [pos[0] as number, pos[1] as number, pos[2] as number] : null,
  };
}

export interface ClanStats {
  /** Key 1: the clan's might. */
  might: number | null;
  /** Key 7: the in-game "Clan wealth points". */
  wealth: number | null;
  /** Every key as sent (3, 4, 5, 9 not decoded yet). */
  raw: Record<string, unknown>;
}

/** Message 25 (`[[[clanId]]]`): `{1: might, 3: …, 4: …, 5: …, 7: wealth points, 9: …}`. */
export function parseClanStats(frame: Frame): ClanStats | null {
  const o = unwrap(frame.body);
  if (!isPlainObject(o)) return null;
  return { might: num(o['1']), wealth: num(o['7']), raw: plainWire(o) as Record<string, unknown> };
}

export interface CapitalBorder {
  /** Key 30: the Border tab's "Help points". */
  helpPoints: number | null;
  /** Every `[[key], value]` pair of the first list (20, 21, 22, 29, 31, 37–40 not decoded yet). */
  raw: Record<string, unknown>;
}

/** Message 14003 (`[[[capitalId]]]`): `[[ [[[key], value], …], …, … ]]`. */
export function parseCapitalBorder(frame: Frame): CapitalBorder | null {
  const lists = arr(arr(frame.body)[0]);
  const first = arr(lists[0]);
  const raw: Record<string, unknown> = {};
  for (const e of first) {
    const row = arr(e);
    const key = id1(row[0]);
    if (key !== null) raw[String(key)] = plainWire(row[1]);
  }
  if (!Object.keys(raw).length) return null;
  const help = raw['30'];
  return { helpPoints: typeof help === 'number' ? help : null, raw };
}

export interface ClanMedal {
  medalId: number;
  /** Unix s the medal was earned. */
  earnedAt: number;
}

/** Message 28001 (`[[[clanId]]]`): the medals shown on the Information tab, `[[medalId, earnedAt], …]`. */
export function parseClanMedals(frame: Frame): ClanMedal[] {
  const out: ClanMedal[] = [];
  const walk = (v: Wire | undefined, depth: number): void => {
    if (!Array.isArray(v) || depth > 5) return;
    if (v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number' && v[1] > 1_000_000_000) {
      out.push({ medalId: v[0], earnedAt: v[1] });
      return;
    }
    for (const x of v) walk(x, depth + 1);
  };
  walk(frame.body, 0);
  return out;
}

/**
 * Message 23 (`[[kind, count, [], false]]`): the kingdom's clan ranking,
 * `[[clanId, value], …]` — NOT sorted by value. Kind 7 = wealth points
 * (verified against the in-game list); other kinds unverified.
 */
export function parseClanRanking(frame: Frame): Array<{ clanId: number; value: number }> {
  const out: Array<{ clanId: number; value: number }> = [];
  const walk = (v: Wire | undefined, depth: number): void => {
    if (!Array.isArray(v) || depth > 5) return;
    if (v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number' && v[0] > 1_000_000) {
      out.push({ clanId: v[0], value: v[1] });
      return;
    }
    for (const x of v) walk(x, depth + 1);
  };
  walk(frame.body, 0);
  return out;
}

/**
 * The clan ranking window's categories (message 23 kinds), in the game's
 * order: the client config's rating tabs (RATING_CLANS); each probed — 2 and 6
 * answer empty for clans.
 */
export const CLAN_RANKING_KINDS = [7, 1, 3, 4, 5] as const;

export interface ClanSummary {
  clanId: number;
  /** Logo code (see ClanRecord.logo). */
  logo: number | null;
  tag: string;
  name: string;
  memberLimit: number | null;
  members: number | null;
  language: string;
  might: number | null;
}

/**
 * Message 15200 (`[[[[clanId], …]]]`): any clans' headline — what the game's
 * ranking list shows per clan: `[[clanId], logo, tag, name, type, 0, 0,
 * memberLimit, members, language, might, 1]` (then a `{[1018,1] → [n]}` pair).
 */
export function parseClanSummaries(frame: Frame): ClanSummary[] {
  const out: ClanSummary[] = [];
  const walk = (v: Wire | undefined, depth: number): void => {
    if (!Array.isArray(v) || depth > 6) return;
    if (v.length >= 11 && id1(v[0]) !== null && typeof v[2] === 'string' && typeof v[3] === 'string') {
      out.push({
        clanId: id1(v[0]) as number,
        logo: num(v[1]),
        tag: v[2],
        name: v[3],
        memberLimit: num(v[7]),
        members: num(v[8]),
        language: typeof v[9] === 'string' ? v[9] : '',
        might: num(v[10]),
      });
      return;
    }
    for (const x of v) walk(x, depth + 1);
  };
  walk(frame.body, 0);
  return out;
}

/** 1-based rank of `clanId` by value (highest first), or null when it isn't in the list. */
export function rankIn(list: Array<{ clanId: number; value: number }>, clanId: number): number | null {
  const sorted = [...list].sort((a, b) => b.value - a.value);
  const i = sorted.findIndex((e) => e.clanId === clanId);
  return i < 0 ? null : i + 1;
}

export interface PlayerRecord {
  playerId: number;
  name: string;
  /** [realm, x, y] of the player's city. */
  position: [number, number, number] | null;
  heroAvatar: number | null;
  heroLevel: number | null;
  cityLevel: number | null;
  vip: number | null;
  might: number | null;
  clanId: number | null;
  clanTag: string;
  cityId: number | null;
  goldPass: boolean;
  /** Gold Ingots (field 17) — public in the game for every player. */
  goldIngots: number | null;
  /** f6: the frame around their hero portrait (static T52 customization, type 1; 1 = "Standard"). */
  avatarFrame?: number | null;
  /** f5: their city's appearance (T52 customization, type 2; 9 = "Player's City"). */
  cityAppearance?: number | null;
}

/** Message 402: player records, wherever they sit in the reply. */
export function parsePlayers(frame: Frame): PlayerRecord[] {
  const out: PlayerRecord[] = [];
  const walk = (v: Wire): void => {
    if (!Array.isArray(v)) return;
    if (id1(v[0]) !== null && Array.isArray(v[0]) && v[0].length === 1 && typeof v[1] === 'string' && typeof v[2] === 'string') {
      const pos = arr(v[15]);
      out.push({
        playerId: id1(v[0]) as number,
        name: v[2],
        position: pos.length === 3 && pos.every((p) => typeof p === 'number') ? (pos as [number, number, number]) : null,
        heroAvatar: num(v[4]),
        heroLevel: num(v[7]),
        cityLevel: num(v[8]),
        vip: num(v[9]),
        might: num(v[10]),
        clanId: id1(v[11]),
        clanTag: typeof v[13] === 'string' ? v[13] : '',
        cityId: id1(v[16]),
        goldPass: Array.isArray(v[22]) && v[22][0] === 1,
        goldIngots: num(v[17]),
        avatarFrame: num(v[6]),
        cityAppearance: num(v[5]),
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

/** Message 15013 (claim): the rewards granted, `{itemId: count}` (summed for a batch). */
export function parseClaimRewards(frame: Frame): Record<string, number> {
  const r = arr(arr(arr(frame.body[0])[0]))[0];
  const out: Record<string, number> = {};
  if (r && typeof r === 'object' && !Array.isArray(r) && !('$bin' in r) && !('$pairs' in r)) {
    for (const [k, v] of Object.entries(r)) if (typeof v === 'number') out[k] = v;
  }
  return out;
}

export interface CityRecord {
  cityId: number;
  ownerId: number | null;
  /** Research + hero talents: techId → level. */
  techs: Record<string, number>;
  /** Building slot → { type, level }. */
  buildings: Record<string, { type: number; level: number }>;
  /** Hero summary: level and experience, when present. */
  hero: { level: number | null; xp: number | null };
  /**
   * Field 30: the city's army — `[unitId, count, 0]` per troop type (T9 ids:
   * Heavy arbalester VI 80, Vulture VII 36, Crystal Dragon 152, City Walls V
   * 5014, …). Only present in the signed-in account's own city. NOT captains:
   * their ids merely overlap T75 (checked Nov 2026).
   */
  troops: Array<{ id: number; count: number }>;
  /**
   * Field 9: every captain the player owns, read for ANY player's city (not
   * only the signed-in one). Per entry [0] captain id (T75), [1] active slot
   * (1–3 = in the active line-up, 0 = not), [9] experience, [10] level,
   * [12] equipment, [14] skills, [18] star level. Checked against the game's
   * Captains screen (Nov 2026): Cleopatra 278 ★5, Leonidas 234 ★2, Dustan 151
   * ★6, active Carter/Hercules/Farhad = slots 1/2/3. Entry id 1 is the hero
   * (no T75 row); the caller keeps the ids T75 names.
   */
  captains: CityCaptain[];
  /**
   * Field 14: every effect active in the city, `[effectId, sourceBits, count]`
   * (~600 for a developed city) — research, buildings, and the artifacts the
   * line-up captains wear (see game-protocol/artifacts.ts). Read for ANY
   * player's city.
   */
  effects: CityEffect[];
  /**
   * Field 10: the player's equipment item instances (hero and captains),
   * `[uid, itemType, [cityId], 1000, a, b, c, enchantment, [gems], presetId]`.
   * itemType is a T11 row and includes the quality grade; enchantment and gems
   * are T8 items set into it (0 / [] = none); presetId is the captain preset
   * (captain entry [14]) the item sits in, 0 = in the inventory. a, b and c
   * are not decoded yet (a ∈ {0,1,3,6,10}, b mostly 0–40, c 0–31) and are
   * kept raw. Read for ANY player's city.
   */
  items: CityItem[];
}

export interface CityCaptain {
  id: number;
  level: number;
  stars: number;
  xp: number | null;
  /** 1–3 = in the active line-up, 0 = not. */
  slot: number;
  /**
   * Captain entry [12]: the six equipment positions, `[captainId, slotId,
   * itemUid, 100]` each — the item uid per position ('' = empty). Positions
   * 0–2 are usually empty, 3–5 hold the worn gear (Nov 2026).
   */
  equipment?: string[];
}

export interface CityItem {
  /** 64-bit instance id, as a decimal string. */
  uid: string;
  type: number;
  /** T8 enchantment item set into it (0 = none). */
  enchantment: number;
  /** T8 gem items set into it. */
  gems: number[];
  presetId: number;
  /** Undecoded instance fields [3], a, b, c — kept so a later decode can use them. */
  raw: Array<number | null>;
}

/** A 64-bit id as the codec hands it over (number, or "123…n" past 2^53) → decimal string; '' for 0/none. */
export function uidOf(v: Wire): string {
  if (typeof v === 'number') return v > 0 ? String(v) : '';
  if (typeof v === 'string') {
    const s = v.replace(/n$/, '');
    return /^\d+$/.test(s) && s !== '0' ? s : '';
  }
  return '';
}

/**
 * A 601 reply for several cities (GameClient.cities) cut into one body per
 * city, each in exactly the shape a single-city reply has (`[[[record], []]]`),
 * so parseCityRecord and the raw archive treat them the same as before.
 */
export function splitCityReply(frame: Frame): Array<{ cityId: number; body: Wire[] }> {
  let root: Wire = frame.body;
  while (Array.isArray(root) && root.length === 1) root = root[0];
  const out: Array<{ cityId: number; body: Wire[] }> = [];
  for (const rec of arr(arr(root)[0])) {
    const cityId = id1(arr(rec)[0]);
    if (cityId !== null) out.push({ cityId, body: [[[rec], []]] });
  }
  return out;
}

/**
 * Message 601 for a player's city: [0] city id, [1][0] owner, [12] buildings
 * {slot: [slot, type, level, …]}, [17] techs, [26] hero {"1": [1, [heroId], xp,
 * level, …]}. Verified against Miana's and Kordobrek's cities (Nov 2026).
 */
export function parseCityRecord(frame: Frame): CityRecord | null {
  let root: Wire = frame.body;
  while (Array.isArray(root) && root.length === 1) root = root[0];
  const rec = arr(arr(root)[0])[0];
  const r = arr(rec);
  const cityId = id1(r[0]);
  if (cityId === null) return null;
  const buildings: CityRecord['buildings'] = {};
  const b = r[12];
  if (b && typeof b === 'object' && !Array.isArray(b) && !('$bin' in b) && !('$pairs' in b)) {
    for (const [slot, v] of Object.entries(b)) {
      const row = arr(v);
      if (typeof row[1] === 'number' && typeof row[2] === 'number') buildings[slot] = { type: row[1], level: row[2] };
    }
  }
  const h = r[26];
  const heroRow = h && typeof h === 'object' && !Array.isArray(h) && !('$bin' in h) && !('$pairs' in h) ? arr(Object.values(h)[0]) : [];
  return {
    cityId,
    ownerId: id1(arr(r[1])[0]),
    techs: parseCityTechs(frame),
    buildings,
    hero: { level: num(heroRow[3]), xp: num(heroRow[2]) },
    troops: arr(r[30])
      .map((e) => arr(e))
      .filter((e) => typeof e[0] === 'number' && typeof e[1] === 'number')
      .map((e) => ({ id: e[0] as number, count: e[1] as number })),
    captains: arr(r[9])
      .map((e) => arr(e))
      .filter((e) => typeof e[0] === 'number' && typeof e[10] === 'number')
      .map((e) => ({
        id: e[0] as number,
        level: e[10] as number,
        stars: num(e[18]) ?? 0,
        xp: num(e[9]),
        slot: num(e[1]) ?? 0,
        equipment: arr(e[12]).map((s) => uidOf(arr(s)[2])),
      })),
    effects: arr(r[14])
      .map((e) => arr(e))
      .filter((e) => typeof e[0] === 'number')
      .map((e) => ({ id: e[0] as number, source: num(e[1]) ?? 0, count: num(e[2]) ?? 1 })),
    items: arr(r[10])
      .map((e) => arr(e))
      .filter((e) => uidOf(e[0]) && typeof e[1] === 'number')
      .map((e) => ({
        uid: uidOf(e[0]),
        type: e[1] as number,
        enchantment: num(e[7]) ?? 0,
        gems: arr(e[8]).filter((g): g is number => typeof g === 'number' && g > 0),
        presetId: num(e[9]) ?? 0,
        raw: [num(e[3]), num(e[4]), num(e[5]), num(e[6])],
      })),
  };
}

export interface MapObject {
  objectId: number;
  type: number;
  level: number | null;
  realm: number | null;
  x: number | null;
  y: number | null;
  ownerId: number | null;
  expiresAt: number | null;
}

/** Message 312 (map tiles): `[[id], type, …, level@5, …, [realm,x,y]@8, [owner]@9, expiresAt@10, …]`. */
export function parseMapObjects(frame: Frame): MapObject[] {
  const out: MapObject[] = [];
  const walk = (v: Wire): void => {
    if (!Array.isArray(v)) return;
    const pos = arr(v[8]);
    if (id1(v[0]) !== null && Array.isArray(v[0]) && v[0].length === 1 && typeof v[1] === 'number' && pos.length === 3) {
      out.push({
        objectId: id1(v[0]) as number,
        type: v[1],
        level: num(v[5]),
        realm: num(pos[0]),
        x: num(pos[1]),
        y: num(pos[2]),
        ownerId: id1(v[9]),
        expiresAt: num(v[10]),
      });
      return;
    }
    v.forEach(walk);
  };
  frame.body.forEach(walk);
  return out;
}

export interface MapCity {
  cityId: number;
  ownerId: number;
  clanId: number | null;
  level: number | null;
  position: [number, number, number] | null;
  /** The shield bubble on the map (field 39, true/false). */
  shielded: boolean;
  /** Walls down — the city burns on the map (field 25, 1/0). */
  burning: boolean;
}

/**
 * Cities on the map tiles of a 312 reply: each tile's [4] lists the cities on
 * it as 43-field records `[[cityId], [0], [ownerId], 2, [clanId], …,
 * level@13, avatar@14, [realm,x,y]@17, …, burning@25 (1/0), …, shielded@39
 * (true/false), …]`. Confirmed by the user against the map (Nov 2026): 54 of
 * CWB's 68 cities shielded, field 25 = 1 the burning ones.
 */
export function parseMapCities(frame: Frame): MapCity[] {
  const out: MapCity[] = [];
  const walk = (v: Wire): void => {
    if (!Array.isArray(v)) return;
    const pos = arr(v[17]);
    if (v.length >= 40 && v[3] === 2 && id1(v[0]) !== null && Array.isArray(v[0]) && v[0].length === 1 && id1(v[2]) !== null && typeof v[39] === 'boolean') {
      out.push({
        cityId: id1(v[0]) as number,
        ownerId: id1(v[2]) as number,
        clanId: id1(v[4]),
        level: num(v[13]),
        position: pos.length === 3 && pos.every((p) => typeof p === 'number') ? (pos as [number, number, number]) : null,
        shielded: v[39] === true,
        burning: v[25] === 1,
      });
      return;
    }
    v.forEach(walk);
  };
  frame.body.forEach(walk);
  return out;
}

/** Map tile id (20×20 squares, 50 tiles per row) holding a coordinate. */
export function tileOf(x: number, y: number): number {
  return Math.floor(y / 20) * 50 + Math.floor(x / 20);
}

/**
 * Message 601: a city's tech levels (research + hero talents) — the city
 * record's field 17, `{techId: [techId, level]}`. Read from the field itself:
 * the first version searched the reply for a map holding tech 1215, so a
 * player who had not researched 1215 got no research at all (6 members on
 * Nov 17 2026, their captains from the same reply stored fine).
 */
export function parseCityTechs(frame: Frame): Record<string, number> {
  let root: Wire = frame.body;
  while (Array.isArray(root) && root.length === 1) root = root[0];
  const t = arr(arr(arr(root)[0])[0])[17];
  const out: Record<string, number> = {};
  if (t && typeof t === 'object' && !Array.isArray(t) && !('$pairs' in t) && !('$bin' in t)) {
    for (const [k, v] of Object.entries(t)) {
      if (Array.isArray(v) && typeof v[1] === 'number') out[k] = v[1];
    }
  }
  return out;
}

/** One event (tournament) in the 24001 list. */
export interface GameEventEntry {
  type: number;
  run: number;
  /** Which occurrence of the run this is (Rise of the Ancients #242); a new one each time the event comes round. */
  occurrence: number;
  /** 1 = running now (the list the client polls with 24203), 2 = past / upcoming / not for this clan. */
  state: number;
  /** Epoch seconds; 4294967295 = open-ended. */
  startsAt: number | null;
  endsAt: number | null;
}

/**
 * Message 24001 (ask `[[[[playerId], [clanId], realm], []]]`): every event the
 * account's realm knows, `[[type, run], occurrence, state, endsAt, …, startsAt]`
 * each, in body[0][0] (body[0][1] lists `[type, run]` pairs only). Recorded
 * Nov 17 2026: 186 entries, 10 with state 1 — exactly the ones the client then
 * polls (24203), e.g. `[[1024,1],242,1,…]` Rise of the Ancients running
 * Nov 16 17:00 → Nov 17 17:00 UTC.
 */
export function parseEventList(frame: Frame): GameEventEntry[] {
  const list = arr(arr(arr(frame.body)[0])[0]);
  const out: GameEventEntry[] = [];
  for (const e of list) {
    const r = arr(e);
    const key = arr(r[0]);
    const type = num(key[0]);
    const run = num(key[1]);
    const occurrence = num(r[1]);
    const state = num(r[2]);
    if (type === null || run === null || occurrence === null || state === null) continue;
    out.push({ type, run, occurrence, state, startsAt: num(r[7]), endsAt: num(r[3]) });
  }
  return out;
}

/** Running now: state 1 and not past its end (an open-ended end counts as running). */
export function isEventRunning(e: GameEventEntry, nowSec: number): boolean {
  if (e.state !== 1) return false;
  if (e.startsAt !== null && e.startsAt > nowSec) return false;
  return e.endsAt === null || e.endsAt >= nowSec;
}

/** One member's line in an event's clan-members standings. */
export interface GameEventStanding {
  playerId: number;
  points: number;
  rank: number;
}

/**
 * Message 38003 (ask `[[[type, run]]]`): the event's "Clan members" tab for the
 * signed-in account's clan — `[[playerId], points, rank]` per member, in
 * body[0][0]. Verified against the game's window (Nov 17 2026): Rise of the
 * Ancients for SIK, Mr Freeze 52,586,600 #1, Daigor 50,047,641 #2, Fiin SK 2
 * 49,899,136 #3; CWB's all 0 before its first summon.
 */
export function parseEventStandings(frame: Frame): GameEventStanding[] {
  const rows = arr(arr(arr(frame.body)[0])[0]);
  const out: GameEventStanding[] = [];
  for (const row of rows) {
    const r = arr(row);
    const playerId = id1(r[0]);
    const points = num(r[1]);
    const rank = num(r[2]);
    if (playerId === null || points === null || rank === null) continue;
    out.push({ playerId, points, rank });
  }
  return out;
}

/** The clan's state in an event, from its window's header (38000). */
export interface GameEventProgress {
  occurrence: number | null;
  /** Rise of the Ancients: the clan's Ancient (an id from T44's clanBossAtoms 6000–6249). */
  bossId: number | null;
  /** Rise of the Ancients: "Summons left" — CWB 2 and SIK 1 on Nov 17 2026, as the game showed. */
  summonsLeft: number | null;
  /** The clan's event artifacts: artifact id → [level, points put in]. */
  artifacts: Record<number, { level: number; points: number }>;
}

/**
 * Message 38000 (ask `[[[type, run]]]`, what the client sends as the event
 * window opens): `body[0]` = `[[occurrence, bossId, summonsLeft, 0, [0],
 * [0,0,0]], {artifactId: [level, points]}]`. Read for Rise of the Ancients;
 * fields 3–5 are not decoded. The artifacts map is T44 f9's `artifactIds`
 * (`clandoom_artifacts` config: 1 Tome of Knowledge, 2/4 Enchanted Figurine,
 * 3 Mysterious Clock) — SIK's Tome 26 / Clock 16 match its in-game screen.
 */
export function parseEventProgress(frame: Frame): GameEventProgress | null {
  const root = arr(arr(frame.body)[0]);
  const head = arr(root[0]);
  if (!head.length) return null;
  const artifacts: Record<number, { level: number; points: number }> = {};
  const map = root[1];
  if (map && typeof map === 'object' && !Array.isArray(map) && !('$pairs' in map) && !('$bin' in map)) {
    for (const [k, v] of Object.entries(map as Record<string, Wire>)) {
      const id = Number(k);
      const level = num(arr(v)[0]);
      if (!Number.isInteger(id) || level === null) continue;
      artifacts[id] = { level, points: num(arr(v)[1]) ?? 0 };
    }
  }
  return { occurrence: num(head[0]), bossId: num(head[1]), summonsLeft: num(head[2]), artifacts };
}
