import { describe, expect, it } from 'vitest';
import { markResolved, type LogBufferEntry } from '../../src/utils/log-buffer.js';
import { reauthLegacyMatcher, reauthWarningKey } from '../../src/data/repositories/clan-repo.js';

/**
 * The System page's "Needs attention" list is a log capture, and it had no way
 * to learn that a problem had gone away. On 2026-09-28 it still showed
 * "Clan #2 needs re-authentication ×14" from Sep 24, and a Clan #1 one from
 * Sep 23 — both clans had long since signed in again, clan #1 within a minute.
 * Clearing the re-auth flag now retires the matching entries; these pin down
 * which ones.
 */
const entry = (msg: string, extra: Partial<LogBufferEntry> = {}): LogBufferEntry => ({
  ts: 1,
  level: 50,
  levelName: 'error',
  module: 'scanner',
  msg,
  alert: true,
  ...extra,
});

const reauthMsg = (id: number) =>
  `Clan #${id} needs re-authentication — saved Total Battle session cannot load the game canvas. Open Clans → Refresh login.`;

const resolveReauth = (entries: LogBufferEntry[], id: number, now = 500) =>
  markResolved(entries, reauthWarningKey(id), now, reauthLegacyMatcher(id));

describe('markResolved', () => {
  it('retires keyed entries: out of Needs attention, off the nav dot, still listed', () => {
    const entries = [entry(reauthMsg(2), { resolveKey: reauthWarningKey(2) })];

    expect(resolveReauth(entries, 2)).toBe(1);
    expect(entries[0].alert).toBe(false);
    expect(entries[0].resolvedAt).toBe(500);
    expect(entries).toHaveLength(1);
  });

  it('retires entries logged before the key existed, on their message', () => {
    // Exactly what is sitting in data/warnings.jsonl on prod today.
    const entries = [entry(reauthMsg(2)), entry(reauthMsg(2))];

    expect(resolveReauth(entries, 2)).toBe(2);
    expect(entries.every((e) => e.alert === false)).toBe(true);
  });

  it("never touches another clan's re-auth, including one whose id starts the same", () => {
    const entries = [
      entry(reauthMsg(12)),
      entry(reauthMsg(2), { resolveKey: reauthWarningKey(2) }),
      entry('Not logged in', { levelName: 'warn', level: 40, resolveKey: reauthWarningKey(3) }),
    ];

    expect(resolveReauth(entries, 1)).toBe(0);
    expect(entries.every((e) => e.alert === true)).toBe(true);
  });

  it('leaves unrelated warnings alone', () => {
    const entries = [entry('Members tab still not visible after a retry and a reload.')];

    expect(resolveReauth(entries, 1)).toBe(0);
    expect(entries[0].alert).toBe(true);
  });

  it('does not let a keyed entry fall through to the message match', () => {
    // An entry tagged for some other condition is that condition's to resolve,
    // even if its text happens to read like a re-auth error.
    const entries = [entry(reauthMsg(1), { resolveKey: 'something-else' })];

    expect(resolveReauth(entries, 1)).toBe(0);
  });

  it('keeps the first resolution time, so a healthy clan re-checking every cycle changes nothing', () => {
    const entries = [entry(reauthMsg(1), { resolveKey: reauthWarningKey(1) })];

    resolveReauth(entries, 1, 500);
    expect(resolveReauth(entries, 1, 900)).toBe(0);
    expect(entries[0].resolvedAt).toBe(500);
  });
});
