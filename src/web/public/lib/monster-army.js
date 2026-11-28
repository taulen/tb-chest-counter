// Tools → Monsters, the data side (docs/monster-simulator.md): battle-data.json
// (GET /api/tools/battle-data) as unit definitions for the engine and the
// picker, the targets grouped the way players think of them, troop levels,
// and what a player's own shared battles say — each troop's bonuses, the
// army's extra bonus against an event's monsters, and the most of each troop
// they sent.
//
// Plain ESM, no DOM access — imported by pages/monster-tool.js and the tests.

import { withGapsFilled } from './report-bonuses.js';

/** The picker's groups, in order (a unit's `kind`). */
export const UNIT_GROUPS = ['guardsmen', 'specialists', 'monsters', 'mercenaries', 'siege'];
/** Monsters and mercenaries are never traded for cheaper losses (Citadel's rule). */
export const PROTECTED_KINDS = new Set(['monsters', 'mercenaries']);
const LEVEL_KIND = { guardsmen: 'g', specialists: 's', monsters: 'm', siege: 'e' };

/**
 * Every unit as the engine and the page read it: { id (string), unit (T9 id),
 * name, tier, str, hp, tags, vs, icon, kind?, group?, lead?, dom?, auth? }.
 * The same object every time, so the engine's per-def caches hold.
 */
export function unitDefs(data) {
  const out = new Map();
  for (const [id, u] of Object.entries(data?.units ?? {})) {
    out.set(String(id), { ...u, id: String(id), unit: Number(id), group: u.kind ?? null });
  }
  return out;
}

/** The units a player can send, in the picker's order: kind, then strongest first. */
export function fieldableUnits(defs) {
  return [...defs.values()]
    .filter((d) => d.kind)
    .sort((a, b) => UNIT_GROUPS.indexOf(a.kind) - UNIT_GROUPS.indexOf(b.kind) || b.str - a.str || a.unit - b.unit);
}

/** [kind letter, tier] for the level gate, or null (mercenaries, map units). */
export function unitLevel(def) {
  const k = def ? LEVEL_KIND[def.kind] : null;
  return k && def.tier ? [k, def.tier] : null;
}

// ─── Targets ─────────────────────────────────────────────────────

/** The target groups, in the picker's order. */
export const TARGET_GROUPS = ['common', 'rare', 'heroic', 'legendary', 'epic', 'raid', 'vault', 'citadel', 'other'];

/**
 * Which group a target belongs to: its T7 class, with the name for what the
 * class leaves open (Legendary and older squads have class 0; the game spells
 * "Сommon Pumpkin squad" with a Cyrillic С).
 */
export function targetGroup(t) {
  const n = String(t?.name ?? '');
  if (/^legendary /i.test(n)) return 'legendary';
  if (/citadel/i.test(n)) return 'citadel';
  switch (t?.cls) {
    case 1: return 'common';
    case 2: return 'rare';
    case 3: return 'heroic';
    case 5: return 'epic';
    case 7: return 'raid';
    case 8: return 'vault';
    default: break;
  }
  if (/^[cс]ommon /i.test(n)) return 'common';
  if (/^rare /i.test(n)) return 'rare';
  if (/^heroic /i.test(n)) return 'heroic';
  if (/\bepic\b/i.test(n)) return 'epic';
  return 'other';
}

/**
 * The picker's list: [{ group, families: [{ name, levels: [{ level, variants: [target…] }] }] }],
 * groups in TARGET_GROUPS order, families by name, levels ascending. A level
 * with several armies (the game keeps more than one version) lists each.
 */
export function targetFamilies(data) {
  const byName = new Map();
  for (const t of data?.targets ?? []) {
    let fam = byName.get(t.name);
    if (!fam) byName.set(t.name, (fam = { name: t.name, group: targetGroup(t), levels: new Map() }));
    if (!fam.levels.has(t.level)) fam.levels.set(t.level, []);
    fam.levels.get(t.level).push(t);
  }
  return TARGET_GROUPS.map((group) => ({
    group,
    families: [...byName.values()]
      .filter((f) => f.group === group)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((f) => ({ name: f.name, levels: [...f.levels].sort((a, b) => a[0] - b[0]).map(([level, variants]) => ({ level, variants })) })),
  })).filter((g) => g.families.length);
}

/**
 * Who leads an attack on a target (battle-data's T7 f10 / f11): 'hero' — the
 * Hero alone (Rare squads, Basilisk), 'captains' — captains only (Common
 * squads, Fenrir, the Tin Man, Briareus), 'both' — the Hero with captains
 * (Heroic squads, citadels). Bonuses and the leadership a march has differ
 * with it, so a battle only tells about targets led the same way.
 */
