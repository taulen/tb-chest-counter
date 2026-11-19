/**
 * Accounts from the game (v127, docs/account-invites.md): codes, joining with
 * one, and the account's role following the player's in-game rank — in BOTH
 * directions, every scan, home clan and extra clans each on their own, with
 * the very next request seeing it (validateSession re-reads the role).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/data/database.js';
import {
  CODE_TTL_MS,
  accountForPlayer,
  formatCode,
  generateCode,
  hashCode,
  isAccountBlocked,
  linkFor,
  planJoin,
  linkedPlayerIds,
  linksInClan,
  mainLink,
  memberIdsByPlayer,
  playerKey,
  setMainPlayer,
  lookupCode,
  normalizeCode,
  rankRole,
  recordInviteRequest,
  redeemJoin,
  reserveInviteSend,
  syncLinkedAccounts,
  unlinkGameAccount,
  JoinError,
  CODE_ALPHABET,
} from '../../src/data/repositories/account-invite-repo.js';
import * as userRepo from '../../src/data/repositories/user-repo.js';
import { makeTestDb, seedTwoClans } from '../helpers/test-db.js';

let cleanup: () => void;
beforeEach(() => {
  ({ cleanup } = makeTestDb());
  seedTwoClans();
});
afterEach(() => cleanup());

const NOW = Date.parse('2026-11-18T12:00:00.000Z');
const PW = 'Test1234!aA-x';

function gamePlayer(clanId: number, playerId: number, name: string, role: number, inClan = 1): void {
  getDb().prepare(
    `INSERT INTO game_players (clan_id, player_id, name, role, joined_at, in_clan, first_seen, last_seen)
     VALUES (?, ?, ?, ?, 1790000000, ?, '2026-11-01', '2026-11-18')
     ON CONFLICT (clan_id, player_id) DO UPDATE SET role = excluded.role, in_clan = excluded.in_clan, name = excluded.name`,
  ).run(clanId, playerId, name, role, inClan);
}

let msgId = 1;
/** A code the way the chat flow issues one: a recorded request, reserved. */
function issueCode(clanId: number, playerId: number, chatUserId = `tb:${playerId}`, nowMs = NOW): string {
  const id = msgId++;
  recordInviteRequest({ clanId, channelUrl: `ch-${id}`, messageId: id, senderChatId: chatUserId, playerId, requestedAt: nowMs }, 'pending', null);
  const reqId = (getDb().prepare('SELECT id FROM chat_invite_requests WHERE message_id = ?').get(id) as { id: number }).id;
  const r = reserveInviteSend(reqId, nowMs);
  if (!r) throw new Error('not reserved');
  return r.code;
}

/** A roster of at least five (the floor below which nothing changes access), with these ranks. */
function roster(ranks: Record<number, number>): Array<{ playerId: number; role: number; name: string }> {
  const out = Object.entries(ranks).map(([id, role]) => ({ playerId: Number(id), role, name: `P${id}` }));
  for (let i = 900; out.length < 5; i++) out.push({ playerId: i, role: 5, name: `Filler${i}` });
  return out;
}

const session = (userId: number) => userRepo.validateSession(userRepo.createSession(userId));

describe('codes', () => {
  it('are 8 characters from the unambiguous alphabet, stored only as sha256', () => {
    for (let i = 0; i < 50; i++) {
      const c = generateCode();
      expect(c).toMatch(new RegExp(`^[${CODE_ALPHABET}]{8}$`));
      expect(c).not.toMatch(/[01OIL]/);
    }
    gamePlayer(1, 11, 'Alpha', 4);
    const code = issueCode(1, 11);
    const rows = getDb().prepare('SELECT * FROM account_invite_codes').all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(code);
    expect(rows[0].code_hash).toBe(hashCode(code));
  });

  it('accept any case and separators, and are told apart from nothing (no oracle)', () => {
    gamePlayer(1, 11, 'Alpha', 4);
    const code = issueCode(1, 11);
    expect(normalizeCode(formatCode(code).toLowerCase())).toBe(code);
    expect(lookupCode(` ${formatCode(code).toLowerCase()} `, NOW)?.playerId).toBe(11);
    expect(lookupCode('ABCD-EFGH', NOW)).toBeNull();
  });

  it('expire after 72 hours, and need the player still on the roster', () => {
    gamePlayer(1, 11, 'Alpha', 4);
    const code = issueCode(1, 11);
    expect(lookupCode(code, NOW + CODE_TTL_MS - 1000)).not.toBeNull();
    expect(lookupCode(code, NOW + CODE_TTL_MS + 1000)).toBeNull();
    gamePlayer(1, 11, 'Alpha', 4, 0);
    expect(lookupCode(code, NOW)).toBeNull();
  });

  it('a clan’s code never grants another clan', () => {
    gamePlayer(1, 11, 'Alpha', 1);
    gamePlayer(2, 11, 'Alpha', 1);
    const code = issueCode(1, 11);
    const r = redeemJoin(code, null, { username: 'alpha', password: PW }, NOW);
    expect(r.clanId).toBe(1);
    expect(userRepo.getUserById(r.user.id)).toMatchObject({ clanId: 1, role: 'admin' });
    expect(userRepo.listClanAccess(r.user.id)).toEqual([]);
    expect(linkFor(r.user.id, 2)).toBeNull();
  });
});

