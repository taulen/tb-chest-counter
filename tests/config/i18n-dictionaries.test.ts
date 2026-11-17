/**
 * The translation dictionaries stay in step with the source.
 *
 * The frontend's strings are their own keys (lib/i18n.js): t('Leaderboard')
 * shows the Spanish entry for 'Leaderboard', or the English when there isn't
 * one. That fallback is what makes a missing translation invisible — the page
 * still works, just in English, and nothing would ever say so. So:
 *
 *  - every t()/tn() literal and every data-i18n string in the shells has an
 *    entry in every language, and no language keeps entries nothing uses;
 *  - a translation carries the same {placeholders} and HTML tags as its key
 *    (t() inserts translations into innerHTML templates as-is), and no bare
 *    double quote, which would end the attribute a string sits in;
 *  - plurals give every form the language needs (Russian: one / few / many).
 *
 * Game names (tGame) come from the game's own translation files, built on the
 * server (src/game-protocol/game-texts.ts) — not from these dictionaries. The
 * hand-kept `game` block holds only the few names those files don't cover
 * (the app's shorthands like 'Ancients'). It is keyed by data, not by source,
 * so it is checked for shape, for being the same list in every language, and
 * for staying the exception: copying the game's names back in by hand is what
 * this replaced (~1,000 entries per language, Nov 2026).
 *
 * Adding a string: wrap it in t(), then add it to lib/i18n/{es,fr,ru,de}.js.
 * Pure test; part of `npm run build`.
 */

import path from 'path';
import { pathToFileURL } from 'url';
import { describe, it, expect } from 'vitest';
import { PUBLIC_DIR, extractKeys, placeholders, tags } from '../helpers/i18n-keys.js';
import { UI_TEXT_KEYS } from '../../src/game-protocol/game-texts.js';

const LANGS = ['es', 'fr', 'ru', 'de'] as const;
/** The hand-kept `game` block is the exception (13 names in Nov 2026). */
const HAND_GAME_NAMES_MAX = 20;
type Dict = { ui: Record<string, unknown>; game: Record<string, unknown> };

async function load(lang: string): Promise<Dict> {
  return import(pathToFileURL(path.join(PUBLIC_DIR, 'lib', 'i18n', `${lang}.js`)).href) as Promise<Dict>;
}

/** The plural categories a language actually uses for whole numbers. */
function integerCategories(lang: string): string[] {
  const rules = new Intl.PluralRules(lang);
  const seen = new Set<string>();
  for (let n = 0; n <= 1000; n += 1) seen.add(rules.select(n));
  return [...seen].sort();
}

function list(items: string[], max = 40): string {
  const shown = items.slice(0, max).map((s) => `  ${JSON.stringify(s)}`).join('\n');
  return items.length > max ? `${shown}\n  … and ${items.length - max} more` : shown;
}

const { keys, errors } = extractKeys();

describe('i18n source', () => {
  it('passes only string literals to t() and tn()', () => {
    expect(errors, errors.join('\n')).toEqual([]);
  });
});

describe.each(LANGS)('i18n dictionary %s', (lang) => {
  it('translates every string in the source, and nothing else', async () => {
    const { ui } = await load(lang);
    const missing = [...keys.keys()].filter((k) => !(k in ui));
    const stale = Object.keys(ui).filter((k) => !keys.has(k));
    expect(missing, `${lang}: ${missing.length} untranslated:\n${list(missing)}`).toEqual([]);
    expect(stale, `${lang}: ${stale.length} entries no longer in the source:\n${list(stale)}`).toEqual([]);
  });

  it('keeps placeholders, tags and plural forms intact', async () => {
    const { ui } = await load(lang);
    const needed = integerCategories(lang);
    const problems: string[] = [];
    for (const [key, info] of keys) {
      const value = ui[key];
      if (value === undefined) continue;
      if (info.kind === 'text') {
        if (typeof value !== 'string' || !value.trim()) {
          problems.push(`${JSON.stringify(key)}: expected a non-empty string`);
          continue;
        }
        if (placeholders(value).join() !== placeholders(key).join()) {
          problems.push(`${JSON.stringify(key)}: placeholders ${placeholders(value)} ≠ ${placeholders(key)}`);
        }
        if (tags(value).join() !== tags(key).join()) {
          problems.push(`${JSON.stringify(key)}: HTML tags differ`);
        }
        if (value.includes('"') && !key.includes('"')) {
          problems.push(`${JSON.stringify(key)}: translation has a bare " (use « » „ " or ' instead)`);
        }
        continue;
      }
      if (!value || typeof value !== 'object') {
        problems.push(`${JSON.stringify(key)}: plural, expected { ${needed.join(', ')} }`);
        continue;
      }
      const forms = value as Record<string, unknown>;
      const english = new Set([...placeholders(key), ...placeholders(info.one ?? '')]);
      for (const category of needed) {
        const form = forms[category];
        if (typeof form !== 'string' || !form.trim()) {
          problems.push(`${JSON.stringify(key)}: missing plural form "${category}"`);
          continue;
        }
        const extra = placeholders(form).filter((p) => !english.has(p));
        if (extra.length) problems.push(`${JSON.stringify(key)} [${category}]: unknown placeholders ${extra}`);
        if (tags(form).join() !== tags(key).join()) problems.push(`${JSON.stringify(key)} [${category}]: HTML tags differ`);
        if (form.includes('"') && !key.includes('"')) problems.push(`${JSON.stringify(key)} [${category}]: bare "`);
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('gives official game names as plain strings, patterns keeping their {n}', async () => {
    const { game } = await load(lang);
    const problems: string[] = [];
    for (const [key, value] of Object.entries(game)) {
      if (typeof value !== 'string' || !value.trim()) {
        problems.push(`${JSON.stringify(key)}: expected a non-empty string`);
        continue;
      }
      const count = (s: string) => (s.match(/\{n\}/g) ?? []).length;
      if (count(value) !== count(key)) problems.push(`${JSON.stringify(key)}: {n} count differs`);
      if (/[<>"]/.test(value)) problems.push(`${JSON.stringify(key)}: no markup or " in a game name`);
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it("keeps the hand-kept game names to what the game's own files don't cover", async () => {
    const { game } = await load(lang);
    const keys = Object.keys(game);
    // The game's names arrive from its translation files (GET /api/game-texts);
    // a hand copy would only go stale. Raise this only for names the game's
    // files really lack — see docs/i18n.md.
    expect(keys.length, `${lang}: ${keys.length} hand-kept game names — the game's own files cover game names (docs/i18n.md)`).toBeLessThanOrEqual(HAND_GAME_NAMES_MAX);
    const fromGame = new Set(UI_TEXT_KEYS.map((u) => u.en));
    const duplicated = keys.filter((k) => fromGame.has(k));
    expect(duplicated, `${lang}: these come from the game (UI_TEXT_KEYS in src/game-protocol/game-texts.ts):\n${list(duplicated)}`).toEqual([]);
  });
});

describe('hand-kept game names', () => {
  it('are the same names in every language', async () => {
    const sets = await Promise.all(LANGS.map(async (lang) => [lang, Object.keys((await load(lang)).game).sort()] as const));
    const [, first] = sets[0];
    for (const [lang, keys] of sets) {
      const missing = first.filter((k) => !keys.includes(k));
      const extra = keys.filter((k) => !first.includes(k));
      expect({ lang, missing, extra }).toEqual({ lang, missing: [], extra: [] });
    }
  });
});
