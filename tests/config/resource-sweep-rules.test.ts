/**
 * Guards for the pure rules the Clan Capital resource sweep is built on.
 *
 * In tests/config because `npm run build` runs `vitest run tests/config` and nothing
 * else, and every rule here has a failure mode that is INVISIBLE at runtime: a wrong
 * answer produces a plausible number, not an error. The two that already cost real
 * data are pinned by name below.
 *
 * The module deliberately imports nothing, so this suite is fast and pulls in no
 * onnxruntime.
 */
import { describe, it, expect } from 'vitest';
import {
  ANCHOR_SAFE_STOP_REASONS,
  CURSOR_MIN_RUN,
  CURSOR_ROWS,
  DATE_BACKSTOP_MARGIN_DAYS,
  REREAD_OPEN_DAY_DAYS,
  buildCursorFingerprints,
  firstSettledRowIndex,
  maxDaysBackFor,
  readCompleteness,
  rowFingerprint,
  withholdAlreadyRecorded,
} from '../../src/browser/resource-sweep-rules.js';

/** A row as the sweep sees it. `n` only exists to make failures readable. */
function row(
  name: string,
  amount: number,
  date: string,
  resourceTypeId: number | null = 6,
  direction: 1 | -1 = 1,
) {
  const r = { rawPlayerName: name, direction, amount, transactionDate: date, resourceTypeId };
  return { ...r, fingerprint: rowFingerprint(r) };
}

const OPEN = new Set(['2026-09-05']);

describe('firstSettledRowIndex', () => {
  it('skips the leading block the game is still writing to', () => {
    const rows = [
      row('a', 1, '2026-09-05'), row('b', 2, '2026-09-05'),
      row('c', 3, '2026-09-04'), row('d', 4, '2026-09-04'),
    ];
    expect(firstSettledRowIndex(rows, OPEN)).toBe(2);
  });

  it('anchors on row 0 when nobody has donated yet today', () => {
    // Measured: 4 of clan 1's last 35 runs had a zero-length open block. A rule that
    // said "skip the first block" instead of "skip open dates" would lose a day here.
    const rows = [row('c', 3, '2026-09-04'), row('d', 4, '2026-09-04')];
    expect(firstSettledRowIndex(rows, OPEN)).toBe(0);
  });

  it('reports -1 when every row is still open', () => {
    expect(firstSettledRowIndex([row('a', 1, '2026-09-05')], OPEN)).toBe(-1);
  });
});

describe('buildCursorFingerprints', () => {
  // Distinct names per block: rowFingerprint deliberately omits the date, so two
  // blocks generated from the same seed would be indistinguishable by design.
  const settled = (n: number, date = '2026-09-04', tag = 'p') =>
    Array.from({ length: n }, (_, i) => row(`${tag}${i}`, 1000 + i, date));

  it('never anchors on a row the game can still change', () => {
    // THE bug. The old rule was rows.slice(0, CURSOR_ROWS) — the top of the list —
    // which is by construction the open block. On 2026-09-05 exactly 2 of those 12
    // rows were still findable the next day.
    const rows = [...settled(3, '2026-09-05', 'open'), ...settled(CURSOR_ROWS)];
    const built = buildCursorFingerprints(rows, OPEN);
    expect(built.anchorAt).toBe(3);
    expect(built.anchorDate).toBe('2026-09-04');
    expect(built.fingerprints).toEqual(rows.slice(3, 3 + CURSOR_ROWS).map((r) => r.fingerprint));
    for (const fp of built.fingerprints) {
      expect(rows.slice(0, 3).map((r) => r.fingerprint)).not.toContain(fp);
    }
  });

  it('returns an EMPTY marker rather than a short one', () => {
    // A marker under CURSOR_MIN_RUN is one the matcher will not even attempt, so
    // storing it silently arms a full-window duplicate sweep next run. Empty means
    // "read everything", which re-reads rather than skips.
    const rows = [...settled(2, '2026-09-05', 'open'), ...settled(CURSOR_MIN_RUN - 1)];
    expect(buildCursorFingerprints(rows, OPEN).fingerprints).toEqual([]);
  });

  it('spills into the next-older day when the settled block is short', () => {
    const rows = [...settled(1, '2026-09-05', 'open'), ...settled(2), ...settled(20, '2026-09-03', 'old')];
    const built = buildCursorFingerprints(rows, OPEN);
    expect(built.fingerprints).toHaveLength(CURSOR_ROWS);
    expect(built.anchorDate).toBe('2026-09-04');
  });

  it('produces nothing when the sweep never reached a settled row', () => {
    expect(buildCursorFingerprints(settled(5, '2026-09-05'), OPEN).fingerprints).toEqual([]);
  });
});

