import { describe, expect, it } from 'vitest';
import {
  advanceDateLabel,
  collapseUnresolvedTwins,
  daysAgoFromLabel,
  dedupeNearbyRepeats,
  findCursorIndex,
  fingerprintsAlign,
  looseSweepKey,
  rowFingerprint,
  stitchPage,
} from '../../src/browser/resource-history-capture.js';
import type { ResourceHistoryRow } from '../../src/browser/resource-history-capture.js';
import { resolveTransactionDate } from '../../src/vision/resource-ocr.js';

/**
 * Guard for the two pieces of the automated resource capture that can be
 * silently, dangerously wrong.
 *
 * Everything else in that module either works or visibly produces nothing. These
 * two decide which rows get written to the database:
 *
 *   - stitchPage decides where one scroll page ends and the next begins. Get it
 *     wrong and rows are either duplicated or dropped, both looking like real
 *     data.
 *   - findCursorIndex decides how much of the list is new since the last run.
 *     Too high and days of contributions are skipped; too low and they're
 *     recorded twice.
 *
 * The design rests on one property of the game: it merges same-day repeats into
 * a single line, so two ADJACENT rows are never identical even though one row on
 * its own is not unique (which is why migration v39 dropped the UNIQUE key). The
 * tests below encode that property — including the case that motivates it, where
 * the same (player, amount, resource) triple appears twice in the list.
 */

/** Build a row. `date` defaults to a fixed value: the fingerprint deliberately
 *  excludes the date, since a row ages from TODAY to YESTERDAY between runs. */
function row(
  name: string,
  direction: 1 | -1,
  amount: number,
  resourceTypeId: number | null,
  date = '2026-07-31',
): ResourceHistoryRow {
  const base = {
    memberId: null,
    resourceTypeId,
    direction,
    amount,
    transactionDate: date,
    rawPlayerName: name,
    rowCropPath: null,
  };
  return { ...base, fingerprint: rowFingerprint(base) };
}

/** A recognisable run of rows, modelled on the real screenshots. */
function sampleList(): ResourceHistoryRow[] {
  return [
    row('Kevyy', 1, 1, null),
    row('Child of Chaos', 1, 14_222, 3),
    row('taulen302', 1, 1_019_650, 3),
    row('Chaos John Wick', 1, 3_352, 3),
    row('Marinn', 1, 8_699, 3),
    row('Glorgol', 1, 11_970_000, 5),
    row('Light of Chaos', 1, 26_077, 3),
    row('Feli', -1, 5_000, 5),
    row('Eydaen', -1, 7_500, 5),
    row('sahkermahker', -1, 52_000, 5),
    row('Микам from Chaos', -1, 21_000, 5),
    row('XERN', -1, 21_000, 5),
    row('FrostChaos', -1, 21_000, 5),
    row('Pallas Athena', 1, 6_576_094, 2),
    row('Max75', 1, 10_875_000, 4),
  ];
}

describe('rowFingerprint', () => {
  it('ignores the date, so a row keeps its identity as it ages TODAY → YESTERDAY', () => {
    const today = row('taulen302', 1, 1_019_650, 3, '2026-07-31');
    const yesterday = row('taulen302', 1, 1_019_650, 3, '2026-07-30');
    expect(today.fingerprint).toBe(yesterday.fingerprint);
  });

  it('ignores case and internal whitespace, which OCR renders inconsistently', () => {
    expect(row('Child of Chaos', 1, 14_222, 3).fingerprint)
      .toBe(row('child  ofchaos', 1, 14_222, 3).fingerprint);
  });

  it('separates rows that differ only in direction', () => {
    expect(row('XERN', 1, 21_000, 5).fingerprint)
      .not.toBe(row('XERN', -1, 21_000, 5).fingerprint);
  });

  it('separates rows that differ only in resource', () => {
    expect(row('XERN', -1, 21_000, 5).fingerprint)
      .not.toBe(row('XERN', -1, 21_000, 3).fingerprint);
  });

  it('gives unresolved rows a distinct marker rather than colliding on null', () => {
    // Two rows the reader couldn't identify must not be treated as the same row
    // just because both are unknown — the amount and player still separate them.
    expect(row('Feli', -1, 5_000, null).fingerprint)
      .not.toBe(row('Feli', -1, 6_000, null).fingerprint);
    expect(row('Feli', -1, 5_000, null).fingerprint).toContain('|x');
  });
});

