/**
 * Troop cards from a march's effects (troop-effects.ts): every strength (kind
 * 4) and health (kind 5) line of the general condition whose unit targets hold
 * the troop. The rows are made-up T20 rows in the game's shape.
 */
import { describe, expect, it } from 'vitest';
import { buildTroopEffects, troopCard } from '../../src/game-protocol/troop-effects.js';
import type { Wire } from '../../src/game-protocol/codec.js';

// Vectors: 1 → flying units (206 Corax I, 214 Royal Lion I), 2 → guardsmen (206), 3 → empty.
const VECTORS: Record<number, Wire[]> = { 1: [206, 214], 2: [206], 3: [] };
const vec = (ref: Wire) => (typeof ref === 'number' ? VECTORS[ref] : undefined);
const line = (kind: number, target: number, cond: number[], pct: number): Wire[] => [kind, target, [], cond, 0, 10000 + pct * 100, 0];
const T20: Record<string, Wire> = {
  // "Flying units' strength +50%" and health +40%.
  100: [100, 0, 0, [line(4, 1, [2786], 50), line(5, 1, [2786], 40)]],
  // "Guardsmen's strength +30%".
  101: [101, 0, 0, [line(4, 2, [2786], 30)]],
  // Every unit: strength +10% (an empty target).
  102: [102, 0, 0, [line(4, 3, [2786], 10)]],
  // Situational: only against monsters — not on the card.
  103: [103, 0, 0, [line(4, 3, [71285], 500)]],
  // Not strength or health (march speed): left out of the table.
  104: [104, 0, 0, [line(8, 3, [2786], 25)]],
};

describe('the troop-effects table', () => {
  const table = buildTroopEffects(T20, vec, 'test');

  it('keeps every strength and health line of the general condition, with its unit targets shared', () => {
    expect(table.effects['100']).toEqual([[4, 0, 50], [5, 0, 40]]);
    expect(table.effects['101']).toEqual([[4, 1, 30]]);
    expect(table.effects['102']).toEqual([[4, -1, 10]]);
    expect(table.targets).toEqual([[206, 214], [206]]);
  });

  it('leaves out situational lines and other kinds', () => {
    expect(table.effects['103']).toBeUndefined();
    expect(table.effects['104']).toBeUndefined();
  });

  it('adds a troop’s card up from a march’s effects, counted', () => {
    const effects = [{ id: 100, count: 1 }, { id: 101, count: 2 }, { id: 102, count: 1 }, { id: 103, count: 1 }, { id: 999, count: 1 }];
    expect(troopCard(table, effects, 206)).toEqual({ strength: 50 + 60 + 10, health: 40 });
    expect(troopCard(table, effects, 214)).toEqual({ strength: 50 + 10, health: 40 });
    expect(troopCard(table, effects, 87)).toEqual({ strength: 10, health: 0 });
  });

  it('finds the general condition by majority, so a renumbered one still works', () => {
    const renumbered: Record<string, Wire> = {
      1: [1, 0, 0, [line(4, 2, [9999], 30), line(5, 2, [9999], 20)]],
      2: [2, 0, 0, [line(4, 2, [9999], 5), line(4, 2, [7], 400)]],
    };
    const t = buildTroopEffects(renumbered, vec, 'test');
    expect(troopCard(t, [{ id: 1, count: 1 }, { id: 2, count: 1 }], 206)).toEqual({ strength: 35, health: 20 });
  });
});
