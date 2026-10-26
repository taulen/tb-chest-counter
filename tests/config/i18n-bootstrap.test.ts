/**
 * The inline language bootstrap in each HTML shell, and the language list.
 *
 * Three shells (app, login, public share) carry a tiny inline script that, for
 * a saved non-English language, stamps <html lang> and hides the page until
 * lib/i18n.js has translated it — the module loads after first paint, so
 * without it the English markup flashes first. Like the theme bootstrap next
 * door, three copies drift unless something holds them together.
 *
 * English stays the default: nothing saved, a garbage value or blocked storage
 * must leave the page alone (English, visible), whatever the browser prefers.
 *
 * The languages are listed in three places — lib/i18n.js, this bootstrap and
 * the server's ALLOWED_LANGUAGES — and must agree. Pure test; part of
 * `npm run build`.
 */

import path from 'path';
import fs from 'fs';
import { describe, it, expect } from 'vitest';
import { LANGUAGES } from '../../src/web/public/lib/i18n.js';
import { PUBLIC_DIR, SHELLS } from '../helpers/i18n-keys.js';

const CODES = LANGUAGES.map((l: { code: string }) => l.code);

function bootstrapOf(file: string): string {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8').replace(/\r\n/g, '\n');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const lang = scripts.filter((s) => s.includes("localStorage.getItem('lang')"));
  expect(lang, `${file} should carry exactly one inline language bootstrap`).toHaveLength(1);
  return lang[0];
}

function run(code: string, stored: string | null, storageBlocked = false): Record<string, string> {
  const attrs: Record<string, string> = {};
  const localStorage = {
    getItem: () => {
      if (storageBlocked) throw new Error('blocked');
      return stored;
    },
  };
  const document = { documentElement: { setAttribute: (k: string, v: string) => { attrs[k] = v; } } };
  new Function('localStorage', 'document', code)(localStorage, document);
  return attrs;
}

describe('inline language bootstrap', () => {
  it('is identical in every shell that loads lib/i18n.js', () => {
    const [first, ...rest] = SHELLS.map(bootstrapOf);
    rest.forEach((code, i) => {
      expect(code, `${SHELLS[i + 1]} differs from ${SHELLS[0]}`).toBe(first);
    });
  });

  it('hides and tags the page for a saved non-English language only', () => {
    const code = bootstrapOf('index.html');
    for (const lang of CODES.filter((c: string) => c !== 'en')) {
      expect(run(code, lang)).toEqual({ lang, 'data-i18n-pending': '' });
    }
    for (const stored of [null, 'en', 'garbage', 'EN', '']) {
      expect(run(code, stored), `stored ${stored}`).toEqual({});
    }
    expect(run(code, 'de', true)).toEqual({});
  });
});

describe('language list', () => {
  it('starts with English, the default', () => {
    expect(CODES[0]).toBe('en');
  });

  it('matches the server', () => {
    const repo = fs.readFileSync(path.resolve(PUBLIC_DIR, '../../data/repositories/user-repo.ts'), 'utf8');
    const m = repo.match(/ALLOWED_LANGUAGES: readonly UserLanguage\[\] = \[([^\]]*)\]/);
    expect(m, 'ALLOWED_LANGUAGES in user-repo.ts').not.toBeNull();
    expect([...m![1].matchAll(/'(\w+)'/g)].map((x) => x[1])).toEqual(CODES);
  });

  it('has a dictionary for every language but English', () => {
    for (const code of CODES.filter((c: string) => c !== 'en')) {
      expect(fs.existsSync(path.join(PUBLIC_DIR, 'lib', 'i18n', `${code}.js`)), code).toBe(true);
    }
  });
});