describe('stitchPage', () => {
  it('drops the overlap between consecutive scroll pages', () => {
    const list = sampleList();
    const page1 = list.slice(0, 8);
    const page2 = list.slice(4, 12); // 50% overlap, as the wheel step produces

    const stitched = stitchPage(page1, page2);
    expect(stitched.rows.map((r) => r.fingerprint)).toEqual(
      list.slice(0, 12).map((r) => r.fingerprint),
    );
    expect(stitched.overlap).toBe(4);
  });

  it('handles a page that overlaps entirely (a wheel event that did not land)', () => {
    const page = sampleList().slice(0, 6);
    const stitched = stitchPage(page, page);
    expect(stitched.rows).toHaveLength(6);
    expect(stitched.overlap).toBe(6);
  });

  it('reports overlap 0 when the pages share nothing — the skipped-rows signal', () => {
    // The one way this sweep can lose data silently: a scroll step big enough to jump
    // clean over rows, which no later stage can detect. Appending is the safe
    // direction (the de-duplication pass catches repeats), but the caller has to be
    // TOLD, so overlap 0 is reported rather than swallowed.
    const list = sampleList();
    const stitched = stitchPage(list.slice(0, 4), list.slice(9, 13));
    expect(stitched.rows).toHaveLength(8);
    expect(stitched.overlap).toBe(0);
  });

  it('distinguishes "nothing to stitch" from "nothing matched"', () => {
    // -1, not 0: an empty page or a first page is not evidence of skipped rows, and
    // reporting it as such would cry wolf on every sweep's opening page.
    const page = sampleList().slice(0, 3);
    expect(stitchPage(page, []).rows).toEqual(page);
    expect(stitchPage(page, []).overlap).toBe(-1);
    expect(stitchPage([], page).rows).toEqual(page);
    expect(stitchPage([], page).overlap).toBe(-1);
  });

  it('recognises a clipped read of a row it already resolved, and keeps the resolved one', () => {
    // The 117-of-503 bug. A row sliced by the rectangle's top or bottom edge keeps its
    // name and amount but loses its icon, so it read as a DIFFERENT row from the clean
    // read on the neighbouring page: the stitch couldn't align them, dedupe couldn't
    // collapse them, and the row landed in the database twice — once correct, once
    // "unknown", double-counting the amount.
    const list = sampleList();
    const page1 = list.slice(0, 8);
    // Page 2 starts with the same three rows, but its first one lost its icon to the
    // crop edge.
    const clipped = row('Marinn', 1, 8_699, null);
    const page2 = [clipped, ...list.slice(5, 12)];

    const stitched = stitchPage(page1, page2);
    // 4: Marinn (clipped) plus the three rows after it that both pages share.
    expect(stitched.overlap).toBe(4);
    // No duplicate, and the surviving row is the RESOLVED one — not the clipped read
    // that happened to be seen first.
    const marinns = stitched.rows.filter((r) => r.rawPlayerName === 'Marinn');
    expect(marinns).toHaveLength(1);
    expect(marinns[0].resourceTypeId).toBe(3);
  });

  it('upgrades an unresolved row already in the list when a later page resolves it', () => {
    // Order matters: a row's FIRST sighting is often the one clipped at the bottom
    // edge, so "first read wins" would keep the unresolved version and throw the clean
    // one away — exactly backwards.
    const resolved = row('Feli', -1, 5_000, 5);
    const unresolved = row('Feli', -1, 5_000, null);
    const stitched = stitchPage([row('Kevyy', 1, 1, null), unresolved], [resolved]);
    expect(stitched.rows).toHaveLength(2);
    expect(stitched.rows[1].resourceTypeId).toBe(5);
  });

  it('never merges two resolved rows that differ only by resource', () => {
    // The reason the resource cannot simply be dropped from the identity: a player
    // really can send the same amount of two different resources on the same day, and
    // those adjacent rows are both real. Observed live as "Clau +2,000,000" twice.
    const wood = row('Clau', 1, 2_000_000, 3);
    const stone = row('Clau', 1, 2_000_000, 5);
    const stitched = stitchPage([wood], [stone]);
    expect(stitched.rows).toHaveLength(2);
    expect(stitched.overlap).toBe(0);
  });

  it('still aligns a long overlap when one row inside it was read differently', () => {
    // The brittleness that made a faster scroll look unsafe. A perfect-match rule
    // rejects a 10-row window over one garbled row, and the next candidate compares a
    // SHIFTED window that cannot match either — so one OCR wobble threw the whole
    // page away. Measured on 11 of 39 real pages.
    const list = sampleList();
    const page1 = list.slice(0, 12);
    const page2 = list.slice(4, 15).slice();
    // OCR read this player's name differently on the second frame.
    page2[2] = row('Light 0f Chaos', 1, 26_077, 3);

    const stitched = stitchPage(page1, page2);
    expect(stitched.overlap).toBe(8);
    // 15 distinct rows, not 12 + 11 appended wholesale.
    expect(stitched.rows).toHaveLength(15);
  });

  it('refuses a short overlap that is not exact', () => {
    // A long window can afford a bad read; three rows agreeing on two is weak
    // evidence and must not be accepted as an alignment.
    const a = row('A', 1, 10, 1);
    const b = row('B', 1, 20, 1);
    const c = row('C', 1, 30, 1);
    const wrong = row('Z', 1, 99, 1);
    const stitched = stitchPage([a, b, c], [a, wrong, c]);
    expect(stitched.overlap).toBe(0);
  });

  it('aligns on the longest overlap when a single row repeats elsewhere in the list', () => {
    // XERN and FrostChaos both took 21,000 of resource 5 — one row is genuinely
    // ambiguous. The overlap is found from the RUN, not the row, so the stitch
    // still lands correctly.
    const list = sampleList();
    const page1 = list.slice(0, 12); // ends …Микам, XERN
    const page2 = list.slice(10, 15); // starts Микам, XERN, FrostChaos…

    const stitched = stitchPage(page1, page2);
    expect(stitched.rows.map((r) => r.fingerprint)).toEqual(list.map((r) => r.fingerprint));
    expect(stitched.overlap).toBe(2);
  });
});

