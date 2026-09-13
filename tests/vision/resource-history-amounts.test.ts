import { describe, it, expect } from 'vitest';
import { parseHistoryLine } from '../../src/vision/resource-ocr.js';

/**
 * Every string below is a verbatim OCR line from one 269-page production sweep of
 * the Clan Capital history list (data/exports/run_2026-07-31T12-21-19-375Z), so these
 * are the reads the parser genuinely has to survive rather than invented input.
 */
describe('resource history line parsing', () => {
  const tx = (line: string) => {
    const p = parseHistoryLine(line);
    if (p?.type !== 'transaction') throw new Error(`not a transaction: ${line}`);
    return p;
  };

  describe('thousands separators', () => {
    it('reads a comma-separated amount', () => {
      expect(tx('Queen of Chaos sent resources. +4,145,105').amount).toBe(4145105);
    });

    // PaddleOCR reads the game's comma as a period on ~0.6% of amounts. The old
    // pattern captured [\d,]+, so it stopped dead at the period and stored the
    // leading group alone — six digits lost on half of the affected rows.
    it.each([
      ['George sent resources. +25.620.000', 25620000],
      ['Aunava Dora sent resources +18.562.500', 18562500],
      ['Goblin of Chaos sent resources +10.931.622', 10931622],
      ['lon Snow sent resources. +9.100.000', 9100000],
      ['Miran sent resources. +1.247.528', 1247528],
      ['Clau sent resources. +2.000.000', 2000000],
      ['Princess of Chaos sent resources. +137.291', 137291],
      ['Megrond sent resources. +800.000', 800000],
      ['Athena sent resources. +12.804', 12804],
      ['Chaos Maid sent resources. +16.354', 16354],
    ])('reads a period-separated amount: %s', (line, expected) => {
      expect(tx(line).amount).toBe(expected);
    });

    it('reads a period-separated amount on a "took" row', () => {
      const p = tx('Morarn Il took resources -21.000');
      expect(p.amount).toBe(21000);
      expect(p.direction).toBe(-1);
    });

    it('tolerates a trailing space after the amount', () => {
      expect(tx('George sent resources. +25.620.000 ').amount).toBe(25620000);
    });
  });

  describe('does not absorb the region after the amount', () => {
    // The resource icon comes back as its OWN text region on 11% of rows, reading
    // "2", "S", "LVL" or a CJK glyph, and row text is built by joining regions with
    // a space. Accepting a space inside the number would make "+1 2" into 12.
    it.each([
      ['Mehmed II sent resources. +1 2', 1],
      ['Lady Chaos Amanda sent resources. +4 2', 4],
      ['George sent resources. +9 2', 9],
      ['Creams Chaos Pie sent resources. +2 LVL', 2],
      ['Lady Chaos Amanda sent resources. +4 园', 4],
      ['Marinn sent resources. +1 心', 1],
    ])('keeps the amount alone: %s', (line, expected) => {
      expect(tx(line).amount).toBe(expected);
    });

    it('ignores the panel close button when it lands in the row text', () => {
      expect(tx('FrostChaos sent resources. +8,820,000 X').amount).toBe(8820000);
    });
  });

  describe('rows it must still refuse', () => {
    // A mangled verb means the row cannot be trusted at all; the sweep re-reads every
    // row on ~4 consecutive pages, so refusing is cheap and guessing is not.
    it.each([
      'Fruslcllaus LookTesources -21,000 X',
      'Givigur sent Tesources. TO1,9/0,0T x',
      'nunaya Duia Jentre TAL,21J,V x',
      'Ale88 sent resources',
      'Chaosraven sent resources',
      'All players All resources',
      '-42,000',
      'X',
    ])('refuses %s', (line) => {
      const p = parseHistoryLine(line);
      expect(p?.type === 'transaction').toBe(false);
    });

    it('refuses an amount longer than any real one', () => {
      expect(parseHistoryLine('Someone sent resources. +1,234,567,890,123')?.type)
        .not.toBe('transaction');
    });
  });

  describe('other row kinds still work', () => {
    it('reads date headers', () => {
      expect(parseHistoryLine('14 DAYS AGO')).toEqual({ type: 'date-header', label: '14 DAYS AGO' });
      expect(parseHistoryLine('TODAY')).toEqual({ type: 'date-header', label: 'TODAY' });
    });

    it('reads a speedup row in hours', () => {
      const p = parseHistoryLine('taulen302 speeded up the building process by 2 d o h');
      expect(p).toMatchObject({ type: 'transaction', amount: 48, knownResourceSlug: 'clan-speedup' });
    });
  });
});
