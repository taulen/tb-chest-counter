// Runs the count search (battle-sim.js optimizeArmySteps; Tools → Monsters and
// Tools → Citadel) without freezing the page: in module Web Workers
// (lib/battle-worker.js), or — where workers can't start — on the main thread
// in slices, giving the browser a turn between them. Either way the page gets
// progress reports and the same counts (the search is deterministic: it stops
// on work done, never on the clock). A newer search cancels the one before it.
//
// `jobs` > 1 runs that many searches side by side, each with its own seed for
// the random stage, and keeps the best army (ties: the lowest seed) — the same
// answer on any device: with fewer cores, or on the main thread, the jobs just
// take turns.
//
// The worker's URL is built from this module's own URL, so it carries the
// page's /v/<build>/ prefix like every other asset (docs/cloudflare-caching.md).

import { optimizeArmySteps } from './battle-sim.js';

/** Main-thread slices: give the browser a turn after this long. */
const SLICE_MS = 30;
const EPS = 1e-6;

const pool = [];
let workerBroken = typeof Worker === 'undefined';
let running = null;
let nextId = 1;

function startWorker() {
  try {
    return new Worker(new URL('./battle-worker.js', import.meta.url), { type: 'module' });
  } catch {
    workerBroken = true;
    return null;
  }
}

/** Stop whatever search is running (its promise resolves with null). */
export function cancelArmySearch() {
  if (!running) return;
  const r = running;
  running = null;
  r.cancelled = true;
  // A busy worker can't read messages: replace it.
  for (const w of r.busy) {
    w.terminate();
    const k = pool.indexOf(w);
    if (k >= 0) pool.splice(k, 1);
  }
  r.resolve(null);
}

/** The better of two finished searches: won first, then protected losses, other losses, a smaller army. */
function betterResult(a, b) {
  if (!b) return !!a;
  if (!a) return false;
  if (a.ok !== b.ok) return a.ok;
  const x = a.score;
  const y = b.score;
  if (!x || !y) return false;
  if (Math.abs(x.prot - y.prot) > EPS) return x.prot < y.prot;
  if (Math.abs(x.loss - y.loss) > EPS) return x.loss < y.loss;
  return x.power < y.power - EPS;
}

/**
 * Search counts for an army. `params` are optimizeArmySteps' (army rows with
 * plain-data defs, enemy, starts, worstCase…; no functions). Resolves with
 * { ok, counts, evaluations, score }, or null when a newer search (or
 * cancelArmySearch) replaced it.
 * @param {object} params
 * @param {{ onProgress?: (p: {done: number, total: number, phase: string}) => void, useWorker?: boolean, jobs?: number }} [opts]
 * @returns {Promise<{ok: boolean, counts: number[], evaluations: number, score?: object} | null>}
 */
export function searchArmy(params, { onProgress, useWorker = true, jobs = 1 } = {}) {
  cancelArmySearch();
  const n = Math.max(1, Math.floor(jobs) || 1);
  return new Promise((resolve) => {
    const job = { id: nextId++, resolve, cancelled: false, busy: [] };
    running = job;
    const parts = Array.from({ length: n }, (_, k) => ({ params: n > 1 ? { ...params, tune: { ...(params.tune ?? {}), seed: k + 1 } } : params, p: null, result: undefined }));
    const report = () => {
      if (job.cancelled || !onProgress) return;
      let done = 0;
      let total = 0;
      let phase = 'improve';
      for (const part of parts) {
        if (!part.p) { phase = 'starts'; continue; }
        done += part.p.done;
        total += part.p.total;
        if (part.p.phase !== 'improve') phase = 'starts';
      }
      // Parts not started yet count as all their work still to do.
      const each = parts.find((x) => x.p)?.p.total ?? 0;
      total += each * parts.filter((x) => !x.p).length;
      if (total > 0) onProgress({ done, total, phase });
    };
    const settle = () => {
      if (job.cancelled || parts.some((x) => x.result === undefined)) return;
      if (running === job) running = null;
      let best = null;
      for (const part of parts) if (betterResult(part.result, best)) best = part.result;
      resolve(best ?? parts[0].result ?? null);
    };
    const onPart = (part) => ({
      progress: (p) => { part.p = p; report(); },
      done: (value) => { part.result = value; settle(); },
    });
    /** These parts on this thread, one after another (no worker for them). */
    const runInSlices = async (list) => {
      for (const k of list) {
        if (job.cancelled) return;
        const h = onPart(parts[k]);
        const value = await inSlices(parts[k].params, job, h.progress);
        if (job.cancelled) return;
        h.done(value);
      }
    };
    if (!useWorker || workerBroken) { runInSlices(parts.map((_, k) => k)); return; }
    const sliced = [];
    for (let k = 0; k < n; k++) {
      const part = parts[k];
      while (pool.length <= k && !workerBroken) {
        const w = startWorker();
        if (!w) break;
        pool.push(w);
      }
      const w = pool[k];
      if (!w) { sliced.push(k); continue; }
      const h = onPart(part);
      job.busy.push(w);
      w.onmessage = (e) => {
        const m = e.data || {};
        if (m.id !== `${job.id}:${k}` || job.cancelled) return;
        if (m.type === 'progress') h.progress(m);
        else {
          job.busy = job.busy.filter((x) => x !== w);
          h.done(m.type === 'result' ? { ok: m.ok, counts: m.counts, evaluations: m.evaluations, score: m.score } : null);
        }
      };
      // A module worker the browser can't run (older Safari, a blocked URL): this part and the next searches run in slices.
      w.onerror = (e) => {
        e?.preventDefault?.();
        if (job.cancelled) return;
        workerBroken = true;
        w.terminate();
        const at = pool.indexOf(w);
        if (at >= 0) pool.splice(at, 1);
        job.busy = job.busy.filter((x) => x !== w);
        inSlices(part.params, job, h.progress).then((value) => { if (!job.cancelled) h.done(value); });
      };
      w.postMessage({ id: `${job.id}:${k}`, params: part.params });
    }
    if (sliced.length) runInSlices(sliced);
  });
}

/** The search on this thread, a slice at a time; null when cancelled. */
export async function inSlices(params, job, onProgress) {
  const gen = optimizeArmySteps(params);
  let until = now() + SLICE_MS;
  for (;;) {
    const step = gen.next();
    if (step.done) return step.value;
    onProgress(step.value);
    if (now() >= until) {
      await new Promise((r) => setTimeout(r, 0));
      if (job.cancelled) return null;
      until = now() + SLICE_MS;
    }
  }
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
