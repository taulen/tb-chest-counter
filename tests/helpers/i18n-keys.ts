/**
 * Every translatable string in the frontend, read off disk: the literal
 * arguments of t() / tn() in src/web/public, plus the data-i18n markup in the
 * HTML shells. tests/config/i18n-dictionaries.test.ts compares the result
 * against each lib/i18n/<lang>.js dictionary.
 *
 * Deliberately syntactic, like frontend-imports.test.ts: it understands string
 * literals as t()'s first argument and nothing else, which is also the rule for
 * the source — a t(variable) can't be checked, so it is reported as an error.
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

export const PUBLIC_DIR = path.resolve(fileURLToPath(new URL('../../src/web/public', import.meta.url)));
export const SHELLS = ['index.html', 'login.html', 'public-share.html'];

export interface ExtractedKey {
  kind: 'text' | 'plural';
  /** English singular, for plural keys (the key itself is the plural). */
  one?: string;
  files: string[];
}

export interface Extraction {
  keys: Map<string, ExtractedKey>;
  errors: string[];
}

function listJsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (path.relative(PUBLIC_DIR, abs).replace(/\\/g, '/') === 'lib/i18n') continue;
      out.push(...listJsFiles(abs));
    } else if (entry.name.endsWith('.js')) {
      out.push(abs);
    }
  }
  return out;
}

const SIMPLE_ESCAPES: Record<string, string> = {
  n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0',
};

/** Parse a JS string literal starting at `i` (on the quote). */
function readStringLiteral(src: string, i: number): { value: string; end: number } | null {
  const quote = src[i];
  if (quote !== "'" && quote !== '"' && quote !== '`') return null;
  let value = '';
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === quote) return { value, end: j + 1 };
    if (quote === '`' && c === '$' && src[j + 1] === '{') return null;
    if (c === '\\') {
      const n = src[j + 1];
      if (n === 'u') {
        if (src[j + 2] === '{') {
          const close = src.indexOf('}', j);
          value += String.fromCodePoint(parseInt(src.slice(j + 3, close), 16));
          j = close + 1;
        } else {
          value += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16));
          j += 6;
        }
        continue;
      }
      if (n === 'x') {
        value += String.fromCharCode(parseInt(src.slice(j + 2, j + 4), 16));
        j += 4;
        continue;
      }
      if (n === '\r' || n === '\n') {
        j += n === '\r' && src[j + 2] === '\n' ? 3 : 2;
        continue;
      }
      value += SIMPLE_ESCAPES[n] ?? n;
      j += 2;
      continue;
    }
    if (quote !== '`' && (c === '\n' || c === '\r')) return null;
    value += c === '\r' ? '' : c;
    j += 1;
  }
  return null;
}

function skipSpace(src: string, i: number): number {
  let j = i;
  while (j < src.length && /\s/.test(src[j])) j += 1;
  return j;
}

/** Skip one call argument (balanced brackets, strings) up to the next top-level comma. */
function skipArgument(src: string, i: number): number {
  let depth = 0;
  let j = i;
  while (j < src.length) {
    const c = src[j];
    if (c === "'" || c === '"' || c === '`') {
      // Template literals with ${} are skipped crudely: find the closing backtick.
      if (c === '`') {
        j = src.indexOf('`', j + 1) + 1;
        continue;
      }
      const lit = readStringLiteral(src, j);
      j = lit ? lit.end : j + 1;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return j;
      depth -= 1;
    } else if (c === ',' && depth === 0) return j;
    j += 1;
  }
  return j;
}

function lineOf(src: string, index: number): number {
  return src.slice(0, index).split('\n').length;
}

/** Blank out comments (keeping offsets) so a t('x') in a comment isn't a key. */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      // Copy string literals verbatim (crude for templates, but comments
      // inside them are vanishingly rare).
      let j = i + 1;
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') j += 1;
        if (c !== '`' && src[j] === '\n') break;
        j += 1;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      out += ' '.repeat(stop - i);
      i = stop;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function add(keys: Map<string, ExtractedKey>, key: string, kind: ExtractedKey['kind'], file: string, one?: string): string | null {
  const prior = keys.get(key);
  if (prior) {
    if (prior.kind !== kind) return `"${key}" is used both as a plain string and as a plural (${file})`;
    if (kind === 'plural' && prior.one !== one) return `plural "${key}" has two different singulars ("${prior.one}" / "${one}")`;
    if (!prior.files.includes(file)) prior.files.push(file);
    return null;
  }
  keys.set(key, { kind, one, files: [file] });
  return null;
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|\w+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      return String.fromCodePoint(body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10));
    }
    return ENTITIES[body] ?? whole;
  });
}

