import { describe, expect, it } from 'vitest';
import {
  HEADLINE_MAX,
  warningHeadline,
  hasMoreThanHeadline,
  groupWarnings,
  splitWarnings,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore - plain browser module, imported directly so the digest logic is testable here
} from '../../src/web/public/lib/warning-digest.js';

/**
 * The System page's Recent Warnings card used to print every log message in
 * full, in a four-column table. Measured over one real day (2026-09-15): 19
 * entries, median 171 characters, longest 637, and three identical "Discord
 * member lookup failed" lines holding three of the twenty buffer slots.
 * Nothing distinguished a note about a chart gap from a clan whose roster
 * capture had failed, so the card got dismissed unread — which is worse than
 * showing nothing, because the real faults were in there.
 *
 * These messages are verbatim from that day's log. What they guard is the one
 * assumption the whole approach rests on: that the messages are written
 * headline-first, so a useful headline can be DERIVED rather than authored at
 * 179 call sites where it would drift out of sync with the message anyway. If
 * that assumption stops holding, these cases are where it shows.
 */

const REAL = {
  deadRefs: '5 configuration reference(s) point at something that no longer exists '
    + '(source-points/source-key-dead, merge-rules/from-value-dead) — open the System page for the list.',
  missedReadings: 'Might capture for clan #1: 6 active member(s) got no reading today — '
    + 'AngelEyes, King Morlurn, SarSnow, WALID, [Unknown], another. Either the sweep never reached '
    + 'their row, or their name was read differently enough to land on someone else (see any '
    + 'collapsed-reading warning above). They keep yesterday’s value; the chart simply has no '
    + 'point for them today.',
  membersPanel: 'Members tab still not visible after a retry and a reload. The calibrated Members '
    + 'sidebar coord (-999416, 384) did not open the Members panel — if the screen looks right in '
    + 'data/screenshots/member_nav_after_reload.png, re-run the calibration wizard’s Stage 2.',
  noMarker: 'Resource capture for clan #2: not comparing this read against rows already recorded, '
    + 'because the marker row could not be located, so there is nothing to date-check against. Rows '
    + 'already held may therefore be written again; they are visible on the batch and can be deleted, '
    + 'which is the recoverable direction.',
  newChest: 'pipelined: 1 new unrecognised chest name(s) seen for the first time in '
    + 'CWB - ChaosWithoutBorders (#2) — review for new chest types vs OCR garbage. '
    + 'Samples: "Connection lost" → "Connection lost"',
  discord: 'Discord member lookup failed: DiscordAPIError[50001]: Missing Access',
};

describe('warningHeadline', () => {
  it('keeps every real message inside the headline budget', () => {
    for (const [name, msg] of Object.entries(REAL)) {
      const h = warningHeadline(msg);
      expect(h.length, name).toBeLessThanOrEqual(HEADLINE_MAX + 1); // +1 for the ellipsis
    }
  });

  it('cuts at the em dash, which is where these messages stop being the headline', () => {
    expect(warningHeadline(REAL.missedReadings))
      .toBe('Might capture for clan #1: 6 active member(s) got no reading today');
  });

  it('cuts at the first sentence when there is no em dash before it', () => {
    expect(warningHeadline(REAL.membersPanel))
      .toBe('Members tab still not visible after a retry and a reload');
  });

  it('never cuts on a hyphen — clan names contain one', () => {
    // "CWB - ChaosWithoutBorders". Cutting on " - " would behead the message
    // at the clan name and lose what the warning is actually about.
    expect(warningHeadline(REAL.newChest)).toContain('new unrecognised chest name');
    expect(warningHeadline('Scan finished for CWB - ChaosWithoutBorders with 4 errors'))
      .toBe('Scan finished for CWB - ChaosWithoutBorders with 4 errors');
  });

  it('ends on a clause rather than mid-thought when it has to truncate', () => {
    const h = warningHeadline(REAL.noMarker);
    expect(h).toBe('Resource capture for clan #2: not comparing this read against rows already recorded…');
    expect(h).not.toMatch(/because the…$/);
  });

  it('leaves a message that is already short completely alone', () => {
    expect(warningHeadline(REAL.discord)).toBe(REAL.discord);
    expect(hasMoreThanHeadline(REAL.discord, warningHeadline(REAL.discord))).toBe(false);
  });

  it('does not treat a decimal, a duration or a trailing "#2." as a sentence end', () => {
    // A cut here would leave "Maintenance will last for about 1 h" — dropping
    // the minutes, which is the half that matters.
    expect(warningHeadline('Maintenance will last for about 1 h 0 m and blocks the scan until it ends'))
      .toBe('Maintenance will last for about 1 h 0 m and blocks the scan until it ends');
    expect(warningHeadline('Upgrade to v1.2 before the next scan cycle to pick up the fix'))
      .toBe('Upgrade to v1.2 before the next scan cycle to pick up the fix');
  });

  it('survives empty and missing messages instead of rendering "undefined"', () => {
    expect(warningHeadline('')).toBe('(empty message)');
    expect(warningHeadline(null)).toBe('(empty message)');
    expect(warningHeadline(undefined)).toBe('(empty message)');
  });

  it('collapses newlines so a multi-line message cannot break the row', () => {
    expect(warningHeadline('Scan failed\n  at doThing()\n  at other()')).toBe('Scan failed at doThing() at other()');
  });
});