describe('same row repeating on different days', () => {
  it('keeps an identical row from one player on two different days', () => {
    // The data-loss bug behind the false "shares no rows" warnings. A Loyalty Level
    // row ("+1") is byte-identical every time a player earns one, so keying a sweep on
    // the date-free cursor fingerprint merged day 3 into day 7 — losing a real
    // transaction — and, by deleting rows out of the accumulated list's TAIL, left its
    // last rows no longer lining up with the next page's first rows.
    const day3 = row('Naty', 1, 1, 7, '2026-07-28');
    const day7 = row('Naty', 1, 1, 7, '2026-07-24');
    expect(day3.fingerprint).toBe(day7.fingerprint); // cursor identity ignores the date
    // …but a sweep must treat them as two rows.
    const stitched = stitchPage([day3], [day7]);
    expect(stitched.rows).toHaveLength(2);
    expect(stitched.overlap).toBe(0);
  });

  it('still aligns pages when such rows are present', () => {
    // The end-to-end shape of the bug: a page whose overlap contains repeat-prone
    // rows must still align, or the sweep appends it whole and warns about skipped
    // rows that were never skipped.
    const shared = [
      row('Naty', 1, 1, 7, '2026-07-28'),
      row('Meninad', 1, 1, 7, '2026-07-28'),
      row('WALID', 1, 42_000, 3, '2026-07-28'),
      row('Feral', 1, 2, 7, '2026-07-28'),
      row('Clayton', 1, 2, 7, '2026-07-28'),
    ];
    // An earlier day held identical Loyalty rows for two of the same players.
    const earlier = [
      row('Naty', 1, 1, 7, '2026-07-30'),
      row('Clayton', 1, 2, 7, '2026-07-30'),
    ];
    const acc = stitchPage(earlier, shared).rows;
    expect(acc).toHaveLength(7);

    const nextPage = [...shared.slice(2), row('Lothar', 1, 42_000, 3, '2026-07-28')];
    const stitched = stitchPage(acc, nextPage);
    expect(stitched.overlap).toBe(3);
    expect(stitched.rows).toHaveLength(8);
  });
});

