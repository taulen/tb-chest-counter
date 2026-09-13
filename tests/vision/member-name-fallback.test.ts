/**
 * Pins the positional name read that backs up the Latin-leading regex.
 *
 * A first roster build on a 100-member clan stored 88. The sweep reached the
 * end of the list, so nothing was missed by scrolling — the rows were read and
 * then dropped, because the name pattern requires a name that STARTS with a
 * Latin letter:
 *
 *     ([A-Za-z][A-Za-z0-9 _.'"-]{1,30}?)\s*\(?\s*[Kk]\s*[:.]?\s*\d
 *
 * Every name opening with a digit, a bracketed clan tag or an emoji failed it
 * and vanished without a log line. The might sweep never had this problem: it
 * takes the words to the left of the coordinate anchor, whatever they are.
 *
 * Losing a member here is the expensive kind of loss — the roster is what every
 * later scan matches a chest's player name against, so a member missing from it
 * reads for weeks as someone who simply never sends anything.
 */

import { describe, it, expect } from 'vitest';
import { positionalMemberName } from '../../src/browser/member-capture.js';

const words = (...texts: string[]): Array<{ text: string }> => texts.map((text) => ({ text }));

describe('positionalMemberName', () => {
  it('reads a name the Latin-leading pattern refuses', () => {
    // Real shapes from the live roster and its merge rules: a numeric prefix,
    // a bracketed tag, and a leading symbol.
    expect(positionalMemberName(words('185/', 'taulen302', '(K:34', 'X:188', 'Y:534)'), 2))
      .toBe('185/ taulen302');
    expect(positionalMemberName(words('[THE]', 'Wolfich', '(K:34', 'X:394', 'Y:540)'), 2))
      .toBe('[THE] Wolfich');
    expect(positionalMemberName(words('⚔Naty', '(K:34', 'X:406', 'Y:544)'), 1)).toBe('⚔Naty');
  });

  it('reads an ordinary name the same way', () => {
    expect(positionalMemberName(words('SuccubusMom', '(K:34', 'X:406', 'Y:544)'), 1))
      .toBe('SuccubusMom');
  });

  it('returns nothing when the coordinates start the row', () => {
    // Nothing to the left of the anchor means there is no name on this row to
    // read — a clipped row, not a member. It must not invent one.
    expect(positionalMemberName(words('(K:34', 'X:406', 'Y:544)'), 0)).toBe('');
    expect(positionalMemberName(words('(K:34', 'X:406'), -1)).toBe('');
  });
});