describe('joining with a code', () => {
  it('new: creates an account linked to the player, admin for a Leader/Superior, user otherwise; single use', () => {
    gamePlayer(1, 21, 'Lead', 1);
    gamePlayer(1, 22, 'Sup', 2);
    gamePlayer(1, 23, 'Off', 3);
    const lead = redeemJoin(issueCode(1, 21), null, { username: 'lead', password: PW }, NOW);
    const sup = redeemJoin(issueCode(1, 22), null, { username: 'sup', password: PW }, NOW);
    const offCode = issueCode(1, 23);
    const off = redeemJoin(offCode, null, { username: 'off', password: PW }, NOW);
    expect([lead.user.role, sup.user.role, off.user.role]).toEqual(['admin', 'admin', 'user']);
    expect(linkFor(off.user.id, 1)).toMatchObject({ playerId: 23, chatUserId: 'tb:23', onRoster: true });
    expect(userRepo.authenticate('off', PW)?.id).toBe(off.user.id);
    expect(() => redeemJoin(offCode, null, { username: 'again', password: PW }, NOW)).toThrow(JoinError);
  });

  it('recover: signed out, the player already has an account → new password, every old session ends', () => {
    gamePlayer(1, 31, 'Rec', 4);
    const first = redeemJoin(issueCode(1, 31), null, { username: 'rec', password: PW }, NOW);
    const oldToken = userRepo.createSession(first.user.id);
    const r = redeemJoin(issueCode(1, 31, 'tb:31', NOW + 20 * 60_000), null, { password: 'Another1!pass' }, NOW + 20 * 60_000);
    expect(r).toMatchObject({ mode: 'recover', user: { id: first.user.id, username: 'rec' } });
    expect(userRepo.authenticate('rec', 'Another1!pass')).not.toBeNull();
    expect(userRepo.authenticate('rec', PW)).toBeNull();
    expect(userRepo.validateSession(oldToken)).toBeNull();
  });

  it('link: an old password account links itself, and its role then follows the rank', () => {
    const old = userRepo.createUser('oldadmin', PW, 'admin', undefined, 1);
    gamePlayer(1, 41, 'Old', 4);
    const r = redeemJoin(issueCode(1, 41), userRepo.getUserById(old.id), {}, NOW);
    expect(r.mode).toBe('link');
    expect(userRepo.getUserById(old.id)?.role).toBe('user');
    expect(accountForPlayer(41)).toBe(old.id);
  });

  it('add-clan: a signed-in account adds the code’s clan with the role there', () => {
    gamePlayer(1, 51, 'Home', 4);
    const home = redeemJoin(issueCode(1, 51), null, { username: 'multi', password: PW }, NOW);
    gamePlayer(2, 52, 'Alt', 2);
    const r = redeemJoin(issueCode(2, 52), home.user, {}, NOW);
    expect(r.mode).toBe('add-clan');
    expect(userRepo.getClanAccessRole(home.user.id, 2)).toBe('admin');
    expect(userRepo.getUserById(home.user.id)).toMatchObject({ clanId: 1, role: 'user' });
  });

  it('refuses a player linked to another account, even for the superadmin', () => {
    gamePlayer(1, 61, 'Taken', 4);
    gamePlayer(1, 62, 'Other', 4);
    redeemJoin(issueCode(1, 61), null, { username: 'owner', password: PW }, NOW);
    const other = userRepo.createUser('other', PW, 'user', undefined, 1);
    expect(() => redeemJoin(issueCode(1, 61, 'tb:61', NOW + 11 * 60_000), userRepo.getUserById(other.id), {}, NOW + 11 * 60_000)).toThrow('conflict');
    const su = userRepo.createUser('su', PW, 'superadmin');
    expect(() => redeemJoin(issueCode(1, 61, 'tb:61', NOW + 22 * 60_000), su, {}, NOW + 22 * 60_000)).toThrow('conflict');
  });
});

