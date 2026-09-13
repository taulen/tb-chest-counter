/**
 * The might capture's reading → member decision, which is where this feature's
 * one real bug lived.
 *
 * `resolveMember` is the only thing standing between an OCR reading of the in-game
 * member list and a new `members` row, and until now it consulted the roster and
 * nothing else. Player merge rules — the admin explicitly stating "this reading IS
 * that player" — were read in exactly one place in the whole codebase, the gift
 * scan, so a rule an admin had already written was ignored here and the duplicate
 * member it existed to prevent was re-created on the next daily capture. Every day.
 *
 * It survived because this decision was only reachable through a live browser page:
 * `runMightCapturePhase` needs a Playwright `Page`, so nothing tested the resolution
 * itself, and the tests that do exist enter below it with an already-resolved member
 * id (see tests/data/repositories/might-new-member-crops.test.ts).
 *
 * The four production readings caught by it are used verbatim below. Not one is
 * reachable by edit distance — 3, 3, 1-onto-an-already-claimed-member and 3 against
 * a budget of 2 — so no change to the fuzzy matcher could have covered for the
 * missing rule lookup. See tests/utils/fuzzy.test.ts for why the budget stays put.
 *
 * Rules are inserted as ROWS here rather than through `addMergeRule`, deliberately.
 * That function now also records the rule as an alias of its destination, which is
 * the other half of the fix and resolves these readings all by itself — so going
 * through it would hide whether the canonicaliser works at all. A bare row is also
 * the true state of the twenty rules already on the live roster: they were written
 * before any of this existed.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveMember } from '../../src/scheduler/might-capture-phase.js';
import { nameMatchCandidates } from '../../src/browser/might-capture.js';
import { loadPlayerNameCanonicaliser } from '../../src/data/repositories/merge-repo.js';
import { getAllMembers, upsertMember } from '../../src/data/repositories/member-repo.js';
import { getDb } from '../../src/data/database.js';
import type { ClanMember } from '../../src/models/types.js';
import { makeTestDb, seedChestData } from '../helpers/test-db.js';

describe('might capture: resolving a reading to a member', () => {
  let cleanup: () => void;
  const clanId = 1;

  /** No rules consulted — what this path did before the fix. */
  const noRules = (name: string): string => name;

  /** A rule row, with none of addMergeRule's alias or data-merge side effects. */
  const seedRule = (from: string, to: string): void => {
    getDb().prepare(
      `INSERT INTO merge_rules (clan_id, type, from_value, to_value, created_at)
       VALUES (?, 'player', ?, ?, '2026-08-11')`,
    ).run(clanId, from, to);
  };

  const resolve = (
    name: string,
    canonicalise: (n: string) => string,
  ): { name: string; exact: boolean } | null => {
    const members = getAllMembers(true, clanId);
    const inactive = getAllMembers(false, clanId).filter((m: ClanMember) => !m.isActive);
    const hit = resolveMember(name, members, inactive, nameMatchCandidates, canonicalise);
    return hit ? { name: hit.member.name, exact: hit.exact } : null;
  };

  beforeEach(() => {
    const t = makeTestDb();
    cleanup = t.cleanup;
    seedChestData();
  });

  afterEach(() => cleanup());

  it('resolves a reading a merge rule covers, and would not without one', () => {
    upsertMember('Mikam Chaosraven', clanId);
    seedRule('Ma Chaosraven', 'Mikam Chaosraven');

    // The bug: with no rule lookup this reading matches nothing, and the caller
    // creates a member for it — the duplicate that kept coming back.
    expect(resolve('Ma Chaosraven', noRules)).toBeNull();

    expect(resolve('Ma Chaosraven', loadPlayerNameCanonicaliser(clanId)))
      .toEqual({ name: 'Mikam Chaosraven', exact: true });
  });

  it('resolves it even while the duplicate member row is still on the roster', () => {
    // The state the live roster is in right now, and the reason the alias
    // `addMergeRule` writes is not enough on its own: `upsertMember` and
    // `exactMatchMember` both find a member's OWN name before any alias, so as long
    // as a row called "Ma Chaosraven" exists the reading resolves to IT. Only the
    // rule, applied to the reading before any matching, sends it to the right player.
    const real = upsertMember('Mikam Chaosraven', clanId);
    const duplicate = upsertMember('Ma Chaosraven', clanId);
    expect(duplicate.id).not.toBe(real.id);
    seedRule('Ma Chaosraven', 'Mikam Chaosraven');

    expect(resolve('Ma Chaosraven', noRules)?.name).toBe('Ma Chaosraven');
    expect(resolve('Ma Chaosraven', loadPlayerNameCanonicaliser(clanId))?.name)
      .toBe('Mikam Chaosraven');
  });

  it('resolves a hero level read into the name, with no rule needed', () => {
    // A badge merged into the name needs no merge rule at all — splitBadgeAndName
    // removes it, and nameMatchCandidates offers the bare name either way. That is
    // the fix that matters here, because a rule could only ever cover the levels the
    // player has already been seen at: "370/ WrongPortal", "372/ WrongPortal" and
    // "373/ WrongPortal" each minted a member on the live roster and each got its own
    // rule, and the next level-up would have minted the next one.
    upsertMember('taulen302', clanId);

    expect(nameMatchCandidates('185/ taulen302')).toContain('taulen302');
    expect(resolve('185/ taulen302', noRules)?.name).toBe('taulen302');

    // A level never seen before therefore also resolves, which is the whole point.
    upsertMember('WrongPortal', clanId);
    expect(resolve('374/ WrongPortal', noRules)?.name).toBe('WrongPortal');
  });

  it('reports a rule hit as EXACT, so it can never be promoted to a new player', () => {
    // The claim loop treats a FUZZY match onto an already-claimed member as somebody
    // else and creates a member for it. That branch is what turned "FENRØTH Øf CHAOS"
    // into a fresh row every day: it is 1 edit from "FENRØTH Øf CHAØS", whose row had
    // already been claimed by a cleaner reading. A rule hit must be exact or the same
    // thing happens with the rule in place.
    upsertMember('FENRØTH Øf CHAØS', clanId);
    seedRule('FENRØTH Øf CHAOS', 'FENRØTH Øf CHAØS');

    expect(resolve('FENRØTH Øf CHAOS', noRules)?.exact).toBe(false);
    expect(resolve('FENRØTH Øf CHAOS', loadPlayerNameCanonicaliser(clanId)))
      .toEqual({ name: 'FENRØTH Øf CHAØS', exact: true });
  });

  it('creates the rule destination rather than a member two edits from it', () => {
    // A rule whose destination is not on the roster must not fall through to the
    // distance tier: that would land the row on whoever happens to sit within the
    // budget of the DESTINATION — a member neither the reading nor the rule named.
    // Returning null makes the caller create the admin's own spelling, which shows up
    // in the review queue where they can see it.
    upsertMember('Mikam Chaosravel', clanId);
    seedRule('Ma Chaosraven', 'Mikam Chaosraven');

    expect(resolve('Ma Chaosraven', loadPlayerNameCanonicaliser(clanId))).toBeNull();
  });

  it('leaves a reading no rule covers exactly as it was', () => {
    // The rule lookup must not disturb the matching this path already did. Everything
    // here is pre-existing behaviour, asserted with the canonicaliser in place.
    upsertMember('RebelTurk', clanId);
    upsertMember('Bardin', clanId);
    seedRule('Ma Chaosraven', 'Mikam Chaosraven');
    const canonicalise = loadPlayerNameCanonicaliser(clanId);

    expect(resolve('RebelTurk', canonicalise)).toEqual({ name: 'RebelTurk', exact: true });
    // One edit of real OCR damage still resolves, by distance.
    expect(resolve('RebenTurk', canonicalise)).toEqual({ name: 'RebelTurk', exact: false });
    // And a genuinely new player is still new.
    expect(resolve('Someone Entirely New', canonicalise)).toBeNull();
  });
});
