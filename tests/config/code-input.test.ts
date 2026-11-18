// The invite-code field formats as you type (lib/code-input.js): nobody types
// the dash. Whatever it shows must still be what the server accepts.
import { describe, expect, it } from 'vitest';
import { formatInviteCode } from '../../src/web/public/lib/code-input.js';
import { normalizeCode } from '../../src/data/repositories/account-invite-repo.js';

describe('formatInviteCode', () => {
  it('puts the dash in itself and upper-cases', () => {
    expect(formatInviteCode('abcdefgh')).toBe('ABCD-EFGH');
    expect(formatInviteCode('abcd')).toBe('ABCD');
    expect(formatInviteCode('abcde')).toBe('ABCD-E');
  });

  it('takes a pasted code in any shape and drops what is not a letter or digit', () => {
    expect(formatInviteCode(' abcd - efgh ')).toBe('ABCD-EFGH');
    expect(formatInviteCode('ABCD-EFGH')).toBe('ABCD-EFGH');
    expect(formatInviteCode('ab cd ef gh extra')).toBe('ABCD-EFGH');
  });

  it('shows what the server reads', () => {
    for (const typed of ['abcdefgh', 'ABCD EFGH', 'abcd-efgh']) {
      expect(normalizeCode(formatInviteCode(typed))).toBe(normalizeCode(typed));
    }
  });
});
