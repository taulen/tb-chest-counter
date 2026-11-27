/**
 * What the clan won, from the ledger's kind 5/8 entries. The entries are real
 * ones from prod's game_ledger (Nov 2026).
 */
import { describe, expect, it } from 'vitest';
import { pickClanWinnings, WINNINGS_AFTER_MS, WINNINGS_BEFORE_MS, type WonEntry } from '../../src/data/clan-winnings.js';

const NAMES: Record<string, string> = {
  20: 'Scientific Tractates',
  31: 'Dragon Coins',
  701216: 'Torch of Olympus Clan Fragment',
  701220: 'Chronoglyph Clan Fragment',
};
const itemName = (id: string) => NAMES[id] ?? '';
const at = (iso: string) => Date.parse(iso) / 1000;
const entry = (iso: string, amounts: Record<string, number>): WonEntry => ({ occurredAt: at(iso), amounts });

/** CWB's Olympus win: the run ended at 17:00 in the calendar, 18:00 in the game. */
const CWB_OLYMPUS = [
  entry('2026-11-06T18:00:19Z', { 701216: 700 }),
  entry('2026-11-06T18:00:19Z', { 31: 525000 }),
  entry('2026-11-06T18:00:19Z', { 20: 27500000 }),
];

describe('pickClanWinnings', () => {
  it('reads the Olympus win an hour after the calendar says the run ended', () => {
    expect(pickClanWinnings(CWB_OLYMPUS, Date.parse('2026-11-06T17:00:00Z'), itemName)).toEqual({
      creditedAt: '2026-11-06T18:00:19.000Z',
      coins: 525000,
      fragments: [{ itemId: 701216, name: 'Torch of Olympus Clan Fragment', amount: 700 }],
    });
  });

  it('a win with no fragment (an SK Ragnarök) has coins only', () => {
    const sk = [entry('2026-11-25T17:01:11Z', { 31: 262500 }), entry('2026-11-25T17:01:11Z', { 20: 27500000 })];
    expect(pickClanWinnings(sk, Date.parse('2026-11-25T17:00:00Z'), itemName)).toEqual({
      creditedAt: '2026-11-25T17:01:11.000Z', coins: 262500, fragments: [],
    });
  });

  it('nothing in the window is no win', () => {
    expect(pickClanWinnings([], Date.parse('2026-11-06T17:00:00Z'), itemName)).toBeNull();
  });

  it('takes the credit nearest the run end when two fall in the window', () => {
    const twoWins = [
      entry('2026-11-06T17:00:09Z', { 31: 100000 }),
      entry('2026-11-06T17:00:09Z', { 701220: 300 }),
      ...CWB_OLYMPUS,
    ];
    const omens = pickClanWinnings(twoWins, Date.parse('2026-11-06T17:00:00Z'), itemName);
    expect(omens?.coins).toBe(100000);
    expect(omens?.fragments).toEqual([{ itemId: 701220, name: 'Chronoglyph Clan Fragment', amount: 300 }]);
    expect(pickClanWinnings(twoWins, Date.parse('2026-11-06T18:00:00Z'), itemName)?.coins).toBe(525000);
  });

  it('entries a few seconds apart are one credit, summed per item', () => {
    const split = [entry('2026-11-06T18:00:19Z', { 31: 500000 }), entry('2026-11-06T18:00:41Z', { 31: 25000, 701216: 700 })];
    expect(pickClanWinnings(split, Date.parse('2026-11-06T18:00:00Z'), itemName)).toMatchObject({
      creditedAt: '2026-11-06T18:00:19.000Z', coins: 525000,
    });
  });

  it('without item names no fragment is recognised, coins still are', () => {
    expect(pickClanWinnings(CWB_OLYMPUS, Date.parse('2026-11-06T17:00:00Z'), () => '')).toMatchObject({ coins: 525000, fragments: [] });
  });

  it('the window reaches the game\'s hour-later reset from the calendar\'s end', () => {
    expect(WINNINGS_BEFORE_MS).toBeGreaterThanOrEqual(3_600_000);
    expect(WINNINGS_AFTER_MS).toBeGreaterThan(3_600_000 + 60_000);
  });
});
