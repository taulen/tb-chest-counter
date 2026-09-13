/**
 * Every named import in src/web/public must resolve to a real export.
 *
 * The frontend is vanilla ES modules — no bundler, no tsc, no linter in the
 * build. Nothing checks it. `import { foo } from './bar.js'` where bar.js has
 * stopped exporting `foo` compiles fine, ships fine, and then throws
 * "SyntaxError: The requested module does not provide an export named 'foo'"
 * in the browser — which aborts the WHOLE module graph, so the symptom is a
 * blank page rather than one broken feature. Exactly the failure shape as the
 * public-share allowlist bug next door, from a different cause.
 *
 * That is a live risk here because shared helpers move between modules as the
 * lib/ folder grows: period-nav was lifted out of four pages, and the period
 * anchor helpers moved from pages/leaderboard.js into lib/period.js, which
 * pages/triumphal.js and app.js were both importing across.
 *
 * A pure test — reads files off disk, no DB, no server — so it runs as part of
 * `npm run build` and catches a rename before it reaches a browser.
 *
 * Deliberately simple and syntactic: it understands the static import/export
 * forms this codebase actually uses and nothing else. If it ever needs to
 * understand dynamic imports or re-export chains, prefer keeping the source
 * simple over teaching this file to parse JavaScript.
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';

const PUBLIC_DIR = path.resolve(fileURLToPath(new URL('../../src/web/public', import.meta.url)));

function listJsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsFiles(abs));
    else if (entry.name.endsWith('.js')) out.push(abs);
  }
  return out;
}

/** The export names a module provides, for the static forms used in this app. */
function exportsOf(src: string): Set<string> {
  const names = new Set<string>();
  for (const m of src.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm)) {
    names.add(m[1]);
  }
  for (const m of src.matchAll(/^export\s+(?:const|let|var|class)\s+([A-Za-z0-9_$]+)/gm)) {
    names.add(m[1]);
  }
  // export { a, b as c }
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop();
      if (name) names.add(name.trim());
    }
  }
  if (/^export\s+default\b/m.test(src)) names.add('default');
  return names;
}

