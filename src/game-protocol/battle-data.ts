/**
 * What a battle needs from the game's own files: every unit's numbers (T9) and
 * every monster target's army (T7), built beside names.json as battle-data.json
 * once per game patch (static-data.ts) for Tools → Monsters, the shared battle
 * engine (lib/battle-sim.js) and docs/monster-simulator.md.
 *
 *   T9 units   f1 name vector, f2 tier, f4 icon, f6 price (empty for map
 *              monsters), f10 strength, f12 health, f16 leadership ×100,
 *              f17 authority ×100, f18 dominance ×100, f23 tags (string refs:
 *              MELEE, MOUNTED, BEAST, CITYWALLS…), f38 "vs" features
 *              `[[tagRefs], percent, multiplier ×100]` — the multiplier is 100,
 *              or 2000 on a siege engine's feature against walls: the ×20 the
 *              citadel reports showed.
 *   T7 objects f1 type (6 = a monster or NPC army on the map; 22 Exiles' Grove,
 *              2 a player's city), f3 name vector, f6[1] the army
 *              `{unitId: count}` (walls are a unit too: 51 for citadels),
 *              f10 whether the Hero may lead the attack, f11 how many captains
 *              may (0, 1 or 3: Rare squads are the Hero's alone, Common
 *              squads one captain's, Heroic squads and citadels the Hero's
 *              with up to three captains — every shared report agrees),
 *              f15 level, f18 class (1 Common, 2 Rare, 3 Heroic, 4 citadel or
 *              enemy city, 5 Epic, 7 a group raid, 8 Vault of the Ancients,
 *              9 Abyss; 0 an older version kept beside the current one).
 *
 * Measured against 374,502 strikes of shared reports (Nov 28 2026): monsters
 * fight at exactly these numbers with no bonus, and an army is exactly T7's
 * when nobody hit it before.
 *
 * Pure.
 */
import type { Wire } from './codec.js';

export const BATTLE_DATA_FILE = 'battle-data.json';
/** Bump when the file's shape changes (2: who may lead a target; 3: revival gold). */
export const BATTLE_DATA_FORMAT = 3;

/** T7 f1 of an army on the map (monster squads, citadels, enemy cities, vaults). */
const MAP_ARMY = 6;
/** T7 f18 of a citadel (and an enemy city). */
const CLASS_CITADEL = 4;

/** What a player fields a unit as; null for the monsters of the map. */
export type UnitKind = 'guardsmen' | 'specialists' | 'monsters' | 'mercenaries' | 'siege';

export interface BattleUnit {
  name: string;
  /** T9 f2: 1–9 for trained troops (Corax II = 9), the frame colour for icons. */
  tier: number;
  str: number;
  hp: number;
  /** Lower-case tags ("mounted", "beast", "citywalls", "epicmonster"…). */
  tags: string[];
  /** "vs" features: [tags any of which a target must carry, percent, damage multiplier (1, or 20 for siege on walls)]. */
  vs: Array<[string[], number, number]>;
  icon: string;
  /** Set for units a player can send; absent for the map's monsters. */
  kind?: UnitKind;
  /** March costs per unit (only the one that applies is set). */
  lead?: number;
  dom?: number;
  auth?: number;
  /** Gold to revive one lost in an attack (T9 f6, item 1 = Gold; equals Kaiculator's revival gold for all 53 mercenaries it lists). */
  revive?: number;
}

export interface BattleTarget {
  /** Every T7 id with this name, level and army (reports name one of them). */
  ids: number[];
  name: string;
  level: number;
  /** T7 f18 (see above). */
  cls: number;
  /** Whether the Hero may lead the attack (T7 f10). */
  hero: boolean;
  /** How many captains may join it (T7 f11): 0 = the Hero's alone. */
  captains: number;
  /** [unitId, count], strongest stack first. */
  army: Array<[number, number]>;
}

