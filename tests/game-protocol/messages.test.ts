import { describe, expect, it } from 'vitest';
import type { Frame, Wire } from '../../src/game-protocol/codec.js';
import {
  GIFT_LIFETIME_S,
  parseCityRecord,
  parseCityTechs,
  parseClaimRewards,
  parseClanRecord,
  parseLedger,
  parseMapCities,
  parseMapObjects,
  parsePlayers,
  splitCityReply,
  tileOf,
} from '../../src/game-protocol/messages.js';
import { buildLoginBody, classifySitePage, loginHumanArray, parseSitePage } from '../../src/game-protocol/client.js';

const frame = (type: number, body: Wire[]): Frame => ({ type, seq: 1, head: [type, 1], body, children: [], events: [] });

describe('game messages', () => {
  it('reads members and both gift tabs from the clan record (15000)', () => {
    const rec: Wire = [
      [1297080123906],
      ['CWB', 'ChaosWithoutBorders', 1118480, 'Welcome'],
      [[[390842355323], 4, 1790003608], [[631360456527], 5, 1794868161]],
      [], {}, [], 100, 8399289373, null, 0, null, 0, {},
      [[197080, [1297080235690], 5212, 1794938146, 1, 1], [18255, [4599909974644], 1156, 1794938700, 3, 2]],
      false,
    ];
    const r = parseClanRecord(frame(15000, [[[rec]]]));
    expect(r?.clanId).toBe(1297080123906);
    expect(r?.tag).toBe('CWB');
    expect(r?.members).toEqual([
      { playerId: 390842355323, role: 4, joinedAt: 1790003608 },
      { playerId: 631360456527, role: 5, joinedAt: 1794868161 },
    ]);
    expect(r?.gifts).toEqual([
      { giftId: 197080, senderId: 1297080235690, giftType: 5212, expiresAt: 1794938146, arrivedAt: 1794938146 - GIFT_LIFETIME_S, count: 1, tab: 1 },
      { giftId: 18255, senderId: 4599909974644, giftType: 1156, expiresAt: 1794938700, arrivedAt: 1794938700 - GIFT_LIFETIME_S, count: 3, tab: 2 },
    ]);
  });

  it('reads player records (402), including the Gold Pass flag, Gold Ingots and the portrait frame', () => {
    const p: Wire = [
      [4599909974644], 'tb:117395457', 'baron SP K260 sk', '', 2, 10000096, 10000095, 116, 30, 12, 29724600,
      [4599909974038], 2168077, 'SIN', 0, [1071, 549, 527], [4599917580129], 3126, 63730, [], [[160, 15]], '', [1],
    ];
    const [r] = parsePlayers(frame(402, [[[[p]]]]));
    expect(r).toEqual({
      playerId: 4599909974644, name: 'baron SP K260 sk', position: [1071, 549, 527], heroAvatar: 2, heroLevel: 116, cityLevel: 30, vip: 12,
      might: 29724600, clanId: 4599909974038, clanTag: 'SIN', cityId: 4599917580129, goldPass: true, goldIngots: 3126,
      // f6 a portrait frame (T52 kind 1), f5 a city look (kind 2)
      avatarFrame: 10000095, cityAppearance: 10000096,
    });
  });

  it('reads Clan Capital ledger entries (15031)', () => {
    const rows: Wire = [
      [4609, [4599909975340], 7, 74285, 1794870480, [{ 74285: 1600 }, {}, 1]],
      [1620, [4599909974071], 2, 0, 1794516720, [{ 2051: 24, 2052: 48 }, {}, 1]],
    ];
    expect(parseLedger(frame(15031, [[[rows]]]))).toEqual([
      { entryId: 4609, playerId: 4599909975340, kind: 7, resource: 74285, occurredAt: 1794870480, amounts: { 74285: 1600 } },
      { entryId: 1620, playerId: 4599909974071, kind: 2, resource: 0, occurredAt: 1794516720, amounts: { 2051: 24, 2052: 48 } },
    ]);
  });

  it('reads the rewards a claim (15013) granted', () => {
    // Real reply shape: Triumphal Wooden Chest opened → one 1-hour Clan Speedup.
    const body: Wire[] = [[[{ 2050: 1 }, {}, [], [], [], [], 0, 0, 0, {}, [], {}, 0, [], 0, {}]]];
    expect(parseClaimRewards(frame(15013, body))).toEqual({ 2050: 1 });
    expect(parseClaimRewards(frame(15013, [[[{}]]]))).toEqual({});
  });

  it('lists the clan-owned objects (15000 f5)', () => {
    const rec: Wire = [[7], ['T', 'Test'], [[[1], 1, 0]], [], {}, [[4599917580066], [4599917593293]], 1, 0, null, 0, null, 0, {}, [], false];
    expect(parseClanRecord(frame(15000, [[[rec]]]))?.objects).toEqual([4599917580066, 4599917593293]);
  });

  it('reads a city (601): owner, buildings, techs and hero', () => {
    const city: Wire[] = [];
    city[0] = [4599917580129];
    city[1] = [[4599909974644]];
    city[12] = { 3: [3, 41, 25, 0], 7: [7, 12, 30, 0] };
    city[17] = { 1215: [1215, 2], 29006: [29006, 20] };
    city[26] = { 1: [1, [5], 98765, 116] };
    city[30] = [[27, 1211, 0], [30, 1705, 0]];
    // Captains: the real entry layout (equipment/skills trimmed); id 1 is the hero.
    city[9] = [
      [1, 0, 9, [4599917580129], 1, 0, 0, 0, 0, 2295854228842, 214, 0, [], 1, [], [1, 12, 2, 9, 5], 1794234013, 0, 0, []],
      [20, 0, 0, [4599917580129], 1, 0, 0, 0, 0, 14939681299178, 278, 0, [], 0, [], [], 0, 0, 5, []],
      [8, 1, 0, [4599917580129], 1, 0, 0, 0, 0, 633274738935, 200, 0, [], 0, [], [], 0, 0, 6, []],
    ];
    // Real reply nesting: [[[city], []]].
    const r = parseCityRecord(frame(601, [[[city], []]]));
    expect(r).toEqual({
      cityId: 4599917580129,
      ownerId: 4599909974644,
      techs: { 1215: 2, 29006: 20 },
      buildings: { 3: { type: 41, level: 25 }, 7: { type: 12, level: 30 } },
      dragon: { level: 116, xp: 98765 },
      troops: [{ id: 27, count: 1211 }, { id: 30, count: 1705 }],
      captains: [
        { id: 1, level: 214, stars: 0, xp: 2295854228842, slot: 0, equipment: [] },
        { id: 20, level: 278, stars: 5, xp: 14939681299178, slot: 0, equipment: [] },
        { id: 8, level: 200, stars: 6, xp: 633274738935, slot: 1, equipment: [] },
      ],
      effects: [],
      items: [],
    });
  });

  it('reads active effects (field 14), item instances (field 10) and captain equipment (field 9 [12])', () => {
    const city: Wire[] = [];
    city[0] = [77];
    // Layout as the game sends it (Nov 2026); ids made up. Uids past 2^53 come
    // through the codec as "<digits>n" strings, small ones as numbers.
    city[9] = [
      [8, 1, 0, [77], 1, 0, 0, 0, 0, 1000, 200, 0,
        [[8, 129, 0, 100], [8, 130, 0, 100], [8, 131, 0, 100], [8, 132, '90000000000000001n', 100], [8, 133, 5005, 100], [8, 134, 0, 100]],
        0, [], [], 0, 0, 6, []],
    ];
    city[10] = [
      ['90000000000000001n', 4423, [77], 1000, 10, 40, 0, 8408, [257], 128],
      [5005, 4430, [77], 1000, 6, 36, 0, 0, [], 128],
      [0, 1, [77], 1000, 0, 0, 0, 0, [], 0], // no uid: not an item
    ];
    city[14] = [[308949, 16384, 1], [309681, 1, 1], [509522, 1, 2]];
    const r = parseCityRecord(frame(601, [[[city], []]]));
    expect(r?.captains[0].equipment).toEqual(['', '', '', '90000000000000001', '5005', '']);
    expect(r?.items).toEqual([
      { uid: '90000000000000001', type: 4423, enchantment: 8408, gems: [257], presetId: 128, raw: [1000, 10, 40, 0] },
      { uid: '5005', type: 4430, enchantment: 0, gems: [], presetId: 128, raw: [1000, 6, 36, 0] },
    ]);
    expect(r?.effects).toEqual([
      { id: 308949, source: 16384, count: 1 },
      { id: 309681, source: 1, count: 1 },
      { id: 509522, source: 1, count: 2 },
    ]);
  });

  it('reads map objects (312) wherever they sit in the tile reply, and maps coordinates to tiles', () => {
    const vault: Wire = [[88], 5021, 0, 0, 0, 45, 0, 0, [1071, 549, 527], [4599909974644], 1795000000];
    const objs = parseMapObjects(frame(312, [[[[[[1301, [vault]]]]]]]));
    expect(objs).toEqual([
      { objectId: 88, type: 5021, level: 45, realm: 1071, x: 549, y: 527, ownerId: 4599909974644, expiresAt: 1795000000 },
    ]);
    expect(tileOf(549, 527)).toBe(26 * 50 + 27);
    expect(tileOf(0, 0)).toBe(0);
  });

  it('reads cities from map tiles (312 tile [4]): shield = field 39, burning = field 25', () => {
    // A 43-field city record: [[cityId], [0], [owner], 2, [clan], …, level@13, avatar@14, [realm,x,y]@17, …
    const city = (id: number, owner: number, burning: 0 | 1, shielded: boolean): Wire => {
      const r: Wire[] = new Array(43).fill(0);
      r[0] = [id]; r[1] = [0]; r[2] = [owner]; r[3] = 2; r[4] = [1297080123906];
      r[13] = 44; r[14] = 9; r[17] = [260, 803, 165]; r[18] = [260, 803, 165];
      r[25] = burning; r[39] = shielded; r[40] = 1790014008;
      return r;
    };
    const tile: Wire = [440, 23014, { $bin: 12, hex: '00' }, 22367, [city(11, 101, 0, true), city(12, 102, 1, false)], []];
    const cities = parseMapCities(frame(312, [[[tile], [], [], []]]));
    expect(cities).toEqual([
      { cityId: 11, ownerId: 101, clanId: 1297080123906, level: 44, position: [260, 803, 165], shielded: true, burning: false },
      { cityId: 12, ownerId: 102, clanId: 1297080123906, level: 44, position: [260, 803, 165], shielded: false, burning: true },
    ]);
    // The vault parser never mistakes a city for a map object.
    expect(parseMapObjects(frame(312, [[[tile], [], [], []]]))).toEqual([]);
  });

  it('cuts a several-city 601 reply into single-city bodies the city parser reads as before', () => {
    const rec = (id: number): Wire[] => {
      const r: Wire[] = new Array(36).fill(0);
      r[0] = [id]; r[1] = [[700 + id]]; r[17] = { 1001: [1001, id] };
      return r;
    };
    const parts = splitCityReply(frame(601, [[[rec(1), rec(2), rec(3)], []]]));
    expect(parts.map((p) => p.cityId)).toEqual([1, 2, 3]);
    for (const p of parts) {
      const city = parseCityRecord(frame(601, p.body));
      expect(city?.cityId).toBe(p.cityId);
      expect(city?.techs).toEqual({ 1001: p.cityId });
    }
    // A single-city reply splits into itself.
    expect(splitCityReply(frame(601, [[[rec(9)], []]])).map((p) => p.cityId)).toEqual([9]);
  });

  it('reads the tech map (research + talents) from city field 17 (601)', () => {
    const city: Wire[] = [];
    city[0] = [1];
    city[12] = { 3: [3, 41, 25, 0] };
    city[17] = { 1197: [1197, 1], 1215: [1215, 1], 1233: [1233, 8], 29006: [29006, 20] };
    expect(parseCityTechs(frame(601, [[[city], []]]))).toEqual({ 1197: 1, 1215: 1, 1233: 8, 29006: 20 });
  });

  it('reads the techs of a player who has not researched tech 1215', () => {
    // Gudal (SK7, Nov 2026): 49 techs, no 1215 — the old search found none.
    const city: Wire[] = [];
    city[0] = [1];
    city[17] = { 1000: [1000, 1], 1001: [1001, 4], 1018: [1018, 4] };
    expect(parseCityTechs(frame(601, [[[city], []]]))).toEqual({ 1000: 1, 1001: 4, 1018: 4 });
  });
});

