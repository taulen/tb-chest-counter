import { describe, expect, it } from 'vitest';
import { parseTinmanStandings } from '../../src/data/tinman-parse.js';

// Lines from a real paste (2026-10-23), markdown table as copied.
const MARKDOWN = `
| Rank | Name | Points |
| :--- | :--- | :--- |
| 1 | Fiin SK 2 | 63,965,364 |
| 2 | Frostbite | 59,878,655 |
| 41 | Störtebeker | 3,511,613 |
| 60 | MиkaM Chaosraven | 511,824 |
| 80 | FENRØTH ØF CHAØS | 0 |
| 98 | STRUGGLE 1 | 0 |
| 100 | kekko | 0 |
`;

describe('parseTinmanStandings', () => {
  it('reads a markdown table, skipping its header and rule', () => {
    const { rows, skipped } = parseTinmanStandings(MARKDOWN);
    expect(skipped).toEqual([]);
    expect(rows).toEqual([
      { rank: 1, name: 'Fiin SK 2', points: 63_965_364 },
      { rank: 2, name: 'Frostbite', points: 59_878_655 },
      { rank: 41, name: 'Störtebeker', points: 3_511_613 },
      { rank: 60, name: 'MиkaM Chaosraven', points: 511_824 },
      { rank: 80, name: 'FENRØTH ØF CHAØS', points: 0 },
      { rank: 98, name: 'STRUGGLE 1', points: 0 },
      { rank: 100, name: 'kekko', points: 0 },
    ]);
  });

  it('reads tab-separated spreadsheet rows', () => {
    const { rows } = parseTinmanStandings('Rank\tName\tPoints\n1\tFiin SK 2\t63965364\n2\tTASH II\t43.716.208');
    expect(rows).toEqual([
      { rank: 1, name: 'Fiin SK 2', points: 63_965_364 },
      { rank: 2, name: 'TASH II', points: 43_716_208 },
    ]);
  });

  it('reads plain lines without eating a number at the end of a name', () => {
    const { rows } = parseTinmanStandings('1. Fiin SK 2 63,965,364\n98 STRUGGLE 1 0\n3 taulen 48 161 026');
    expect(rows).toEqual([
      { rank: 1, name: 'Fiin SK 2', points: 63_965_364 },
      { rank: 98, name: 'STRUGGLE 1', points: 0 },
      { rank: 3, name: 'taulen', points: 48_161_026 },
    ]);
  });

  it('reports lines it could not read instead of dropping them silently', () => {
    const { rows, skipped } = parseTinmanStandings('| 1 | Ace | 10,063,193 |\nsome chatter here\n| x | broken |');
    expect(rows).toHaveLength(1);
    expect(skipped).toEqual(['some chatter here', '| x | broken |']);
  });
});
