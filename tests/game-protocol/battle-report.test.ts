/**
 * Battle reports from the journal service (docs/battle-reports.md): the
 * request/reply framing, the `0xc7` wrapper the journal writes, the report
 * layout (both armies, the target, the strike log), the Tin Man's level and
 * stacks, and the journal token in the login reply. The shapes mirror the
 * reports recorded on Nov 27 2026; ids and names here are made up.
 */
import { describe, expect, it } from 'vitest';
import { WireReader, decodeJournalValues, encodeValues, type Wire } from '../../src/game-protocol/codec.js';
import { decodeJournalReply, encodeJournalRequest, journalUrl } from '../../src/game-protocol/journal.js';
import { findJournalToken, journalTokenExpiry } from '../../src/game-protocol/journal-token.js';
import {
  parseAnnouncement, parseBattleReport, parseStrikeLog, playerIdOf, tinmanLevel, tinmanStacks,
} from '../../src/game-protocol/battle-report.js';
import { chatReportLinks } from '../../src/game-protocol/chat-text.js';

const bin = (b: Buffer) => ({ $bin: b.length, hex: b.toString('hex') });
const STRIKE_LOG = '11111111-2222-4333-8444-555555555555';
// realm 300, number 0x12345: the side's short form keeps only 0x345.
const PLAYER = playerIdOf(300, 0x12345);
const MONSTERS = playerIdOf(260, 1);

/** A march record with the owner and the units at index 30, as the game lays it out (36 fields). */
function march(armyId: number, owner: number, units: Array<[number, number]>): Wire[] {
  const m: Wire[] = new Array(36).fill(0);
  m[0] = [armyId];
  // [[player], [city], 1, set out at 1794084684, …]
  m[1] = [[owner], [0], 1, 1794084684];
  // Effects [id, sourceBits, count] and timed boosts [id, 0, from, to]: one running, one over.
  m[14] = [[31, 2, 1], [2070, 512, 108]];
  m[16] = [[4020, 0, 1769730123, 1814161323], [7802, 0, 1794000000, 1794080000]];
  m[30] = units.map(([u, c]) => [u, c, 0]);
  return m;
}

/** A report's bytes: the strike log id goes in the journal's `c7 01` wrapper, like the game writes it. */
function reportBytes(o: { target: number; won: boolean; attacker: Array<[number, number]>; defender: Array<[number, number]>; killed: Record<number, number> }): Buffer {
  const b: Wire[] = new Array(17).fill([]);
  b[0] = 'battle';
  b[1] = o.won ? 'true' : 'false';
  b[2] = 6;
  b[3] = 1; b[4] = 2; b[5] = 3; b[6] = 4;
  b[7] = [[[300, 0x345], march(1001, PLAYER, o.attacker), [{}, {}, 1]]];
  b[8] = [[[260, 1], march(2002, MONSTERS, o.defender), [{}, o.killed, 1]]];
  b[9] = '@@WRAP@@';
  b[14] = o.target;
  const plain = encodeValues([b]);
  const marker = encodeValues(['@@WRAP@@']);
  const at = plain.indexOf(marker);
  return Buffer.concat([plain.subarray(0, at), Buffer.from([0xc7, 0x01]), encodeValues([STRIKE_LOG]), plain.subarray(at + marker.length)]);
}

describe('journal codec', () => {
  it('reads `c7 01` as a wrapper around one value only when asked to (game-server replies are untouched)', () => {
    const bytes = Buffer.concat([Buffer.from([0x92, 0xc7, 0x01]), encodeValues([STRIKE_LOG]), encodeValues([7])]);
    expect(decodeJournalValues(bytes)).toEqual([[STRIKE_LOG, 7]]);
    // Read as a MessagePack ext, the wrapper swallows the string's header.
    expect(new WireReader(bytes).value()).not.toEqual([STRIKE_LOG, 7]);
  });

  it('frames a request the way the game client does: the head bin holds [method, seq] then 0', () => {
    const req = encodeJournalRequest(1129936016, 141, ['aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee']);
    const [head, args] = decodeJournalValues(req);
    expect(args).toEqual(['aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee']);
    const inner = (head as Array<Record<string, { hex: string }>>)[0]['2002062134'];
    expect(decodeJournalValues(Buffer.from(inner.hex, 'hex'))).toEqual([[1129936016, 141], 0]);
  });

  it('reads a reply: seq, status and the body', () => {
    const reply = encodeValues([[{ 733765024: bin(encodeValues([[141, 0, '']])) }], [1795381332, 'battle', [bin(Buffer.from([0x90]))]]]);
    const r = decodeJournalReply(reply);
    expect(r).toMatchObject({ seq: 141, status: 0, error: '' });
    expect((r!.body as Wire[])[1]).toBe('battle');
    // Anything that isn't a reply (a push) is not taken for one.
    expect(decodeJournalReply(encodeValues([[{ 5: 1 }], []]))).toBeNull();
  });
});