export function extractKeys(): Extraction {
  const keys = new Map<string, ExtractedKey>();
  const errors: string[] = [];
  const callRe = /(?<![\w$.])(tn|t)\(/g;

  for (const abs of listJsFiles(PUBLIC_DIR)) {
    const rel = path.relative(PUBLIC_DIR, abs).replace(/\\/g, '/');
    if (rel === 'lib/i18n.js') continue;
    const src = stripComments(fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n'));
    for (const m of src.matchAll(callRe)) {
      const fn = m[1];
      let i = skipSpace(src, m.index! + m[0].length);
      const where = `${rel}:${lineOf(src, m.index!)}`;
      if (fn === 'tn') {
        i = skipSpace(src, skipArgument(src, i) + 1);
        const one = readStringLiteral(src, i);
        const other = one ? readStringLiteral(src, skipSpace(src, skipSpace(src, one.end) + 1)) : null;
        if (!one || !other) {
          errors.push(`${where}: tn() needs string literals for its singular and plural`);
          continue;
        }
        const err = add(keys, other.value, 'plural', rel, one.value);
        if (err) errors.push(`${where}: ${err}`);
        continue;
      }
      const lit = readStringLiteral(src, i);
      if (!lit) {
        errors.push(`${where}: t() needs a string literal (no variables, no \${} in a template)`);
        continue;
      }
      const err = add(keys, lit.value, 'text', rel);
      if (err) errors.push(`${where}: ${err}`);
    }
  }

  for (const shell of SHELLS) {
    const html = fs.readFileSync(path.join(PUBLIC_DIR, shell), 'utf8').replace(/\r\n/g, '\n');
    for (const m of html.matchAll(/<(\w+)((?:[^>"']|"[^"]*"|'[^']*')*)>/g)) {
      const attrs = m[2];
      if (/\sdata-i18n(?=[\s>=]|$)(?!-)/.test(attrs)) {
        const rest = html.slice(m.index! + m[0].length);
        const text = decodeEntities(rest.slice(0, rest.indexOf('<'))).trim();
        if (!text) errors.push(`${shell}: data-i18n on an empty <${m[1]}>`);
        else add(keys, text, 'text', shell);
      }
      const attrList = attrs.match(/\sdata-i18n-attr="([^"]*)"/);
      if (attrList) {
        for (const name of attrList[1].split(/\s+/).filter(Boolean)) {
          const value = attrs.match(new RegExp(`\\s${name}="([^"]*)"`));
          if (!value) errors.push(`${shell}: data-i18n-attr names ${name}, which <${m[1]}> doesn't have`);
          else add(keys, decodeEntities(value[1]), 'text', shell);
        }
      }
    }
  }

  // The event catalog's display text reaches the Events page from the server
  // and is shown through tGame(), which falls back to the ui dictionary — so
  // its labels are keys too.
  const catalog = fs.readFileSync(CATALOG_FILE, 'utf8').replace(/\r\n/g, '\n');
  for (const m of catalog.matchAll(/\b(?:name|label|levelSummaryLabel|levelCardLabel|description):\s*(?=['"`])/g)) {
    const lit = readStringLiteral(catalog, m.index! + m[0].length);
    if (lit && lit.value) add(keys, lit.value, 'text', 'config/event-catalog.ts');
  }

  return { keys, errors };
}

const CATALOG_FILE = path.resolve(PUBLIC_DIR, '../../config/event-catalog.ts');

/** {placeholder} names in a string. */
export function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

/** HTML tag names, in order, in a string. */
export function tags(text: string): string[] {
  return [...text.matchAll(/<\/?([a-zA-Z][\w-]*)/g)].map((m) => m[0]).sort();
}
