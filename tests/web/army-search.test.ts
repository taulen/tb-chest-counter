/**
 * Tools → Monsters' count search off the page's thread (lib/army-search.js,
 * lib/battle-worker.js): the worker's messages, the main-thread fallback in
 * slices, and a newer search cancelling the one before — all giving exactly
 * the counts a plain optimizeArmy call gives (the search stops on work done,
 * never on the clock, so where it runs can't change the army).
 */
import { describe, expect, it } from 'vitest';
import { optimizeArmy } from '../../src/web/public/lib/battle-sim.js';
import { searchArmy, cancelArmySearch, inSlices } from '../../src/web/public/lib/army-search.js';
import { runSearchMessage } from '../../src/web/public/lib/battle-worker.js';
import { DEFENDERS, CITADELS, troopById } from '../../src/web/public/lib/citadel-sim.js';

const cards: Array<[string, number, number]> = [
  ['siege-ballistae-7', 2277, 1616.75], ['corax-1', 5226.5, 3936.75], ['fire-phoenix-1', 3736.5, 2794.75],
  ['royal-lion-1', 3736.5, 2794.75], ['griffin-7', 5326.5, 4036.75], ['vulture-7', 3636.5, 2694.75],
];
const e25 = CITADELS.find((c) => c.id === 'elven-25')!;
/** Plain data, as the page posts it to the worker (a structured clone keeps nothing else). */
const params = () => JSON.parse(JSON.stringify({
  army: cards.map(([id, strengthPct, healthPct]) => {
    const def = troopById(id)!;
    return { def, strengthPct, healthPct, protected: ['monsters', 'mercenaries'].includes(def.group), cap: 5000 };
  }),
  enemy: [...(e25.units as Array<[string, number]>).map(([id, n]) => ({ def: DEFENDERS[id], count: n })), { def: DEFENDERS.walls, count: e25.walls }],
  worstCase: true,
  work: 3e6,
}));
type Progress = { done: number; total: number; phase: string };
const plain = () => optimizeArmy({ ...params(), explore: true }).counts;

describe('the count search in a worker', () => {
  it('posts its progress, then the counts a plain call finds', () => {
    const posted: Array<Record<string, unknown>> = [];
    runSearchMessage({ id: 7, params: params() }, (m: Record<string, unknown>) => posted.push(m));
    const progress = posted.filter((m) => m.type === 'progress') as unknown as Array<Progress & { id: number }>;
    const result = posted.at(-1)!;
    expect(progress.length).toBeGreaterThan(10);
    expect(progress.every((m) => m.id === 7)).toBe(true);
    for (let i = 1; i < progress.length; i++) expect(progress[i].done).toBeGreaterThanOrEqual(progress[i - 1].done);
    expect(progress.at(-1)!.done).toBe(progress.at(-1)!.total);
    expect(result).toMatchObject({ id: 7, type: 'result', ok: true });
    expect(result.counts).toEqual(plain());
  });

  it('answers an error message, not silence, when the search throws', () => {
    const posted: Array<Record<string, unknown>> = [];
    runSearchMessage({ id: 3, params: { army: [{ def: null }], enemy: [] } }, (m: Record<string, unknown>) => posted.push(m));
    expect(posted.at(-1)).toMatchObject({ id: 3, type: 'error' });
  });
});

describe('the count search on the main thread (no worker)', () => {
  it('runs in slices and finds the same counts', async () => {
    const seen: Progress[] = [];
    const res = await searchArmy(params(), { onProgress: (p) => seen.push(p) });
    expect(res?.ok).toBe(true);
    expect(res?.counts).toEqual(plain());
    for (let i = 1; i < seen.length; i++) expect(seen[i].done).toBeGreaterThanOrEqual(seen[i - 1].done);
    expect(seen.at(-1)!.done).toBe(seen.at(-1)!.total);
  });

  it('gives the browser a turn between slices', async () => {
    let turns = 0;
    const tick = setInterval(() => { turns += 1; }, 0);
    await inSlices({ ...params(), work: 2e7 }, { cancelled: false }, () => {});
    clearInterval(tick);
    expect(turns).toBeGreaterThan(0);
  });

  it('with several jobs keeps the best of their seeds, the same on any device', async () => {
    const one = (seed: number) => optimizeArmy({ ...params(), explore: true, tune: { seed } });
    const runs = [1, 2, 3].map(one);
    const key = (r: { counts: number[]; both: unknown }) => r.counts.join();
    const res = await searchArmy(params(), { jobs: 3 });
    expect(runs.map(key)).toContain(res?.counts.join());
    expect(res?.score).toBeDefined();
    // Never worse than the first seed alone (the single-job answer).
    const first = await searchArmy(params());
    const a = res!.score as { prot: number; loss: number };
    const b = first!.score as { prot: number; loss: number };
    expect(a.prot).toBeLessThanOrEqual(b.prot + 1e-6);
    if (Math.abs(a.prot - b.prot) <= 1e-6) expect(a.loss).toBeLessThanOrEqual(b.loss + 1e-6);
  });

  it('a newer search cancels the one before (its promise gives null)', async () => {
    const first = searchArmy(params());
    const second = searchArmy(params());
    expect(await first).toBeNull();
    expect((await second)?.counts).toEqual(plain());
    const third = searchArmy(params());
    cancelArmySearch();
    expect(await third).toBeNull();
  });
});
