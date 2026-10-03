// Text alternatives for the Chart.js canvases (Analytics, Might, member Might,
// Resources).
//
// A canvas is a picture. Before this, a screen reader met every chart as
// nothing at all, and nobody without a mouse could read a single value — they
// only ever appeared in hover tooltips. Each chart now gets a one-sentence
// summary as its accessible name and a "Show data as table" disclosure under
// it, built from the same labels and datasets the chart draws, so the table can
// never disagree with the picture.

import { esc } from './ui.js';

const formatDefault = (v) => (typeof v === 'number' ? v.toLocaleString() : String(v));

/**
 * The chart's data as rows: one per x label, one column per dataset. Accepts
 * plain numbers or {x, y} points; null, undefined and NaN read as "no value".
 * Datasets flagged `a11yHidden: true` are left out. Pure — exported for tests.
 */
export function chartTableModel(data) {
  const datasets = (data?.datasets || []).filter((d) => !d.a11yHidden);
  const labels = data?.labels || [];
  const valueAt = (d, i) => {
    const raw = d.data?.[i];
    const y = raw !== null && typeof raw === 'object' ? raw.y : raw;
    return y === null || y === undefined || Number.isNaN(y) ? null : y;
  };
  return {
    columns: datasets.map((d, i) => d.label || `Series ${i + 1}`),
    rows: labels.map((label, i) => ({
      label: String(label),
      values: datasets.map((d) => valueAt(d, i)),
    })),
  };
}

/**
 * One sentence for the canvas's accessible name: what it shows, the range it
 * covers, and the latest value of up to three series. Pure — exported for tests.
 */
export function chartSummary(model, { caption, format = formatDefault }) {
  const { rows, columns } = model;
  if (rows.length === 0) return `${caption}: no data.`;
  const range = rows.length === 1 ? rows[0].label : `${rows[0].label} to ${rows[rows.length - 1].label}`;
  const latest = columns.slice(0, 3).map((name, c) => {
    for (let r = rows.length - 1; r >= 0; r--) {
      const v = rows[r].values[c];
      if (v !== null) return `${name} ${format(v)}`;
    }
    return null;
  }).filter(Boolean);
  return `${caption}, ${range}.${latest.length ? ` Latest: ${latest.join('; ')}.` : ''}`;
}

/**
 * Describe a Chart.js chart for assistive tech and put its data in a table.
 * Call right after `new Chart(...)`. Charts are rebuilt on every period, metric
 * and theme change, so a second call replaces this chart's table (keeping it
 * open if it was) rather than adding another.
 *
 *  - caption  what the chart shows, e.g. "Clan might over the last 90 game days"
 *  - xLabel   heading for the label column (default "Date")
 *  - format   value formatter for the table and summary
 */
export function describeChart(chart, { caption, xLabel = 'Date', format = formatDefault }) {
  const canvas = chart?.canvas;
  if (!canvas) return;
  const model = chartTableModel(chart.data);
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', chartSummary(model, { caption, format }));

  // After the sized container, never inside it: .chart-container has a fixed
  // height for the canvas, which an open table would overflow.
  const host = canvas.parentElement;
  if (!host) return;
  const existing = host.nextElementSibling;
  let details = existing && existing.matches('details.chart-data') ? existing : null;
  const wasOpen = !!details?.open;
  if (!details) {
    details = document.createElement('details');
    details.className = 'chart-data';
    host.after(details);
  }
  details.innerHTML = `<summary>Show data as table</summary>
    <div class="chart-data-scroll">
      <table class="chart-data-table">
        <caption class="visually-hidden">${esc(caption)}</caption>
        <thead><tr>
          <th scope="col">${esc(xLabel)}</th>
          ${model.columns.map((c) => `<th scope="col" class="num">${esc(c)}</th>`).join('')}
        </tr></thead>
        <tbody>${model.rows.map((r) => `<tr>
          <th scope="row">${esc(r.label)}</th>
          ${r.values.map((v) => `<td class="num">${v === null ? '—' : esc(format(v))}</td>`).join('')}
        </tr>`).join('')}</tbody>
      </table>
    </div>`;
  details.open = wasOpen;
}

/** Drop the table that follows `host`, when the chart it described is gone. */
export function clearChartTable(host) {
  const next = host?.nextElementSibling;
  if (next && next.matches('details.chart-data')) next.remove();
}
