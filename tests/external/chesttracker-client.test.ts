import { describe, expect, it } from 'vitest';
import { parseCountsPayload } from '../../src/external/chesttracker-client.js';

// chesttracker.com's counts endpoint changed shape around Nov 2026: the
// bare [players, definitions, schema] tuple became an envelope carrying the
// clan's settings too. The strict tuple check rejected every response, and
// a clan added then (VRG, clan 6) got a "completed" backfill with nothing in
// it. Both shapes must parse; anything else must say what it got.
const players = [{ name: 'Alice', guardsLevel: 8, points: 120, chests: 2, 'rare crypt': { chests: 2 } }];
const definitions = [{ type: 'Rare Crypt', name: 'Sand Chest', source: 'Level 25 Rare Crypt', points: 50, override: { points: 10 } }];
const schema = { 'rare crypt': { 'level 25 rare crypt': {} } };

describe('parseCountsPayload', () => {
  it('reads the current { clan, window, counts } envelope', () => {
    const clan = { id: 'c1', name: 'Test Clan', status: 'active', settings: { requirement: [{ points: 6700 }] } };
    const out = parseCountsPayload({
      clan,
      window: { start: '2026-11-15T17:00:00.000Z', end: '2026-11-22T17:00:00.000Z', duration: 7 },
      counts: [players, definitions, schema, [{ points: 6700 }]],
    });
    expect(out.counts[0]).toEqual(players);
    expect(out.counts[1]).toEqual(definitions);
    expect(out.clan).toEqual(clan);
  });

  it('still reads the legacy bare tuple, with no clan block', () => {
    const out = parseCountsPayload([players, definitions, schema]);
    expect(out.counts[0]).toEqual(players);
    expect(out.clan).toBeNull();
  });

  it('accepts an envelope whose clan block is missing', () => {
    const out = parseCountsPayload({ counts: [players, definitions, schema] });
    expect(out.clan).toBeNull();
  });

  it('names the keys of an object it does not recognise', () => {
    expect(() => parseCountsPayload({ clan: {}, rows: [] })).toThrow(/keys: clan, rows/);
  });

  it('rejects other shapes with what it got', () => {
    expect(() => parseCountsPayload([players, definitions])).toThrow(/an array of 2/);
    expect(() => parseCountsPayload(null)).toThrow(/null/);
    expect(() => parseCountsPayload('nope')).toThrow(/string/);
  });
});
