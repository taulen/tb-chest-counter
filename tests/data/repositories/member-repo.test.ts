import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addAlias,
  deleteMember,
  findMemberByName,
  getAllMembers,
  getMemberById,
  getMemberClanId,
  getMemberCount,
  removeMember,
  renameMember,
  restoreMember,
  upsertMember,
} from '../../../src/data/repositories/member-repo.js';
import { getDb } from '../../../src/data/database.js';
import { makeTestDb, seedTwoClans } from '../../helpers/test-db.js';

describe('member-repo: multi-clan scoping', () => {
  let cleanup: () => void;
  let clanA: number;
  let clanB: number;

  beforeEach(() => {
    const t = makeTestDb();
    cleanup = t.cleanup;
    const seeded = seedTwoClans();
    clanA = seeded.clanIdA;
    clanB = seeded.clanIdB;
  });

  afterEach(() => cleanup());

  describe('upsertMember', () => {
    it('creates a new member in the requested clan', () => {
      const m = upsertMember('Alice', clanA);
      expect(m.name).toBe('Alice');
      expect(m.id).toBeGreaterThan(0);
      expect(getMemberClanId(m.id)).toBe(clanA);
    });

    it('updates last_seen on repeat insert with the same name', () => {
      const first = upsertMember('Bob', clanA);
      // Force a different timestamp.
      const before = first.lastSeen;
      // Sleep briefly to ensure ISO string difference.
      const start = Date.now();
      while (Date.now() === start) { /* tight loop */ }
      const second = upsertMember('Bob', clanA);
      expect(second.id).toBe(first.id);
      expect(second.lastSeen >= before).toBe(true);
    });

    it('treats the same player name in two clans as two distinct members', () => {
      const a = upsertMember('Carol', clanA);
      const b = upsertMember('Carol', clanB);
      expect(a.id).not.toBe(b.id);
      expect(getMemberClanId(a.id)).toBe(clanA);
      expect(getMemberClanId(b.id)).toBe(clanB);
    });

    it('matches by alias inside the same clan only', () => {
      const dave = upsertMember('Dave', clanA);
      addAlias(dave.id, 'davey', clanA);
      // Same alias text in clan B should NOT collide; clan B has no Dave yet.
      const daveAgain = upsertMember('davey', clanA); // hits alias
      const newPersonInB = upsertMember('davey', clanB); // brand new in clan B
      expect(daveAgain.id).toBe(dave.id);
      expect(newPersonInB.id).not.toBe(dave.id);
      expect(getMemberClanId(newPersonInB.id)).toBe(clanB);
    });
  });

  describe('reads scope to the requesting clan', () => {
    it('findMemberByName ignores other clans', () => {
      upsertMember('Eve', clanA);
      expect(findMemberByName('Eve', clanA)).not.toBeNull();
      expect(findMemberByName('Eve', clanB)).toBeNull();
    });

    it('getAllMembers returns only the requested clan', () => {
      upsertMember('Fred', clanA);
      upsertMember('Greg', clanB);
      expect(getAllMembers(false, clanA).map((m) => m.name)).toEqual(['Fred']);
      expect(getAllMembers(false, clanB).map((m) => m.name)).toEqual(['Greg']);
    });

    it('getMemberById returns null when id belongs to another clan', () => {
      const m = upsertMember('Hugo', clanA);
      expect(getMemberById(m.id, clanA)?.id).toBe(m.id);
      expect(getMemberById(m.id, clanB)).toBeNull();
    });

    it('getMemberCount counts only the requested clan', () => {
      upsertMember('I', clanA);
      upsertMember('J', clanA);
      upsertMember('K', clanB);
      expect(getMemberCount(clanA)).toBe(2);
      expect(getMemberCount(clanB)).toBe(1);
    });
  });

  describe('writes refuse cross-clan operations', () => {
    it('renameMember does nothing when called with the wrong clan id', () => {
      const m = upsertMember('Liam', clanA);
      renameMember(m.id, 'Renamed', clanB);
      // Original name should still be in clan A.
      expect(getMemberById(m.id, clanA)?.name).toBe('Liam');
    });

    it('deleteMember does nothing when called with the wrong clan id', () => {
      const m = upsertMember('Mia', clanA);
      deleteMember(m.id, clanB);
      expect(getMemberById(m.id, clanA)).not.toBeNull();
    });

    it('addAlias does nothing when called with the wrong clan id', () => {
      const m = upsertMember('Noah', clanA);
      addAlias(m.id, 'no_a', clanB);
      const fresh = getMemberById(m.id, clanA)!;
      expect(fresh.aliases).toEqual([]);
    });
  });

  describe('removeMember (always soft-delete)', () => {
    function seedChestForMember(memberId: number, clanId: number): void {
      const db = getDb();
      const session = db
        .prepare(
          "INSERT INTO scan_sessions (clan_id, started_at, status) VALUES (?, ?, 'completed')",
        )
        .run(clanId, new Date().toISOString());
      const chest = db.prepare("INSERT OR IGNORE INTO chests (name) VALUES ('Test Chest')").run();
      const chestId = chest.lastInsertRowid
        || (db.prepare("SELECT id FROM chests WHERE name='Test Chest'").get() as { id: number }).id;
      db.prepare(
        `INSERT INTO chest_records (clan_id, session_id, member_id, chest_id, captured_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(clanId, session.lastInsertRowid, memberId, chestId, Date.now());
    }

    it('soft-deletes a member with no chest history (recoverable from removed list)', () => {
      const m = upsertMember('Olive', clanA);
      removeMember(m.id, clanA);
      const after = getMemberById(m.id, clanA);
      expect(after).not.toBeNull();
      expect(after!.isActive).toBe(false);
    });

    it('soft-deletes a member with chest history', () => {
      const m = upsertMember('Patty', clanA);
      seedChestForMember(m.id, clanA);

      removeMember(m.id, clanA);
      const after = getMemberById(m.id, clanA);
      expect(after).not.toBeNull();
      expect(after!.isActive).toBe(false);
    });

    it('excludes soft-deleted members from active-only listing', () => {
      const m = upsertMember('Quinn', clanA);
      seedChestForMember(m.id, clanA);
      removeMember(m.id, clanA);

      const active = getAllMembers(true, clanA).map((x) => x.name);
      const all = getAllMembers(false, clanA).map((x) => x.name);
      expect(active).not.toContain('Quinn');
      expect(all).toContain('Quinn');
    });

    it('upsertMember auto-reactivates a soft-deleted member seen again', () => {
      const m = upsertMember('Riley', clanA);
      seedChestForMember(m.id, clanA);
      removeMember(m.id, clanA);
      expect(getMemberById(m.id, clanA)!.isActive).toBe(false);

      const seenAgain = upsertMember('Riley', clanA);
      expect(seenAgain.id).toBe(m.id);
      expect(getMemberById(m.id, clanA)!.isActive).toBe(true);
    });

    it('restoreMember flips is_active back to true', () => {
      const m = upsertMember('Sam', clanA);
      seedChestForMember(m.id, clanA);
      removeMember(m.id, clanA);
      restoreMember(m.id, clanA);
      expect(getMemberById(m.id, clanA)!.isActive).toBe(true);
    });
  });

  describe('names match exactly (case-folded), never by spacing', () => {
    it('keeps differently-spaced names as different members', () => {
      // The spacing-insensitive key (members.despaced_name, v66) was for OCR's
      // spacing variants; it went Nov 25 2026 (v138). Game names are exact, and
      // "Ra ven" and "Raven" are two players.
      const a = upsertMember('Ra ven', clanA);
      const b = upsertMember('Raven', clanA);
      expect(b.id).not.toBe(a.id);
      expect(findMemberByName('Raven', clanA)!.id).toBe(b.id);
      expect(upsertMember('raven', clanA).id).toBe(b.id); // case still folds
    });
  });
});