describe('groupWarnings', () => {
  const at = (ts: number, msg: string, extra = {}) =>
    Object.assign({ ts, level: 40, levelName: 'warn', module: 'discord-directory', msg, alert: true }, extra);

  it('folds identical repeats into one row with a count', () => {
    // The real case: three of twenty buffer slots spent on one message.
    const out = groupWarnings([at(1, REAL.discord), at(2, REAL.discord), at(3, REAL.discord)]);
    expect(out).toHaveLength(1);
    expect(out[0].count).toBe(3);
  });

  it('keeps the newest timestamp, because the question is whether it is still happening', () => {
    const out = groupWarnings([at(100, REAL.discord), at(300, REAL.discord), at(200, REAL.discord)]);
    expect(out[0].ts).toBe(300);
    expect(out[0].firstTs).toBe(100);
  });

  it('keeps the same message from two different modules apart', () => {
    const out = groupWarnings([
      at(1, 'Request failed', { module: 'discord' }),
      at(2, 'Request failed', { module: 'external-loop' }),
    ]);
    expect(out).toHaveLength(2);
  });

  it('keeps a warn and an error of the same text apart', () => {
    const out = groupWarnings([
      at(1, 'Members tab not visible', { levelName: 'warn' }),
      at(2, 'Members tab not visible', { levelName: 'error', level: 50 }),
    ]);
    expect(out).toHaveLength(2);
  });

  it('orders newest first', () => {
    const out = groupWarnings([at(1, 'a'), at(3, 'c'), at(2, 'b')]);
    expect(out.map((e: { msg: string }) => e.msg)).toEqual(['c', 'b', 'a']);
  });

  it('handles an empty or missing buffer', () => {
    expect(groupWarnings([])).toEqual([]);
    expect(groupWarnings(undefined)).toEqual([]);
  });
});

describe('splitWarnings', () => {
  const entry = (msg: string, alert: boolean, ts = 1) =>
    ({ ts, level: 40, levelName: 'warn', module: 'scanner', msg, alert });

  it('routes on the same flag that drives the System nav dot', () => {
    // If these two disagreed, the dot would light for something the page
    // filed under "informational", or stay dark next to a red row.
    const { attention, fyi } = splitWarnings([
      entry(REAL.deadRefs, true, 2),
      entry(REAL.newChest, false, 1),
    ]);
    expect(attention).toHaveLength(1);
    expect(attention[0].msg).toBe(REAL.deadRefs);
    expect(fyi).toHaveLength(1);
  });

  it('treats a missing alert flag as needing attention', () => {
    // Back-compat with entries persisted before the flag existed: a warning
    // whose importance is unknown must not be filed away silently.
    const { attention } = splitWarnings([
      { ts: 1, level: 40, levelName: 'warn', module: '', msg: 'legacy entry' },
    ]);
    expect(attention).toHaveLength(1);
  });

  it('folds repeats before splitting, so a burst cannot flood either group', () => {
    const { fyi } = splitWarnings([
      entry(REAL.discord, false, 1),
      entry(REAL.discord, false, 2),
      entry(REAL.discord, false, 3),
    ]);
    expect(fyi).toHaveLength(1);
    expect(fyi[0].count).toBe(3);
  });
});
