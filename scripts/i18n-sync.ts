/**
 * Maintenance for the translation dictionaries (src/web/public/lib/i18n/*.js).
 *
 * RUNS-BY-HAND: it rewrites source files in a working copy during development
 * (the dictionaries ship in the image), so there is nothing for a running
 * container to do; the check half lives in tests/config and runs on every build.
 *
 *   npx tsx scripts/i18n-sync.ts missing <out.json>
 *       Write every source string that some language lacks, with the
 *       languages that lack it — the work list for a translation pass.
 *
 *   npx tsx scripts/i18n-sync.ts merge <lang> <translations.json>...
 *       Merge { "<English>": "<translation>" | { one, few, many, other } }
 *       files into lib/i18n/<lang>.js, drop entries the source no longer uses,
 *       and rewrite the file grouped by the source file each string first
 *       appears in. The `game` block is kept as it is.
 *
 *   npx tsx scripts/i18n-sync.ts game <lang> <names.json>
 *       Replace the `game` block (official game names) with { "<English>": "<name>" }.
 *
 * tests/config/i18n-dictionaries.test.ts is the check; this only edits.
 */

import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { PUBLIC_DIR, extractKeys } from '../tests/helpers/i18n-keys.js';

const LANGS = ['es', 'fr', 'ru', 'de'];
type Entry = string | Record<string, string>;
type Dict = { ui: Record<string, Entry>; game: Record<string, string> };

const dictPath = (lang: string) => path.join(PUBLIC_DIR, 'lib', 'i18n', `${lang}.js`);

async function load(lang: string): Promise<Dict> {
  return (await import(pathToFileURL(dictPath(lang)).href)) as Dict;
}

const HEADER: Record<string, string> = {
  es: 'Spanish', fr: 'French', ru: 'Russian', de: 'German',
};

function literal(value: Entry): string {
  if (typeof value === 'string') return JSON.stringify(value);
  const forms = ['zero', 'one', 'two', 'few', 'many', 'other'].filter((f) => f in value);
  return `{ ${forms.map((f) => `${f}: ${JSON.stringify(value[f])}`).join(', ')} }`;
}

function write(lang: string, ui: Record<string, Entry>, game: Record<string, string>): void {
  const { keys } = extractKeys();
  const lines: string[] = [
    `// ${HEADER[lang]} translations for lib/i18n.js. Keys are the English source strings.`,
    "// ui: the app's own text, grouped by the file each string first appears in.",
    "// game: the game's OFFICIAL names only — see tGame(). Maintained with",
    '// scripts/i18n-sync.ts; checked by tests/config/i18n-dictionaries.test.ts.',
    '',
    'export const ui = {',
  ];
  let group = '';
  for (const [key, info] of keys) {
    if (!(key in ui)) continue;
    if (info.files[0] !== group) {
      group = info.files[0];
      lines.push(`  // ${group}`);
    }
    lines.push(`  ${JSON.stringify(key)}: ${literal(ui[key])},`);
  }
  lines.push('};', '', 'export const game = {');
  for (const [key, value] of Object.entries(game)) lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(value)},`);
  lines.push('};', '');
  fs.writeFileSync(dictPath(lang), lines.join('\n'));
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'missing') {
    const { keys, errors } = extractKeys();
    if (errors.length) console.error(errors.join('\n'));
    const dicts = Object.fromEntries(await Promise.all(LANGS.map(async (l) => [l, await load(l)] as const)));
    const out = [...keys].flatMap(([key, info]) => {
      const lacking = LANGS.filter((l) => !(key in dicts[l].ui));
      return lacking.length ? [{ key, kind: info.kind, one: info.one, file: info.files[0], lacking }] : [];
    });
    fs.writeFileSync(args[0], JSON.stringify(out, null, 1));
    console.log(`${out.length} strings missing in at least one language (of ${keys.size})`);
    return;
  }
  if (cmd === 'merge') {
    const [lang, ...files] = args;
    if (!LANGS.includes(lang)) throw new Error(`unknown language ${lang}`);
    const dict = await load(lang);
    const ui: Record<string, Entry> = { ...dict.ui };
    for (const file of files) Object.assign(ui, JSON.parse(fs.readFileSync(file, 'utf8')));
    write(lang, ui, { ...dict.game });
    console.log(`${lang}: wrote ${dictPath(lang)}`);
    return;
  }
  if (cmd === 'game') {
    const [lang, file] = args;
    if (!LANGS.includes(lang)) throw new Error(`unknown language ${lang}`);
    const dict = await load(lang);
    write(lang, { ...dict.ui }, JSON.parse(fs.readFileSync(file, 'utf8')));
    console.log(`${lang}: game names replaced`);
    return;
  }
  throw new Error('usage: i18n-sync.ts missing <out.json> | merge <lang> <file.json>... | game <lang> <names.json>');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