describe('roles follow the in-game rank, both directions, every scan', () => {
  function linkedAccount(clanId: number, playerId: number, rank: number, username: string): number {
    gamePlayer(clanId, playerId, `P${playerId}`, rank);
    return redeemJoin(issueCode(clanId, playerId), null, { username, password: PW }, NOW).user.id;
  }
  const audits = (action: string) => (getDb().prepare('SELECT details FROM audit_log WHERE action = ? ORDER BY id').all(action) as Array<{ details: string }>)
    .map((r) => JSON.parse(r.details) as Record<string, unknown>);

  it('rankRole: Leader and Superior are admin, everyone else user', () => {
    expect([1, 2, 3, 4, 5, null].map(rankRole)).toEqual(['admin', 'admin', 'user', 'user', 'user', 'user']);
  });

  it('a Soldier/Veteran/Officer promoted to Superior or Leader becomes admin; the next request sees it', () => {
    const id = linkedAccount(1, 101, 5, 'riser');
    const token = userRepo.createSession(id);
    expect(userRepo.validateSession(token)?.user.role).toBe('user');
    syncLinkedAccounts(1, roster({ 101: 2 }));
    expect(userRepo.validateSession(token)?.user.role).toBe('admin');
    syncLinkedAccounts(1, roster({ 101: 1 }));
    expect(userRepo.validateSession(token)?.user.role).toBe('admin');
    const a = audits('account.role_from_game');
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ from: 'user', to: 'admin', fromRank: 5, toRank: 2, source: 'game' });
  });

  it('a Superior or Leader demoted below Superior loses admin on the very next request', () => {
    const id = linkedAccount(1, 102, 2, 'faller');
    const token = userRepo.createSession(id);
    expect(userRepo.validateSession(token)?.user.role).toBe('admin');
    syncLinkedAccounts(1, roster({ 102: 3 }));
    expect(userRepo.validateSession(token)?.user.role).toBe('user');
    expect(audits('account.role_from_game')[0]).toMatchObject({ from: 'admin', to: 'user', fromRank: 2, toRank: 3, source: 'game' });
  });

  it('a leadership transfer: the new Leader gains admin; the old one keeps it at Superior, loses it lower', () => {
    const oldLead = linkedAccount(1, 111, 1, 'oldlead');
    const newLead = linkedAccount(1, 112, 4, 'newlead');
    syncLinkedAccounts(1, roster({ 111: 2, 112: 1 }));
    expect(userRepo.getUserById(newLead)?.role).toBe('admin');
    expect(userRepo.getUserById(oldLead)?.role).toBe('admin');
    syncLinkedAccounts(1, roster({ 111: 4, 112: 1 }));
    expect(userRepo.getUserById(oldLead)?.role).toBe('user');
  });

  it('home clan and extra clans each follow their own rank', () => {
    const id = linkedAccount(1, 121, 5, 'twoclans');
    gamePlayer(2, 122, 'Alt', 1);
    redeemJoin(issueCode(2, 122), userRepo.getUserById(id), {}, NOW);
    expect(userRepo.getUserById(id)?.role).toBe('user');
    expect(userRepo.getClanAccessRole(id, 2)).toBe('admin');

    // Promoted at home, demoted in the other clan.
    syncLinkedAccounts(1, roster({ 121: 1 }));
    syncLinkedAccounts(2, roster({ 122: 5 }));
    expect(userRepo.getUserById(id)?.role).toBe('admin');
    expect(userRepo.getClanAccessRole(id, 2)).toBe('user');

    // Viewing clan 2, the session carries clan 2's role — re-read every request.
    const token = userRepo.createSession(id);
    userRepo.setSessionActiveClan(token, 2);
    expect(userRepo.validateSession(token)?.user).toMatchObject({ clanId: 2, role: 'user' });
    syncLinkedAccounts(2, roster({ 122: 2 }));
    expect(userRepo.validateSession(token)?.user).toMatchObject({ clanId: 2, role: 'admin' });
  });

  it('leaving the clan in the game takes the clan away; rejoining gives it back', () => {
    const id = linkedAccount(1, 131, 4, 'leaver');
    gamePlayer(2, 132, 'Alt', 4);
    redeemJoin(issueCode(2, 132), userRepo.getUserById(id), {}, NOW);

    // Gone from the extra clan: the grant goes.
    syncLinkedAccounts(2, roster({}));
    expect(userRepo.getClanAccessRole(id, 2)).toBeNull();
    // Back: it returns, with the rank's role.
    syncLinkedAccounts(2, roster({ 132: 2 }));
    expect(userRepo.getClanAccessRole(id, 2)).toBe('admin');

    // Gone from the home clan with another clan still theirs: home moves there.
    syncLinkedAccounts(1, roster({}));
    expect(userRepo.getUserById(id)).toMatchObject({ clanId: 2, role: 'admin' });
    expect(isAccountBlocked(id)).toBe(false);
  });

  it('gone from its only clan: the account is paused (no session works) until the player is back', () => {
    const id = linkedAccount(1, 141, 4, 'paused');
    const token = userRepo.createSession(id);
    syncLinkedAccounts(1, roster({}));
    expect(isAccountBlocked(id)).toBe(true);
    expect(userRepo.validateSession(token)).toBeNull();
    syncLinkedAccounts(1, roster({ 141: 4 }));
    expect(isAccountBlocked(id)).toBe(false);
    expect(userRepo.validateSession(userRepo.createSession(id))?.user.clanId).toBe(1);
    expect(audits('account.left_in_game')).toHaveLength(1);
    expect(audits('account.rejoined_in_game')).toHaveLength(1);
  });

  it('a short roster (a partial read) changes nobody', () => {
    const id = linkedAccount(1, 151, 1, 'shortroster');
    syncLinkedAccounts(1, [{ playerId: 999, role: 5 }]);
    expect(userRepo.getUserById(id)?.role).toBe('admin');
    expect(linkFor(id, 1)?.onRoster).toBe(true);
  });

  it('never touches a superadmin or an unlinked old account', () => {
    const su = userRepo.createUser('su', PW, 'superadmin');
    const old = userRepo.createUser('oldie', PW, 'admin', undefined, 1);
    // A superadmin's link row is kept current; the account itself is not touched.
    getDb().prepare(
      "INSERT INTO user_game_links (user_id, clan_id, player_id, player_name, linked_at, synced_at) VALUES (?, 1, 161, 'X', 'x', 'x')",
    ).run(su.id);
    syncLinkedAccounts(1, roster({ 161: 5 }));
    expect(userRepo.getUserById(su.id)).toMatchObject({ role: 'superadmin', clanId: null });
    expect(userRepo.listClanAccess(su.id)).toEqual([]);
    expect(linkFor(su.id, 1)).toMatchObject({ playerId: 161, rank: 5, onRoster: true });
    expect(userRepo.getUserById(old.id)?.role).toBe('admin');
  });

  it('promoting an account to superadmin keeps its links (its role no longer follows them); unlinking keeps the access as a plain grant', () => {
    const id = linkedAccount(1, 171, 2, 'promoted');
    const other = linkedAccount(1, 172, 2, 'unlinked');
    userRepo.updateRole(id, 'superadmin');
    expect(linkFor(id, 1)?.playerId).toBe(171);
    syncLinkedAccounts(1, roster({ 171: 5, 172: 2 }));
    expect(userRepo.getUserById(id)).toMatchObject({ role: 'superadmin', clanId: null });
    expect(userRepo.listClanAccess(id)).toEqual([]);
    expect(unlinkGameAccount(other, 1)[0]?.playerId).toBe(172);
    syncLinkedAccounts(1, roster({ 172: 5 }));
    expect(userRepo.getUserById(other)?.role).toBe('admin');
  });
});

