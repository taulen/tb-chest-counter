import { beforeAll, describe, expect, it } from 'vitest';
import {
  buildBoard,
  listHtml,
  podiumHtml,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore - plain browser module, imported directly so the board's logic is testable here
} from '../../src/web/public/lib/ranking-board.js';

// esc() in lib/ui.js escapes through a throwaway <div> (the same stub as
// a11y-helpers.test.ts). Installed after the imports: ui.js wires a document
// listener at load when a document exists, and this stub has none.
beforeAll(() => {
  const g = globalThis as unknown as { document?: unknown };
  if (!g.document) {
    g.document = {
      createElement: () => {
        let text = '';
        return {
          set textContent(v: string) { text = String(v); },
          get innerHTML() {
            return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          },
        };
      },
    };
  }
});

/**
 * The ranking board (lib/ranking-board.js) is ONE build shared by the Members
 * board and the public share page, so its banding, delta and ordering are what
 * both surfaces show. These are the parts with no DOM in them.
 */

const WEEK = { from: '2026-11-15T17:00:00.000Z', to: '2026-11-22T17:00:00.000Z' };
const HALF_WAY = Date.parse(WEEK.from) + 3.5 * 86_400_000;
const GOAL = { weeklyPoints: 14_000, history: [] };

const entries = [
  { memberId: 1, memberName: 'Alice', rank: 1, totalPoints: 20_000, totalChests: 300, might: 5e8, guardsLevel: 7, goldPass: 'current' },
  { memberId: 2, memberName: 'bob', rank: 2, totalPoints: 9_000, totalChests: 120, might: null, guardsLevel: null, goldPass: null },
  { memberId: 3, memberName: 'Cara', rank: 3, totalPoints: 1_000, totalChests: 400, might: 2e8, guardsLevel: 5, goldPass: null },
  { memberId: 4, memberName: 'Dan', rank: 4, totalPoints: 0, totalChests: 0, might: 9e8, guardsLevel: null, goldPass: null },
];

function board({ running = true, prevEntries = null as Array<{ memberId: number; totalPoints: number }> | null } = {}) {
  return buildBoard({
    entries,
    prevEntries,
    goal: GOAL,
    period: 'weekly',
    offset: running ? 0 : 1,
    rolloverHr: 17,
    weekStart: 'sunday',
    windows: { win: WEEK, running, prev: null, now: HALF_WAY },
  });
}

const LOOK = { tag: 'a', attrs: (r: { id: number }) => `href="#member/${r.id}"`, pic: () => '' };
const order = (html: string) => [...html.matchAll(/href="#member\/(\d+)"/g)].map((m) => Number(m[1]));
const state = (over: Record<string, unknown> = {}) => ({ band: 'all', sort: 'points', reverse: false, query: '', ...over });

describe('buildBoard', () => {
  it('bands each member against the goal and the pace mark while the week runs', () => {
    const b = board();
    expect(b.goalPts).toBe(14_000);
    expect(b.pacePts).toBe(7_000); // half the week gone
    expect(b.rows.map((r: { band: string }) => r.band)).toEqual(['ok', 'pace', 'behind', 'behind']);
  });

  it('has no pace once the week has ended: reached or behind', () => {
    const b = board({ running: false });
    expect(b.pacePts).toBeNull();
    expect(b.rows.map((r: { band: string }) => r.band)).toEqual(['ok', 'behind', 'behind', 'behind']);
  });

  it('gives a delta only when the window before was read', () => {
    expect(board().rows[0].delta).toBeNull();
    const b = board({ prevEntries: [{ memberId: 1, totalPoints: 25_000 }] });
    expect(b.rows[0].delta).toBe(-5_000);
    expect(b.rows[1].delta).toBe(9_000); // not on last week's board: from zero
  });
});

describe('podiumHtml', () => {
  it('shows the top three with points, by rank', () => {
    expect(order(podiumHtml(board(), LOOK))).toEqual([1, 2, 3]);
  });

  it('is empty before anybody has points', () => {
    const empty = buildBoard({
      entries: entries.map((e) => ({ ...e, totalPoints: 0 })),
      goal: GOAL, period: 'weekly', offset: 0, rolloverHr: 17, weekStart: 'sunday',
      windows: { win: WEEK, running: true, prev: null, now: HALF_WAY },
    });
    expect(podiumHtml(empty, LOOK)).toBe('');
  });
});

describe('listHtml ordering', () => {
  it('groups by band when ranked by points, and turns it all on its head when reversed', () => {
    expect(order(listHtml(board(), state(), LOOK))).toEqual([1, 2, 3, 4]);
    expect(order(listHtml(board(), state({ reverse: true }), LOOK))).toEqual([4, 3, 2, 1]);
  });

  it('sorts names A→Z, then Z→A on the second click, case-blind', () => {
    expect(order(listHtml(board(), state({ sort: 'name' }), LOOK))).toEqual([1, 2, 3, 4]);
    expect(order(listHtml(board(), state({ sort: 'name', reverse: true }), LOOK))).toEqual([4, 3, 2, 1]);
  });

  it('sorts chests most-first, then fewest-first', () => {
    expect(order(listHtml(board(), state({ sort: 'chests' }), LOOK))).toEqual([3, 1, 2, 4]);
    expect(order(listHtml(board(), state({ sort: 'chests', reverse: true }), LOOK))).toEqual([4, 2, 1, 3]);
  });

  it('keeps an unknown might at the bottom both ways: missing is not smallest', () => {
    expect(order(listHtml(board(), state({ sort: 'might' }), LOOK))).toEqual([4, 1, 3, 2]);
    expect(order(listHtml(board(), state({ sort: 'might', reverse: true }), LOOK))).toEqual([3, 1, 4, 2]);
  });

  it('filters by band and by name', () => {
    expect(order(listHtml(board(), state({ band: 'behind' }), LOOK))).toEqual([3, 4]);
    expect(order(listHtml(board(), state({ query: 'CA' }), LOOK))).toEqual([3]);
  });
});
