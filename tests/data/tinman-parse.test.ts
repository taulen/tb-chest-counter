import { describe, expect, it } from 'vitest';
import { parseTinmanStandings, missingRanks, parseTierTargets } from '../../src/data/tinman-parse.js';

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

  it('reads a CSV export with quoted points', () => {
    // Lines from a real SK7 paste (2026-11-14) that read as nothing before.
    const csv = [
      'Rank,Name,Points',
      '1,Ariron SK,"3,279,585"',
      '5,Sergio Magaña,"266,327"',
      '10,Fiin SK 3,"239,421"',
      '46,Tojalkis 007,"45,515"',
      '71,Störtebeker 260 SK,"14,083"',
      '73,taulen K260 SK,0',
    ].join('\r\n');
    const { rows, skipped } = parseTinmanStandings(csv);
    expect(skipped).toEqual([]);
    expect(rows).toEqual([
      { rank: 1, name: 'Ariron SK', points: 3_279_585 },
      { rank: 5, name: 'Sergio Magaña', points: 266_327 },
      { rank: 10, name: 'Fiin SK 3', points: 239_421 },
      { rank: 46, name: 'Tojalkis 007', points: 45_515 },
      { rank: 71, name: 'Störtebeker 260 SK', points: 14_083 },
      { rank: 73, name: 'taulen K260 SK', points: 0 },
    ]);
  });

  it('reads CSV without quotes, quoted names, and semicolon CSV', () => {
    const { rows, skipped } = parseTinmanStandings([
      '1,Ariron SK,3,279,585',
      '10,Fiin SK 3,239,421',
      '"11","Smith, John","1,000"',
      '12;Sombrita K260 SK;224.811',
      'Zorro,"172,737"',
      '"Bob ""Ace"" Jr",500',
    ].join('\n'));
    expect(skipped).toEqual([]);
    expect(rows).toEqual([
      { rank: 1, name: 'Ariron SK', points: 3_279_585 },
      { rank: 10, name: 'Fiin SK 3', points: 239_421 },
      { rank: 11, name: 'Smith, John', points: 1_000 },
      { rank: 12, name: 'Sombrita K260 SK', points: 224_811 },
      { rank: 5, name: 'Zorro', points: 172_737 },
      { rank: 6, name: 'Bob "Ace" Jr', points: 500 },
    ]);
  });

  it('reads chat-style lists: separators, units, bold and medals', () => {
    const { rows, skipped } = parseTinmanStandings([
      '🥇 **Ariron SK** – 3,279,585 points',
      '#2 Frostbite sk7: 2,385,257 pts',
      '3) DragonFly K260 SK7 - 437,542',
      '4.Mean Lucifer = 281,574',
      '| 5 | **Sergio Magaña** | **266,327** |',
      '6. Kobe 260 SK7\t265,399',
      'Chenzo — 137,999 Punkte',
    ].join('\n'));
    expect(skipped).toEqual([]);
    expect(rows).toEqual([
      { rank: 1, name: 'Ariron SK', points: 3_279_585 },
      { rank: 2, name: 'Frostbite sk7', points: 2_385_257 },
      { rank: 3, name: 'DragonFly K260 SK7', points: 437_542 },
      { rank: 4, name: 'Mean Lucifer', points: 281_574 },
      { rank: 5, name: 'Sergio Magaña', points: 266_327 },
      { rank: 6, name: 'Kobe 260 SK7', points: 265_399 },
      { rank: 7, name: 'Chenzo', points: 137_999 },
    ]);
  });

  it('never reads a number at the end of a name into mixed-separator points', () => {
    const { rows } = parseTinmanStandings('10 Fiin SK 3 239,421\nFiin SK 3 239.421\nAgent 007, 1,234');
    expect(rows).toEqual([
      { rank: 10, name: 'Fiin SK 3', points: 239_421 },
      { rank: 2, name: 'Fiin SK 3', points: 239_421 },
      { rank: 3, name: 'Agent 007', points: 1_234 },
    ]);
  });

  it('skips headers in other wordings', () => {
    const { rows, skipped } = parseTinmanStandings('"Rank","Name","Points"\n# | Player | Score\nPos;Member;Damage\n1,Ace,10');
    expect(skipped).toEqual([]);
    expect(rows).toEqual([{ rank: 1, name: 'Ace', points: 10 }]);
  });

  it('keeps unreadable names apart instead of merging them into one player', () => {
    // From the CWB paste (2026-10-23): two stand-ins on different ranks.
    const { rows } = parseTinmanStandings('| 24 | rerw | 0 |\n| 25 | *(Name not visible)* | 0 |\n| 54 | *(Name not visible)* | 0 |');
    expect(rows.map((r) => r.name)).toEqual([
      'rerw',
      '(name not visible · rank 25)',
      '(name not visible · rank 54)',
    ]);
  });

  it('finds the ranks a copy skipped', () => {
    // The CWB paste jumped 12 → 14 and 18 → 20.
    const { rows } = parseTinmanStandings('| 12 | Lil Chaos | 102,797 |\n| 14 | John Wick | 70,537 |\n| 18 | Isabeau dAnjou | 3,178 |\n| 20 | Sweet Cheeks | 0 |');
    expect(missingRanks(rows)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 16, 17, 19]);
  });

  it('reports lines it could not read instead of dropping them silently', () => {
    const { rows, skipped } = parseTinmanStandings('| 1 | Ace | 10,063,193 |\nsome chatter here\n| x | broken |');
    expect(rows).toHaveLength(1);
    expect(skipped).toEqual(['some chatter here', '| x | broken |']);
  });
});

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
});