describe('the superadmin links its own players: the link and nothing else', () => {
  function superadmin() {
    return userRepo.createUser('boss', PW, 'superadmin');
  }

  it('a code checks as link-player and links the player — no grant, no home, no role change', () => {
    const su = superadmin();
    gamePlayer(1, 401, 'Boss Main', 5);
    const info = lookupCode(issueCode(1, 401), NOW)!;
    expect(planJoin(info, su)).toMatchObject({ mode: 'link-player', userId: su.id });
    const r = redeemJoin(issueCode(1, 401, 'tb:401', NOW + 11 * 60_000), su, {}, NOW + 11 * 60_000);
    expect(r.mode).toBe('link-player');
    expect(linkedPlayerIds(su.id, 1)).toEqual([401]);
    expect(userRepo.getUserById(su.id)).toMatchObject({ role: 'superadmin', clanId: null });
    expect(userRepo.listClanAccess(su.id)).toEqual([]);
    // A second player in the same clan (an alt) links the same way; the main stays the first.
    gamePlayer(1, 402, 'Boss Alt', 1);
    expect(redeemJoin(issueCode(1, 402, 'tb:402', NOW + 22 * 60_000), su, {}, NOW + 22 * 60_000).mode).toBe('link-player');
    expect(mainLink(su.id, 1)?.playerId).toBe(401);
    expect(userRepo.listClanAccess(su.id)).toEqual([]);
  });

  it('promotion, demotion, leaving and rejoining in the game keep the link current and never touch the account', () => {
    const su = superadmin();
    gamePlayer(1, 411, 'Boss', 5);
    redeemJoin(issueCode(1, 411), su, {}, NOW);
    const token = userRepo.createSession(su.id);
    const steps: Array<Record<number, number>> = [{ 411: 2 }, { 411: 1 }, { 411: 4 }, {}, { 411: 3 }];
    for (const ranks of steps) {
      syncLinkedAccounts(1, roster(ranks));
      expect(userRepo.getUserById(su.id)).toMatchObject({ role: 'superadmin', clanId: null });
      expect(userRepo.listClanAccess(su.id)).toEqual([]);
      expect(isAccountBlocked(su.id)).toBe(false);
      expect(userRepo.validateSession(token)?.user.role).toBe('superadmin');
    }
    expect(linkFor(su.id, 1)).toMatchObject({ rank: 3, onRoster: true });
    syncLinkedAccounts(1, roster({}));
    expect(linkFor(su.id, 1)?.onRoster).toBe(false);
  });

  it("a code for the superadmin's player never resets its password", () => {
    const su = superadmin();
    gamePlayer(1, 421, 'Boss', 4);
    redeemJoin(issueCode(1, 421), su, {}, NOW);
    const code = issueCode(1, 421, 'tb:421', NOW + 11 * 60_000);
    expect(planJoin(lookupCode(code, NOW + 11 * 60_000)!, null).mode).toBe('superadmin-recover');
    expect(() => redeemJoin(code, null, { password: 'Another1234!aA' }, NOW + 11 * 60_000)).toThrow('superadmin-recover');
    expect(userRepo.authenticate('boss', PW)).not.toBeNull();
  });
});

