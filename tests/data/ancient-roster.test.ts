import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/data/database.js';
import * as mightRepo from '../../src/data/repositories/might-repo.js';
import { addGuardsReport } from '../../src/data/repositories/guards-repo.js';
import { getAncientRoster, MAX_ROSTER } from '../../src/data/ancient-roster.js';
import { makeTestDb, seedTwoClans } from '../helpers/test-db.js';

let cleanup: () => void;

const NOW = Date.parse('2026-10-23T12:00:00.000Z');
const TODAY = '2026-10-22'; // game day at 12:00 UTC with a 17:00 rollover
const DAY = 86_400_000;

function addMember(clanId: number, name: string, lastSeenMs = NOW, active = 1): number {
  const seen = new Date(lastSeenMs).toISOString();
  const row = getDb().prepare(
    `INSERT INTO members (clan_id, name, normalized_name, first_seen, last_seen, is_active)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
  ).get(clanId, name, name.toLowerCase(), seen, seen, active) as { id: number };
  return row.id;
}

beforeEach(() => {
  ({ cleanup } = makeTestDb());
  seedTwoClans();
});

afterEach(() => cleanup());

describe('getAncientRoster', () => {
  it('uses the newest might capture when it is fresh, with guards levels', () => {
    const a = addMember(1, 'Alice');
    const b = addMember(1, 'Bob');
    addMember(1, 'Carol'); // seen, but not on the capture
    mightRepo.saveSnapshots(1, '2026-10-21', '2026-10-21T18:00:00.000Z', [
      { memberId: a, might: 500 },
      { memberId: b, might: 900 },
    ]);
    addGuardsReport({ clanId: 1, memberId: a, level: 8, observedDate: '2026-10-01', note: '', createdBy: null });

    const r = getAncientRoster(1, TODAY, NOW);
    expect(r.source).toBe('might');
    expect(r.mightGameDate).toBe('2026-10-21');
    expect(r.members.map((m) => m.name)).toEqual(['Bob', 'Alice']);
    expect(r.members.find((m) => m.name === 'Alice')?.guardsLevel).toBe(8);
    expect(r.members.find((m) => m.name === 'Bob')?.guardsLevel).toBeNull();
  });

  it('falls back to members seen this week when the capture is outdated', () => {
    const a = addMember(1, 'Alice', NOW - 1 * DAY);
    addMember(1, 'Bob', NOW - 3 * DAY);
    addMember(1, 'Gone', NOW - 9 * DAY);
    addMember(1, 'Left', NOW - 1 * DAY, 0);
    mightRepo.saveSnapshots(1, '2026-10-15', '2026-10-15T18:00:00.000Z', [{ memberId: a, might: 1 }]);

    const r = getAncientRoster(1, TODAY, NOW);
    expect(r.source).toBe('recent');
    expect(r.mightGameDate).toBe('2026-10-15');
    expect(r.members.map((m) => m.name)).toEqual(['Alice', 'Bob']);
  });

  it('falls back when there has never been a capture, and caps at 100', () => {
    for (let i = 0; i < 105; i++) addMember(1, `M${String(i).padStart(3, '0')}`, NOW - i * 60_000);
    const r = getAncientRoster(1, TODAY, NOW);
    expect(r.source).toBe('recent');
    expect(r.members).toHaveLength(MAX_ROSTER);
    // Most recently seen first: the five seen longest ago are the ones dropped.
    expect(r.members.some((m) => m.name === 'M104')).toBe(false);
  });

  it('caps a capture at 100 too, keeping the strongest', () => {
    const rows = [];
    for (let i = 0; i < 103; i++) rows.push({ memberId: addMember(1, `P${i}`), might: 1000 + i });
    mightRepo.saveSnapshots(1, '2026-10-22', '2026-10-22T18:00:00.000Z', rows);
    const r = getAncientRoster(1, TODAY, NOW);
    expect(r.source).toBe('might');
    expect(r.members).toHaveLength(100);
    expect(r.members[0].name).toBe('P102');
  });

  it('never reads another clan', () => {
    addMember(2, 'Other');
    const r = getAncientRoster(1, TODAY, NOW);
    expect(r.source).toBe('none');
    expect(r.members).toEqual([]);
  });
});