export function targetCommand(t) {
  if (!t) return null;
  if (t.hero && !t.captains) return 'hero';
  if (!t.hero) return 'captains';
  return 'both';
}

/** How a report's march was led, in targetCommand's words; null when the report can't say. */
export function battleCommand(led) {
  if (!led) return null;
  if (led.hero && !led.captains) return 'hero';
  if (!led.hero) return 'captains';
  return 'both';
}

/** The battles led the way this target must be. */
export function battlesLedFor(target, reports) {
  const want = targetCommand(target);
  return (reports ?? []).filter((r) => battleCommand(r.led) === want);
}

/** The target a report fought (by T7 id), or null. */
export function targetOfReport(data, staticId) {
  if (staticId === null || staticId === undefined) return null;
  return (data?.targets ?? []).find((t) => t.ids.includes(Number(staticId))) ?? null;
}

/** Whether a target's army has an event's monsters (where an army's extra "vs" bonus counts). */
export const hasEventMonsters = (target, defs) => (target?.army ?? []).some(([u]) => defs.get(String(u))?.tags.includes('epicmonster'));

/** A def with the army's extra bonus against event monsters (one number per army, docs/monster-simulator.md). */
export function withEventBonus(def, eventPct) {
  if (!eventPct) return def;
  return { ...def, vs: [...(def.vs ?? []), [['epicmonster'], eventPct, 1]] };
}

// ─── What a player's battles say ─────────────────────────────────

/** report-bonuses.js's troop shape for the game's units (it matches a report's unit by name and base stats). */
export function reportTroops(defs) {
  return [...defs.values()].filter((d) => d.kind).map((d) => {
    const walls = (d.vs ?? []).find(([on]) => on.includes('citywalls'));
    return { id: d.id, name: d.name, str: d.str, hp: d.hp, siegeEngine: d.tags.includes('siege'), vs: walls ? { fortification: walls[1] } : {} };
  });
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * The army's extra "vs" bonus against an event's monsters (percent), as a
 * battle shows it: what each strike on such a monster made beyond the troop's
 * own features (extraA is the features' share of the damage). Null when the
 * battle shows none.
 */
export function eventBonusFromReport(report, defs) {
  const extras = [];
  for (const tr of report?.troops ?? []) {
    const me = defs.get(String(tr.unit));
    if (!me) continue;
    for (const s of tr.strikes ?? []) {
      const target = defs.get(String(s.target?.unit));
      if (!target?.tags.includes('epicmonster') || !s.count || !(s.damage > 0)) continue;
      const base = s.extraB > 0 ? s.extraB : s.capped ? 0 : s.damage;
      if (!(base > 0)) continue;
      const m = base / (s.count * me.str);
      const features = (s.extraA / s.damage) * m;
      let own = 0;
      for (const [on, pct] of me.vs ?? []) if (on.some((x) => target.tags.includes(x))) own += pct / 100;
      extras.push((features - own) * 100);
    }
  }
  const v = median(extras);
  return v === null ? null : Math.round(v * 1000) / 1000;
}

/**
 * What one battle says about the player's troops: their bonuses by unit id
 * (report-bonuses.js: exact where the battle shows them, else the card), the
 * event bonus, and which other battles filled gaps.
 */
export function bonusesFromBattle(report, reports, defs) {
  const { found, borrowed, gapsFrom } = withGapsFilled(report, reports, reportTroops(defs));
  return { found, borrowed, gapsFrom, eventPct: eventBonusFromReport(report, defs) };
}

/**
 * An army from the player's own battles: every troop they sent, with its
 * newest bonuses and `cap` — the most of it they sent in one battle, which
 * they have at least. Battles newest first. Mercenary purchases of one kind
 * fight as one stack, so a battle's count is their sum.
 */
export function armyFromBattles(reports, defs) {
  const rows = new Map();
  for (const r of reports ?? []) {
    let found = null;
    try { found = withGapsFilled(r, reports, reportTroops(defs)).found; } catch { found = new Map(); }
    const sent = new Map();
    for (const tr of r.troops ?? []) sent.set(String(tr.unit), (sent.get(String(tr.unit)) ?? 0) + (tr.count || 0));
    for (const [id, count] of sent) {
      if (!defs.get(id)?.kind) continue;
      let row = rows.get(id);
      if (!row) rows.set(id, (row = { unitId: id, cap: 0, strengthPct: null, healthPct: null }));
      row.cap = Math.max(row.cap, count);
      const b = found.get(id);
      if (row.strengthPct === null && Number.isFinite(b?.strengthPct)) row.strengthPct = b.strengthPct;
      if (row.healthPct === null && Number.isFinite(b?.healthPct)) row.healthPct = b.healthPct;
    }
  }
  return [...rows.values()];
}
