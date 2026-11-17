// The game's own names in the site's other languages (game-texts.ts), from a
// miniature of the static data and hand-made CSV rows — no game data.

import { describe, expect, it } from 'vitest';
import type { Wire } from '../../src/game-protocol/codec.js';
import {
  TABLE_GIFT_TYPES,
  TABLE_MAP_OBJECTS,
  buildNamesInLanguages,
  parseTranslationsCsv,
} from '../../src/game-protocol/static-data.js';
import { TABLE_CLIENT_CONFIG } from '../../src/game-protocol/client-config.js';
import {
  UI_TEXT_KEYS,
  buildGameTexts,
  fillPattern,
  labelTexts,
  localQuotes,
  pairTexts,
  type TextPairs,
} from '../../src/game-protocol/game-texts.js';

const csv = (rows: Record<string, string>): string =>
  Object.entries(rows).map(([k, v]) => `"${k}","${v.replace(/"/g, '""')}"`).join('\n');

const pairsOf = (entries: Array<[string, string, number?]>): TextPairs => {
  const p: TextPairs = new Map();
  for (const [en, loc, n = 1] of entries) {
    if (!p.has(en)) p.set(en, new Map());
    p.get(en)!.set(loc, (p.get(en)!.get(loc) ?? 0) + n);
  }
  return p;
};

describe('pairing two builds', () => {
  it('pairs strings at the same position, by key and index, counting repeats', () => {
    const pairs = pairTexts(
      { a: 'Wooden Chest', b: ['Crypt', 'Crypt', 'icon_72'], c: { d: 'Arena' }, onlyEn: 'x', n: 5 },
      { a: 'Holztruhe', b: ['Gruft', 'Gruft'], c: { d: 'Arena' }, onlyLoc: 'y', n: 6 },
    );
    expect([...pairs].map(([k, m]) => [k, Object.fromEntries(m)])).toEqual([
      ['Wooden Chest', { Holztruhe: 1 }],
      ['Crypt', { Gruft: 2 }],
      ['Arena', { Arena: 1 }],
    ]);
  });
});

