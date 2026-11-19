// What opened chests paid out, printed one way everywhere: Resources → Chest
// rewards and Scan History both show the server's reward totals
// (src/data/chest-rewards.ts RewardTotal: { unit, itemId, total, fromPacks,
// items }) with the game's art (lib/game-art.js rewardChipHtml).
//
// Units never mix: an amount is one resource, time is one kind of speedup,
// a count is one item. `items` is the answer's id → { name, iconUrl,
// quality, seconds } map (src/data/reward-items.ts).

import { rewardChipHtml } from './game-art.js';
import { t, tGame } from './i18n.js';

/** Grouped number in the viewer's locale: "1,250,000", "4.2". */
export const plainNumber = (n, digits = 0) => Number(n).toLocaleString(undefined, { maximumFractionDigits: digits });

const COMPACT = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

/** Short number for a tile badge or a table cell: "312.5K", "4.2", "17". */
export function compactNumber(n) {
  const v = Number(n) || 0;
  if (v < 10) return plainNumber(v, v % 1 ? 1 : 0);
  if (v < 1000) return plainNumber(v, 0);
  return COMPACT.format(v);
}

/** Exact number with the precision an average needs. */
export function exactNumber(n) {
  const v = Number(n) || 0;
  return plainNumber(v, v < 10 ? 2 : v < 100 ? 1 : 0);
}

/**
 * Seconds → "41d 6h", "8h", "4h 12m", "15m". `short` (a tile badge) drops the
 * hours once it runs to 100 days and more: "1,409d", not "1409d 4h" cut off.
 */
export function formatSeconds(sec, { short = false } = {}) {
  const totalMin = Math.round((Number(sec) || 0) / 60);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) {
    return h > 0 && !(short && d >= 100)
      ? t('{days}d {hours}h', { days: plainNumber(d), hours: h })
      : t('{days}d', { days: plainNumber(d) });
  }
  if (h > 0) return m > 0 ? t('{h}h {m}m', { h, m }) : t('{hours}h', { hours: h });
  return t('{minutes}m', { minutes: m });
}

/** A total in its own unit: time as a duration, amounts and counts as numbers. */
export function formatRewardValue(unit, v, { exact = false, short = false } = {}) {
  if (unit === 'time') return formatSeconds(v, { short });
  return exact ? exactNumber(v) : compactNumber(v);
}

/** An item's display name (the game's, translated), or "Item 1234" when the names lack it. */
export function rewardItemName(items, id) {
  const name = items?.[id]?.name;
  return name ? tGame(name) : t('Item {id}', { id });
}

/** The item a reward shows as, ready for rewardChipHtml / itemIconHtml. */
export function rewardItemOf(items, id) {
  const it = items?.[id] ?? {};
  return { name: rewardItemName(items, id), iconUrl: it.iconUrl ?? null, quality: it.quality ?? 0 };
}

/** What makes up a total, for its tooltip: "290,000 (250,000 from packs)", "15d 6h (41 × 8h, …)". */
export function rewardTotalDetail(tot, items) {
  if (tot.unit === 'amount') {
    return tot.fromPacks > 0
      ? t('{total} ({packs} from packs)', { total: plainNumber(tot.total), packs: plainNumber(tot.fromPacks) })
      : plainNumber(tot.total);
  }
  if (tot.unit === 'time') {
    const parts = Object.entries(tot.items ?? {})
      .map(([id, n]) => ({ n, sec: items?.[id]?.seconds ?? 0 }))
      .sort((a, b) => b.sec - a.sec)
      .map(({ n, sec }) => `${plainNumber(n)} × ${formatSeconds(sec)}`);
    return parts.length ? `${formatSeconds(tot.total)} (${parts.join(', ')})` : formatSeconds(tot.total);
  }
  return plainNumber(tot.total);
}

/**
 * A total as the game's reward window shows it: the tile, the short amount on
 * it, the name under it ('stack'); or a small tile with the amount beside it
 * ('inline', a table cell). The exact total is its tooltip and its label.
 */
export function rewardTotalChip(tot, items, { size = 64, layout = 'stack' } = {}) {
  const item = rewardItemOf(items, tot.itemId);
  return rewardChipHtml(item, formatRewardValue(tot.unit, tot.total, { short: true }), {
    size,
    layout,
    label: `${item.name}: ${rewardTotalDetail(tot, items)}`,
  });
}
