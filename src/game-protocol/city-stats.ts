/**
 * Every bonus a city has — production, storage, army strength and health per
 * troop type, march speed, crypts, points, the speeds… — named with the game's
 * own texts, for ANY member (city field 14 lists every effect active in the
 * city; city-speeds.ts does the three Statistics-page speeds with sources).
 *
 * T20 effect lines `[kind, target, [], [cond], 0, value ×10000, flat]` carry no
 * text. The game prints the same lines in its windows — a research level's
 * props, a captain's level, a gear piece, an artifact's level and star level,
 * a building level: `{"props":[{"propText": key, "propValue": "+1,25%"}, …]}`
 * in the order of the effect's lines. buildCityStats pairs them (same count,
 * values agree) and votes a text key per (kind, target). `target` is a vector
 * of ids (units, resources, crypts; empty = all): its pool index changes
 * between patches, the game's text key doesn't — stats are keyed by that.
 *
 * Lines aimed at several resources at once ("+670 %" to all five) split into
 * each resource's own line, so "Food production" is everything that raises
 * food. At runtime lines that share an English label add up, as the game's
 * Statistics page adds every construction speed line into one number.
 *
 * Pure; tests/game-protocol/city-stats.test.ts.
 */
import type { Wire } from './codec.js';

export interface GameCityStats {
  /** Text key → the game's text for it (English here; texts-<lang>.json translates it). */
  labels: Record<string, string>;
  /** Text key → its effect kind (T20 line [0]): which group the bonus belongs to. */
  kinds: Record<string, number>;
  /** The text keys `effects` points into. */
  keys: string[];
  /** Effect id → its named lines: [index into `keys`, percent, flat]. */
  effects: Record<string, Array<[number, number, number]>>;
  /** Research levels the city record leaves out (VIP, the clan's research): tech id → level → effect id. */
  techs: Record<string, Record<string, number>>;
}

/**
 * A city's bonuses: "kind:label" (the game's English label; the kind keeps the
 * clan's own "Research speed" apart from the city's) → [percent, flat].
 */
export type CityStats = Record<string, [number, number]>;

/**
 * Every bonus that moved between one read and the next, newest first: a new
 * bonus comes from [0, 0], a lost one goes to [0, 0].
 */
export function statChanges(
  history: ReadonlyArray<{ gameDate: string; stats: CityStats }>,
): Array<{ gameDate: string; stat: string; from: [number, number]; to: [number, number] }> {
  const out: Array<{ gameDate: string; stat: string; from: [number, number]; to: [number, number] }> = [];
  for (let i = 1; i < history.length; i++) {
    const before = history[i - 1].stats;
    const after = history[i].stats;
    for (const stat of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const from = before[stat] ?? [0, 0];
      const to = after[stat] ?? [0, 0];
      if (Math.abs(from[0] - to[0]) >= 0.005 || Math.abs(from[1] - to[1]) >= 0.005) out.push({ gameDate: history[i].gameDate, stat, from, to });
    }
  }
  return out.reverse();
}

/** "17:Research speed" → { kind: 17, label: 'Research speed' }. */
export function splitStatKey(key: string): { kind: number; label: string } {
  const i = key.indexOf(':');
  return { kind: Number(key.slice(0, i)), label: key.slice(i + 1) };
}

/** Tables whose rows print an effect's lines: hero and captain levels, gear, research, captain stars, artifacts. */
export const STAT_LABEL_TABLES = [10, 11, 21, 75, 111, 112];

type Lookup = { get(key: string): string | undefined };

const round = (v: number): number => Math.round(v * 100) / 100;

/** "+1,25%" → 1.25; NaN for anything else. */
function propNumber(s: unknown): number {
  return Number(String(s ?? '').replace(/[+%\s ]/g, '').replace(/,(?=\d{1,2}$)/, '.').replace(/,/g, ''));
}

