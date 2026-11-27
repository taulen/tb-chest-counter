/**
 * Vault links members post in the clan's vault chat (v144, data/vault-posts.ts),
 * matched to the Vaults of the Ancients the map pass saw. The shapes are CWB's
 * from Nov 21–22 2026 (one tile held three vaults in a day); ids are made up.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/data/database.js';
import { saveChatMessages } from '../../src/data/repositories/chat-repo.js';
import { getReportChats, setReportChats, vaultChats } from '../../src/data/repositories/battle-report-repo.js';
import { isVaultType, listVaultPosts, matchVault, vaultLevel } from '../../src/data/vault-posts.js';
import type { RaisedVault } from '../../src/data/repositories/game-protocol-repo.js';
import type { ChatMessage } from '../../src/game-protocol/chat.js';
import { makeTestDb, seedTwoClans } from '../helpers/test-db.js';

let cleanup: () => void;
beforeEach(() => { ({ cleanup } = makeTestDb()); seedTwoClans(); });
afterEach(() => cleanup());

const VAULT_CHAT = 'sendbird_group_channel_9_vaults';
const ME = 1241245577338;
const OTHER = 1297080313077;
const ms = (iso: string) => Date.parse(iso);

function vault(objectId: number, objectType: number, owner: number, firstSeen: string, lastSeen = firstSeen, x = 790, y = 162): RaisedVault {
  return {
    objectId, objectType, level: objectType % 100, realm: 260, x, y, ownerId: owner, memberId: null, ownerName: null, inClan: true,
    firstSeen, lastSeen,
  };
}

// 790:162 in a day: a level 39, then the poster's level 44, then another 39.
const TILE = [
  vault(1, 150239, OTHER, '2026-11-21T18:14:00.000Z'),
  vault(2, 150244, ME, '2026-11-21T19:31:00.000Z'),
  vault(3, 150239, 4428111283115, '2026-11-22T09:44:00.000Z', '2026-11-22T14:07:00.000Z'),
];

describe('matching a vault link to the map', () => {
  const link = { realm: 260, x: 790, y: 162, playerId: ME };

  it('matches the same tile, the same level, at a time that fits', () => {
    expect(matchVault({ ...link, objectType: 150244, atMs: ms('2026-11-21T19:26:18.000Z') }, TILE)?.objectId).toBe(2);
    // The level 39 the next morning is the third vault, not the first.
    expect(matchVault({ ...link, playerId: null, objectType: 150239, atMs: ms('2026-11-22T10:00:00.000Z') }, TILE)?.objectId).toBe(3);
  });

  it('prefers the poster’s own vault, and finds nothing at another tile, level or day', () => {
    const twin = [vault(7, 150239, OTHER, '2026-11-21T18:14:00.000Z'), vault(8, 150239, ME, '2026-11-21T20:00:00.000Z')];
    expect(matchVault({ ...link, objectType: 150239, atMs: ms('2026-11-21T18:15:00.000Z') }, twin)?.objectId).toBe(8);
    expect(matchVault({ ...link, x: 791, objectType: 150244, atMs: ms('2026-11-21T19:26:00.000Z') }, TILE)).toBeNull();
    expect(matchVault({ ...link, objectType: 150245, atMs: ms('2026-11-21T19:26:00.000Z') }, TILE)).toBeNull();
    expect(matchVault({ ...link, objectType: 150244, atMs: ms('2026-11-25T19:26:00.000Z') }, TILE)).toBeNull();
  });

  it('reads a vault’s level from its type', () => {
    expect(vaultLevel(150244)).toBe(44);
    expect(vaultLevel(150314)).toBe(14);
    expect(isVaultType(150244)).toBe(true);
    expect(isVaultType(6054)).toBe(false);
  });
});

describe('vault links in the vault chat', () => {
  const coord = (x: number, y: number, staticId: number) => JSON.stringify({ subs: { '/%0%/': {
    type: 'coord', entryType: 'poi', x, y, realmId: 260, staticId, name: 'Vault of the Ancients', v: 1,
  } } });
  function msg(id: number, channelUrl: string, at: string, data: string, sender = ME): ChatMessage {
    return {
      messageId: id, channelUrl, createdAt: ms(at), customType: 'user', senderId: 'tb:1', senderName: 'taulen',
      senderInfo: `104,${sender.toString(16)},41d0000001b,0,2,CWB`, message: '/%0%/', data, updatedAt: 0, translations: '',
    };
  }

  beforeEach(() => {
    getDb().prepare(
      "INSERT INTO members (clan_id, name, normalized_name, first_seen, last_seen, is_active, game_player_id) VALUES (1, 'taulen', 'taulen', '2026-11-01', '2026-11-27', 1, ?)",
    ).run(ME);
    saveChatMessages(1, [
      msg(1, VAULT_CHAT, '2026-11-21T19:26:18.000Z', coord(790, 162, 150244)),
      msg(2, VAULT_CHAT, '2026-11-21T20:00:00.000Z', coord(500, 500, 150245)),
      msg(3, 'triumph_clan_channel_1', '2026-11-21T19:27:00.000Z', coord(790, 162, 150244)),
      msg(4, VAULT_CHAT, '2026-11-21T20:05:00.000Z', 'no link here'),
      msg(5, VAULT_CHAT, '2026-11-10T20:00:00.000Z', coord(790, 162, 150244)),
    ]);
  });

  it('is nothing until a chat is picked for vaults', () => {
    setReportChats(1, [{ url: VAULT_CHAT, name: '-CWB VAULTS-', purpose: 'reports' }]);
    expect(listVaultPosts(1, null, null, TILE)).toEqual([]);
  });

  it('lists the window’s links from the vault chat only, matched to the map or not', () => {
    setReportChats(1, [{ url: VAULT_CHAT, name: '-CWB VAULTS-', purpose: 'vaults' }]);
    const posts = listVaultPosts(1, '2026-11-21T17:00:00.000Z', '2026-11-22T17:00:00.000Z', TILE);
    expect(posts.map((p) => [p.messageId, p.level, p.objectId])).toEqual([[1, 44, 2], [2, 45, null]]);
    expect(posts[0]).toMatchObject({ chatName: '-CWB VAULTS-', name: 'taulen', x: 790, y: 162, realm: 260 });
    expect(posts[0].memberId).not.toBeNull();
    expect(listVaultPosts(2, null, null, TILE)).toEqual([]);
  });

  it('keeps what each picked chat is read for', () => {
    setReportChats(1, [{ url: VAULT_CHAT, name: '-CWB VAULTS-', purpose: 'vaults' }, { url: 'sendbird_group_channel_8', name: 'Hits' }]);
    expect(getReportChats(1).map((c) => [c.name, c.purpose])).toEqual([['-CWB VAULTS-', 'vaults'], ['Hits', 'reports']]);
    expect(vaultChats(1).map((c) => c.name)).toEqual(['-CWB VAULTS-']);
  });
});