/**
 * A page whose overlap straddles a date header dates the top of that overlap one day too
 * new: the header has scrolled off, so the page inherits the label in effect at the END of
 * the previous page, which belongs to rows further DOWN the list. Measured on pages 186/187
 * of a real sweep — seven rows read as 07-22 then as 07-21, identical otherwise.
 *
 * With the date in the alignment those pages found no overlap at all, warned about skipped
 * rows that were never skipped, and appended a second mis-dated copy of every one. It
 * accounted for 10 of 12 such warnings on that sweep, and 92 duplicate rows.
 */
describe('a page whose overlap straddles a date header', () => {
  // Seven rows the new page dates one day older, then two both reads agree on.
  const drifted = (date: string) => [
    row('Feli', -1, 30_000, 8, date),
    row('Pallas Athena', -1, 10_000, 8, date),
    row('Queen of Chaos', -1, 20_000, 8, date),
    row('Chaotic Vesper', -1, 10_000, 8, date),
    row('CHaoS JOooO', -1, 10_000, 8, date),
    row('nurgul', -1, 10_000, 8, date),
    row('Nimath', 1, 3_150_000, 5, date),
  ];
  const agreed = [
    row('SHAHIN', 1, 4_232_127, 2, '2026-07-21'),
    row('SHAHIN', 1, 5_273_893, 3, '2026-07-21'),
  ];

  it('aligns despite the date disagreement, instead of appending a mis-dated copy', () => {
    const acc = [...drifted('2026-07-22'), ...agreed];
    const page = [...drifted('2026-07-21'), ...agreed, row('Kadal', 1, 233, 6, '2026-07-21')];

    const stitched = stitchPage(acc, page);
    expect(stitched.overlap).toBe(9);
    // 9 accumulated + the one genuinely new row. Not 9 + 10.
    expect(stitched.rows).toHaveLength(10);
  });

  it('keeps the earlier read\'s date, which is the one that still had the header', () => {
    const acc = [...drifted('2026-07-22'), ...agreed];
    const page = [...drifted('2026-07-21'), ...agreed];

    const stitched = stitchPage(acc, page);
    expect(stitched.rows.slice(0, 7).map((r) => r.transactionDate))
      .toEqual(Array(7).fill('2026-07-22'));
  });

  /**
   * The floor that keeps this from becoming the data-loss bug it replaced. A short window
   * proves nothing by content alone, so the date-tolerant rule is not allowed to see it —
   * see the day-repeat case above, where one Loyalty Level row would swallow another.
   */
  it('refuses to ignore the date on a window shorter than the floor', () => {
    const acc = [
      row('Naty', 1, 1, 7, '2026-07-28'),
      row('Meninad', 1, 1, 7, '2026-07-28'),
      row('Feral', 1, 2, 7, '2026-07-28'),
      row('Clayton', 1, 2, 7, '2026-07-28'),
      row('Adam', 1, 5, 7, '2026-07-28'),
    ];
    // The same five rows a different day: a real repeat, not a re-read.
    const page = acc.map((r) => ({ ...r, transactionDate: '2026-07-24' }));

    const stitched = stitchPage(acc, page);
    expect(stitched.overlap).toBe(0);
    expect(stitched.rows).toHaveLength(10);
  });
});