describe('alts: several players of one account in the same clan (v130)', () => {
  const audits = (action: string) => (getDb().prepare('SELECT details FROM audit_log WHERE action = ? ORDER BY id').all(action) as Array<{ details: string }>)
    .map((r) => JSON.parse(r.details) as Record<string, unknown>);
  function account(clanId: number, playerId: number, rank: number, username: string) {
    gamePlayer(clanId, playerId, `P${playerId}`, rank);
    return redeemJoin(issueCode(clanId, playerId), null, { username, password: PW }, NOW).user;
  }
  function addAlt(user: userRepo.User, clanId: number, playerId: number, rank: number) {
    gamePlayer(clanId, playerId, `P${playerId}`, rank);
    return redeemJoin(issueCode(clanId, playerId), userRepo.getUserById(user.id)!, {}, NOW);
  }

  it('a code for another player in a clan the account is in ADDS it; the first stays the main', () => {
    const u = account(1, 301, 5, 'alty');
    const r = addAlt(u, 1, 302, 4);
    expect(r.mode).toBe('add-player');
    expect(linksInClan(u.id, 1).map((l) => l.playerId)).toEqual([301, 302]);
    expect(mainLink(u.id, 1)?.playerId).toBe(301);
    expect(linkedPlayerIds(u.id, 1)).toEqual([301, 302]);
    expect(setMainPlayer(u.id, 1, 302)).toBe(true);
    expect(mainLink(u.id, 1)?.playerId).toBe(302);
    expect(setMainPlayer(u.id, 1, 999)).toBe(false);
  });

  it('a Superior alt makes the account admin; demoting the alt takes it away; promoting the main gives it back', () => {
    const u = account(1, 311, 5, 'boss');
    const token = userRepo.createSession(u.id);
    addAlt(u, 1, 312, 2);
    expect(userRepo.validateSession(token)?.user.role).toBe('admin');
    syncLinkedAccounts(1, roster({ 311: 5, 312: 3 }));
    expect(userRepo.validateSession(token)?.user.role).toBe('user');
    syncLinkedAccounts(1, roster({ 311: 1, 312: 3 }));
    expect(userRepo.validateSession(token)?.user.role).toBe('admin');
    const a = audits('account.role_from_game');
    expect(a.at(-1)).toMatchObject({ from: 'user', to: 'admin', playerId: 311, toRank: 1, source: 'game' });
  });

  it('one alt leaving keeps the clan; the last one leaving takes it; a return gives it back', () => {
    const u = account(1, 321, 4, 'home1');
    gamePlayer(2, 322, 'P322', 4);
    redeemJoin(issueCode(2, 322), userRepo.getUserById(u.id)!, {}, NOW);
    addAlt(u, 2, 323, 4);
    expect(userRepo.getClanAccessRole(u.id, 2)).toBe('user');
    syncLinkedAccounts(2, roster({ 323: 4 }));
    expect(userRepo.getClanAccessRole(u.id, 2)).toBe('user');
    syncLinkedAccounts(2, roster({}));
    expect(userRepo.getClanAccessRole(u.id, 2)).toBeNull();
    syncLinkedAccounts(2, roster({ 322: 2 }));
    expect(userRepo.getClanAccessRole(u.id, 2)).toBe('admin');
  });

  it('the home clan blocks the account only when every one of its players there has left', () => {
    const u = account(1, 331, 4, 'homey');
    addAlt(u, 1, 332, 4);
    const token = userRepo.createSession(u.id);
    syncLinkedAccounts(1, roster({ 332: 4 }));
    expect(isAccountBlocked(u.id)).toBe(false);
    expect(userRepo.validateSession(token)).not.toBeNull();
    syncLinkedAccounts(1, roster({}));
    expect(isAccountBlocked(u.id)).toBe(true);
    expect(userRepo.validateSession(token)).toBeNull();
  });

  it('unlinking one alt keeps the other, and the main moves to the one left', () => {
    const u = account(1, 341, 4, 'pair');
    addAlt(u, 1, 342, 4);
    setMainPlayer(u.id, 1, 342);
    expect(unlinkGameAccount(u.id, 1, 342).map((l) => l.playerId)).toEqual([342]);
    expect(linkedPlayerIds(u.id, 1)).toEqual([341]);
    expect(mainLink(u.id, 1)?.playerId).toBe(341);
  });

  it('still refuses a player linked to another account', () => {
    account(1, 351, 4, 'first');
    const u = account(1, 352, 4, 'second');
    expect(() => redeemJoin(issueCode(1, 351, 'tb:351', NOW + 11 * 60_000), userRepo.getUserById(u.id)!, {}, NOW + 11 * 60_000)).toThrow('conflict');
  });
});

