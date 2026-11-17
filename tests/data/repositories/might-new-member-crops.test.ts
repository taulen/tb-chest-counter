import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../../src/data/database.js';
import * as mightRepo from '../../../src/data/repositories/might-repo.js';
import { upsertMember } from '../../../src/data/repositories/member-repo.js';
import { resolveAllowedCropPath, MIGHT_NEW_MEMBER_CROP_DIR } from '../../../src/utils/crop-dirs.js';
import { makeTestDb, seedTwoClans } from '../../helpers/test-db.js';
import path from 'node:path';

/**
 * A player who joins between the roster build and their first chest is real, so a
 * might capture creates them rather than dropping the reading — and keeps a crop
 * of their member-list row as the evidence an admin acknowledges them against.
 *
 * These pin that the stored path survives and stays servable (the review queue
 * that showed it is gone: members come from the game roster now, Nov 2026).
 */
describe('might new-member evidence crops', () => {
  let cleanup: () => void;

  beforeEach(() => {
    ({ cleanup } = makeTestDb());
    seedTwoClans();
  });

  afterEach(() => cleanup());

  const cropPath = (name: string): string => path.join(MIGHT_NEW_MEMBER_CROP_DIR, name);

  it('stores the crop path on the snapshot row', () => {
    const member = upsertMember('NewJoiner', 1);
    const p = cropPath('might_new_member_newjoiner.png');

    mightRepo.saveSnapshots(1, '2026-07-31', '2026-07-31T18:00:00.000Z', [
      { memberId: member.id, might: 12_345_678, cropPath: p },
    ]);

    const row = getDb().prepare(
      'SELECT row_crop_path AS p FROM member_snapshots WHERE member_id = ? AND clan_id = 1',
    ).get(member.id) as { p: string | null };
    expect(row.p).toBe(p);
  });

  it('does not blank an existing crop when the day is re-captured', () => {
    // "Re-capture now" re-reads today. By then the member is known, so no new crop
    // is taken — and the re-run must not overwrite the original path with NULL, or
    // the acknowledgement hover would break the moment anyone forced a refresh.
    const member = upsertMember('Kept', 1);
    const p = cropPath('kept.png');

    mightRepo.saveSnapshots(1, '2026-07-31', '2026-07-31T18:00:00.000Z', [
      { memberId: member.id, might: 500, cropPath: p },
    ]);
    mightRepo.saveSnapshots(1, '2026-07-31', '2026-07-31T21:00:00.000Z', [
      { memberId: member.id, might: 600 },
    ]);

    const row = getDb().prepare(
      'SELECT power, row_crop_path AS p FROM member_snapshots WHERE member_id = ?',
    ).get(member.id) as { power: number; p: string | null };

    expect(row.power).toBe(600);
    expect(row.p).toBe(p);
  });

  it('allows the might crop directory to be served', () => {
    // The endpoint refuses any stored path outside the allow-list, so a new crop
    // directory that isn't registered there yields a 403 and an invisible feature.
    expect(resolveAllowedCropPath(cropPath('x.png'))).not.toBeNull();
    expect(resolveAllowedCropPath('/etc/passwd')).toBeNull();
    // The directory itself is not a file and must not be servable.
    expect(resolveAllowedCropPath(MIGHT_NEW_MEMBER_CROP_DIR)).toBeNull();
  });
});
