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

  // ── the despaced key (v66) ──────────────────────────────────────────────────
  //
  // normalized_name keeps single spaces, so it read every OCR spacing variant of one
  // player as a separate person: "J I Z Z I C A" grew a row for "JIZZICA", another
  // for "JI ZZICA", another for "JIZZI C A". Each was its own leaderboard entry and
  // its own hand-written merge rule.

  describe('spacing variants resolve to one member', () => {
    it('does not create a second row for a differently-spaced reading', () => {
      const original = upsertMember('J I Z Z I C A', clanA);
      for (const read of ['JIZZICA', 'JI ZZICA', 'JIZZI C A', 'JI ZZI C A']) {
        expect(upsertMember(read, clanA).id).toBe(original.id);
      }
      expect(getAllMembers(false, clanA).filter((m) => m.name.includes('Z'))).toHaveLength(1);
      // And the roster keeps the spacing it was given — the key is a lookup key only.
      expect(getMemberById(original.id, clanA)!.name).toBe('J I Z Z I C A');
    });

    it('resolves the same way whichever spelling was seen first', () => {
      const original = upsertMember('JIZZICA', clanB);
      expect(upsertMember('J I Z Z I C A', clanB).id).toBe(original.id);
      expect(findMemberByName('JI ZZI C A', clanB)!.id).toBe(original.id);
    });

    it('stays scoped to its clan', () => {
      const a = upsertMember('J I Z Z I C A', clanA);
      const b = upsertMember('JIZZICA', clanB);
      expect(b.id).not.toBe(a.id);
      expect(findMemberByName('JIZZICA', clanA)!.id).toBe(a.id);
      expect(findMemberByName('J I Z Z I C A', clanB)!.id).toBe(b.id);
    });

    it('carries the key through a rename, so fixing the spelling once sticks', () => {
      // The whole promise of the feature: an admin corrects the name once and the
      // next scan that reads it correctly lands on the same row. Leave despaced_name
      // behind on the rename and the row keeps answering to the misread key instead,
      // so the very next scan mints the duplicate that was just cleaned up.
      const m = upsertMember('J1ZZICA', clanA);
      renameMember(m.id, 'J I Z Z I C A', clanA);
      expect(upsertMember('JIZZICA', clanA).id).toBe(m.id);
      expect(upsertMember('J I Z Z I C A', clanA).id).toBe(m.id);
      expect(getAllMembers(false, clanA)).toHaveLength(1);
    });

    it('leaves genuinely different names apart', () => {
      const a = upsertMember('J I Z Z I C A', clanA);
      const b = upsertMember('JIMMICA', clanA);
      expect(b.id).not.toBe(a.id);
    });

    it('prefers an exact normalized_name hit over a despaced one', () => {
      // The despaced lookup is a fallback. Anything that matched before must still
      // reach the same row, or this silently redirects existing traffic.
      const spaced = upsertMember('A B C D', clanA);
      const joined = upsertMember('ABCD', clanA);
      expect(joined.id).toBe(spaced.id);

      // With both rows already present (the pre-v66 state an admin has yet to merge),
      // an exact spelling still wins over the despaced fallback.
      const db = getDb();
      db.prepare(
        `INSERT INTO members (clan_id, name, normalized_name, despaced_name, aliases, first_seen, last_seen)
         VALUES (?, 'ABCD', 'abcd', 'abcd', '[]', '2026-01-01', '2026-01-01')`,
      ).run(clanA);
      expect(findMemberByName('ABCD', clanA)!.name).toBe('ABCD');
      expect(findMemberByName('A B C D', clanA)!.name).toBe('A B C D');
    });
  });
});