/** The named bindings a module imports, grouped by relative specifier. */
function namedImportsOf(src: string): Array<{ spec: string; names: string[] }> {
  const out: Array<{ spec: string; names: string[] }> = [];
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](\.[^'"\n]+)['"]/g)) {
    const names = m[1]
      .split(',')
      .map((part) => part.trim().split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
    out.push({ spec: m[2], names });
  }
  return out;
}

/** Relative specifiers a module references at all, named or not. */
function allRelativeSpecs(src: string): string[] {
  // The character class excludes newlines on purpose. A module specifier never
  // contains one, and without that the pattern runs off the end of a line and
  // happily matches ordinary prose ending in the word "from" before a quote —
  // which it did, against a code comment, and reported a broken import.
  return [...src.matchAll(/(?:from|import)\s*['"](\.[^'"\n]+)['"]/g)].map((m) => m[1]);
}

const files = listJsFiles(PUBLIC_DIR);
const rel = (abs: string): string => path.relative(PUBLIC_DIR, abs).split(path.sep).join('/');

describe('frontend ES module graph', () => {
  it('finds modules to check', () => {
    // Guards against the walker silently returning nothing, which would make
    // every assertion below pass vacuously.
    expect(files.length).toBeGreaterThan(10);
  });

  it('resolves every relative import to a file on disk', () => {
    const broken: string[] = [];
    for (const abs of files) {
      const src = fs.readFileSync(abs, 'utf8');
      for (const spec of allRelativeSpecs(src)) {
        const target = path.resolve(path.dirname(abs), spec);
        if (!fs.existsSync(target)) broken.push(`${rel(abs)} -> ${spec}`);
      }
    }
    expect(broken, `import paths that point at nothing: ${broken.join(', ')}`).toEqual([]);
  });

  it('imports only names the target module actually exports', () => {
    const exportCache = new Map<string, Set<string>>();
    const exportsFor = (abs: string): Set<string> => {
      let hit = exportCache.get(abs);
      if (!hit) {
        hit = exportsOf(fs.readFileSync(abs, 'utf8'));
        exportCache.set(abs, hit);
      }
      return hit;
    };

    const missing: string[] = [];
    for (const abs of files) {
      const src = fs.readFileSync(abs, 'utf8');
      for (const { spec, names } of namedImportsOf(src)) {
        const target = path.resolve(path.dirname(abs), spec);
        if (!fs.existsSync(target)) continue; // reported by the test above
        const available = exportsFor(target);
        for (const name of names) {
          if (!available.has(name)) missing.push(`${rel(abs)} imports "${name}" from ${spec}`);
        }
      }
    }
    expect(
      missing,
      'these imports would throw at module-evaluation time and blank the page: '
        + missing.join('; '),
    ).toEqual([]);
  });
});

/**
 * Reduce a module to just its code: no comments, no string contents, no regex
 * literals — but KEEPING the interpolated expressions inside template literals.
 *
 * That last part is the whole point. These pages are built from template
 * strings, so `${concentrationCardHtml(current)}` is a real call site while the
 * markup around it is not. A scanner that dropped template literals whole would
 * miss exactly the call that broke; one that kept them whole would drown in
 * prose.
 *
 * Regex literals have to be skipped rather than passed through, because a
 * perfectly ordinary one contains a quote — lib/ui.js has `.replace(/"/g, …)` —
 * and a naive scanner treats that quote as the start of a string and swallows
 * the rest of the file, losing every declaration after it.
 */
function stripNonCode(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  // What the previous meaningful character was, to tell a regex literal from a
  // division. After a value (identifier, ), ]) a slash is division; after an
  // operator, punctuation or the start of input it opens a regex.
  let prevMeaningful = '';

  const regexCanStart = (): boolean => {
    if (prevMeaningful === '') return true;
    return !/[A-Za-z0-9_$)\]]/.test(prevMeaningful);
  };

  while (i < n) {
    const c = src[i];
    const next = src[i + 1];

    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (c === '/' && regexCanStart()) {
      i += 1;
      let inClass = false;
      while (i < n) {
        const ch = src[i];
        if (ch === '\\') { i += 2; continue; }
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) break;
        else if (ch === '\n') break; // unterminated: bail rather than run away
        i += 1;
      }
      i += 1;
      while (i < n && /[gimsuy]/.test(src[i])) i += 1;
      out += ' 0 ';
      prevMeaningful = '0';
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      i += 1;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') i += 1;
        i += 1;
      }
      i += 1;
      out += ' 0 ';
      prevMeaningful = '0';
      continue;
    }
    if (c === '`') {
      i += 1;
      while (i < n && src[i] !== '`') {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '$' && src[i + 1] === '{') {
          i += 2;
          let depth = 1;
          const start = i;
          while (i < n && depth > 0) {
            if (src[i] === '{') depth += 1;
            else if (src[i] === '}') depth -= 1;
            if (depth > 0) i += 1;
          }
          // An interpolation can hold another template literal.
          out += ' ' + stripNonCode(src.slice(start, i)) + ' ';
          i += 1;
          continue;
        }
        i += 1;
      }
      i += 1;
      out += ' 0 ';
      prevMeaningful = '0';
      continue;
    }
    out += c;
    if (!/\s/.test(c)) prevMeaningful = c;
    i += 1;
  }
  return out;
}