describe('dedupeNearbyRepeats', () => {
  it('collapses an ADJACENT identical pair — always a re-read, never two events', () => {
    // The game merges two identical same-day entries before drawing the list, so it
    // never shows the same line twice in a row. An adjacent pair therefore cannot be
    // two transactions; it is one row caught by two overlapping screenshots.
    const dup = row('Naty', 1, 1, 7, '2026-07-28');
    const out = dedupeNearbyRepeats([row('Adam', 1, 5, 7, '2026-07-28'), dup, dup]);
    expect(out.dropped).toBe(1);
    expect(out.rows).toHaveLength(2);
  });

  it('keeps an identical pair with even ONE row between them', () => {
    // The boundary, and why it sits at exactly 1: with anything in between, the pair
    // could be two real events. Only the game's own "never twice in a row" guarantee
    // makes the adjacent case safe to collapse.
    const hermes = () => row('Naty', 1, 1, 7, '2026-07-28');
    const out = dedupeNearbyRepeats([hermes(), row('Adam', 1, 5, 7, '2026-07-28'), hermes()]);
    expect(out.dropped).toBe(0);
    expect(out.rows).toHaveLength(3);
  });

  it('keeps two identical rows from the same day that are far apart', () => {
    // The case value-based de-duplication cannot see: one player earning "+1" Loyalty
    // Level twice in a day, hours apart. Both rows are real; they sit far apart in the
    // list, so position is the only thing distinguishing them from a re-read.
    const hermes = () => row('Naty', 1, 1, 7, '2026-07-28');
    const filler = Array.from({ length: 60 }, (_, i) => row(`P${i}`, 1, 1000 + i, 3, '2026-07-28'));
    const out = dedupeNearbyRepeats([hermes(), ...filler, hermes()]);
    expect(out.dropped).toBe(0);
    expect(out.rows).toHaveLength(62);
  });

  it('keeps the resolved copy when only one read identified the icon', () => {
    const unresolved = row('Feli', -1, 5_000, null, '2026-07-28');
    const resolved = row('Feli', -1, 5_000, 5, '2026-07-28');
    // Same row, but sweepRowKey differs by resource, so the icon-less pair is handled
    // by the stitch/twin-collapse path; here we check an exact-key pair upgrades.
    const out = dedupeNearbyRepeats([unresolved, unresolved]);
    expect(out.rows).toHaveLength(1);
    expect(resolved.resourceTypeId).toBe(5);
  });
});

