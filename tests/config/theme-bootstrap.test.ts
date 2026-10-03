/**
 * The inline theme bootstrap in each HTML shell.
 *
 * Four pages (app, login, setup, public share) each carry a tiny inline script
 * that sets data-theme before the first paint — it has to be inline, or every
 * page flashes the wrong palette while a module loads. Four copies of anything
 * drift: when 'auto' (follow the device) was added, a shell left on the old
 * copy would have painted Dark for a visitor whose phone is in light mode, on
 * exactly the pages a first-time visitor lands on.
 *
 * So: the four must be byte-identical, and the script must agree with
 * resolveTheme() in lib/theme.js — which takes over once the page loads — for
 * every stored value and device setting. Pure test; part of `npm run build`.
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';
import { resolveTheme } from '../../src/web/public/lib/theme.js';

const PUBLIC_DIR = path.resolve(fileURLToPath(new URL('../../src/web/public', import.meta.url)));
const SHELLS = ['index.html', 'login.html', 'setup.html', 'public-share.html'];

function bootstrapOf(file: string): string {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8').replace(/\r\n/g, '\n');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const theme = scripts.filter((s) => s.includes("localStorage.getItem('theme')"));
  expect(theme, `${file} should carry exactly one inline theme bootstrap`).toHaveLength(1);
  return theme[0];
}

/** Run a bootstrap against a fake page and return the data-theme it set. */
function paint(code: string, stored: string | null, prefersLight: boolean, storageBlocked = false): string | null {
  let painted: string | null = null;
  const localStorage = {
    getItem: () => {
      if (storageBlocked) throw new Error('blocked');
      return stored;
    },
  };
  const window = { matchMedia: () => ({ matches: prefersLight }) };
  const document = { documentElement: { setAttribute: (_: string, v: string) => { painted = v; } } };
  new Function('localStorage', 'window', 'document', code)(localStorage, window, document);
  return painted;
}

describe('inline theme bootstrap', () => {
  it('is identical in every HTML shell', () => {
    const [first, ...rest] = SHELLS.map(bootstrapOf);
    rest.forEach((code, i) => {
      expect(code, `${SHELLS[i + 1]} differs from ${SHELLS[0]}`).toBe(first);
    });
  });

  it('paints what resolveTheme() would, for every stored value and device', () => {
    const code = bootstrapOf('index.html');
    for (const stored of [null, 'auto', 'light', 'dark', 'oled', 'garbage']) {
      for (const prefersLight of [true, false]) {
        const expected = resolveTheme(stored ?? 'auto', prefersLight);
        expect(paint(code, stored, prefersLight), `stored=${stored} light=${prefersLight}`).toBe(expected);
      }
    }
  });

  it('follows the device when storage is blocked', () => {
    const code = bootstrapOf('index.html');
    expect(paint(code, 'light', false, true)).toBe('oled');
    expect(paint(code, 'dark', true, true)).toBe('light');
  });
});

describe('resolveTheme', () => {
  it('maps auto to OLED on a dark device and Light on a light one', () => {
    expect(resolveTheme('auto', false)).toBe('oled');
    expect(resolveTheme('auto', true)).toBe('light');
  });

  it('keeps an explicit choice whatever the device says', () => {
    for (const t of ['light', 'dark', 'oled']) {
      expect(resolveTheme(t, true)).toBe(t);
      expect(resolveTheme(t, false)).toBe(t);
    }
  });
});
