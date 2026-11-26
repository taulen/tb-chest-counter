// Tools → Costs helpers. Research costs come from the game itself: every
// level's cost and research time from its Factory table (T12), read every patch
// (src/game-protocol/tech-trees.ts buildTechLevels, GET /api/game/research-costs).
// Until Nov 26 2026 they were a hand copy of kingdom289.com's sheet (Apr 2026),
// with fixes where the sheet contradicted itself; the game's own numbers
// replaced it. Only the upgrade blueprints below are still from that sheet —
// the game's building upgrade costs aren't read yet.
//
// Rows stay in each tree's order (left to right, top to bottom, as the
// Academy draws it); never sort them by price — the order is the path.
//
// Plain ESM, no DOM: tests/web/research-costs.test.ts imports it directly.

/** Columns of the levels table. Every research and clan tree's research has at most 10 levels. */
export const LEVEL_COLUMNS = 10;

/** The item a tree's research is paid in: the one most of its levels cost (each tree uses one). */
export function treeCurrency(tree) {
  const count = new Map();
  for (const n of [...(tree.nodes || []), ...(tree.unplaced || [])]) {
    for (const l of n.levels || []) for (const id of Object.keys(l.cost || {})) count.set(id, (count.get(id) || 0) + 1);
  }
  let best = null;
  for (const [id, n] of count) if (!best || n > best[1]) best = [id, n];
  return best ? best[0] : null;
}

/** A research's value per level in the view: its cost in `currency`, or its research time in seconds. */
export function levelValues(node, view, currency) {
  return (node.levels || []).map((l) => (view === 'time' ? Number(l.seconds || 0) : Number(l.cost?.[currency] ?? 0)));
}

/**
 * Research that costs the same at every level shares a row, in tree order —
 * the first of them sets the row's place. `valuesOf(node)` is its per-level
 * values. A row: { nodes, values, total } (total = one research, every level).
 */
export function mergeLevelRows(nodes, valuesOf) {
  const out = [];
  const byKey = new Map();
  for (const node of nodes) {
    const values = valuesOf(node);
    const key = `${values.length}:${values.join(',')}`;
    const row = byKey.get(key);
    if (row) {
      row.nodes.push(node);
      continue;
    }
    const fresh = { nodes: [node], values, total: values.reduce((a, b) => a + b, 0) };
    byKey.set(key, fresh);
    out.push(fresh);
  }
  return out;
}

// ─── Tier by tier (src/game-protocol/tier-costs.ts): "G5 → G6" ───

/** The steps of a family from tier `from` (exclusive; 0 = nothing yet) to `to` (inclusive). */
export function rangeSteps(family, from, to) {
  return (family?.steps || []).filter((s) => s.tier > from && s.tier <= to);
}

/** A range's totals: cost per item, research time, Might, the highest level each building is asked for. */
export function sumSteps(steps) {
  const out = { cost: {}, seconds: 0, might: 0, buildings: {} };
  for (const s of steps) {
    for (const [id, n] of Object.entries(s.cost || {})) out.cost[id] = (out.cost[id] || 0) + n;
    out.seconds += s.seconds || 0;
    out.might += s.might || 0;
    for (const [b, lv] of Object.entries(s.buildings || {})) out.buildings[b] = Math.max(out.buildings[b] || 0, lv);
  }
  return out;
}

/** Research time with the player's research speed bonus (+300% = 4× as fast). */
export function withSpeed(seconds, bonusPct) {
  const b = Math.max(0, Number(bonusPct) || 0);
  return seconds / (1 + b / 100);
}

/**
 * Where each research of a family sits on the way up: the first step that
 * needs it, or the step where it opens without being needed (optional).
 * techId → { tier, label, optional }.
 */
export function stepOfTech(family) {
  const out = new Map();
  for (const s of family?.steps || []) {
    for (const it of s.items) if (!out.has(it.techId)) out.set(it.techId, { tier: s.tier, label: s.label, optional: false });
  }
  for (const s of family?.steps || []) {
    for (const it of s.optional) if (!out.has(it.techId)) out.set(it.techId, { tier: s.tier, label: s.label, optional: true });
  }
  return out;
}

/** Blueprints per upgrade level, and their Gold: 10 per blueprint at every level. kingdom289.com (Apr 2026). */
export const BLUEPRINTS = [
  [10, 320],
  [15, 2450],
  [20, 10_400],
  [25, 25_600],
  [30, 51_000],
  [35, 112_000],
  [40, 196_000],
  [45, 343_000],
].map(([level, blueprints]) => ({ level, blueprints, gold: blueprints * 10 }));