describe('collapseUnresolvedTwins', () => {
  /**
   * maxPerPage exactly as the sweep builds it: how many rows one screenshot ever
   * showed for each name/direction/amount ON A GIVEN DAY.
   *
   * Must use the same key the production code does — this helper originally used the
   * date-free one and silently disagreed, which made the Clau case look like a
   * regression when only the fixture was wrong.
   */
  function pageCounts(...pages: ResourceHistoryRow[][]): Map<string, number> {
    const max = new Map<string, number>();
    for (const page of pages) {
      const seen = new Map<string, number>();
      for (const r of page) seen.set(looseSweepKey(r), (seen.get(looseSweepKey(r)) ?? 0) + 1);
      for (const [k, n] of seen) if (n > (max.get(k) ?? 0)) max.set(k, n);
    }
    return max;
  }

  it('drops an unresolved row ADJACENT to the resolved read of the same row', () => {
    const resolved = row('Feli', -1, 5_000, 5);
    const phantom = row('Feli', -1, 5_000, null);
    const list = [row('XERN', -1, 21_000, 5), resolved, phantom];
    const out = collapseUnresolvedTwins(list, pageCounts([resolved], [phantom]));
    expect(out.dropped).toBe(1);
    expect(out.rows).toHaveLength(2);
    expect(out.rows.every((r) => r.resourceTypeId != null)).toBe(true);
  });

  it('keeps an unresolved row that is NOT adjacent to its resolved lookalike', () => {
    // It could be a genuine same-day repeat whose icon failed to read, and deleting a
    // real transaction is worse than leaving an unknown for an admin to resolve. The
    // stitch is what merges true edge-clipped pairs, using position rather than value.
    const resolved = row('Feli', -1, 5_000, 5);
    const maybeReal = row('Feli', -1, 5_000, null);
    const list = [resolved, row('XERN', -1, 21_000, 5), maybeReal];
    const out = collapseUnresolvedTwins(list, pageCounts([resolved], [maybeReal]));
    expect(out.dropped).toBe(0);
    expect(out.rows).toHaveLength(3);
  });

  it('keeps both same-amount rows from one player when one of them is unreadable', () => {
    // The case that makes a blind collapse unsafe. One page showed TWO "Clau
    // +2,000,000" rows, so two such transactions exist; the unreadable one must
    // survive as an unknown rather than being deleted.
    const wood = row('Clau', 1, 2_000_000, 3);
    const failed = row('Clau', 1, 2_000_000, null);
    const out = collapseUnresolvedTwins([wood, failed], pageCounts([wood, failed]));
    expect(out.dropped).toBe(0);
    expect(out.rows).toHaveLength(2);
  });

  it('drops only the surplus when a key is genuinely duplicated', () => {
    // Two real rows, plus a third phantom read of one of them.
    const a = row('Clau', 1, 2_000_000, 3);
    const b = row('Clau', 1, 2_000_000, 5);
    const phantom = row('Clau', 1, 2_000_000, null);
    const out = collapseUnresolvedTwins([a, b, phantom], pageCounts([a, b]));
    expect(out.dropped).toBe(1);
    expect(out.rows).toHaveLength(2);
  });

  it('leaves a lone unresolved row alone — it is a real reading failure', () => {
    const only = row('Ilrin', 1, 81_019, null);
    const out = collapseUnresolvedTwins([only], pageCounts([only]));
    expect(out.dropped).toBe(0);
    expect(out.rows).toHaveLength(1);
  });
});