describe('direct client building blocks', () => {
  it('only calls a session logged out on the site’s own logged-out page', () => {
    expect(classifySitePage(200, '<script>{"suid":"tb:117471041"}</script>')).toBe('ok');
    expect(classifySitePage(200, '<h1>Register or log in</h1>')).toBe('logged-out');
    expect(classifySitePage(200, '<p>Sign up with Google</p>')).toBe('logged-out');
    // A maintenance page, a Cloudflare challenge or an outage proves nothing.
    expect(classifySitePage(200, '<h1>Maintenance</h1>')).toBe('unknown');
    expect(classifySitePage(503, '<h1>Register or log in</h1>')).toBe('unknown');
  });

  it('pulls the game account id and realm servers out of the site page', () => {
    const html = 'x"externalId":"ab","suid":"tb:117471041","suid_simulate":0 '
      + '{"realm_id":1071,"logic_url":["https:\\/\\/game-us62.totalbattle.com\\/rubens-realm1071","https:\\/\\/game-us62-fallback.totalbattle.com\\/rubens-realm1071"],"json_rpc_url":[]}';
    const { suid, realmUrls } = parseSitePage(html);
    expect(suid).toBe('tb:117471041');
    expect(realmUrls.get(1071)).toEqual([
      'https://game-us62.totalbattle.com/rubens-realm1071',
      'https://game-us62-fallback.totalbattle.com/rubens-realm1071',
    ]);
  });

  it('lays the login human data out in the client order: 12 fields, two blanks, the rest', () => {
    const device = { deviceId: 'fpc' + '0'.repeat(32), fingerprintId: '123456789', firstWebVisitTs: 1794566702, firstWebVisitRnd: '1794566702840' };
    const arr = loginHumanArray({ ip: '10.0.0.1', continent_code: 'EU', country_code: 'NO', lang: 'en', email: 'a@b.c' }, device);
    expect(arr).toHaveLength(30);
    expect(arr.slice(0, 14)).toEqual(['', '', 'site2', '10.0.0.1', 'EU', 'NO', '', '0', '', '', 'en', 'a@b.c', '', '']);
    expect(arr[19]).toBe('123456789');
    expect(arr[25]).toBe(device.deviceId);
    expect(arr[29]).toBe('unity');

    const body = buildLoginBody(
      { sig: 'f'.repeat(64), newToken: null, realmId: 1071, playerId: 1, accountId: 84522508, accountCreatedAt: 1766741935, humanData: {} },
      'tb:117471041', device, '349.9.1116',
    );
    const login = body[0] as Wire[];
    expect(login[0]).toEqual(['tb:117471041']);
    expect(login[2]).toBe('f'.repeat(64));
    expect(login[11]).toEqual([84522508, 1766741935]);
    expect(login[13]).toEqual(['webgl', '349.9.1116']);
  });
});