describe('the dictionary', () => {
  const build = (entries: Array<[string, string, number?]>, englishTexts: string[] = [], lang = 'de', labels?: Array<[string, string]>) =>
    buildGameTexts({ lang, pairs: pairsOf(entries), englishTexts: new Set(englishTexts), labels });

  it('takes the most frequent translation of a text, then the first seen', () => {
    expect(build([['Research speed', 'Forschungsgeschwindigkeit', 3], ['Research speed', 'Geschwindigkeit der Forschung', 2]]))
      .toEqual({ 'Research speed': 'Forschungsgeschwindigkeit' });
    expect(build([['Easter Chest', 'Oster-Truhe'], ['Easter Chest', 'Ostertruhe']])).toEqual({ 'Easter Chest': 'Oster-Truhe' });
  });

  it('keeps a word the language does not change only when it is a translated text, not data', () => {
    expect(build([['Arena', 'Arena'], ['icon_vault_72', 'icon_vault_72'], ['+50,0%', '+50,0%']], ['Arena'])).toEqual({ Arena: 'Arena' });
  });

  it('leaves out strings without a letter, markup, and empty translations', () => {
    expect(build([['---', 'Енг сундук'], ['Bold', '<b>Fett</b>'], ['<i>x</i>', 'y'], ['Empty', ' ']])).toEqual({});
  });

  it("writes the game's plain quotes as the language's own", () => {
    expect(build([['Monster Slayer enchantment', 'Zauber "Monstertöter"']])).toEqual({ 'Monster Slayer enchantment': 'Zauber „Monstertöter“' });
    expect(localQuotes('Le "Bois"', 'fr')).toBe('Le « Bois »');
    expect(localQuotes('"Львы"', 'ru')).toBe('«Львы»');
    expect(localQuotes('sin comillas', 'es')).toBe('sin comillas');
  });

  it('derives {n} patterns from agreeing names with numbers and drops the exact entries they reproduce', () => {
    const out = build([
      ['Level 15 Crypt', 'Gruft Level 15'],
      ['Level 20 Crypt', 'Gruft Level 20'],
      ['Level 25–29 Vault of the Ancients', 'Schatzkammer der Ahnen Level 25–29'],
    ]);
    expect(out).toEqual({
      'Level {n} Crypt': 'Gruft Level {n}',
      'Level {n}–{n} Vault of the Ancients': 'Schatzkammer der Ahnen Level {n}–{n}',
    });
    expect(fillPattern(out['Level {n} Crypt'], ['35'])).toBe('Gruft Level 35');
  });

  it('keeps exact entries where the numbers move or the instances disagree, and then no pattern', () => {
    const out = build([
      ['Captains needed: level 150, count 2', 'Benötigt: 2 Hauptmänner mit Level 150'],
      ['Chest of 1 gem', 'Truhe mit 1 Edelstein'],
      ['Chest of 5 gem', 'Truhe mit 5 Edelsteinen'],
    ]);
    expect(out).toEqual({
      'Captains needed: level 150, count 2': 'Benötigt: 2 Hauptmänner mit Level 150',
      'Chest of 1 gem': 'Truhe mit 1 Edelstein',
      'Chest of 5 gem': 'Truhe mit 5 Edelsteinen',
    });
  });

  it('lets a UI label replace the same name, and its pattern the derived one', () => {
    const out = build(
      [['Leader', 'Chef'], ['Level: 5', 'Stufe 5'], ['Level: 6', 'Stufe 6']],
      [], 'de', [['Leader', 'Anführer'], ['Level: {n}', 'Level: {n}']],
    );
    // The exact names stay: the label's pattern no longer reproduces them.
    expect(out).toEqual({ 'Level: {n}': 'Level: {n}', Leader: 'Anführer', 'Level: 5': 'Stufe 5', 'Level: 6': 'Stufe 6' });
  });
});

describe('UI labels by translation key', () => {
  const en = new Map([
    ['rank.1', 'Leader'],
    ['level', 'Level: %level%'],
    ['moved', 'Clan Leader'],
    ['swap', '%a% of %b%'],
  ]);
  const de = new Map([
    ['rank.1', 'Anführer'],
    ['level', 'Level: %level%'],
    ['moved', 'Clan-Anführer'],
    ['swap', '%b% von %a%'],
  ]);
  const keys = [
    { key: 'rank.1', en: 'Leader' },
    { key: 'level', en: 'Level: {n}' },
    { key: 'moved', en: 'Leader of the clan' },
    { key: 'swap', en: '{n} of {n}' },
    { key: 'gone', en: 'Gone' },
  ];

  it("keys each label by the site's English, placeholders as {n}; reordered placeholders are left out", () => {
    const { labels, drift } = labelTexts(keys, en, de);
    expect(labels).toEqual([['Leader', 'Anführer'], ['Level: {n}', 'Level: {n}'], ['Leader of the clan', 'Clan-Anführer']]);
    expect(drift).toEqual(['moved ("Clan Leader" ≠ "Leader of the clan")', 'gone (gone)']);
  });

  it('pins every UI key to the English the site passes to tGame', () => {
    for (const { key, en: label } of UI_TEXT_KEYS) {
      expect(key).toMatch(/^[a-z_]+(\.[\w]+)+$/);
      expect(label.trim()).toBe(label);
      expect(label).not.toMatch(/%\w+%/);
    }
    expect(new Set(UI_TEXT_KEYS.map((u) => u.en)).size).toBe(UI_TEXT_KEYS.length);
  });
});

