import { describe, expect, it } from 'vitest';
import { parseTierTargets } from '../../src/data/tinman-parse.js';

// The Ancient planner's "Points per member" card, copied as-is (2026-10-23).
const PLANNER_TABLE = [
  'Points per member',
  'Rise of the Ancients',
  '',
  'For 3 kills, already lowered for a 15% overshoot.',
  'Tier\tMembers\tPoints each\tTier total\tShare',
  'T9 \t0 members \t107M \t— \t0.0%',
  'G9 \t6 members \t61.3M \t368M \t19.2%',
  'G8 \t33 members \t27.2M \t898M \t46.9%',
  'G7 \t59 members \t10.9M \t643M \t33.5%',
  'G6 \t2 members \t4.36M \t8.71M \t0.5%',
  'G4 \t0 members \t484K \t— \t0.0%',
  'G1 \t0 members \t6.05K \t— \t0.0%',
].join('\n');

describe('parseTierTargets', () => {
  it('reads points each per tier and the kill count from the planner card', () => {
    expect(parseTierTargets(PLANNER_TABLE)).toEqual({
      tiers: { t9: 107e6, g9: 61.3e6, g8: 27.2e6, g7: 10.9e6, g6: 4.36e6, g4: 484e3, g1: 6050 },
      kills: 3,
      skipped: [],
    });
  });

  it('reads the table copied from a translated planner', () => {
    const translated = (members: string, kills: string) => [
      kills,
      `G9 \t6 ${members} \t61.3M \t368M \t19.2%`,
      `G8 \t1 ${members} \t27.2M \t27.2M \t46.9%`,
    ].join('\n');
    for (const [members, kills] of [
      ['miembros', 'Para 3 muertes, ya reducido para un excedente del 15%.'],
      ['membres', 'Pour 3 éliminations, déjà réduit pour un dépassement de 15 %.'],
      ['участников', 'Для 3 убийств, уже уменьшено с учётом перевыполнения на 15%.'],
      ['Mitglieder', 'Für 3 Kills, bereits um 15 % Überschuss verringert.'],
    ]) {
      expect(parseTierTargets(translated(members, kills)), members).toEqual({
        tiers: { g9: 61.3e6, g8: 27.2e6 }, kills: 3, skipped: [],
      });
    }
  });

  it('reads plain and markdown lines too', () => {
    expect(parseTierTargets('G9 61.3M\nG8 27,200,000\n| G7 | 59 members | 10.9M | 643M | 33.5% |').tiers)
      .toEqual({ g9: 61.3e6, g8: 27.2e6, g7: 10.9e6 });
  });

  it('reads short hand-typed lines in any case', () => {
    expect(parseTierTargets('g7 1.3m\ng6 600k\nG5 250K')).toEqual({
      tiers: { g7: 1.3e6, g6: 600e3, g5: 250e3 }, kills: null, skipped: [],
    });
  });
});
