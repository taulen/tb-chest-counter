import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../../src/data/database.js';
import * as mightRepo from '../../../src/data/repositories/might-repo.js';
import { getMemberEvidenceCropPath, upsertMember } from '../../../src/data/repositories/member-repo.js';
import { getReviewQueue } from '../../../src/data/repositories/review-queue-repo.js';
import { resolveAllowedCropPath, MIGHT_NEW_MEMBER_CROP_DIR } from '../../../src/utils/crop-dirs.js';
import { makeTestDb, seedTwoClans } from '../../helpers/test-db.js';
import path from 'node:path';

/**
 * A player who joins between the roster build and their first chest is real, so a
 * might capture creates them rather than dropping the reading — and keeps a crop
 * of their member-list row as the evidence an admin acknowledges them against.
 *
 * These pin the three things that have to line up for that hover to work: the
 * path is stored, the review queue advertises it, and the resolver finds it.
 */
describe('might new-member evidence crops', () => {
  let cleanup: () => void;

  beforeEach(() => {
    ({ cleanup } = makeTestDb());
    seedTwoClans();
  });

  afterEach(() => cleanup());

  const cropPath = (name: string): string => path.join(MIGHT_NEW_MEMBER_CROP_DIR, name);

  it('stores the crop path and surfaces it as the member evidence', () => {
    const member = upsertMember('NewJoiner', 1);
    const p = cropPath('might_new_member_newjoiner.png');

    mightRepo.saveSnapshots(1, '2026-07-31', '2026-07-31T18:00:00.000Z', [
      { memberId: member.id, might: 12_345_678, cropPath: p },
    ]);

    expect(getMemberEvidenceCropPath(member.id, 1)).toBe(p);
    // Clan-scoped: another clan's admin must not reach it by guessing the id.
    expect(getMemberEvidenceCropPath(member.id, 2)).toBeNull();
  });

  it('marks the review-queue entry as having a crop', () => {
    const withCrop = upsertMember('HasCrop', 1);
    const without = upsertMember('NoCrop', 1);

    mightRepo.saveSnapshots(1, '2026-07-31', '2026-07-31T18:00:00.000Z', [
      { memberId: withCrop.id, might: 1_000_000, cropPath: cropPath('a.png') },
      { memberId: without.id, might: 2_000_000 },
    ]);

    const entries = getReviewQueue(1).members.entries;
    expect(entries.find((e) => e.value === 'HasCrop')?.hasCrop).toBe(true);
    expect(entries.find((e) => e.value === 'NoCrop')?.hasCrop).toBe(false);
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
