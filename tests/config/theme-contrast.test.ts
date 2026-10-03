/**
 * WCAG AA text contrast for every theme, computed from the tokens in base.css.
 *
 * Nobody had ever measured it, and when someone finally did, --text-muted
 * failed 4.5:1 in all three themes (down to 2.2:1 on the leaderboard goal
 * line), white text sat at 1.7:1 on gold fills and 2.8:1 on red ones, and the
 * light theme's gold failed on white. None of that is visible on the screen you
 * test on — it is visible to the reader with low vision, in sunlight, on a
 * cheap panel. So it is a guard: a pure test, files off disk, run by
 * `npm run build` before anything compiles.
 *
 * The pairs are the ones the UI actually paints, with translucent tokens
 * composited over the real surface they sit on (a goal-coloured Points cell is
 * card + row wash + cell wash). Light and OLED inherit every token they don't
 * redefine from :root, exactly as the cascade does.
 *
 * When this fails: change the TOKEN in base.css, not the threshold. The
 * message names the pair and the ratio it got.
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';

const PUBLIC_DIR = path.resolve(fileURLToPath(new URL('../../src/web/public', import.meta.url)));
const CSS = fs.readFileSync(path.join(PUBLIC_DIR, 'base.css'), 'utf8').replace(/\r\n/g, '\n');

const AA_TEXT = 4.5;
const AA_NON_TEXT = 3;

type Rgba = [number, number, number, number];

function tokensOf(selector: string): Record<string, string> {
  const start = CSS.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`base.css has no "${selector} {" block`);
  const end = CSS.indexOf('\n}', start);
  const body = CSS.slice(start, end);
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

const ROOT = tokensOf(':root');
const THEMES: Record<string, Record<string, string>> = {
  dark: ROOT,
  light: { ...ROOT, ...tokensOf('[data-theme="light"]') },
  oled: { ...ROOT, ...tokensOf('[data-theme="oled"]') },
};

function parseColor(value: string, name: string): Rgba {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].split('').map((c) => c + c).join('') : hex[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).concat(1) as Rgba;
  }
  const fn = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(value);
  if (fn) return [Number(fn[1]), Number(fn[2]), Number(fn[3]), fn[4] === undefined ? 1 : Number(fn[4])];
  throw new Error(`${name} is "${value}", which this test can't read as a colour`);
}

function linear(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}
function luminance([r, g, b]: Rgba): number {
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}
function ratio(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
function over(top: Rgba, under: Rgba): Rgba {
  const a = top[3];
  return [0, 1, 2].map((i) => top[i] * a + under[i] * (1 - a)).concat(1) as Rgba;
}

/** The colour a stack of layers paints, bottom (opaque) first. */
function composite(tokens: Record<string, string>, layers: string[]): Rgba {
  const read = (name: string): Rgba => {
    const v = tokens[name];
    if (v === undefined) throw new Error(`token ${name} is not defined`);
    return parseColor(v, name);
  };
  let acc = read(layers[0]);
  if (acc[3] !== 1) throw new Error(`${layers[0]} is translucent; a stack must start on an opaque surface`);
  for (const layer of layers.slice(1)) acc = over(read(layer), acc);
  return acc;
}

interface Pair { label: string; fg: string; on: string[]; min: number }

const SURFACES = ['--bg-primary', '--bg-card', '--bg-surface', '--bg-elevated', '--bg-input'];
const TEXT = ['--text-primary', '--text-secondary', '--text-muted'];
const GOAL = [
  ['ok', '--accent-green-soft-text'],
  ['warn', '--accent-warn-text'],
  ['low', '--accent-red-soft-text'],
] as const;
const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'arena', 'event', 'unknown'];

const PAIRS: Pair[] = [
  ...TEXT.flatMap((t) => SURFACES.map((s) => ({ label: `${t} on ${s}`, fg: t, on: [s], min: AA_TEXT }))),
  // A leaderboard row tinted for its goal status still carries muted and
  // secondary text (the phone layout's "POINTS" caption, the chest count).
  ...GOAL.flatMap(([status]) => ['--text-secondary', '--text-muted'].map((t) => ({
    label: `${t} on a ${status} goal row`, fg: t, on: ['--bg-card', `--goal-row-${status}-bg`], min: AA_TEXT,
  }))),
  // The Points cell: its status colour on card + row wash + cell wash.
  ...GOAL.map(([status, fg]) => ({
    label: `${status} goal cell text`, fg, on: ['--bg-card', `--goal-row-${status}-bg`, `--goal-cell-${status}-bg`], min: AA_TEXT,
  })),
  { label: 'gold text on card', fg: '--accent-gold', on: ['--bg-card'], min: AA_TEXT },
  { label: 'gold text on surface', fg: '--accent-gold', on: ['--bg-surface'], min: AA_TEXT },
  { label: 'gold text on a gold pill', fg: '--accent-gold', on: ['--bg-card', '--accent-gold-bg-strong'], min: AA_TEXT },
  { label: 'gold text on a faint gold pill', fg: '--accent-gold', on: ['--bg-card', '--accent-gold-bg'], min: AA_TEXT },
  { label: 'link blue on card', fg: '--accent-blue', on: ['--bg-card'], min: AA_TEXT },
  { label: 'button text on solid blue', fg: '--text-on-accent', on: ['--accent-blue-solid'], min: AA_TEXT },
  { label: 'button text on solid blue (hover)', fg: '--text-on-accent', on: ['--accent-blue-solid-hover'], min: AA_TEXT },
  { label: 'button text on solid red', fg: '--text-on-accent', on: ['--accent-red-solid'], min: AA_TEXT },
  { label: 'button text on solid red (hover)', fg: '--text-on-accent', on: ['--accent-red-solid-hover'], min: AA_TEXT },
  { label: 'text on a gold fill', fg: '--text-on-gold', on: ['--accent-gold'], min: AA_TEXT },
  ...RARITIES.map((r) => ({ label: `${r} chest badge`, fg: `--chest-${r}-text`, on: [`--chest-${r}-bg`], min: AA_TEXT })),
  // Non-text: the keyboard focus outline against the surfaces it is drawn on.
  ...['--bg-primary', '--bg-card', '--bg-surface'].map((s) => ({
    label: `focus ring on ${s}`, fg: '--focus-ring', on: [s], min: AA_NON_TEXT,
  })),
];

describe('theme tokens', () => {
  it('finds all three theme blocks', () => {
    for (const [name, tokens] of Object.entries(THEMES)) {
      expect(tokens['--bg-card'], `${name} has no --bg-card`).toBeDefined();
    }
    // The cascade only works if the overrides really are overrides.
    expect(tokensOf('[data-theme="light"]')['--bg-card']).not.toBe(ROOT['--bg-card']);
    expect(tokensOf('[data-theme="oled"]')['--bg-card']).not.toBe(ROOT['--bg-card']);
  });
});

describe.each(Object.keys(THEMES))('contrast in the %s theme', (theme) => {
  it('meets WCAG AA for every text pair the UI paints', () => {
    const tokens = THEMES[theme];
    const failures = PAIRS
      .map((p) => ({ p, got: ratio(composite(tokens, [p.fg]), composite(tokens, p.on)) }))
      .filter(({ p, got }) => got < p.min)
      .map(({ p, got }) => `${p.label}: ${got.toFixed(2)}:1 (needs ${p.min}:1)`);
    expect(failures, `\n${failures.join('\n')}`).toEqual([]);
  });
});