describe('the names build in every language', () => {
  // String pool, vectors of refs (a localised field; [template, placeholder, value]
  // for a templated one) and three tables — shaped like the game's.
  const strings: Wire[] = [
    'x', // 0
    'item.name.wooden', // 1
    'gift.source.crypt', // 2
    '%value%', // 3
    '15', // 4
    '20', // 5
    'item.name.mimic', // 6
    'map_object.vault', // 7
    'item.name.arena', // 8
    'academy/branches', // 9
    JSON.stringify({ branches: [{ id: 1, name: 'cfg.b1', tree: 'guardTree', type: 'tech' }], tabs: [{ name: 'cfg.tab1', branches: [1] }] }), // 10
  ];
  const vectors: Wire[] = [[1], [2, 3, 4], [2, 3, 5], [6], [7], [8]];
  const item = (id: number, nameVec: number, sourceVec: number): Wire => [id, 10, 0, nameVec, 0, 0, 0, [], 0, 0, 3, 0, 0, 0, sourceVec];
  const tables = new Map<number, Record<string, Wire>>([
    [TABLE_GIFT_TYPES, { 100: item(100, 0, 1), 101: item(101, 0, 2), 102: item(102, 3, 4), 103: item(103, 5, 4) }],
    [TABLE_MAP_OBJECTS, { 7: [7, 0, 0, 4] }],
    [TABLE_CLIENT_CONFIG, { 0: [9, 10] }],
  ]);
  const en = parseTranslationsCsv(csv({
    'item.name.wooden': 'Wooden Chest',
    'gift.source.crypt': 'Level %value% Crypt',
    'item.name.mimic': 'Mimic Chest',
    'map_object.vault': 'Vault of the Ancients',
    'item.name.arena': 'Arena',
    'cfg.b1': 'Guardsmen I',
    'cfg.tab1': 'Unlock',
    'client_config.value.clan.common.name_by_rank.1': 'Leader',
    'client.fractions_hall.altar_label': 'Level: %level%',
  }));
  const languages: Record<string, string> = {
    de: csv({
      'item.name.wooden': 'Holztruhe',
      'gift.source.crypt': 'Gruft Level %value%',
      'map_object.vault': 'Schatzkammer der Ahnen',
      'item.name.arena': 'Arena',
      'cfg.b1': 'Gardisten I',
      'cfg.tab1': 'Freischalten',
      'client_config.value.clan.common.name_by_rank.1': 'Anführer',
      'client.fractions_hall.altar_label': 'Level: %level%',
      'unused.key': 'Nie benutzt',
    }),
    fr: csv({ 'item.name.wooden': 'Coffre "en bois"', 'item.name.mimic': '' }),
  };
  const built = buildNamesInLanguages('v1', strings, vectors, tables, en, (lang) => languages[lang] ?? null);

  it('keeps names.json English', () => {
    expect(built.names.gifts['100']).toEqual({ chest: 'Wooden Chest', source: 'Level 15 Crypt' });
    expect(built.names.gifts['102'].chest).toBe('Mimic Chest');
  });

  it('builds each language it has a CSV for, from the same build run with that language', () => {
    expect([...built.texts.keys()].sort()).toEqual(['de', 'fr']);
    expect(built.texts.get('de')).toEqual({
      'Level {n} Crypt': 'Gruft Level {n}',
      'Level: {n}': 'Level: {n}',
      'Wooden Chest': 'Holztruhe',
      'Vault of the Ancients': 'Schatzkammer der Ahnen',
      Arena: 'Arena',
      'Guardsmen I': 'Gardisten I',
      Unlock: 'Freischalten',
      Leader: 'Anführer',
    });
  });

  it("leaves out what a language doesn't translate — its English is no translation", () => {
    expect(built.texts.get('de')).not.toHaveProperty('Mimic Chest');
    expect(built.texts.get('fr')).toEqual({ 'Wooden Chest': 'Coffre « en bois »' });
  });

  it('reports no label drift when the English still matches', () => {
    expect(built.drift.filter((d) => !d.endsWith('(gone)'))).toEqual([]);
  });
});
