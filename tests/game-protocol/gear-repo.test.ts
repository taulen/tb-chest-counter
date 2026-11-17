/**
 * Artifacts and captain equipment from city reads (v112): the current rows,
 * history only on change, artifacts that leave the line-up kept but marked,
 * emptied equipment positions recorded, and archive replays (oldest read first)
 * that never duplicate or regress.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getParseMarker,
  rawSnapshotsOldestFirst,
  saveArtifacts,
  saveCaptainEquipment,
  saveRawSnapshot,
  setParseMarker,
} from '../../src/data/repositories/game-protocol-repo.js';
import {
  getPlayerArtifactChanges,
  getPlayerArtifacts,
  getPlayerEquipment,
  getPlayerEquipmentChanges,
} from '../../src/data/repositories/game-profile-repo.js';
import { makeTestDb } from '../helpers/test-db.js';

let cleanup: () => void;
beforeEach(() => { ({ cleanup } = makeTestDb()); });
afterEach(() => cleanup());

const CLAN = 1;
const PLAYER = 4599909974644;
const art = (type: number, level: number, star: number, bonuses: number[] = []) => ({ type, level, star, bonuses });
const item = (captainId: number, position: number, uid: string, type: number, enchantment = 0, gems: number[] = []) =>
  ({ captainId, position, uid, type, enchantment, gems, raw: [1000, 6, 36, 0] });

describe('artifacts', () => {
  it('keeps the current artifacts and a history row only when level, star level or rolls change', () => {
    expect(saveArtifacts(CLAN, PLAYER, [art(16, 49, 21, [9681]), art(20, 50, 22)], '2026-11-17T01:00:00Z')).toBe(2);
    expect(saveArtifacts(CLAN, PLAYER, [art(16, 49, 21, [9681]), art(20, 50, 22)], '2026-11-17T03:00:00Z')).toBe(0);
    expect(saveArtifacts(CLAN, PLAYER, [art(16, 50, 21, [9681]), art(20, 50, 22, [9512])], '2026-11-17T05:00:00Z')).toBe(2);

    // Line-up first, then level, then star level.
    expect(getPlayerArtifacts(CLAN, PLAYER)).toEqual([
      { artifactType: 20, level: 50, star: 22, bonuses: [9512], inLineup: true, firstSeen: '2026-11-17T01:00:00Z', lastSeen: '2026-11-17T05:00:00Z' },
      { artifactType: 16, level: 50, star: 21, bonuses: [9681], inLineup: true, firstSeen: '2026-11-17T01:00:00Z', lastSeen: '2026-11-17T05:00:00Z' },
    ]);
    // The baseline read is left out of the changes.
    expect(getPlayerArtifactChanges(CLAN, PLAYER, '2026-11-01T00:00:00Z')).toEqual([
      { artifactType: 16, level: 50, star: 21, prevLevel: 49, prevStar: 21, rerolled: false, lineup: null, changedAt: '2026-11-17T05:00:00Z' },
      { artifactType: 20, level: 50, star: 22, prevLevel: 50, prevStar: 22, rerolled: true, lineup: null, changedAt: '2026-11-17T05:00:00Z' },
    ]);
  });

  it('marks an artifact that left the line-up instead of deleting it, and brings it back', () => {
    saveArtifacts(CLAN, PLAYER, [art(16, 50, 21), art(20, 50, 22)], '2026-11-17T01:00:00Z');
    saveArtifacts(CLAN, PLAYER, [art(16, 50, 21)], '2026-11-17T02:00:00Z');
    expect(getPlayerArtifacts(CLAN, PLAYER).map((a) => [a.artifactType, a.inLineup])).toEqual([[16, true], [20, false]]);
    saveArtifacts(CLAN, PLAYER, [art(20, 50, 22)], '2026-11-17T03:00:00Z');
    expect(getPlayerArtifacts(CLAN, PLAYER).map((a) => [a.artifactType, a.inLineup])).toEqual([[20, true], [16, false]]);
  });

  it('records line-up moves: a first sighting after the baseline is INTO the line-up, a drop OUT of it (v118)', () => {
    // Baseline: Mythril Pickaxe (10) and Ifrit Belt (11) on the line-up captains.
    saveArtifacts(CLAN, PLAYER, [art(10, 40, 20), art(11, 40, 19)], '2026-11-17T01:00:00Z');
    // Captains swapped: both leave, Chronoglyph (20) comes in.
    expect(saveArtifacts(CLAN, PLAYER, [art(20, 50, 22)], '2026-11-17T02:00:00Z')).toBe(3);
    // Nothing moved: no rows (a benched artifact is recorded leaving once).
    expect(saveArtifacts(CLAN, PLAYER, [art(20, 50, 22)], '2026-11-17T03:00:00Z')).toBe(0);
    // The belt comes back.
    expect(saveArtifacts(CLAN, PLAYER, [art(20, 50, 22), art(11, 40, 19)], '2026-11-17T04:00:00Z')).toBe(1);
    const moves = getPlayerArtifactChanges(CLAN, PLAYER, '2026-11-01T00:00:00Z').map((c) => [c.artifactType, c.lineup, c.changedAt]);
    expect(moves).toEqual([
      [11, 'in', '2026-11-17T04:00:00Z'],
      [20, 'in', '2026-11-17T02:00:00Z'],
      [10, 'out', '2026-11-17T02:00:00Z'],
      [11, 'out', '2026-11-17T02:00:00Z'],
    ]);
  });

  it('replays an archive oldest first without duplicating history, keeping the first time seen', () => {
    saveArtifacts(CLAN, PLAYER, [art(16, 50, 21)], '2026-11-17T05:00:00Z'); // the live read
    // The archive replay: two older reads, then the same latest one again.
    saveArtifacts(CLAN, PLAYER, [art(16, 48, 21)], '2026-11-15T05:00:00Z');
    saveArtifacts(CLAN, PLAYER, [art(16, 50, 21)], '2026-11-16T05:00:00Z');
    saveArtifacts(CLAN, PLAYER, [art(16, 50, 21)], '2026-11-17T05:00:00Z');
    const [a] = getPlayerArtifacts(CLAN, PLAYER);
    expect(a).toMatchObject({ level: 50, firstSeen: '2026-11-15T05:00:00Z', lastSeen: '2026-11-17T05:00:00Z' });
    // The live read now sits after an equal replayed one: not listed as a change.
    expect(getPlayerArtifactChanges(CLAN, PLAYER, '2026-11-01T00:00:00Z').map((c) => [c.prevLevel, c.level, c.changedAt]))
      .toEqual([[48, 50, '2026-11-16T05:00:00Z']]);
  });
});

describe('captain equipment', () => {
  it('re-reads only the given wearers: the hero (entry 1) without touching the captains already stored', () => {
    // Captains' gear as stored by the first replay of the whole archive (from
    // its oldest read) and the live reads since.
    saveCaptainEquipment(CLAN, PLAYER, [item(8, 3, 'u0', 4400)], '2026-11-15T05:00:00Z');
    saveCaptainEquipment(CLAN, PLAYER, [item(8, 3, 'u1', 4423)], '2026-11-17T05:00:00Z');
    const carter = () => getPlayerEquipmentChanges(CLAN, PLAYER, '2026-11-01T00:00:00Z').filter((c) => c.captainId === 8).map((c) => [c.itemType, c.changedAt]);
    const before = carter();
    // The hero-only re-read of that oldest read: Carter's older item is
    // ignored (his rows are left alone), the hero's u9 is recorded.
    const n = saveCaptainEquipment(CLAN, PLAYER, [item(8, 3, 'u0', 4400), item(1, 0, 'u9', 4501)], '2026-11-15T05:00:00Z', new Set([1]));
    expect(n).toBe(1);
    expect(getPlayerEquipment(CLAN, PLAYER).map((e) => [e.captainId, e.position, e.itemType])).toEqual([[1, 0, 4501], [8, 3, 4423]]);
    expect(carter()).toEqual(before);
  });

  it('keeps what each captain wears and a history row when an item, its gems or enchantment change, or a position empties', () => {
    expect(saveCaptainEquipment(CLAN, PLAYER, [item(8, 3, 'u1', 4423, 8408, [257]), item(8, 4, 'u2', 4430)], '2026-11-17T01:00:00Z')).toBe(2);
    expect(saveCaptainEquipment(CLAN, PLAYER, [item(8, 3, 'u1', 4423, 8408, [257]), item(8, 4, 'u2', 4430)], '2026-11-17T02:00:00Z')).toBe(0);
    // u1 gets a new gem; position 4 gets a different item; then position 4 empties.
    expect(saveCaptainEquipment(CLAN, PLAYER, [item(8, 3, 'u1', 4423, 8408, [258]), item(8, 4, 'u3', 4422)], '2026-11-17T03:00:00Z')).toBe(2);
    expect(saveCaptainEquipment(CLAN, PLAYER, [item(8, 3, 'u1', 4423, 8408, [258])], '2026-11-17T04:00:00Z')).toBe(1);

    expect(getPlayerEquipment(CLAN, PLAYER)).toEqual([
      { captainId: 8, position: 3, itemType: 4423, enchantment: 8408, gems: [258], firstSeen: '2026-11-17T01:00:00Z' },
    ]);
    expect(getPlayerEquipmentChanges(CLAN, PLAYER, '2026-11-01T00:00:00Z')).toEqual([
      { captainId: 8, position: 4, itemType: 0, prevType: 4422, reworked: false, changedAt: '2026-11-17T04:00:00Z' },
      { captainId: 8, position: 3, itemType: 4423, prevType: 4423, reworked: true, changedAt: '2026-11-17T03:00:00Z' },
      { captainId: 8, position: 4, itemType: 4422, prevType: 4430, reworked: false, changedAt: '2026-11-17T03:00:00Z' },
    ]);
  });

  it('dates an item to when it came into the position, not the first read of the position', () => {
    saveCaptainEquipment(CLAN, PLAYER, [item(8, 3, 'u1', 4423)], '2026-11-17T01:00:00Z');
    saveCaptainEquipment(CLAN, PLAYER, [item(8, 3, 'u5', 4423)], '2026-11-17T02:00:00Z');
    expect(getPlayerEquipment(CLAN, PLAYER)[0].firstSeen).toBe('2026-11-17T02:00:00Z');
  });
});

describe('archive replay bookkeeping', () => {
  it('remembers a parser version per clan', () => {
    expect(getParseMarker(CLAN, 'artifacts')).toBe(0);
    setParseMarker(CLAN, 'artifacts', 1, '2026-11-17T05:00:00Z');
    setParseMarker(CLAN, 'artifacts', 2, '2026-11-18T05:00:00Z');
    expect(getParseMarker(CLAN, 'artifacts')).toBe(2);
    expect(getParseMarker(CLAN, 'equipment')).toBe(0);
  });

  it('walks the archived replies of a kind oldest read first', () => {
    saveRawSnapshot(CLAN, 'city', 2, '2026-11-17', ['b17'], '2026-11-17T04:00:00Z');
    saveRawSnapshot(CLAN, 'city', 1, '2026-11-16', ['a16'], '2026-11-16T04:00:00Z');
    saveRawSnapshot(CLAN, 'clan_record', 0, '2026-11-15', ['x'], '2026-11-15T04:00:00Z');
    expect([...rawSnapshotsOldestFirst(CLAN, 'city')]).toEqual([
      { refId: 1, capturedAt: '2026-11-16T04:00:00Z', body: ['a16'] },
      { refId: 2, capturedAt: '2026-11-17T04:00:00Z', body: ['b17'] },
    ]);
  });

  it('lets the caller write while it walks the archive (no open cursor)', () => {
    saveRawSnapshot(CLAN, 'city', 1, '2026-11-16', ['a'], '2026-11-16T04:00:00Z');
    saveRawSnapshot(CLAN, 'city', 2, '2026-11-17', ['b'], '2026-11-17T04:00:00Z');
    let walked = 0;
    // On prod this threw "This database connection is busy executing a query".
    for (const raw of rawSnapshotsOldestFirst(CLAN, 'city')) {
      setParseMarker(CLAN, 'artifacts', raw.refId);
      walked++;
    }
    expect(walked).toBe(2);
    expect(getParseMarker(CLAN, 'artifacts')).toBe(2);
  });
});