describe('ANCHOR_SAFE_STOP_REASONS', () => {
  it('admits only the stops that read the ground below the anchor', () => {
    expect([...ANCHOR_SAFE_STOP_REASONS].sort()).toEqual(['cursor', 'date-floor', 'end-of-list']);
  });

  it.each(['blank', 'crashed', 'page-limit', 'no-new-rows', 'error'])(
    'refuses to advance the marker after a %s stop',
    (reason) => {
      // These all stop with unread rows still BELOW the new anchor. Advancing over
      // them puts those rows under every future cut, permanently — a sweep the idle
      // overlay kills after 30 rows of a 180-row day would write 30 and strand 150.
      expect(ANCHOR_SAFE_STOP_REASONS.has(reason)).toBe(false);
    },
  );
});

describe('maxDaysBackFor', () => {
  it('leaves room for the settled day the anchor now sits behind', () => {
    // Pinned as an exact value, not as ">= d + DATE_BACKSTOP_MARGIN_DAYS". That
    // weaker assertion still passes with REREAD_OPEN_DAY_DAYS deleted, which is
    // exactly the regression it would exist to catch — a false green.
    expect(REREAD_OPEN_DAY_DAYS).toBeGreaterThanOrEqual(1);
    for (let d = 0; d <= 30; d++) {
      expect(maxDaysBackFor(d)).toBe(d + REREAD_OPEN_DAY_DAYS + DATE_BACKSTOP_MARGIN_DAYS);
      expect(maxDaysBackFor(d)).toBeGreaterThan(d + DATE_BACKSTOP_MARGIN_DAYS);
    }
  });
});

describe('readCompleteness', () => {
  const list = [
    row('a', 1, '2026-09-05'), row('b', 2, '2026-09-04'),
    row('c', 3, '2026-09-04'), row('d', 4, '2026-09-03'),
  ];

  it('excludes the oldest date, which is the block the sweep stopped inside', () => {
    const { completeDates } = readCompleteness(list, list.length, 'date-floor');
    expect([...completeDates].sort()).toEqual(['2026-09-04', '2026-09-05']);
  });

  it('includes the oldest date when the list genuinely ran out', () => {
    const { completeDates } = readCompleteness(list, list.length, 'end-of-list');
    expect(completeDates.has('2026-09-03')).toBe(true);
  });

  it('excludes a date that straddles the cut', () => {
    // The cut is where the previous marker was found, so a date with rows on both
    // sides of it was only PARTLY re-read. Comparing a partial read against a whole
    // stored date is what would delete a genuine same-day repeat.
    const { completeDates } = readCompleteness(list, 2, 'cursor');
    expect(completeDates.has('2026-09-04')).toBe(false);
    expect(completeDates.has('2026-09-05')).toBe(true);
  });

  it('trusts nothing when the dates are not monotone', () => {
    const jumbled = [row('a', 1, '2026-09-03'), row('b', 2, '2026-09-05')];
    const out = readCompleteness(jumbled, jumbled.length, 'end-of-list');
    expect(out.monotone).toBe(false);
    expect(out.completeDates.size).toBe(0);
  });
});