export function buildCityStats(
  tables: Map<number, Record<string, Wire>>,
  str: (ref: Wire) => string | undefined,
  vec: (ref: Wire) => Wire[] | undefined,
  en: Lookup,
  /** Research hook: sees the votes and the key chosen per (kind/target). */
  inspect?: (votes: ReadonlyMap<string, ReadonlyMap<string, number>>, keyOf: ReadonlyMap<string, string>) => void,
): GameCityStats {
  const effects = tables.get(20) ?? {};
  const linesOf = (id: Wire): Wire[][] => {
    const row = typeof id === 'number' ? effects[String(id)] : undefined;
    return Array.isArray(row) && Array.isArray(row[3]) ? row[3].filter((e): e is Wire[] => Array.isArray(e)) : [];
  };
  const value = (e: Wire[]): { pct: number; flat: number } => ({
    pct: typeof e[5] === 'number' && e[5] !== 0 ? (e[5] - 10000) / 100 : 0,
    flat: typeof e[6] === 'number' ? e[6] : 0,
  });

  // 1. Vote a text key per (kind, target) from every printed effect.
  const votes = new Map<string, Map<string, number>>();
  const pair = (effectId: number, propsJson: string): void => {
    let props: unknown;
    try { props = (JSON.parse(propsJson) as { props?: unknown }).props; } catch { return; }
    if (!Array.isArray(props)) return;
    const shown = props.filter((p): p is { propText: string; propValue?: unknown; icon?: unknown } =>
      !!p && typeof (p as { propText?: unknown }).propText === 'string' && (p as { icon?: unknown }).icon !== '1_power_22');
    const lines = linesOf(effectId);
    if (!lines.length || shown.length !== lines.length) return;
    // The game prints the lines in the effect's order; every value has to agree, or it is another effect's text.
    const agrees = lines.every((e, i) => {
      const v = value(e);
      const pv = propNumber(shown[i].propValue);
      return !Number.isFinite(pv) || [v.pct, v.flat].some((x) => Math.abs(Math.abs(pv) - Math.abs(x)) < 0.011);
    });
    if (!agrees) return;
    // Only a line whose value no other line of the effect shares: VIP's dozen
    // "+1 %" lines are printed in another order than they are stored.
    const key = (e: Wire[]): string => { const v = value(e); return `${v.pct}|${v.flat}`; };
    const seen = new Map<string, number>();
    for (const e of lines) seen.set(key(e), (seen.get(key(e)) ?? 0) + 1);
    lines.forEach((e, i) => {
      if ((seen.get(key(e)) ?? 0) > 1) return;
      const k = `${String(e[0])}/${String(e[1])}`;
      const m = votes.get(k) ?? new Map<string, number>();
      m.set(shown[i].propText, (m.get(shown[i].propText) ?? 0) + 1);
      votes.set(k, m);
    });
  };
  // Where each table keeps an effect and the text it prints — by position: a
  // row's other numbers (levels, prices) are often ids of effects and texts too.
  const rowsOf = (t: number): Wire[][] => Object.values(tables.get(t) ?? {}).filter((r): r is Wire[] => Array.isArray(r));
  const inner = (v: Wire): Wire[][] => (v && typeof v === 'object'
    ? (Array.isArray(v) ? v : Object.values(v as Record<string, Wire>)).filter((r): r is Wire[] => Array.isArray(r))
    : []);
  const pairAt = (r: Wire[], effectAt: number, textAt: number): void => {
    const id = r[effectAt];
    const text = str(r[textAt]);
    if (typeof id === 'number' && text?.startsWith('{"props"')) pair(id, text);
  };
  for (const row of rowsOf(21)) for (const lv of inner(row[5])) pairAt(lv, 1, 4); // research levels
  for (const row of rowsOf(10)) for (const lv of inner(row[7])) pairAt(lv, 6, 7); // hero and captain levels
  for (const row of rowsOf(75)) for (const s of inner(row[12])) pairAt(s, 6, 7); // captain star levels
  for (const row of rowsOf(11)) pairAt(row, 6, 9); // gear
  for (const row of rowsOf(111)) for (const s of inner(row[1])) pairAt(s, 2, 4); // artifact star levels
  for (const row of rowsOf(112)) for (const lv of inner(row[2])) pairAt(lv, 1, 4); // artifact levels

  // A text names one kind of bonus: the kind most of its votes came from. Votes
  // it got from other kinds were another line's text, and are dropped.
  const kindVotes = new Map<string, Map<string, number>>();
  for (const [k, m] of votes) {
    const kind = k.split('/')[0];
    for (const [key, n] of m) {
      const kv = kindVotes.get(key) ?? new Map<string, number>();
      kv.set(kind, (kv.get(kind) ?? 0) + n);
      kindVotes.set(key, kv);
    }
  }
  const kindOfKey = new Map<string, string>();
  for (const [key, kv] of kindVotes) kindOfKey.set(key, [...kv].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0]);
  const keyOf = new Map<string, string>();
  for (const [k, m] of votes) {
    const kind = k.split('/')[0];
    const best = [...m].filter(([key]) => kindOfKey.get(key) === kind).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    if (best) keyOf.set(k, best[0]);
  }
  inspect?.(votes, keyOf);
  // A line without its own key takes its kind's general one (target 51: no ids, everything).
  const generalOf = (kind: Wire): string | undefined => {
    for (const [k, key] of keyOf) if (k.startsWith(`${String(kind)}/`) && !(vec(Number(k.split('/')[1])) ?? []).length) return key;
    return undefined;
  };
  // Per kind, the key of a line aimed at one id (one resource): splits lines aimed at several.
  const singleKey = new Map<string, string>();
  for (const [k, key] of keyOf) {
    const [kind, target] = k.split('/');
    const ids = vec(Number(target)) ?? [];
    if (ids.length === 1) singleKey.set(`${kind}/${String(ids[0])}`, key);
  }

  // 2. Every effect's lines under their keys.
  const keys: string[] = [];
  const index = new Map<string, number>();
  const labels: Record<string, string> = {};
  const kinds: Record<string, number> = {};
  const idx = (key: string, kind: number): number | null => {
    let i = index.get(key);
    if (i === undefined) {
      const text = en.get(key);
      if (!text) return null;
      i = keys.length;
      keys.push(key);
      index.set(key, i);
      labels[key] = text.replace(/\s+/g, ' ').trim();
      kinds[key] = kind;
    }
    return i;
  };
  const out: GameCityStats = { labels, kinds, keys, effects: {}, techs: {} };
  for (const [id, row] of Object.entries(effects)) {
    if (!Array.isArray(row)) continue;
    const named: Array<[number, number, number]> = [];
    for (const e of linesOf(Number(id))) {
      if (typeof e[0] !== 'number') continue;
      const v = value(e);
      if (!v.pct && !v.flat) continue;
      const ids = vec(e[1]) ?? [];
      const split = ids.length > 1 ? ids.map((x) => singleKey.get(`${e[0]}/${String(x)}`)) : [];
      const targets = split.length && split.every(Boolean) ? (split as string[]) : [keyOf.get(`${e[0]}/${String(e[1])}`) ?? generalOf(e[0])];
      for (const key of targets) {
        const i = key ? idx(key, e[0]) : null;
        if (i !== null) named.push([i, round(v.pct), round(v.flat)]);
      }
    }
    if (named.length) out.effects[id] = named;
  }
  // VIP (tech 1000) and the clan's research levels, by level (field 14 leaves them out).
  for (const [id, row] of Object.entries(tables.get(21) ?? {})) {
    const levels = Array.isArray(row) ? row[5] : undefined;
    if (!levels || typeof levels !== 'object' || Array.isArray(levels)) continue;
    const byLevel: Record<string, number> = {};
    for (const lv of Object.values(levels as Record<string, Wire>)) {
      if (Array.isArray(lv) && typeof lv[0] === 'number' && typeof lv[1] === 'number' && out.effects[String(lv[1])]) byLevel[String(lv[0])] = lv[1];
    }
    if (Object.keys(byLevel).length) out.techs[id] = byLevel;
  }
  return out;
}

