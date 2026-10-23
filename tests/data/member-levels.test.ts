import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/data/database.js';
import { parseLevelReports } from '../../src/data/member-levels-parse.js';
import * as levels from '../../src/data/repositories/member-levels-repo.js';
import { getGuardsEstimates, getClanGuardsOverview } from '../../src/data/repositories/guards-repo.js';
import { makeTestDb, seedTwoClans } from '../helpers/test-db.js';

// Lines from a real chat paste (2026-10-23), every format it used.
const CHAT = [
  'taulen: G8/M8/S7/E8/C35/D284',
  'Dark Knight: G7.M8.S7.E7.C30.D199',
  'Madoka: G8/M8/S7/E7/C/D250',
  'Craszit: G7/M7/S6/E6/C35/215',
  'BORJAº: G8/M8/C30/D249, S7',
  'DEADPOOLISADJ: G8/M8/S7/C35/D250/E -12',
  'kekko: S7/g6/m7',
  'IamNotHades: g8/m7/s7/e7/dragon 250/c25',
  'Valvakos: G8/M8/S8/E7 D 250',
  'Creams Mystery Pie: G7/M7/S6/E6/C25/D208',
  'Tish HexHavoc: G8/M8/S8(only 1 unlocked)/E8/C35/D296',
  'Ironhide: g8 m8 s 7 e 8 c35 d238',
  'Crystal: G8 M7 S6 C30 D234, D 246*',
  'Dardaen: g8 m8 s7 e6, g8m8s7e6d250',
  'Creams Mystery Pie: G7/M7/S6/E6/C30*/D209*',
  'Mami: G8/S6/M8/EK- Updated',
].join('\n');

describe('parseLevelReports', () => {
  const by = (name: string) => parseLevelReports(CHAT).players.find((p) => p.name === name)?.levels;

  it('reads every separator style the chat used', () => {
    expect(by('taulen')).toEqual({ g: 8, m: 8, s: 7, e: 8, c: 35, d: 284 });
    expect(by('Dark Knight')).toEqual({ g: 7, m: 8, s: 7, e: 7, c: 30, d: 199 });
    expect(by('Ironhide')).toEqual({ g: 8, m: 8, s: 7, e: 8, c: 35, d: 238 });
    expect(by('Dardaen')).toEqual({ g: 8, m: 8, s: 7, e: 6, d: 250 });
    expect(by('IamNotHades')).toEqual({ g: 8, m: 7, s: 7, e: 7, d: 250, c: 25 });
    expect(by('Valvakos')).toEqual({ g: 8, m: 8, s: 8, e: 7, d: 250 });
    expect(by('kekko')).toEqual({ s: 7, g: 6, m: 7 });
  });

  it('ignores what it cannot read instead of guessing', () => {
    expect(by('Madoka')).toEqual({ g: 8, m: 8, s: 7, e: 7, d: 250 }); // "C/" has no number
    expect(by('Craszit')).toEqual({ g: 7, m: 7, s: 6, e: 6, c: 35 }); // bare "/215"
    expect(by('DEADPOOLISADJ')).toEqual({ g: 8, m: 8, s: 7, c: 35, d: 250 }); // "E -12"
    expect(by('Mami')).toEqual({ g: 8, s: 6, m: 8 }); // "EK- Updated"
    expect(by('Tish HexHavoc')).toEqual({ g: 8, m: 8, s: 8, e: 8, c: 35, d: 296 });
  });

  it('lets the later value win, on a line and across repeated posts', () => {
    expect(by('Crystal')?.d).toBe(246);
    expect(by('Creams Mystery Pie')).toEqual({ g: 7, m: 7, s: 6, e: 6, c: 30, d: 209 });
    expect(parseLevelReports(CHAT).players).toHaveLength(15);
  });
});

