/**
 * Structured chat content (chat-text.ts): placeholders + the data payload the
 * game sends with a shared location, a raid, a clan join… and the sender's
 * metadata. Payload shapes are hand-written from the documented format.
 */
import { describe, expect, it } from 'vitest';
import {
  chatSearchText, chatSenderPlayerId, chatSenderRank, chatSenderTag, chatSubCoords, parseChatSubs,
} from '../../src/game-protocol/chat-text.js';

const coord = JSON.stringify({ subs: { '/%0%/': { type: 'coord', entryType: 'user', x: 808, y: 40, realmId: 260, staticId: 4, name: 'Kajim', v: 1 } } });
const kicked = JSON.stringify({ subs: { '/%0%/': { type: 'clan', entryType: 'kicked', kicker: 'taulen302', name: 'berelyan', v: 1 } } });
const sabotage = JSON.stringify({ subs: { '/%0%/': {
  type: 'spawn_sabotage_spawn_to_enemy', atomCoord: { realmId: 149, x: 504, y: 630 }, spawnerName: 'Nimath',
  staticAtomId: 185065, targetClanInitials: 'UCT', targetClanName: 'United Cities', v: 1,
} } });

describe('chat text', () => {
  it('reads the placeholder payload, and nothing from text that is not one', () => {
    expect(parseChatSubs(coord)['/%0%/']).toMatchObject({ type: 'coord', name: 'Kajim', x: 808 });
    expect(parseChatSubs('')).toEqual({});
    expect(parseChatSubs('{}')).toEqual({});
    expect(parseChatSubs('not json')).toEqual({});
    expect(parseChatSubs('{"subs": [1, 2]}')).toEqual({});
  });

  it('gives coordinates the way the game writes them, also from atomCoord', () => {
    expect(chatSubCoords(parseChatSubs(coord)['/%0%/'])).toBe('K:260 X:808 Y:40');
    expect(chatSubCoords(parseChatSubs(sabotage)['/%0%/'])).toBe('K:149 X:504 Y:630');
    expect(chatSubCoords({ type: 'clan' })).toBe('');
  });

  it('indexes the names and coordinates behind each placeholder, never the placeholder itself', () => {
    expect(chatSearchText('/%0%/', coord)).toBe('Kajim K:260 X:808 Y:40');
    expect(chatSearchText('meet at /%0%/ now', coord)).toBe('meet at Kajim K:260 X:808 Y:40 now');
    expect(chatSearchText('/%0%/', kicked)).toBe('berelyan taulen302');
    expect(chatSearchText('/%0%/', sabotage)).toBe('Nimath United Cities UCT K:149 X:504 Y:630');
    // A placeholder with no payload leaves nothing behind.
    expect(chatSearchText('look /%1%/', '')).toBe('look');
    expect(chatSearchText('Привет всем', '')).toBe('Привет всем');
  });

  it('reads the sender\'s player id, rank and tag from their metadata', () => {
    const info = '104,12e00047d5d,12e00000202,0,4,CWB';
    expect(chatSenderPlayerId(info)).toBe(0x12e00047d5d);
    expect(chatSenderRank(info)).toBe(4);
    expect(chatSenderTag(info)).toBe('CWB');
    expect(chatSenderPlayerId('')).toBeNull();
    expect(chatSenderRank('104,12e00047d5d,12e00000202,0,9,CWB')).toBeNull();
  });
});