describe('battle reports', () => {
  const tinman = reportBytes({
    target: 6054, won: false,
    attacker: [[206, 475], [214, 475]],
    defender: [[7540, 756821], [7541, 73403909], [7542, 855499], [7543, 929430]],
    killed: { 7540: 38399, 7541: 6987638, 7542: 25715, 7543: 94625 },
  });

  it('reads both armies as they stood, the target and the strike log id', () => {
    const r = parseBattleReport(tinman)!;
    expect(r).toMatchObject({ kind: 'battle', won: false, rounds: 6, targetStaticId: 6054, strikeLogId: STRIKE_LOG });
    expect(r.attackers[0]).toMatchObject({ armyId: 1001, units: [{ unit: 206, count: 475 }, { unit: 214, count: 475 }] });
    expect(r.defenders[0].units).toHaveLength(4);
    expect(r.defenders[0].killed[7541]).toBe(6987638);
  });

  it('reads the march’s effects, counted, and the boosts running when it set out', () => {
    expect(parseBattleReport(tinman)!.attackers[0].effects).toEqual([{ id: 31, count: 1 }, { id: 2070, count: 108 }, { id: 4020, count: 1 }]);
  });

  it('takes the player from the march owner, never the short [realm, n] (it keeps only 12 bits)', () => {
    const r = parseBattleReport(tinman)!;
    expect(r.attackers[0].playerId).toBe(PLAYER);
    expect(playerIdOf(300, 0x345)).not.toBe(PLAYER);
  });

  it('counts the Tin Man’s stacks at the hit and its level from the map object', () => {
    expect(tinmanStacks(parseBattleReport(tinman)!)).toBe(4);
    const late = reportBytes({ target: 6130, won: false, attacker: [[206, 1]], defender: [[7540, 2414724], [7542, 4752276]], killed: {} });
    expect(tinmanStacks(parseBattleReport(late)!)).toBe(2);
    expect(tinmanLevel(6054)).toBe(55);
    expect(tinmanLevel(6000)).toBe(1);
    expect(tinmanLevel(7249)).toBe(250);
    expect(tinmanLevel(8000)).toBe(1);
    expect(tinmanLevel(6250)).toBeNull();
    expect(tinmanLevel(1817)).toBeNull();
  });

  it('is no Tin Man hit when the target is something else (a citadel)', () => {
    const citadel = reportBytes({ target: 1817, won: true, attacker: [[87, 789]], defender: [[51, 135000], [6035, 2300]], killed: { 51: 135000 } });
    expect(tinmanStacks(parseBattleReport(citadel)!)).toBeNull();
  });

  it('reads the strike log row by row', () => {
    const rows = [
      ['true', [1001], 87, 789, 4_050_000_000, 3_895_575_072, 0, 0, [2002], 51, 135000, 4_050_000_000, 0, 0, 0, 0, 0, 0],
      ['false', [2002], 6035, 2300, 552_000_000, 0, 0, 0, [1001], 206, 601, 4_454_295_273, 527, 3_902_295_273, 0, 0, 0, 0],
    ];
    const strikes = parseStrikeLog(encodeValues([rows]));
    expect(strikes).toHaveLength(2);
    expect(strikes[1]).toMatchObject({
      byAttacker: false, unit: 6035, count: 2300, damage: 552_000_000, targetUnit: 206, targetCount: 601,
      poolBefore: 4_454_295_273, countAfter: 527, poolAfter: 3_902_295_273,
    });
  });

  it('is null for something that is not a battle, and reads an announcement’s text', () => {
    expect(parseBattleReport(encodeValues([['sklep', '', 0]]))).toBeNull();
    const a = encodeValues([['clan_announcement', [302, 154], 'VAULTS AFTER RESET']]);
    expect(parseAnnouncement(a)).toEqual({ text: 'VAULTS AFTER RESET' });
    expect(parseAnnouncement(tinman)).toBeNull();
  });
});

describe('the journal token and chat links', () => {
  const jwt = (payload: object) => `eyJ0eXAiOiJKV1QifQ%3D%3D.${encodeURIComponent(Buffer.from(JSON.stringify(payload)).toString('base64'))}.c2ln`;

  it('finds the token in the login reply by its "Journal" audience', () => {
    const token = jwt({ aud: 'Journal', exp: 1798933937, name: '1', role: 'Player' });
    expect(findJournalToken([[1], 0, 'eyJhbGciOiJIUzI1NiJ9.e30.x', jwt({ aud: 'Other' }), token])).toBe(token);
    expect(findJournalToken([[1], 0])).toBeNull();
    expect(journalTokenExpiry(token)).toBe(1798933937);
  });

  it('puts a token the game already URL-encoded into the address as it is', () => {
    expect(journalUrl('ab%3D.cd')).toBe('wss://journal-feed-kafka.totalbattle.com//?token=ab%3D.cd');
    expect(journalUrl('a+b=')).toBe('wss://journal-feed-kafka.totalbattle.com//?token=a%2Bb%3D');
  });

  it('reads report links out of a chat message', () => {
    const data = JSON.stringify({ subs: {
      '/%0%/': { type: 'journal', entryType: 'attack', guid: [300, 0x345], staticId: 6054, name: 'Epic Ancient squad', v: 1,
        journalV2EntryId: 'BCE49D54-B9D9-4429-B272-A8F3C166CC7A', source: 'unity_v2' },
      '/%1%/': { type: 'coord', x: 1, y: 2 },
    } });
    expect(chatReportLinks(data)).toEqual([{ entryId: 'bce49d54-b9d9-4429-b272-a8f3c166cc7a', entryType: 'attack', staticId: 6054, name: 'Epic Ancient squad' }]);
    expect(chatReportLinks('')).toEqual([]);
    expect(chatReportLinks('{not json')).toEqual([]);
  });
});