/**
 * A city's bonuses: field 14's effects (`[effectId, sourceBits, count]`,
 * counted as often as the city has them), VIP and the clan's research by
 * level. Lines of one kind sharing a label add up. The clan's research only
 * adds to bonuses the city has itself — the rest of it is the clan's own
 * (its research speed, its buildings). Null for a reply without effects.
 */
export function cityStats(
  effects: ReadonlyArray<{ id: number; count: number }>,
  table: GameCityStats,
  extra: { vip?: number | null; clanLevels?: Record<string, number> } = {},
): CityStats | null {
  if (!effects.length) return null;
  const out: CityStats = {};
  const add = (effectId: number | undefined, count: number, onlyKnown = false): void => {
    for (const [i, pct, flat] of (effectId ? table.effects[String(effectId)] : undefined) ?? []) {
      const key = table.keys[i];
      const label = table.labels[key];
      if (!label) continue;
      const stat = `${table.kinds[key]}:${label}`;
      if (onlyKnown && !out[stat]) continue;
      const s = out[stat] ?? [0, 0];
      s[0] += pct * count;
      s[1] += flat * count;
      out[stat] = s;
    }
  };
  for (const e of effects) add(e.id, e.count || 1);
  if (extra.vip) add(table.techs['1000']?.[String(extra.vip)], 1);
  for (const [tech, level] of Object.entries(extra.clanLevels ?? {})) add(table.techs[tech]?.[String(level)], 1, true);
  for (const [stat, [pct, flat]] of Object.entries(out)) {
    if (!pct && !flat) delete out[stat];
    else out[stat] = [round(pct), round(flat)];
  }
  return out;
}
