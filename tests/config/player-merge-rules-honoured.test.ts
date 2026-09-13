/**
 * Pins that every path which can mint a `members` row from a name read off the
 * screen also consults the clan's player merge rules.
 *
 * A player merge rule is the admin saying "this reading IS that player", and for
 * months exactly ONE place in the codebase read the table: the gift scan
 * (scan-pipeline.ts). Four other paths turn an OCR'd name into a members row —
 * the daily might capture, the roster build, the automated resource-history read
 * and the manual resource upload — and each resolved names through fuzzy.ts and
 * `upsertMember`, neither of which has ever looked at merge_rules. So a rule an
 * admin had already written was ignored by all four, and the duplicate member it
 * existed to prevent was re-created on the very next capture.
 *
 * It ran for days before anyone could prove it, because the failure looks exactly
 * like the feature working: the rule is listed on the Merge Rules page, the merge
 * it performed really did happen, and the duplicate that comes back tomorrow reads
 * as a fresh OCR misread rather than the same one returning. Four names on the live
 * roster were caught in it — and not one is reachable by distance, so no matcher
 * change could ever have covered for the missing rule lookup:
 *
 *     "Ma Chaosraven"    → "Mikam Chaosraven"   3 edits (budget 2)
 *     "Ma from Chaos"    → "Mikam from Chaos"   3 edits (budget 2)
 *     "185/ taulen302"   → "taulen302"          3 edits (budget 2)
 *     "FENRØTH Øf CHAOS" → "FENRØTH Øf CHAØS"   1 edit, but onto a member another
 *                                               reading had already claimed, so it
 *                                               took the promoted-as-separate branch
 *
 * A pure test — it reads source off disk, no DB and no browser — so it runs as part
 * of `npm run build` (npm run guards) and goes red the moment a fifth path is added
 * that creates a member without consulting the rules. That is the whole point: the
 * bug was not a wrong line, it was a missing one, and nothing in a review diff makes
 * an absent lookup visible.
 *
 * The allowlist is not an escape hatch — it is the decision this test forces someone
 * to make out loud, with the reason written down next to it.
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';

const SRC_DIR = path.resolve(fileURLToPath(new URL('../../src', import.meta.url)));

/**
 * Either of the two ways a caller may honour the rules: the canonicaliser built for
 * the capture paths, or the raw cache the gift scan has always used.
 */
const HONOURS_RULES = /loadPlayerNameCanonicaliser|applyMergeRulesCached/;

/**
 * Files allowed to call `upsertMember` without consulting player merge rules, each
 * with the reason it is exempt. Adding a file here is a deliberate statement that a
 * merge rule must NOT apply to its input.
 */
const EXEMPT: Record<string, string> = {
  'data/repositories/member-repo.ts':
    'Defines upsertMember. A clan-scoped rule lookup does not belong in the repo '
    + 'primitive: it is also called with a hand-typed admin name and with the '
    + '"[Unknown]" sentinel, both of which must pass through verbatim.',
  'web/routes/api.ts':
    'The unknown-chest reassign route — an admin typing a destination name by hand. '
    + 'Their intent is authoritative and a rule must never override it. A name that '
    + 'IS a merged spelling still resolves, via the alias addMergeRule now writes.',
};

/**
 * A file's source with comments stripped.
 *
 * Needed because the prose in this codebase discusses `upsertMember(...)` at
 * length — the comments explaining the Bardin misattribution name it directly, in
 * a module that never calls it — and matching those would flag files that have
 * nothing to do with creating a member.
 */
function code(rel: string): string {
  return fs.readFileSync(path.join(SRC_DIR, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** Every .ts file under src/, as a posix path relative to src/. */
function sourceFiles(dir = SRC_DIR, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...sourceFiles(path.join(dir, entry.name), rel));
    else if (entry.name.endsWith('.ts')) out.push(rel);
  }
  return out;
}

describe('player merge rules are honoured wherever a read name creates a member', () => {
  const callers = sourceFiles().filter((rel) => /\bupsertMember\s*\(/.test(code(rel)));

  it('finds the member-creating paths at all', () => {
    // A guard on the guard: if upsertMember is ever renamed, the scan above quietly
    // matches nothing and this test passes while checking absolutely nothing.
    expect(callers.length).toBeGreaterThanOrEqual(5);
    expect(callers).toContain('scheduler/might-capture-phase.ts');
  });

  it('has every caller either consulting the rules or listed as exempt', () => {
    const unguarded = callers.filter((rel) => {
      if (rel in EXEMPT) return false;
      return !HONOURS_RULES.test(code(rel));
    });

    expect(unguarded, unguarded.length === 0 ? '' : (
      `These files create a member from a name without consulting the clan's player `
      + `merge rules: ${unguarded.join(', ')}. Run the name through `
      + `loadPlayerNameCanonicaliser(clanId) before matching and before upserting — or, `
      + `if a rule genuinely must not apply to that input, add the file to EXEMPT with `
      + `the reason.`
    )).toEqual([]);
  });

  it('keeps the exempt list honest', () => {
    // An exemption for a file that no longer calls upsertMember is dead weight that
    // would silently cover a future caller in the same file.
    const stale = Object.keys(EXEMPT).filter((rel) => !callers.includes(rel));
    expect(stale).toEqual([]);
  });
});
