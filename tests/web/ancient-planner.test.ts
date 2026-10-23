/**
 * The Ancient planner must reproduce the calculator it replicates.
 *
 * totalcalculator.org/summons.php computes server-side and publishes no source,
 * so lib/ancient-planner.js was fitted to its responses. The fixture holds 138
 * of those responses verbatim; this replays each one. A changed cost, weight or
 * HP value fails here instead of silently handing a clan the wrong targets.
 *
 * The reference prints 3 significant figures. Kills at Tin Man levels up to 151
 * use an exact multiplier chain and must match exactly; above 151 the HP table
 * was measured to ±0.04%, so those readings get that much slack.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
// Plain ESM with no DOM access at import time.
import {
  planAncients,
  formatCompact,
  tinManHp,
  TIERS,
  CLOCK_MINUTES,
  TOME_BONUS_PCT,
  ARTIFACT_LEVEL_COSTS,
} from '../../src/web/public/lib/ancient-planner.js';

interface RefCase {
  input: Record<string, number>;
  output: string[];
}

const here = path.dirname(fileURLToPath(import.meta.url));
const { cases } = JSON.parse(
  fs.readFileSync(path.join(here, '../fixtures/ancient-planner-reference.json'), 'utf8'),
) as { cases: RefCase[] };

const SCALE: Record<string, number> = { '': 1, K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
function parseShown(s: string): number {
  const m = s.trim().match(/^([\d.]+)([KMBT]?)$/);
  if (!m) throw new Error(`unparseable value "${s}"`);
  return Number(m[1]) * SCALE[m[2]];
}
const round3 = (x: number) => Number(x.toPrecision(3));

/** Same reading, allowing `slack` (relative) for the measured part of the HP curve. */
function sameReading(ours: number, shown: number, slack: number): boolean {
  if (round3(ours) === round3(shown)) return true;
  return Math.abs(ours - shown) <= Math.abs(shown) * (0.005 + slack);
}

function planFor(input: Record<string, number>) {
  const counts = Object.fromEntries(TIERS.map((t) => [t.key, input[t.key] ?? 0]));
  return planAncients({
    counts,
    bonusPct: input.bonus,
    missingPct: input.missing,
    trickPct: input.trick,
    marginPct: input.margin,
    level: input.level,
  });
}

describe('ancient planner reproduces totalcalculator.org', () => {
  it('has the recorded responses to replay', () => {
    expect(cases.length).toBeGreaterThan(100);
  });

  it.each(cases.map((c, i) => [i, c] as const))('case %i', (_i, c) => {
    const plan = planFor(c.input);
    const mismatches: string[] = [];
    let summons = 0;

    for (const line of c.output) {
      let m: RegExpMatchArray | null;
      if ((m = line.match(/^Total vault points: (\d+)$/))) {
        if (plan.pot !== Number(m[1])) mismatches.push(`pot ${plan.pot} vs ${m[1]}`);
      } else if ((m = line.match(/^(\d+) summons?$/))) {
        summons = Number(m[1]);
      } else if ((m = line.match(/^(\d+) minutes, (\d+) vault points leftover$/))) {
        const o = plan.options[summons - 1];
        if (!o.attainable || o.minutes !== Number(m[1]) || o.leftover !== Number(m[2])) {
          mismatches.push(`${summons}: ${o.minutes} min/${o.leftover} vs ${line}`);
        }
      } else if ((m = line.match(/^Unattainable, (\d+) vault points short$/))) {
        const o = plan.options[summons - 1];
        if (o.attainable || o.short !== Number(m[1])) mismatches.push(`${summons}: short ${o.short} vs ${line}`);
      } else if ((m = line.match(/^Clan ancient requirement: (.+)$/))) {
        const o = plan.options[summons - 1];
        const lastLevel = Math.min(250, plan.level + summons - 1);
        const slack = lastLevel > 151 ? 4e-4 : 0;
        if (!sameReading(o.requirement, parseShown(m[1]), slack)) {
          mismatches.push(`${summons}: requirement ${formatCompact(o.requirement)} vs ${m[1]}`);
        }
      } else if (/^(T9|G\d): /.test(line)) {
        const o = plan.options[summons - 1];
        const lastLevel = Math.min(250, plan.level + summons - 1);
        const slack = lastLevel > 151 ? 4e-4 : 0;
        for (const part of line.split(' / ')) {
          const [label, value] = part.split(': ');
          const ours = o.perMember[label.toLowerCase()];
          if (ours === null || !sameReading(ours, Number(value) || parseShown(value), slack)) {
            mismatches.push(`${summons}: ${label} ${formatCompact(ours)} vs ${value}`);
          }
        }
      }
    }
    expect(mismatches).toEqual([]);
  });
});

describe('ancient planner tables', () => {
  it('has 28 levels on every artifact ladder', () => {
    expect(ARTIFACT_LEVEL_COSTS).toHaveLength(28);
    expect(TOME_BONUS_PCT).toHaveLength(28);
    expect(CLOCK_MINUTES).toHaveLength(28);
  });

  it('agrees with the in-game artifact screen (Tome 26 = +70%, Clock 16 = 37 min)', () => {
    expect(TOME_BONUS_PCT[26 - 1]).toBe(70);
    expect(CLOCK_MINUTES[16 - 1]).toBe(37);
  });

  it('has an HP curve that only rises, and holds at 250', () => {
    for (let level = 2; level <= 250; level++) expect(tinManHp(level)).toBeGreaterThan(tinManHp(level - 1));
    expect(tinManHp(251)).toBe(tinManHp(250));
    expect(tinManHp(0)).toBe(tinManHp(1));
  });
});

describe('formatCompact', () => {
  it('prints 3 significant figures with a suffix', () => {
    expect(formatCompact(1000)).toBe('1K');
    expect(formatCompact(869.565)).toBe('870');
    expect(formatCompact(449_123_456)).toBe('449M');
    expect(formatCompact(999_600)).toBe('1M');
    expect(formatCompact(0.0269)).toBe('0.0269');
    expect(formatCompact(null)).toBe('—');
  });
});