describe('withholdAlreadyRecorded', () => {
  const complete = new Set(['2026-09-04']);
  const strip = (r: { rawPlayerName: string; direction: number; amount: number;
    transactionDate: string; resourceTypeId: number | null }) => ({
    rawPlayerName: r.rawPlayerName,
    direction: r.direction,
    amount: r.amount,
    transactionDate: r.transactionDate,
    resourceTypeId: r.resourceTypeId,
  });

  it('declines a row this clan already holds', () => {
    const read = [row('Gritle', 42000, '2026-09-04')];
    const out = withholdAlreadyRecorded(read, [strip(read[0])], complete);
    expect(out.rows).toEqual([]);
    expect(out.withheld).toBe(1);
  });

  it('subtracts by MULTIPLICITY so a genuine same-day repeat survives', () => {
    // v39 dropped the UNIQUE key because a player really can send the same amount
    // twice in a day — 147 such cases in production, mostly Loyalty Level "+1".
    // Read two, hold one, insert one.
    const a = row('Naty', 1, '2026-09-04', 15);
    const out = withholdAlreadyRecorded([a, { ...a }], [strip(a)], complete);
    expect(out.rows).toHaveLength(1);
  });

  it('keeps both when neither is recorded', () => {
    const a = row('Naty', 1, '2026-09-04', 15);
    expect(withholdAlreadyRecorded([a, { ...a }], [], complete).rows).toHaveLength(2);
  });

  it('never lets ONE stored row satisfy two incoming claims', () => {
    // The bug an earlier design had: separate count maps for the exact and the
    // wildcard pass, each built from the same rows and decremented independently.
    // Clau sends 2,000,000 of two different resources on one day (observed live);
    // one read resolves, the other loses its icon at the rectangle edge. Only the
    // exact match may consume the single stored row.
    const stored = strip(row('Clau', 2000000, '2026-09-04', 6));
    const resolvedRead = row('Clau', 2000000, '2026-09-04', 6);
    const iconlessRead = row('Clau', 2000000, '2026-09-04', null);
    const out = withholdAlreadyRecorded([resolvedRead, iconlessRead], [stored], complete);
    expect(out.withheld).toBe(1);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].resourceTypeId).toBeNull();
  });

  it('lets a resolved read claim a stored UNRESOLVED row', () => {
    // Same physical row, read better this time. Pairing them is what stops a
    // phantom "unknown" duplicate.
    const stored = strip(row('Feli', 5000, '2026-09-04', null));
    const read = row('Feli', 5000, '2026-09-04', 5);
    expect(withholdAlreadyRecorded([read], [stored], complete).withheld).toBe(1);
  });

  it('refuses the reverse: an icon-less read never claims a stored resolved row', () => {
    // One-directional on purpose. Erring this way costs an unresolved row an admin
    // can fix; erring the other way silently drops a real transaction.
    const stored = strip(row('Clau', 2000000, '2026-09-04', 6));
    const read = row('Clau', 2000000, '2026-09-04', null);
    expect(withholdAlreadyRecorded([read], [stored], complete).withheld).toBe(0);
  });

  it('touches nothing on a date it was not told is complete', () => {
    const read = [row('Gritle', 42000, '2026-09-03')];
    expect(withholdAlreadyRecorded(read, [strip(read[0])], complete).withheld).toBe(0);
  });

  it('leaves the surviving rows in their original order', () => {
    const rows = [
      row('a', 1, '2026-09-04'), row('b', 2, '2026-09-04'),
      row('c', 3, '2026-09-04'), row('d', 4, '2026-09-04'),
    ];
    const out = withholdAlreadyRecorded(rows, [strip(rows[1])], complete);
    expect(out.rows.map((r) => r.rawPlayerName)).toEqual(['a', 'c', 'd']);
  });

  it('is a no-op with nothing recorded or no complete dates', () => {
    const rows = [row('a', 1, '2026-09-04')];
    expect(withholdAlreadyRecorded(rows, [], complete).withheld).toBe(0);
    expect(withholdAlreadyRecorded(rows, [strip(rows[0])], new Set()).withheld).toBe(0);
  });
});
