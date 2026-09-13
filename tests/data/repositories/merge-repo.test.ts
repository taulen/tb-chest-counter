import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addMergeRule, loadPlayerNameCanonicaliser } from '../../../src/data/repositories/merge-repo.js';
import { getAllMembers, upsertMember } from '../../../src/data/repositories/member-repo.js';
import { exactMatchMember, fuzzyMatchMember } from '../../../src/utils/fuzzy.js';
import { getDb } from '../../../src/data/database.js';
import { makeTestDb, seedChestData } from '../../helpers/test-db.js';

/**
 * A player merge deletes the source `members` row, so EVERY table with an
 * FK on members(id) has to be remapped (or cleared) first. Miss one and the
 * whole merge dies with a bare "FOREIGN KEY constraint failed" - which is
 * exactly what resource_transactions did before it was remapped.
 */
describe('merge-repo: player merge vs. FKs on members(id)', () => {
  let cleanup: () => void;
  const clanId = 1;
  let alice: number;
  let bob: number;
  let goldTypeId: number;

  /** Insert a resource transaction for a member, returning its id. */
  function seedResourceTx(memberId: number, opts: {
    resourceTypeId: number | null;
    direction: number;
    amount: number;
    date: string;
  }): number {
    const db = getDb();
    const now = new Date().toISOString();
    const batch = db.prepare(
      `INSERT INTO resource_upload_batches (clan_id, uploaded_by, uploaded_at, upload_date)
       VALUES (?, 1, ?, ?) RETURNING id`,
    ).get(clanId, now, now) as { id: number };
    const row = db.prepare(
      `INSERT INTO resource_transactions
         (clan_id, batch_id, member_id, resource_type_id, direction, amount, transaction_date, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    ).get(
      clanId, batch.id, memberId, opts.resourceTypeId,
      opts.direction, opts.amount, opts.date, now,
    ) as { id: number };
    return row.id;
  }

  function txMemberIds(): number[] {
    return (getDb().prepare(
      'SELECT member_id FROM resource_transactions ORDER BY id',
    ).all() as { member_id: number }[]).map((r) => r.member_id);
  }

  beforeEach(() => {
    const t = makeTestDb();
    cleanup = t.cleanup;

    const db = getDb();
    const now = new Date().toISOString();
    // resource_upload_batches.uploaded_by FKs users(id).
    db.prepare(
      `INSERT INTO users (id, username, password_hash, role, created_at)
       VALUES (1, 'tester', 'x', 'admin', ?)`,
    ).run(now);
    // resource_types is seeded by initDatabase - reuse a real row rather
    // than inserting a fixed id (which collides with the seed).
    goldTypeId = (db.prepare('SELECT id FROM resource_types ORDER BY id LIMIT 1')
      .get() as { id: number }).id;

    const seeded = seedChestData(clanId);
    alice = seeded.members.alice;
    bob = seeded.members.bob;
  });

  afterEach(() => cleanup());

  it('merges a player who has resource transactions instead of failing the FK', () => {
    seedResourceTx(alice, {
      resourceTypeId: goldTypeId, direction: 1, amount: 500, date: '2026-07-20',
    });

    // Before the fix this threw "FOREIGN KEY constraint failed" on the
    // DELETE FROM members at the end of the merge.
    expect(() => addMergeRule('player', 'Alice', 'Bob', clanId)).not.toThrow();

    const db = getDb();
    expect(db.prepare('SELECT id FROM members WHERE id = ?').get(alice)).toBeUndefined();
    expect(txMemberIds()).toEqual([bob]);
  });

  it('keeps identical-looking transactions from both names (v39 dropped the UNIQUE key)', () => {
    // Same resource/amount/date under both names. v39 rebuilt
    // resource_transactions WITHOUT its UNIQUE constraint on purpose:
    // duplicates are legitimate data, so the merge must remap both rather
    // than "dedupe" one away.
    const same = { resourceTypeId: goldTypeId, direction: 1, amount: 500, date: '2026-07-20' };
    seedResourceTx(alice, same);
    seedResourceTx(bob, same);
    seedResourceTx(alice, {
      resourceTypeId: goldTypeId, direction: -1, amount: 250, date: '2026-07-21',
    });

    addMergeRule('player', 'Alice', 'Bob', clanId);

    expect(txMemberIds()).toEqual([bob, bob, bob]);
    const amounts = (getDb().prepare(
      'SELECT amount FROM resource_transactions ORDER BY amount',
    ).all() as { amount: number }[]).map((r) => r.amount);
    expect(amounts).toEqual([250, 500, 500]);
  });

  it('never loses a transaction to the merge', () => {
    seedResourceTx(alice, { resourceTypeId: null, direction: 1, amount: 500, date: '2026-07-20' });
    seedResourceTx(bob, { resourceTypeId: null, direction: 1, amount: 500, date: '2026-07-20' });
    const before = (getDb().prepare(
      'SELECT COUNT(*) c FROM resource_transactions',
    ).get() as { c: number }).c;

    addMergeRule('player', 'Alice', 'Bob', clanId);

    const after = (getDb().prepare(
      'SELECT COUNT(*) c FROM resource_transactions',
    ).get() as { c: number }).c;
    expect(after).toBe(before);
    expect(txMemberIds()).toEqual([bob, bob]);
  });

  it('remaps chest and triumphal records and removes the source member', () => {
    const db = getDb();
    const beforeAlice = db.prepare(
      'SELECT COUNT(*) c FROM chest_records WHERE member_id = ?',
    ).get(alice) as { c: number };
    expect(beforeAlice.c).toBe(2);

    addMergeRule('player', 'Alice', 'Bob', clanId);

    expect(db.prepare('SELECT id FROM members WHERE id = ?').get(alice)).toBeUndefined();
    const bobChests = db.prepare(
      'SELECT COUNT(*) c FROM chest_records WHERE member_id = ?',
    ).get(bob) as { c: number };
    expect(bobChests.c).toBe(3);
    const orphaned = db.prepare(
      'SELECT COUNT(*) c FROM chest_records WHERE member_id = ?',
    ).get(alice) as { c: number };
    expect(orphaned.c).toBe(0);
  });

  it('renames in place when the merge target does not exist yet', () => {
    seedResourceTx(alice, {
      resourceTypeId: goldTypeId, direction: 1, amount: 500, date: '2026-07-20',
    });

    addMergeRule('player', 'Alice', 'Alicia', clanId);

    const row = getDb().prepare('SELECT name FROM members WHERE id = ?').get(alice) as
      { name: string };
    expect(row.name).toBe('Alicia');
    // The rename path touches no transactions - they stay on the same member.
    expect(txMemberIds()).toEqual([alice]);
  });
});

/**
 * member_snapshots holds the might (`power`) and hero-level (`level`) history, and
 * the merge used to DELETE the source's rows outright. Since the might capture is
 * what creates an OCR-misread member in the first place, the row being deleted was
 * normally the one holding the newest reading - so merging the misread spelling
 * into the real player silently threw away that day's might.
 */
describe('merge-repo: player merge vs. might history', () => {
  let cleanup: () => void;
  const clanId = 1;
  let alice: number;
  let bob: number;

  interface SnapRow { gameDate: string; power: number; level: number; crop: string | null }

  function seedSnapshot(memberId: number, gameDate: string, opts: {
    power: number;
    level?: number;
    crop?: string | null;
  }): void {
    getDb().prepare(
      `INSERT INTO member_snapshots
         (member_id, clan_id, level, power, captured_at, game_date, row_crop_path)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      memberId, clanId, opts.level ?? 0, opts.power,
      `${gameDate}T18:00:00.000Z`, gameDate, opts.crop ?? null,
    );
  }

  function snapshots(memberId: number): SnapRow[] {
    return getDb().prepare(
      `SELECT game_date AS gameDate, power, level, row_crop_path AS crop
       FROM member_snapshots WHERE member_id = ? ORDER BY game_date`,
    ).all(memberId) as SnapRow[];
  }

  beforeEach(() => {
    const t = makeTestDb();
    cleanup = t.cleanup;
    const seeded = seedChestData(clanId);
    alice = seeded.members.alice;
    bob = seeded.members.bob;
  });

  afterEach(() => cleanup());

  it('carries the source\'s days over instead of deleting them', () => {
    seedSnapshot(bob, '2026-07-30', { power: 900_000, level: 29 });
    seedSnapshot(alice, '2026-07-31', { power: 950_000, level: 30 });
    seedSnapshot(alice, '2026-08-01', { power: 1_000_000, level: 31 });

    addMergeRule('player', 'Alice', 'Bob', clanId);

    expect(snapshots(bob)).toEqual([
      { gameDate: '2026-07-30', power: 900_000, level: 29, crop: null },
      { gameDate: '2026-07-31', power: 950_000, level: 30, crop: null },
      { gameDate: '2026-08-01', power: 1_000_000, level: 31, crop: null },
    ]);
    expect(snapshots(alice)).toEqual([]);
  });

  it('keeps the highest power and level when both names were read on the same day', () => {
    // Day 1: the source read higher (the destination's is the misread - OCR
    // dropped a digit). Day 2: the destination read higher. Both must resolve
    // upward, whichever side the bigger number is on.
    seedSnapshot(bob, '2026-07-31', { power: 105_000, level: 30 });
    seedSnapshot(alice, '2026-07-31', { power: 1_050_000, level: 31 });
    seedSnapshot(bob, '2026-08-01', { power: 1_060_000, level: 31 });
    seedSnapshot(alice, '2026-08-01', { power: 106_000, level: 3 });

    addMergeRule('player', 'Alice', 'Bob', clanId);

    expect(snapshots(bob)).toEqual([
      { gameDate: '2026-07-31', power: 1_050_000, level: 31, crop: null },
      { gameDate: '2026-08-01', power: 1_060_000, level: 31, crop: null },
    ]);
    // One row per day survives - the fold has to happen before the remap or the
    // UNIQUE(member_id, game_date) index would have failed the whole merge.
    expect(snapshots(alice)).toEqual([]);
  });

  it('keeps an evidence crop from whichever row had one', () => {
    seedSnapshot(bob, '2026-08-01', { power: 1_000_000, level: 31 });
    seedSnapshot(alice, '2026-08-01', { power: 999_000, level: 30, crop: '/data/crops/alice.png' });

    addMergeRule('player', 'Alice', 'Bob', clanId);

    expect(snapshots(bob)).toEqual([
      { gameDate: '2026-08-01', power: 1_000_000, level: 31, crop: '/data/crops/alice.png' },
    ]);
  });

  it('remaps pre-v57 rows with a blank game day (the partial index exempts them)', () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO member_snapshots (member_id, clan_id, level, power, captured_at)
       VALUES (?, ?, 12, 40000, '2026-01-01T00:00:00.000Z')`,
    ).run(alice, clanId);
    db.prepare(
      `INSERT INTO member_snapshots (member_id, clan_id, level, power, captured_at)
       VALUES (?, ?, 13, 41000, '2026-01-02T00:00:00.000Z')`,
    ).run(alice, clanId);

    addMergeRule('player', 'Alice', 'Bob', clanId);

    const blanks = db.prepare(
      `SELECT COUNT(*) c FROM member_snapshots WHERE member_id = ? AND game_date = ''`,
    ).get(bob) as { c: number };
    expect(blanks.c).toBe(2);
    expect(snapshots(alice)).toEqual([]);
  });

  it('leaves history on the same member when the target does not exist yet', () => {
    seedSnapshot(alice, '2026-08-01', { power: 1_000_000, level: 31 });

    addMergeRule('player', 'Alice', 'Alicia', clanId);

    // Rename path: the row survives, so snapshots follow it untouched.
    expect(snapshots(alice)).toEqual([
      { gameDate: '2026-08-01', power: 1_000_000, level: 31, crop: null },
    ]);
  });

  it('carries the despaced key through the rename path', () => {
    // The rename branch (target does not exist) has to update despaced_name the same
    // way renameMember does. If it does not, the row keeps answering to the misread
    // spelling's key and the next scan that reads the name correctly walks straight
    // past it — re-creating the duplicate this merge just removed.
    addMergeRule('player', 'Alice', 'A L I C E', clanId);
    const row = getDb().prepare(
      'SELECT name, normalized_name, despaced_name FROM members WHERE id = ?',
    ).get(alice) as { name: string; normalized_name: string; despaced_name: string };
    expect(row).toEqual({
      name: 'A L I C E',
      normalized_name: 'a l i c e',
      despaced_name: 'alice',
    });
  });
});

/**
 * Merge rules are matched on `normalize(from_value)`, which strips spacing and
 * punctuation — so "JIZZI C A", "JI ZZICA" and "JIZZICA" are one rule as far as
 * matching goes. The live roster still accumulated four rows for one player, because
 * nothing told the admin that rules two through four were no-ops.
 */
describe('merge-repo: redundant rules', () => {
  let cleanup: () => void;
  const clanId = 1;

  const rules = () => getDb().prepare(
    "SELECT from_value, to_value FROM merge_rules WHERE type = 'player' ORDER BY id",
  ).all() as { from_value: string; to_value: string }[];

  beforeEach(() => {
    const t = makeTestDb();
    cleanup = t.cleanup;
    seedChestData();
  });

  afterEach(() => cleanup());

  it('folds a spacing variant into the rule that already covers it', () => {
    addMergeRule('player', 'JIZZI C A', 'J I Z Z I C A', clanId);
    const second = addMergeRule('player', 'JI ZZICA', 'J I Z Z I C A', clanId);

    expect(rules()).toEqual([{ from_value: 'JIZZI C A', to_value: 'J I Z Z I C A' }]);
    expect(second.note).toMatch(/already covers/);
  });

  it('redirects the existing rule when the destination differs', () => {
    // A second row would be worse than useless: applyMergeRulesCached returns the
    // FIRST rule whose key matches, so the new one would sit there looking active
    // while the old one kept winning.
    addMergeRule('player', 'JIZZI C A', 'J I Z Z I C A', clanId);
    const second = addMergeRule('player', 'JI ZZICA', 'Jizzica', clanId);

    expect(rules()).toEqual([{ from_value: 'JIZZI C A', to_value: 'Jizzica' }]);
    expect(second.note).toMatch(/Updated the existing/);
  });

  it('still performs the data merge when the rule is redundant', () => {
    // The rule and the merge are two jobs sharing one function. Suppressing a
    // duplicate RULE must never suppress the MERGE, or real chest records stay
    // stranded under the member the admin is trying to fold away.
    const db = getDb();
    db.prepare(
      `INSERT INTO members (clan_id, name, normalized_name, despaced_name, aliases, first_seen, last_seen)
       VALUES (?, 'JI ZZICA', 'ji zzica', 'jizzica', '[]', '2026-01-01', '2026-01-01')`,
    ).run(clanId);

    addMergeRule('player', 'JIZZI C A', 'J I Z Z I C A', clanId);
    addMergeRule('player', 'JI ZZICA', 'J I Z Z I C A', clanId);

    // Renamed in place (the destination did not exist), so the duplicate is gone.
    const names = (db.prepare(
      'SELECT name FROM members WHERE clan_id = ?',
    ).all(clanId) as { name: string }[]).map((r) => r.name);
    expect(names).toContain('J I Z Z I C A');
    expect(names).not.toContain('JI ZZICA');
  });

  it('leaves genuinely distinct rules alone', () => {
    addMergeRule('player', 'JIZZI C A', 'J I Z Z I C A', clanId);
    const other = addMergeRule('player', 'Bobb', 'Bob', clanId);
    expect(rules()).toHaveLength(2);
    expect(other.note).toBeUndefined();
  });

  it('updating a rule by its own exact from_value is not treated as redundant', () => {
    addMergeRule('player', 'JIZZI C A', 'J I Z Z I C A', clanId);
    const again = addMergeRule('player', 'JIZZI C A', 'Jizzica', clanId);
    expect(rules()).toEqual([{ from_value: 'JIZZI C A', to_value: 'Jizzica' }]);
    expect(again.note).toBeUndefined();
  });
});

/**
 * A player merge rule has to take effect on EVERY path that reads a name off the
 * screen, not just the gift scan.
 *
 * It didn't, and the failure was silent in the worst way: `merge_rules` is consulted
 * in exactly one place (scan-pipeline.ts), while four other paths turn an OCR'd name
 * into a `members` row — the daily might capture, the roster build, the automated
 * resource-history read and the manual resource upload. Each of those resolves names
 * through fuzzy.ts and `upsertMember`, neither of which has ever looked at the rules,
 * so a rule an admin had already written was ignored and the duplicate member it
 * existed to prevent was re-created on the very next capture, every day.
 *
 * Reported from the live roster after several days of it: "Ma Chaosraven",
 * "Ma from Chaos", "FENRØTH Øf CHAOS" and "185/ taulen302" each had a rule and each
 * kept reappearing in the New Members queue. Not one is reachable by distance — 3, 3,
 * 1-but-already-claimed and 3 edits against a budget of 2 — so the rule was the only
 * thing that could ever have resolved them.
 *
 * The fix is an alias, because an alias is the one mechanism every read path already
 * honours: `exactMatchMember`, `fuzzyMatchMember` and `upsertMember` all check them.
 * One write covers all four paths and keeps covering them — a seam added later cannot
 * forget to consult a rule it never has to know about.
 */
describe('merge-repo: a player merge rule sticks on every read path', () => {
  let cleanup: () => void;
  const clanId = 1;

  const aliasesOf = (name: string): string[] => JSON.parse((getDb().prepare(
    'SELECT aliases FROM members WHERE clan_id = ? AND name = ?',
  ).get(clanId, name) as { aliases: string }).aliases);

  const memberCount = (): number => (getDb().prepare(
    'SELECT COUNT(*) AS n FROM members WHERE clan_id = ?',
  ).get(clanId) as { n: number }).n;

  beforeEach(() => {
    const t = makeTestDb();
    cleanup = t.cleanup;
    seedChestData();
  });

  afterEach(() => cleanup());

  it('records the misread spelling as an alias of the destination member', () => {
    upsertMember('Mikam Chaosraven', clanId);
    upsertMember('Ma Chaosraven', clanId);

    addMergeRule('player', 'Ma Chaosraven', 'Mikam Chaosraven', clanId);

    expect(aliasesOf('Mikam Chaosraven')).toEqual(['Ma Chaosraven']);
    // The source row is gone — the merge folded it away, as it always did.
    expect(getDb().prepare(
      'SELECT COUNT(*) AS n FROM members WHERE clan_id = ? AND name = ?',
    ).get(clanId, 'Ma Chaosraven')).toEqual({ n: 0 });
  });

  it('lets the might capture resolve the misread instead of minting a member', () => {
    // exactMatchMember is what might-capture-phase's resolveMember tries first, and
    // this name is out of the fuzzy matcher's reach either way: "machaosraven" is 3
    // edits from "mikamchaosraven" against a budget of 2.
    upsertMember('Mikam Chaosraven', clanId);
    upsertMember('Ma Chaosraven', clanId);
    addMergeRule('player', 'Ma Chaosraven', 'Mikam Chaosraven', clanId);

    const members = getAllMembers(true, clanId);
    expect(exactMatchMember('Ma Chaosraven', members)?.name).toBe('Mikam Chaosraven');
    expect(fuzzyMatchMember('Ma Chaosraven', members)?.name).toBe('Mikam Chaosraven');
  });

  it('lets the resource paths resolve it, rather than inserting a second row', () => {
    // Both resource paths create through upsertMember, which checks aliases.
    const target = upsertMember('taulen302', clanId);
    upsertMember('185/ taulen302', clanId);
    addMergeRule('player', '185/ taulen302', 'taulen302', clanId);

    const before = memberCount();
    expect(upsertMember('185/ taulen302', clanId).id).toBe(target.id);
    expect(memberCount()).toBe(before);
  });

  it('attaches the alias on the rename path too, where the destination is new', () => {
    // No "Ilrin" yet, so the merge renames the source row in place rather than
    // folding it. The alias has to land on the renamed row or the next read of the
    // old spelling walks straight past it.
    upsertMember('X Ilrin', clanId);
    addMergeRule('player', 'X Ilrin', 'Ilrin', clanId);

    expect(aliasesOf('Ilrin')).toEqual(['X Ilrin']);
    expect(upsertMember('X Ilrin', clanId).name).toBe('Ilrin');
  });

  it('records the alias even when the misread was never a member', () => {
    // A rule typed straight into the Merge Rules page, with nothing to remap.
    upsertMember('Mikam from Chaos', clanId);
    addMergeRule('player', 'Ma from Chaos', 'Mikam from Chaos', clanId);

    expect(aliasesOf('Mikam from Chaos')).toEqual(['Ma from Chaos']);
  });

  it('never records the destination own name, and never duplicates an alias', () => {
    upsertMember('Bob', clanId);
    addMergeRule('player', 'Bobb', 'Bob', clanId);
    addMergeRule('player', 'Bobb', 'Bob', clanId);
    addMergeRule('player', 'Bob', 'Bob', clanId);

    expect(aliasesOf('Bob')).toEqual(['Bobb']);
  });

  it('resolves a truncated reading the roster key cannot reach', () => {
    // "FENRØTH" despaces to "fenrth" (the Ø is stripped, not folded — it has no NFD
    // decomposition) against the member's "fenrthfchas", so neither the exact key nor
    // the 2-edit budget can join them. The alias is what does, and it resolves the
    // reading to exactly what the rule says it is — the same answer the gift scan has
    // always given it.
    const target = upsertMember('FENRØTH Øf CHAØS', clanId);
    addMergeRule('player', 'FENRØTH', 'FENRØTH Øf CHAØS', clanId);

    const before = memberCount();
    expect(upsertMember('FENRØTH', clanId).id).toBe(target.id);
    expect(memberCount()).toBe(before);
    // The rule and the alias agree — that is the whole point of writing both.
    expect(loadPlayerNameCanonicaliser(clanId)('FENRØTH')).toBe('FENRØTH Øf CHAØS');
  });

  it('lets a member keep a name another member carries as an alias', () => {
    // upsertMember checks a member's own normalized_name before any alias, so an
    // alias can never take rows off the player who actually spells it that way.
    const bob = upsertMember('Bob', clanId);
    upsertMember('Alice', clanId);
    getDb().prepare(
      'UPDATE members SET aliases = ? WHERE clan_id = ? AND name = ?',
    ).run(JSON.stringify(['Bob']), clanId, 'Alice');

    expect(upsertMember('Bob', clanId).id).toBe(bob.id);
  });

  it('canonicalises a reading for a destination not yet on the roster', () => {
    // The alias covers a rule with a live destination; this covers the rest — a rule
    // written ahead of the player existing. Every capture path runs its readings
    // through this before matching or creating anything.
    addMergeRule('player', 'Ma Chaosraven', 'Mikam Chaosraven', clanId);
    const canonicalise = loadPlayerNameCanonicaliser(clanId);

    expect(canonicalise('Ma Chaosraven')).toBe('Mikam Chaosraven');
    // Spacing and punctuation are ignored when a rule is matched.
    expect(canonicalise('MaChaosraven')).toBe('Mikam Chaosraven');
    // Anything no rule covers comes back untouched, so it is safe to wrap every read.
    expect(canonicalise('Someone Else')).toBe('Someone Else');
  });

});
