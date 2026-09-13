import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/data/database.js';
import {
  clanRewardChestIds,
  clanRewardChestNames,
  clanRewardExclusionSql,
} from '../../src/data/clan-reward-chests.js';
import { makeTestDb, seedTwoClans } from '../helpers/test-db.js';

/**
 * The name→id resolver behind the clan-reward exclusion.
 *
 * Its failure mode is the mirror image of the Ragnarok zero, and worse: a
 * stranded name doesn't blank a column, it silently puts a 1006-chest placement
 * prize back onto one member's record, where a big number reads like a real
 * result. So the resolver folds a renamed chest the way resolvePredicate does,
 * and fails OPEN (excluding nothing, which is the pre-v70 behaviour) rather
 * than throwing or excluding the wrong chest.
 */

let cleanup: () => void;
beforeEach(() => {
  ({ cleanup } = makeTestDb());
  seedTwoClans();
});
afterEach(() => cleanup());

function insertChest(name: string): number {
  return (getDb().prepare(
    `INSERT INTO chests (name, chest_type) VALUES (?, 'common')
     ON CONFLICT(name) DO UPDATE SET name = excluded.name RETURNING id`,
  ).get(name) as { id: number }).id;
}

describe('clan-reward chests', () => {
  it('declares the finish rewards, and only those', () => {
    const names = clanRewardChestNames();
    expect(names).toContain('Olympus Chest');
    expect(names).toContain('Olympus Elite Chest');
    expect(names).toContain('Dark Omens ranking chest');
    // Chests members actually farm must never be in here.
    expect(names).not.toContain('Tartaros Chest');
    expect(names).not.toContain('Hermes Chest');
    expect(names).not.toContain('Dark Omens chest');   // the earned one, note the case
  });

  it('resolves declared names to chest ids', () => {
    const olympus = insertChest('Olympus Chest');
    const elite = insertChest('Olympus Elite Chest');
    insertChest('Tartaros Chest');

    const ids = clanRewardChestIds();
    expect(ids).toContain(olympus);
    expect(ids).toContain(elite);
    expect(clanRewardExclusionSql()).toContain(`${olympus}`);
    expect(clanRewardExclusionSql()).toContain(' AND chest_id NOT IN (');
    expect(clanRewardExclusionSql('c.')).toContain(' AND c.chest_id NOT IN (');
  });

  it('excludes nothing, rather than throwing, when no reward chest exists yet', () => {
    // A fresh install, or a clan that has never placed in either event.
    expect(clanRewardChestIds()).toEqual([]);
    expect(clanRewardExclusionSql()).toBe('');
  });

  it('still resolves a reward the game has renamed', () => {
    // Accent/case/punctuation fold, same tiers as resolvePredicate. A rename
    // must not quietly re-credit 1006 chests to the recipient.
    const renamed = insertChest('olympus  elite  chest');
    expect(clanRewardChestIds()).toContain(renamed);
  });

  it('never emits a fragment naming a non-integer id', () => {
    insertChest('Olympus Chest');
    // Guards the interpolation: ids are spliced in, not bound.
    expect(clanRewardExclusionSql()).toMatch(/^ AND chest_id NOT IN \(\d+(,\d+)*\)$/);
  });
});
