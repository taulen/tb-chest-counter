import { describe, it, expect } from 'vitest';
import { exactMatchMember } from '../../src/utils/fuzzy.js';
import type { ClanMember } from '../../src/models/types.js';

/**
 * exactMatchMember: a name or alias, case- and accent-folded, nothing looser.
 * The edit-distance matcher and the spacing-insensitive pass (built for OCR
 * misreads) are gone — names come from the game exactly.
 */
/**
 * Build a member the way the database actually stores one.
 *
 * `normalizedName` is LOWERCASED here because that is what member-repo writes
 * (`normalizeName` = trim + toLowerCase + collapse whitespace). The previous
 * fixture passed the name through with its capitalisation intact, which is a
 * shape production never produces — and that is precisely why the
 * case-divergence guard could compare against the wrong field for months while
 * every test below still passed. Keep this lowercased.
 */
const mk = (name: string, id: number, aliases: string[] = []): ClanMember => ({
  id,
  name,
  normalizedName: name.trim().toLowerCase().replace(/\s+/g, ' '),
  aliases,
  firstSeen: '2026-01-01', lastSeen: '2026-07-27', isActive: true,
});

const ROSTER: ClanMember[] = [
  'LizDidntDoIt', 'Toupie', 'Archraven', 'Megrond', 'Nimath', 'Frostterror',
  'Crème À la mode Pie', 'Warrior 1977', 'Glorgol', 'Melmaran', 'alex21rus',
].map((n, i) => mk(n, i + 1));

describe('exactMatchMember', () => {
  it('matches case- and accent-insensitively, on aliases too', () => {
    expect(exactMatchMember('melmaran', ROSTER)?.name).toBe('Melmaran');
    expect(exactMatchMember('Mel', [mk('Melmaran', 1, ['Mel'])])?.name).toBe('Melmaran');
    expect(exactMatchMember('Creme A la mode Pie', ROSTER)?.name).toBe('Crème À la mode Pie');
    expect(exactMatchMember('', ROSTER)).toBeNull();
  });

  it('never matches a name that is merely close', () => {
    expect(exactMatchMember('Bardin', [mk('Bain', 74)])).toBeNull();
    expect(exactMatchMember('FELI 2', [mk('FELI', 1)])).toBeNull();
  });

  it('never matches across spacing: "Ra ven" and "Raven" are two players', () => {
    expect(exactMatchMember('Raven', [mk('Ra ven', 1)])).toBeNull();
    const roster = [mk('Raven', 1), mk('Ra ven', 2)];
    expect(exactMatchMember('Ra ven', roster)?.id).toBe(2);
    expect(exactMatchMember('raven', roster)?.id).toBe(1);
  });
});
