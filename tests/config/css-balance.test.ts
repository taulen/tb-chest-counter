/**
 * Every stylesheet's braces balance. A merge once dropped the closing brace of
 * the clan page's phone-only @media block (Nov 2026): the whole Chats
 * stylesheet after it applied only on phones, and the page shipped unstyled on
 * desktop. A browser never complains about that, so the build has to.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const PUBLIC = path.resolve('src', 'web', 'public');

function cssFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...cssFiles(p));
    else if (e.name.endsWith('.css')) out.push(p);
  }
  return out;
}

/** First problem in a stylesheet's brace nesting, or null when balanced. */
export function braceProblem(css: string): string | null {
  // Comments and strings may hold braces; blank them out, keeping line breaks.
  const text = css
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, (m) => ' '.repeat(m.length));
  let depth = 0;
  let line = 1;
  const opened: number[] = [];
  for (const c of text) {
    if (c === '\n') line++;
    else if (c === '{') { depth++; opened.push(line); }
    else if (c === '}') {
      depth--;
      opened.pop();
      if (depth < 0) return `an extra "}" at line ${line}`;
    }
  }
  return depth ? `a "{" opened at line ${opened[opened.length - 1]} is never closed` : null;
}

describe('stylesheets', () => {
  it('detects an unclosed block and an extra brace', () => {
    expect(braceProblem('@media (max-width: 640px) {\n  .a { b: c; }\n.d { e: f; }\n')).toBe('a "{" opened at line 1 is never closed');
    expect(braceProblem('.a { b: c; }\n}\n')).toBe('an extra "}" at line 2');
    expect(braceProblem('/* { */ .a::after { content: "}"; }\n')).toBeNull();
  });

  for (const file of cssFiles(PUBLIC)) {
    it(`${path.relative(PUBLIC, file)} has balanced braces`, () => {
      expect(braceProblem(fs.readFileSync(file, 'utf8'))).toBeNull();
    });
  }
});
