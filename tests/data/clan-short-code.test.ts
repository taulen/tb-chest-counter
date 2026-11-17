/**
 * Clan short codes (v124): "CWB - ChaosWithoutBorders" splits into code +
 * name once, the label and slug stay what they were, and a rename keeps the
 * slug following the label.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/data/database.js';
import { splitClanShortCodes } from '../../src/data/clan-short-code.js';
import { createClan, getClanById, normalizeShortCode, renameClan } from '../../src/data/repositories/clan-repo.js';
import { makeTestDb } from '../helpers/test-db.js';

let cleanup: () => void;
beforeEach(() => { ({ cleanup } = makeTestDb()); });
afterEach(() => cleanup());

const insert = (id: number, name: string, slug: string) => getDb().prepare(
  `INSERT INTO clans (id, name, slug, game_url, is_active, created_at) VALUES (?, ?, ?, 'https://totalbattle.com', 1, '2026-11-01T00:00:00Z')`,
).run(id, name, slug);

describe('clan short codes', () => {
  it('splits "CWB - ChaosWithoutBorders" once, keeping the label and the slug', () => {
    insert(20, 'CWB - ChaosWithoutBorders', 'cwb-chaoswithoutborders');
    insert(21, 'SK7 - SIN CITY', 'sk7-sin-city');
    insert(22, 'Arcane Dawn', 'arcane-dawn');
    insert(23, 'A-Team - Strike', 'a-team-strike');
    expect(splitClanShortCodes(getDb())).toBe(2);
    expect(splitClanShortCodes(getDb())).toBe(0);

    const cwb = getClanById(20)!;
    expect([cwb.shortCode, cwb.baseName, cwb.name, cwb.slug]).toEqual(['CWB', 'ChaosWithoutBorders', 'CWB - ChaosWithoutBorders', 'cwb-chaoswithoutborders']);
    expect(getClanById(21)!.shortCode).toBe('SK7');
    // No "<code> - " prefix: left alone.
    expect([getClanById(22)!.shortCode, getClanById(22)!.name]).toEqual(['', 'Arcane Dawn']);
    expect(getClanById(23)!.shortCode).toBe('');
  });

  it('creates and renames with a short code; the slug follows the label', () => {
    const c = createClan({ name: 'Arcane Dawn', shortCode: 'ARD' });
    expect([c.name, c.baseName, c.shortCode, c.slug]).toEqual(['ARD - Arcane Dawn', 'Arcane Dawn', 'ARD', 'ard-arcane-dawn']);
    renameClan(c.id, 'Arcane Dusk', 'ARK');
    expect([getClanById(c.id)!.name, getClanById(c.id)!.slug]).toEqual(['ARK - Arcane Dusk', 'ark-arcane-dusk']);
    renameClan(c.id, 'Arcane Dusk', '');
    expect(getClanById(c.id)!.name).toBe('Arcane Dusk');
  });

  it('accepts 1–8 letters or digits as a short code', () => {
    expect(normalizeShortCode(' CWB ')).toBe('CWB');
    expect(normalizeShortCode('SK7')).toBe('SK7');
    expect(normalizeShortCode('')).toBe('');
    expect(normalizeShortCode(undefined)).toBe('');
    expect(normalizeShortCode('TOO-LONG-CODE')).toBeNull();
    expect(normalizeShortCode('A B')).toBeNull();
  });
});