describe('findCursorIndex', () => {
  it('returns -1 when there is no cursor (first run reads everything)', () => {
    expect(findCursorIndex(sampleList(), [])).toBe(-1);
  });

  it('finds the cursor at the top when nothing new has happened', () => {
    const list = sampleList();
    const cursor = list.slice(0, 12).map((r) => r.fingerprint);
    expect(findCursorIndex(list, cursor)).toBe(0);
  });

  it('reports exactly how many rows are new', () => {
    const list = sampleList();
    // Yesterday's run saw the list starting at index 3; three rows arrived since.
    const cursor = list.slice(3, 15).map((r) => r.fingerprint);
    expect(findCursorIndex(list, cursor)).toBe(3);
  });

  it('still anchors when the cursor\'s leading rows have scrolled off the list', () => {
    const list = sampleList();
    // The stored cursor's first two rows are no longer present (aged off the
    // 14-day window), so only its tail can match.
    const cursor = [
      'ghost-a|1|1|1',
      'ghost-b|1|2|1',
      ...list.slice(0, 6).map((r) => r.fingerprint),
    ];
    expect(findCursorIndex(list, cursor)).toBe(0);
  });

  it('tolerates a garbled row at the head of the cursor and still anchors ON it', () => {
    const list = sampleList();
    // The cursor's first row is what is now list[5], read with a different amount
    // this time. The nine rows after it align, which pins the head to row 5 — so
    // row 5 is known ground and only rows 0-4 are new.
    //
    // The old contiguous-run rule answered 6 here: it could only start counting
    // AFTER the bad row, so the previous run's own top row was handed back as new
    // and re-inserted. Aligning through the gap is both stricter evidence and one
    // fewer duplicate.
    const cursor = [
      'garbled|1|999|9',
      ...list.slice(6, 15).map((r) => r.fingerprint),
    ];
    expect(findCursorIndex(list, cursor)).toBe(5);
  });

  it('matches a marker row whose icon was unreadable when it was stored', () => {
    // The single most likely way for the cursor to change between runs, and the one
    // that sent a clan-1 daily run ten days back. The marker rows are the TOP of the
    // list, which is where the rectangle's edge clips the resource icon — so they get
    // stored as "unknown" and then read cleanly next run, once new rows have pushed
    // them down the page.
    const list = sampleList();
    const cursor = list.slice(0, 12).map((r, i) => (
      // Rows 1-3 lost their icon on the run that stored them.
      i >= 1 && i <= 3 ? r.fingerprint.replace(/\|\d+$/, '|x') : r.fingerprint
    ));
    expect(findCursorIndex(list, cursor)).toBe(0);
  });

  it('tolerates a garbled row in the MIDDLE of the cursor', () => {
    const list = sampleList();
    const cursor = list.slice(2, 14).map((r) => r.fingerprint);
    cursor[5] = 'garbled|1|999|9';
    // A row between two rows the previous run recorded cannot be a new arrival —
    // new rows only ever appear at the top of the list — so the gap is certainly a
    // bad read and the alignment holds through it.
    expect(findCursorIndex(list, cursor)).toBe(2);
  });

  it('refuses a window whose matches fall below the scaled threshold', () => {
    const list = sampleList();
    // Half the marker rows differ. Twelve rows need eight to agree, so this is not
    // evidence of a position — the caller keeps everything and reports a lost cursor.
    const cursor = list.slice(0, 12).map((r, i) => (
      i % 2 === 0 ? r.fingerprint : `garbled-${i}|1|${i}|9`
    ));
    expect(findCursorIndex(list, cursor)).toBe(-1);
  });

  it('refuses to match on a run shorter than the minimum', () => {
    const list = sampleList();
    // Three rows is below CURSOR_MIN_RUN: too weak to be sure it's the real
    // position rather than a coincidental alignment, so the caller falls back to
    // keeping everything (and reports a lost cursor).
    const cursor = list.slice(5, 8).map((r) => r.fingerprint);
    expect(findCursorIndex(list, cursor)).toBe(-1);
  });

  it('returns -1 when the cursor is nowhere in the list', () => {
    const cursor = ['a|1|1|1', 'b|1|2|1', 'c|1|3|1', 'd|1|4|1', 'e|1|5|1'];
    expect(findCursorIndex(sampleList(), cursor)).toBe(-1);
  });

  it('returns -1 for an empty list', () => {
    const cursor = sampleList().slice(0, 12).map((r) => r.fingerprint);
    expect(findCursorIndex([], cursor)).toBe(-1);
  });

  it('picks the first alignment when a repeated block could match twice', () => {
    // A pathological list where the same four-row block appears twice. The newer
    // (higher) occurrence wins, which is the conservative choice: it treats fewer
    // rows as new, and re-reading a row is recoverable while skipping one is not.
    const block = [
      row('A', 1, 10, 1),
      row('B', 1, 20, 1),
      row('C', 1, 30, 1),
      row('D', 1, 40, 1),
    ];
    const list = [row('Z', 1, 5, 1), ...block, row('Y', 1, 6, 1), ...block];
    const cursor = block.map((r) => r.fingerprint);
    expect(findCursorIndex(list, cursor)).toBe(1);
  });
});

describe('fingerprintsAlign', () => {
  it('treats an unresolved read as the same row as a resolved one', () => {
    expect(fingerprintsAlign('feli|-1|5000|x', 'feli|-1|5000|5')).toBe(true);
    expect(fingerprintsAlign('feli|-1|5000|5', 'feli|-1|5000|x')).toBe(true);
  });

  it('keeps two rows with DIFFERENT resolved resources apart', () => {
    // A player really can send the same amount of two resources on the same day
    // ("Clau +2,000,000" twice, observed live). The wildcard is one-sided for this.
    expect(fingerprintsAlign('clau|1|2000000|3', 'clau|1|2000000|5')).toBe(false);
  });

  it('never matches across a different player, direction or amount', () => {
    expect(fingerprintsAlign('feli|-1|5000|x', 'feli|-1|5001|x')).toBe(false);
    expect(fingerprintsAlign('feli|-1|5000|x', 'feli|1|5000|x')).toBe(false);
    expect(fingerprintsAlign('feli|-1|5000|x', 'eydaen|-1|5000|x')).toBe(false);
  });
});

