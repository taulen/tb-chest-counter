import { describe, expect, it } from 'vitest';
import type { Frame, Wire } from '../../src/game-protocol/codec.js';
import { GIFT_LIFETIME_S, parseCityTechs, parseClanRecord, parseLedger, parsePlayers } from '../../src/game-protocol/messages.js';
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

  it('reads player records (402), including the Gold Pass flag', () => {
    const p: Wire = [
      [4599909974644], 'tb:117395457', 'baron SP K260 sk', '', 2, 10000096, 10000095, 116, 30, 12, 29724600,
      [4599909974038], 2168077, 'SIN', 0, [1071, 549, 527], [4599917580129], 3126, 63730, [], [[160, 15]], '', [1],
    ];
    const [r] = parsePlayers(frame(402, [[[[p]]]]));
    expect(r).toEqual({
      playerId: 4599909974644, name: 'baron SP K260 sk', heroAvatar: 2, heroLevel: 116, cityLevel: 30, vip: 12,
      might: 29724600, clanId: 4599909974038, clanTag: 'SIN', cityId: 4599917580129, goldPass: true,
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

  it('finds the tech map (research + talents) in city details (601)', () => {
    const techs = { 1197: [1197, 1], 1215: [1215, 1], 1233: [1233, 8], 29006: [29006, 20] };
    expect(parseCityTechs(frame(601, [[[[[1], {}, [], techs]]]]))).toEqual({ 1197: 1, 1215: 1, 1233: 8, 29006: 20 });
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
      { sig: 'f'.repeat(64), realmId: 1071, playerId: 1, accountId: 84522508, accountCreatedAt: 1766741935, humanData: {} },
      'tb:117471041', device, '349.9.1116',
    );
    const login = body[0] as Wire[];
    expect(login[0]).toEqual(['tb:117471041']);
    expect(login[2]).toBe('f'.repeat(64));
    expect(login[11]).toEqual([84522508, 1766741935]);
    expect(login[13]).toEqual(['webgl', '349.9.1116']);
  });
});
