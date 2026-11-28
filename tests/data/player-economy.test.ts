import { describe, it, expect } from 'vitest';
import { playerEconomy } from '../../src/data/player-economy.js';

describe('what a player\'s losses cost them, from their city', () => {
  // The user's own city on Nov 27 2026 (taulen): the lines as the scan stores them.
  const stats = {
    "3:Guardsmen's training cost": [-78, 0],
    "3:Specialists' training cost": [-75, 0],
    "3:Siege engines' training cost": [-76.3, 0],
    "3:Monsters' cost": [-83, 0],
    '4:Strength of entire army': [444.5, 0],
  } as Record<string, [number, number]>;
  const buildings = { 1: { type: 18, level: 44 }, 8: { type: 9, level: 45 }, 9: { type: 11, level: 45 } };

  it('reads the training discount per kind and the Temple\'s level', () => {
    expect(playerEconomy(stats, buildings, 9)).toEqual({
      training: { guardsmen: -78, specialists: -75, siege: -76.3 },
      templeLevel: 45,
      epicStrength: 0,
    });
  });

  it('reads the strength bonus against epic monsters under any effect kind', () => {
    expect(playerEconomy({ '113:Strength of your entire army against epic monsters': [544, 0] }, {}, 9).epicStrength).toBe(544);
  });

  it('leaves out what the city doesn\'t show: no line, no Temple, no Temple type known', () => {
    const e = playerEconomy({}, buildings, null);
    expect(e.training).toEqual({ guardsmen: null, specialists: null, siege: null });
    expect(e.templeLevel).toBeNull();
    expect(playerEconomy(null, { 1: { type: 18, level: 44 } }, 9).templeLevel).toBeNull();
  });
});