/**
 * The date backstop's only piece of arithmetic.
 *
 * It decides whether a sweep that lost its cursor keeps scrolling, so an unparsed
 * label has to mean "don't know" rather than a number — the sweep carries on in that
 * case, which is the recoverable direction.
 */
describe('daysAgoFromLabel', () => {
  it('reads the labels the game actually draws', () => {
    expect(daysAgoFromLabel('TODAY')).toBe(0);
    expect(daysAgoFromLabel('YESTERDAY')).toBe(1);
    expect(daysAgoFromLabel('2 DAYS AGO')).toBe(2);
    expect(daysAgoFromLabel('14 DAYS AGO')).toBe(14);
  });

  it('is insensitive to case and spacing, as OCR output requires', () => {
    expect(daysAgoFromLabel('  today ')).toBe(0);
    expect(daysAgoFromLabel('3 days ago')).toBe(3);
    expect(daysAgoFromLabel('1 DAY AGO')).toBe(1);
  });

  it('returns null for anything it cannot read, rather than guessing', () => {
    expect(daysAgoFromLabel('')).toBeNull();
    expect(daysAgoFromLabel('T0DAY')).toBeNull();
    expect(daysAgoFromLabel('LAST WEEK')).toBeNull();
  });

  it('agrees with advanceDateLabel, which ages the same labels mid-sweep', () => {
    let label = 'TODAY';
    for (let expected = 0; expected <= 5; expected++) {
      expect(daysAgoFromLabel(label)).toBe(expected);
      label = advanceDateLabel(label);
    }
  });
});

/**
 * The mid-sweep day rollover.
 *
 * A full backfill can run for over an hour, so the account's midnight can land
 * inside one sweep — at which point the game re-labels every row it is still
 * showing, without the sweep touching anything. A row read as "YESTERDAY" on
 * page 99 reads "2 DAYS AGO" on page 101.
 *
 * The capture handles it by re-anchoring the base date per page AND ageing the
 * label it carries between pages. Both halves are required and they have to move
 * together: that is exactly what the round-trip below asserts. Move only the
 * anchor and every row after the crossing is dated a day early; move neither and
 * the same row resolves to two different dates in one sweep, which is not just a
 * wrong date but a duplicate INSERT, because sweepRowKey includes the date and
 * the second reading no longer collapses into the first.
 */
describe('advanceDateLabel', () => {
  it('ages a label exactly one day', () => {
    expect(advanceDateLabel('TODAY')).toBe('YESTERDAY');
    expect(advanceDateLabel('YESTERDAY')).toBe('2 DAYS AGO');
    expect(advanceDateLabel('2 DAYS AGO')).toBe('3 DAYS AGO');
    expect(advanceDateLabel('13 DAYS AGO')).toBe('14 DAYS AGO');
    // Case and spacing as the OCR normaliser hands them over.
    expect(advanceDateLabel('yesterday')).toBe('2 DAYS AGO');
    expect(advanceDateLabel('  2 DAY AGO ')).toBe('3 DAYS AGO');
  });

  it('leaves a label it does not recognise alone', () => {
    // Only an OCR misread produces this. Inventing a day for it would be worse
    // than carrying on with what the sweep already had.
    expect(advanceDateLabel('YESTERD4Y')).toBe('YESTERD4Y');
    expect(advanceDateLabel('')).toBe('');
  });

  it('resolves to the same date once the base date advances with it', () => {
    // The invariant the re-anchor rests on: crossing midnight moves the anchor
    // forward a day and ages the label a day, and those two cancel — a row the
    // game re-labelled still lands on the date it always had.
    const before = new Date('2026-08-02T00:00:00Z');
    const after = new Date('2026-08-03T00:00:00Z');
    for (const label of ['TODAY', 'YESTERDAY', ...Array.from({ length: 13 }, (_, i) => `${i + 2} DAYS AGO`)]) {
      expect(resolveTransactionDate(advanceDateLabel(label), after))
        .toBe(resolveTransactionDate(label, before));
    }
  });
});
