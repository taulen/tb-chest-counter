/**
 * The game client's own configuration: static table T1, rows `[keyRef,
 * jsonRef]` — a config key ("academy/branches", "hero_info", "clan", …) and
 * its JSON. Read by the tech trees (tech-trees.ts: which trees exist, their
 * Academy tabs) and by the names build (static-data.ts: the trees' and tabs'
 * names are game texts tGame translates).
 *
 *   "academy/branches"  branches [{id, name, description, tree, type, visual}],
 *                       tabs [{name, branches}] ("Unlock" / "Boost"), order
 *   "hero_info"         branches [18,19,20,21] = the hero's talent trees,
 *                       branch = the retired single "Talents" tree (14)
 *   type: "tech" research · "heroAbility" talents · "clanTalents" clan
 *
 * Names and descriptions are translation keys; `text` resolves them (the
 * English CSV, or any language's — see game-texts.ts).
 */
import type { Wire } from './codec.js';

export const TABLE_CLIENT_CONFIG = 1;

/** A translation lookup: key → text. A Map is one; game-texts.ts passes recording and fallback ones. */
export type TextLookup = { get(key: string): string | undefined };

/** A tree as the client config declares it. */
export interface BranchDef {
  id: number;
  name: string;
  description: string;
  tree: string;
  type: string;
  visual: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** T1 as rows, whether it was decoded as an array or re-keyed by index. */
function configRows(t1: unknown): Wire[] {
  if (Array.isArray(t1)) return t1 as Wire[];
  return isRecord(t1) ? (Object.values(t1) as Wire[]) : [];
}

/** Parsed JSON of one client-config key; null when the key is missing or not a JSON object. */
export function clientConfig(t1: unknown, str: (ref: Wire | undefined) => string | undefined, key: string): Record<string, unknown> | null {
  for (const row of configRows(t1)) {
    if (!Array.isArray(row) || str(row[0]) !== key) continue;
    try {
      const v: unknown = JSON.parse(str(row[1]) ?? '');
      return isRecord(v) ? v : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Every tree the client config declares, wherever it is declared, names resolved through `text`. */
export function readBranchDefs(t1: unknown, str: (ref: Wire | undefined) => string | undefined, text: TextLookup): BranchDef[] {
  const resolve = (k: unknown): string => (typeof k === 'string' ? (text.get(k) ?? '') : '');
  const out = new Map<number, BranchDef>();
  const walk = (v: unknown, depth: number): void => {
    if (depth > 4) return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    if (!isRecord(v)) return;
    if (typeof v.id === 'number' && typeof v.tree === 'string' && typeof v.type === 'string' && !out.has(v.id)) {
      out.set(v.id, {
        id: v.id,
        name: resolve(v.name),
        description: resolve(v.description),
        tree: v.tree,
        type: v.type,
        visual: typeof v.visual === 'string' ? v.visual : '',
      });
    }
    for (const x of Object.values(v)) walk(x, depth + 1);
  };
  for (const key of ['academy/branches', 'hero_info', 'clan']) walk(clientConfig(t1, str, key), 0);
  return [...out.values()];
}

/** The Academy's tabs ("Unlock" / "Boost"): branch id → its tab's name. The first tab listing a branch wins. */
export function academyTabs(t1: unknown, str: (ref: Wire | undefined) => string | undefined, text: TextLookup): Map<number, string> {
  const academy = clientConfig(t1, str, 'academy/branches');
  const out = new Map<number, string>();
  for (const tab of Array.isArray(academy?.tabs) ? academy.tabs : []) {
    if (!isRecord(tab)) continue;
    const name = typeof tab.name === 'string' ? (text.get(tab.name) ?? '') : '';
    for (const id of Array.isArray(tab.branches) ? tab.branches : []) {
      if (typeof id === 'number' && !out.has(id)) out.set(id, name);
    }
  }
  return out;
}
