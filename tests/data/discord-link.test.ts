/**
 * /me has to know who you are, and it has to be told exactly once.
 *
 * Two things here are easy to get wrong and invisible when you do: the link
 * must be scoped to the clan (one bot token can serve several, and the same
 * person can legitimately be a different member in two of them), and the
 * autocomplete must never exceed 25 choices — Discord rejects the entire
 * response above that, so a clan with a long roster gets an autocomplete that
 * silently does nothing rather than a shortened list.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/data/database.js';
import { getLinkedMemberId, linkDiscordUser } from '../../src/data/repositories/discord-link-repo.js';
import { autocompleteMembers } from '../../src/discord/commands.js';
import { makeTestDb, seedTwoClans } from '../helpers/test-db.js';

let cleanup: () => void;
beforeEach(() => { ({ cleanup } = makeTestDb()); });
afterEach(() => cleanup());

function member(name: string, clanId = 1): number {
  const now = new Date().toISOString();
  return (getDb().prepare(
    `INSERT INTO members (clan_id, name, normalized_name, despaced_name, aliases, first_seen, last_seen, is_active)
     VALUES (?, ?, ?, ?, '[]', ?, ?, 1) RETURNING id`,
  ).get(clanId, name, name.toLowerCase(), name.toLowerCase(), now, now) as { id: number }).id;
}

describe('discord member links', () => {
  it('returns null before anyone has been linked', () => {
    expect(getLinkedMemberId(1, 'discord-1')).toBeNull();
  });

  it('remembers a link', () => {
    const id = member('Karnak');
    linkDiscordUser(1, 'discord-1', id);
    expect(getLinkedMemberId(1, 'discord-1')).toBe(id);
  });

  it('re-points an existing link instead of refusing it', () => {
    // Naming a different player is how somebody fixes a link they got wrong.
    // Refusing the second one would leave them stuck with no way to correct
    // it from Discord at all.
    const a = member('First');
    const b = member('Second');
    linkDiscordUser(1, 'discord-1', a);
    linkDiscordUser(1, 'discord-1', b);
    expect(getLinkedMemberId(1, 'discord-1')).toBe(b);
  });

  it('keeps links separate per clan', () => {
    const { clanIdA, clanIdB } = seedTwoClans();
    const inA = member('Same Person', clanIdA);
    const inB = member('Same Person', clanIdB);
    linkDiscordUser(clanIdA, 'discord-1', inA);
    linkDiscordUser(clanIdB, 'discord-1', inB);
    expect(getLinkedMemberId(clanIdA, 'discord-1')).toBe(inA);
    expect(getLinkedMemberId(clanIdB, 'discord-1')).toBe(inB);
  });

  it('is removed when the member is hard-deleted', () => {
    const id = member('Doomed');
    linkDiscordUser(1, 'discord-1', id);
    getDb().prepare('DELETE FROM members WHERE id = ?').run(id);
    expect(getLinkedMemberId(1, 'discord-1')).toBeNull();
  });
});

describe('/me player autocomplete', () => {
  it('never returns more than the 25 choices Discord accepts', () => {
    // Over the cap Discord rejects the WHOLE response, so the user sees an
    // autocomplete that does nothing at all.
    for (let i = 0; i < 60; i += 1) member(`Player ${String(i).padStart(2, '0')}`);
    expect(autocompleteMembers(1, '').length).toBe(25);
    expect(autocompleteMembers(1, 'Player').length).toBe(25);
  });

  it('puts prefix matches before substring matches', () => {
    member('Ragnar');
    member('The Ragged');
    member('Karnak the Rag');
    const names = autocompleteMembers(1, 'rag').map((c) => c.name);
    expect(names[0]).toBe('Ragnar');
    expect(names).toContain('Karnak the Rag');
  });

  it('matches case-insensitively', () => {
    member('Karnak');
    expect(autocompleteMembers(1, 'KARN').map((c) => c.name)).toContain('Karnak');
  });

  it('excludes members who are no longer on the roster', () => {
    const id = member('Departed');
    getDb().prepare('UPDATE members SET is_active = 0 WHERE id = ?').run(id);
    expect(autocompleteMembers(1, 'Dep')).toEqual([]);
  });

  it('returns an empty list rather than throwing on a clan with no members', () => {
    expect(autocompleteMembers(1, 'anything')).toEqual([]);
  });
});