/** Keywords, class syntax, and the browser/standard globals this app uses. */
const KNOWN_CALLABLES = new Set([
  // Keywords that a call-shaped regex will always find.
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function',
  'async', 'await', 'new', 'delete', 'void', 'do', 'else', 'try', 'yield',
  'import', 'super', 'constructor', 'get', 'set', 'of', 'in', 'instanceof',
  // Standard library.
  'Math', 'Date', 'JSON', 'Number', 'String', 'Array', 'Object', 'Map', 'Set',
  'WeakMap', 'WeakSet', 'Promise', 'RegExp', 'Symbol', 'BigInt', 'Error',
  'Intl', 'Proxy', 'Reflect', 'isNaN', 'isFinite', 'parseInt', 'parseFloat',
  'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
  'structuredClone', 'queueMicrotask',
  // Browser.
  'window', 'document', 'console', 'navigator', 'history', 'location',
  'localStorage', 'sessionStorage', 'fetch', 'alert', 'confirm', 'prompt',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle',
  'btoa', 'atob', 'createImageBitmap', 'URL', 'URLSearchParams', 'Blob', 'File',
  'FileReader', 'FormData', 'Image', 'AbortController', 'CustomEvent', 'Event',
  'Node', 'HTMLElement', 'IntersectionObserver', 'ResizeObserver', 'WebSocket',
  'TextDecoder', 'TextEncoder', 'Notification', 'CSS', 'Boolean', 'matchMedia',
  // Loaded from a CDN script tag, so it is a global here rather than an import.
  'Chart',
]);

describe('frontend modules call only functions that exist', () => {
  /**
   * The failure this catches: a call to a module-local helper that is not
   * declared anywhere in the file.
   *
   * It has happened twice, both times during a large edit that spliced a region
   * out of a page and took a neighbouring function with it. Nothing noticed:
   * `node --check` passes because the syntax is fine, tsc never looks at these
   * files, and the import guard above only checks names that cross a module
   * boundary. The page throws "X is not defined" on load — which, because it
   * happens while rendering, is a blank page — and the only way it surfaced was
   * somebody opening it.
   */
  it('has no call to an undeclared identifier', () => {
    const problems: string[] = [];

    for (const abs of files) {
      const raw = fs.readFileSync(abs, 'utf8');
      const code = stripNonCode(raw);
      const declared = new Set<string>();

      const add = (name: string | undefined | null): void => {
        if (name && /^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name);
      };

      for (const m of code.matchAll(/(?:^|[^\w$.])(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_$]+)/g)) add(m[1]);
      for (const m of code.matchAll(/(?:const|let|var|class)\s+([A-Za-z0-9_$]+)/g)) add(m[1]);
      // Object-method and class-method shorthand: `name(args) {`.
      for (const m of code.matchAll(/([A-Za-z0-9_$]+)\s*\([^()]*\)\s*\{/g)) add(m[1]);
      // Destructured bindings.
      for (const m of code.matchAll(/(?:const|let|var)\s*\{([^}]*)\}/g)) {
        for (const part of m[1].split(',')) add(part.split(':').pop()?.split('=')[0].trim());
      }
      // Imports, read from the raw source so a specifier is still intact.
      for (const m of raw.matchAll(/import\s*\{([^}]*)\}/g)) {
        for (const part of m[1].split(',')) add(part.trim().split(/\s+as\s+/).pop()?.trim());
      }
      for (const m of raw.matchAll(/import\s+([A-Za-z0-9_$]+)\s+from/g)) add(m[1]);
      for (const m of raw.matchAll(/import\s+\*\s+as\s+([A-Za-z0-9_$]+)/g)) add(m[1]);
      // Parameters, arrow and classic.
      for (const m of code.matchAll(/\(([^()]*)\)\s*=>/g)) {
        for (const part of m[1].split(',')) add(part.split('=')[0].replace(/[{}[\].]/g, '').trim());
      }
      for (const m of code.matchAll(/([A-Za-z0-9_$]*)\s*\(([^()]*)\)/g)) {
        for (const part of m[2].split(',')) add(part.split('=')[0].replace(/[{}[\].]/g, '').trim());
      }

      // No whitespace before the paren: prose reads "the list (all chests)",
      // code reads "fn(". Lower-case initial only — a capitalised callee is a
      // constructor or a CDN global, and those are covered by the set above.
      for (const m of code.matchAll(/(?<![\w$.])([a-z_$][\w$]*)\(/g)) {
        const name = m[1];
        if (declared.has(name) || KNOWN_CALLABLES.has(name)) continue;
        problems.push(`${rel(abs)}: calls ${name}(), which is not declared or imported`);
      }
    }

    const unique = [...new Set(problems)];
    expect(
      unique,
      'these throw "is not defined" on page load, which renders a blank page: '
        + unique.join('; '),
    ).toEqual([]);
  });
});
