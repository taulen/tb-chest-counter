// Tools → Monsters' count search in a module Web Worker (lib/army-search.js
// starts it), so a search that takes seconds on a phone never freezes the
// page. One message in — { id, params } (optimizeArmy's arguments, plain
// data) — progress messages out while it runs, then the result.
//
// Defs arrive as structured-clone copies, which is all the engine needs: its
// per-def caches are WeakMaps keyed by whatever objects it is given.

import { optimizeArmySteps } from './battle-sim.js';

/** Play one search, posting { id, type: 'progress', done, total, phase } and then { id, type: 'result', ok, counts, evaluations, score }. */
export function runSearchMessage(data, post) {
  const { id, params } = data || {};
  try {
    const gen = optimizeArmySteps(params);
    for (;;) {
      const step = gen.next();
      if (step.done) {
        const { ok, counts, evaluations, score } = step.value;
        post({ id, type: 'result', ok, counts, evaluations, score });
        return;
      }
      post({ id, type: 'progress', done: step.value.done, total: step.value.total, phase: step.value.phase });
    }
  } catch (err) {
    post({ id, type: 'error', message: String(err?.message ?? err) });
  }
}

// In a worker, `self` has postMessage and no document; importing this file elsewhere (the tests) does nothing.
if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof document === 'undefined') {
  self.onmessage = (e) => runSearchMessage(e.data, (msg) => self.postMessage(msg));
}