describe('member levels import', () => {
  let cleanup: () => void;
  const TODAY = '2026-10-23';

  function addMember(name: string): number {
    const now = new Date().toISOString();
    return (getDb().prepare(
      `INSERT INTO members (clan_id, name, normalized_name, despaced_name, first_seen, last_seen, is_active)
       VALUES (1, ?, ?, ?, ?, ?, 1) RETURNING id`,
    ).get(name, name.toLowerCase(), name.toLowerCase().replace(/\s+/g, ''), now, now) as { id: number }).id;
  }

  beforeEach(() => {
    ({ cleanup } = makeTestDb());
    seedTwoClans();
  });
  afterEach(() => cleanup());

  it('matches names like the Tin Man paste does, including a misspelt one', () => {
    addMember('Mikam Chaosraven');
    const taulen = addMember('taulen');
    const rows = levels.previewLevelReports(1, parseLevelReports('taulen: G8\nMukam Chaosraven: G7/M6\nNobody Here: G6').players);
    expect(rows.map((r) => [r.rawName, r.memberName, r.matchKind])).toEqual([
      ['taulen', 'taulen', 'exact'],
      ['Mukam Chaosraven', 'Mikam Chaosraven', 'fuzzy'],
      ['Nobody Here', null, 'unmatched'],
    ]);
    expect(rows[0].memberId).toBe(taulen);
  });

  it('stores every letter, feeds G to the guards estimate, and never doubles the guards entry', () => {
    const taulen = addMember('taulen');
    const entry = { memberId: taulen, levels: { g: 8, m: 8, s: 7, e: 8, c: 35, d: 284 } };
    const first = levels.importLevelReports({ clanId: 1, date: TODAY, entries: [entry], createdBy: 'a1', createdByUserId: null });
    expect(first).toEqual({ saved: 1, guardsReports: 1, rejected: 0 });
    const again = levels.importLevelReports({ clanId: 1, date: TODAY, entries: [entry], createdBy: 'a1', createdByUserId: null });
    expect(again.guardsReports).toBe(0);
    expect(getGuardsEstimates(1).get(taulen)?.level).toBe(8);

    // A first-ever level from an entry is news: "learned", not a level-up.
    const overview = getClanGuardsOverview(1, TODAY);
    expect(overview.recentlyLearned).toEqual([{ memberId: taulen, name: 'taulen', level: 8, date: TODAY }]);
    expect(overview.recentLevelUps).toEqual([]);
  });

  it('keeps the latest value per letter — a later post leaving a letter out does not blank it', () => {
    const ace = addMember('Ace');
    levels.importLevelReports({ clanId: 1, date: '2026-10-20', entries: [{ memberId: ace, levels: { g: 7, c: 35, d: 200 } }], createdBy: 'a', createdByUserId: null });
    levels.importLevelReports({ clanId: 1, date: '2026-10-23', entries: [{ memberId: ace, levels: { g: 8, d: 210 } }], createdBy: 'a', createdByUserId: null });
    expect(levels.getLatestLevels(1)[0]).toMatchObject({
      levels: { g: 8, c: 35, d: 210 },
      asOf: { g: '2026-10-23', c: '2026-10-20', d: '2026-10-23' },
      lastReported: '2026-10-23',
    });
  });

  it('refuses a member from another clan and out-of-range levels', () => {
    const now = new Date().toISOString();
    const other = (getDb().prepare(
      `INSERT INTO members (clan_id, name, normalized_name, first_seen, last_seen, is_active)
       VALUES (2, 'Elsewhere', 'elsewhere', ?, ?, 1) RETURNING id`,
    ).get(now, now) as { id: number }).id;
    const r = levels.importLevelReports({
      clanId: 1, date: TODAY, createdBy: 'a', createdByUserId: null,
      entries: [{ memberId: other, levels: { g: 8 } }],
    });
    expect(r).toEqual({ saved: 0, guardsReports: 0, rejected: 1 });
    expect(levels.cleanLevels({ g: 12, d: 250, m: 7.5, s: '7' })).toEqual({ d: 250 });
  });
});
