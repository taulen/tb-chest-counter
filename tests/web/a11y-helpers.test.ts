import { beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - plain browser module, imported directly so the markup is testable here
import { sortableThHtml } from '../../src/web/public/lib/sort-headers.js';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - plain browser module
import { goalStatusLabel, goalCellContentHtml, goalCellTitle } from '../../src/web/public/lib/leaderboard-render.js';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - plain browser module
import { statusCellHtml } from '../../src/web/public/lib/chesttracker-render.js';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - plain browser module
import { chartTableModel, chartSummary } from '../../src/web/public/lib/chart-a11y.js';

/**
 * The pure halves of the accessibility helpers: the markup and text they
 * produce. The parts that need a real browser (focus, inert, observers) are
 * checked by hand; these are the parts that can be wrong quietly — a header
 * that announces the wrong sort direction, a coloured cell with no words, a
 * chart table that disagrees with the chart.
 */

// esc() in lib/ui.js escapes through a throwaway <div>. Installed after the
// imports on purpose: ui.js wires a document listener at load when a document
// exists, and this stub has no addEventListener.
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

// Numbers render in the machine's locale (toLocaleString) — "4 210" on a
// Norwegian box — so expectations go through the same call.
const n = (v: number) => v.toLocaleString();

describe('sortableThHtml', () => {
  it('puts the label in a real button, so the keyboard can sort', () => {
    const html = sortableThHtml({ key: 'points', labelHtml: 'Points', sortState: { key: 'rank', dir: 'asc' } });
    expect(html).toContain('<button type="button" class="th-sort-btn">Points</button>');
    expect(html).toContain('data-sort-key="points"');
  });

  it('announces the sort direction on the active column only', () => {
    const asc = sortableThHtml({ key: 'name', labelHtml: 'Name', sortState: { key: 'name', dir: 'asc' } });
    const desc = sortableThHtml({ key: 'name', labelHtml: 'Name', sortState: { key: 'name', dir: 'desc' } });
    const other = sortableThHtml({ key: 'name', labelHtml: 'Name', sortState: { key: 'points', dir: 'desc' } });
    expect(asc).toContain('aria-sort="ascending"');
    expect(desc).toContain('aria-sort="descending"');
    expect(other).not.toContain('aria-sort');
  });

  it('keeps the arrow away from screen readers', () => {
    const html = sortableThHtml({ key: 'name', labelHtml: 'Name', sortState: { key: 'name', dir: 'desc' } });
    expect(html).toContain('<span class="sort-arrow" aria-hidden="true"> ▼</span>');
  });

  it('carries data-action and escapes the tooltip', () => {
    const html = sortableThHtml({
      key: 'k', labelHtml: 'K', sortState: null, action: 'sort-members', className: 'num', title: 'a "quoted" <tip>',
    });
    expect(html).toContain('class="sortable num"');
    expect(html).toContain('data-action="sort-members"');
    expect(html).toContain('title="a &quot;quoted&quot; &lt;tip&gt;"');
  });

  it('lets a header that lays out its own arrow pass one (or none)', () => {
    const html = sortableThHtml({ key: 'k', labelHtml: 'K', sortState: { key: 'k', dir: 'asc' }, arrowHtml: '' });
    expect(html).not.toContain('sort-arrow');
    expect(html).toContain('aria-sort="ascending"');
  });
});

describe('goal cells say their status in words', () => {
  it('names each status', () => {
    expect(goalStatusLabel('ok')).toBe('Goal reached');
    expect(goalStatusLabel('warn')).toBe('Close to goal');
    expect(goalStatusLabel('low')).toBe('Below goal');
    expect(goalStatusLabel('')).toBe('');
  });

  it('adds a glyph and spoken text when there is a goal', () => {
    const html = goalCellContentHtml(4210, 7143);
    expect(html).toContain('<span class="goal-glyph" aria-hidden="true">↓</span>');
    expect(html).toContain(n(4210));
    expect(html).toContain('<span class="visually-hidden">, below goal</span>');
    expect(goalCellContentHtml(8000, 7143)).toContain(', goal reached');
    expect(goalCellContentHtml(5000, 7143)).toContain(', close to goal');
  });

  it('is just the number with no goal', () => {
    expect(goalCellContentHtml(4210, null)).toBe(n(4210));
  });

  it('states value against target in the tooltip', () => {
    expect(goalCellTitle(4210, 7143)).toBe(`Below goal — ${n(4210)} of ${n(7143)}`);
    expect(goalCellTitle(4210, null)).toBe('');
  });

  it('does the same on the ChestTracker tab, at its 50% threshold', () => {
    expect(statusCellHtml(13, 13)).toContain(', target reached');
    expect(statusCellHtml(8, 13)).toContain(', at least half the target');
    expect(statusCellHtml(4, 13)).toContain(', below half the target');
    expect(statusCellHtml(4, null)).toBe('4');
  });
});

describe('chart text alternatives', () => {
  it('turns labels and datasets into rows, keeping gaps as gaps', () => {
    const model = chartTableModel({
      labels: ['2026-09-01', '2026-09-02', '2026-09-03'],
      datasets: [
        { label: 'Alice', data: [10, null, 30] },
        { label: 'Bob', data: [{ x: 'a', y: 5 }, { x: 'b', y: 6 }, undefined] },
        { label: 'Band', data: [1, 1, 1], a11yHidden: true },
      ],
    });
    expect(model.columns).toEqual(['Alice', 'Bob']);
    expect(model.rows).toEqual([
      { label: '2026-09-01', values: [10, 5] },
      { label: '2026-09-02', values: [null, 6] },
      { label: '2026-09-03', values: [30, null] },
    ]);
  });

  it('summarises range and each series’ latest real value', () => {
    const model = chartTableModel({
      labels: ['Mon', 'Tue', 'Wed'],
      datasets: [{ label: 'Chests', data: [1, 2000, null] }],
    });
    expect(chartSummary(model, { caption: 'Clan chests per day' }))
      .toBe(`Clan chests per day, Mon to Wed. Latest: Chests ${n(2000)}.`);
  });

  it('says so when there is nothing to show', () => {
    expect(chartSummary(chartTableModel({ labels: [], datasets: [] }), { caption: 'Might' })).toBe('Might: no data.');
  });
});