export interface BattleData {
  format: number;
  /** names.json's version key: the static data it was built from. */
  version: string;
  units: Record<string, BattleUnit>;
  targets: BattleTarget[];
}

export interface BattleLookups {
  /** A string-pool entry. */
  str: (ref: Wire | undefined) => string | undefined;
  /** A name vector's text, or undefined when its key has no text in the game's files (test or unused objects). */
  name: (vref: Wire | undefined) => string | undefined;
}

const num = (v: Wire | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const isRow = (r: Wire): r is Wire[] => Array.isArray(r);
const nonEmpty = (v: Wire | undefined): boolean => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0;

function rowsOf(t: Record<string, Wire> | undefined): Array<[number, Wire[]]> {
  return Object.entries(t ?? {})
    .filter((e): e is [string, Wire[]] => isRow(e[1]))
    .map(([id, row]) => [Number(id), row] as [number, Wire[]])
    .sort((a, b) => a[0] - b[0]);
}

/** How a player fields a priced unit: its march cost decides, then its tags. */
function kindOf(tags: Set<string>, lead: number, dom: number, auth: number): UnitKind | null {
  if (auth > 0) return 'mercenaries';
  if (dom > 0) return 'monsters';
  if (lead <= 0) return null;
  if (tags.has('engine') || tags.has('siege')) return 'siege';
  if (tags.has('guardsmen')) return 'guardsmen';
  if (tags.has('specialist')) return 'specialists';
  return null;
}

export function buildBattleData(
  t7: Record<string, Wire> | undefined,
  t9: Record<string, Wire> | undefined,
  look: BattleLookups,
  version: string,
): BattleData {
  const tagList = (v: Wire | undefined): string[] =>
    (Array.isArray(v) ? v : []).map((r) => look.str(r)?.toLowerCase()).filter((s): s is string => !!s);

  // Every unit that can fight, by id.
  const all = new Map<number, BattleUnit & { priced: boolean }>();
  for (const [id, row] of rowsOf(t9)) {
    const str = num(row[10]);
    const hp = num(row[12]);
    const name = look.name(row[1]);
    if (!(str > 0) || !(hp > 0) || !name) continue;
    const tags = tagList(row[23]);
    const vs: BattleUnit['vs'] = [];
    for (const f of Array.isArray(row[38]) ? row[38] : []) {
      if (!Array.isArray(f) || !Array.isArray(f[0])) continue;
      const on = tagList(f[0]);
      const pct = num(f[1]);
      const mult = num(f[2]) > 0 ? num(f[2]) / 100 : 1;
      if (on.length && (pct || mult !== 1)) vs.push([on, pct, mult]);
    }
    const lead = num(row[16]) / 100;
    const auth = num(row[17]) / 100;
    const dom = num(row[18]) / 100;
    const priced = Array.isArray(row[6]) && nonEmpty(row[6][0]);
    const unit: BattleUnit & { priced: boolean } = { name, tier: num(row[2]), str, hp, tags, vs, icon: look.str(row[4]) ?? '', priced };
    const kind = priced ? kindOf(new Set(tags), lead, dom, auth) : null;
    if (kind) {
      unit.kind = kind;
      const gold = num((row[6] as Wire[])[0] && typeof (row[6] as Wire[])[0] === 'object' ? ((row[6] as Wire[])[0] as Record<string, Wire>)['1'] : undefined);
      if (gold > 0) unit.revive = gold;
      if (kind === 'mercenaries') unit.auth = auth;
      else if (kind === 'monsters') unit.dom = dom;
      else unit.lead = lead;
    }
    all.set(id, unit);
  }

  // A trained troop or mercenary appears again under a higher id with the same
  // numbers and no march cost (75xxx): the lowest id is the one armies carry.
  const seen = new Set<string>();
  const fieldable = new Set<number>();
  for (const [id, u] of all) {
    if (!u.kind) continue;
    const key = `${u.name}|${u.str}|${u.hp}|${u.kind}`;
    if (seen.has(key)) {
      delete u.kind;
      continue;
    }
    seen.add(key);
    fieldable.add(id);
  }

  // Monster targets: one per name, level and army, of the family's live class (below).
  type Cand = { id: number; name: string; level: number; cls: number; hero: boolean; captains: number; army: Array<[number, number]>; key: string };
  const groups = new Map<string, Cand[]>();
  for (const [id, row] of rowsOf(t7)) {
    if (row[1] !== MAP_ARMY) continue;
    const name = look.name(row[3]);
    const raw = Array.isArray(row[6]) ? row[6][1] : undefined;
    if (!name || !nonEmpty(raw)) continue;
    const army: Array<[number, number]> = Object.entries(raw as Record<string, Wire>)
      .map(([u, n]) => [Number(u), num(n)] as [number, number])
      .filter(([, n]) => n > 0);
    if (!army.length || army.some(([u]) => !all.has(u))) continue;
    army.sort((a, b) => all.get(b[0])!.str * b[1] - all.get(a[0])!.str * a[1] || a[0] - b[0]);
    const level = num(row[15]);
    const g = `${name}|${level}`;
    if (!groups.has(g)) groups.set(g, []);
    const hero = row[10] === 1;
    const captains = num(row[11]);
    // Who may lead is part of a target's identity: one version can be the Hero's, another a captain's.
    groups.get(g)!.push({ id, name, level, cls: num(row[18]), hero, captains, army, key: JSON.stringify([hero, captains, [...army].sort((a, b) => a[0] - b[0])]) });
  }
  // Which class of a family is the live one. Class 0 never is (older versions:
  // a "Common Elf squad" of legacy Inferno units, the old Legendary and Epic
  // Elf/Barbarian/Cursed squads — no shared report ever hit one, Nov 28 2026).
  // A citadel family keeps its citadels (class 4; its class-2 objects are the
  // old citadels, 0 of 29 hits); any other its main class (Common Elf squad:
  // 30 of class 1, 5 stray class-2 objects).
  const liveClass = new Map<string, number>();
  {
    const counts = new Map<string, Map<number, number>>();
    for (const list of groups.values()) {
      for (const c of list) {
        if (c.cls === 0) continue;
        const m = counts.get(c.name) ?? new Map<number, number>();
        m.set(c.cls, (m.get(c.cls) ?? 0) + 1);
        counts.set(c.name, m);
      }
    }
    for (const [name, m] of counts) {
      const best = m.has(CLASS_CITADEL) ? CLASS_CITADEL : [...m].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
      liveClass.set(name, best);
    }
  }
  const targets: BattleTarget[] = [];
  const used = new Set<number>(fieldable);
  for (const list of groups.values()) {
    const pick = list.filter((c) => c.cls !== 0 && c.cls === liveClass.get(c.name));
    const byArmy = new Map<string, BattleTarget>();
    for (const c of pick) {
      const t = byArmy.get(c.key);
      if (t) t.ids.push(c.id);
      else byArmy.set(c.key, { ids: [c.id], name: c.name, level: c.level, cls: c.cls, hero: c.hero, captains: c.captains, army: c.army });
    }
    for (const t of byArmy.values()) {
      targets.push(t);
      for (const [u] of t.army) used.add(u);
    }
  }
  targets.sort((a, b) => a.name.localeCompare(b.name) || a.level - b.level || a.ids[0] - b.ids[0]);

  const units: BattleData['units'] = {};
  for (const id of [...used].sort((a, b) => a - b)) {
    const { priced: _p, ...u } = all.get(id)!;
    units[String(id)] = u;
  }
  return { format: BATTLE_DATA_FORMAT, version, units, targets };
}

/** The English names of the units battle data carries, for names.json (and so the game's own text in every site language). */
export function battleUnitNames(data: BattleData): Record<string, string> {
  return Object.fromEntries(Object.entries(data.units).map(([id, u]) => [id, u.name]));
}