describe('the session rejects a demoted or departed account at once', () => {
  it('validateSession re-reads the role from the database on every call', () => {
    gamePlayer(1, 181, 'Live', 1);
    const r = redeemJoin(issueCode(1, 181), null, { username: 'live', password: PW }, NOW);
    expect(session(r.user.id)?.user.role).toBe('admin');
    syncLinkedAccounts(1, roster({ 181: 5 }));
    expect(session(r.user.id)?.user.role).toBe('user');
  });
});

describe('profile links: the member each linked player is', () => {
  function member(clanId: number, name: string, playerId: number | null, active: number): number {
    return (getDb().prepare(
      `INSERT INTO members (clan_id, name, normalized_name, first_seen, last_seen, is_active, game_player_id)
       VALUES (?, ?, ?, '2026-11-01', '2026-11-18', ?, ?) RETURNING id`,
    ).get(clanId, name, name.toLowerCase(), active, playerId) as { id: number }).id;
  }

  it('maps each clan’s players to their member, and skips members with no player', () => {
    const here = member(1, 'Here', 501, 1);
    const gone = member(1, 'Gone', 502, 0);
    member(1, 'NoPlayer', null, 1);
    const other = member(2, 'Other', 501, 1);

    const one = memberIdsByPlayer(1);
    expect(one.get(playerKey(1, 501))).toBe(here);
    // A member who left still has a profile.
    expect(one.get(playerKey(1, 502))).toBe(gone);
    expect(one.has(playerKey(2, 501))).toBe(false);
    expect(one.size).toBe(2);

    const all = memberIdsByPlayer(null);
    expect(all.get(playerKey(1, 501))).toBe(here);
    expect(all.get(playerKey(2, 501))).toBe(other);
  });
});
