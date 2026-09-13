import { setGameDayRolloverUtcHour, getPageLoadSignal } from './state.js';
import { notify } from './ui.js';

/**
 * Thrown when an /api/* call gets a 401. Page modules can catch this to
 * suppress logging — the user has already been redirected to /login,
 * so any error bubbling up isn't actionable.
 */
export class UnauthenticatedError extends Error {
  constructor() {
    super('unauthenticated');
    this.name = 'UnauthenticatedError';
  }
}

/**
 * Wrapper around fetch() that:
 *  - prefixes the URL with /api
 *  - disables HTTP caching (no-store) so refetches always hit the server
 *  - redirects to /login on 401 and throws UnauthenticatedError so the
 *    caller's promise rejects (most callers should `.catch(err => { if
 *    (err.name !== 'UnauthenticatedError') throw err; })` to ignore the
 *    expected redirect)
 *  - sniffs `gameDayRolloverUtcHour` out of any /stats response and
 *    pipes it into shared state (used by leaderboard shortcuts +
 *    analytics chart bucketing)
 */
export async function api(path, opts) {
  // Every /api/* endpoint in this app answers with a JSON body, so an
  // empty response is never a legitimate "no data" result — it always
  // means the request didn't make it through intact: an upstream proxy
  // (Cloudflare) timing out, or the server briefly unresponsive while a
  // scan pins the event loop. Those are transient, so retry idempotent
  // GETs once before giving up. We never retry mutations (POST/PUT/
  // DELETE) — replaying those could double-submit.
  const method = (opts?.method ?? 'GET').toUpperCase();

  // Attach the router's navigation abort signal to idempotent GET reads
  // (unless the caller passed its own). When the user navigates, the
  // router aborts the previous page's in-flight reads so a slow or
  // retrying response can't resolve late and overwrite the page they
  // actually switched to. Mutations are never auto-aborted — cancelling
  // a half-sent POST/PUT/DELETE could leave the server in a worse state.
  const fetchOpts = { cache: 'no-store', ...opts };
  if (method === 'GET' && fetchOpts.signal === undefined) {
    const navSignal = getPageLoadSignal();
    if (navSignal) fetchOpts.signal = navSignal;
  }

  const maxAttempts = method === 'GET' ? 2 : 1;
  let lastEmptyStatus = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(`/api${path}`, fetchOpts);
    if (res.status === 401) {
      window.location.replace('/login');
      throw new UnauthenticatedError();
    }

    // Read as text first so we can surface useful errors when the server
    // returns HTML (e.g. an upstream proxy error page or a default Express
    // crash response). `res.json()` throws "unexpected character" in that
    // case, which masks the actual status / message for the caller, and
    // the resulting unhandled promise rejection silently breaks the UI.
    //
    // If the body parses as JSON we return it as-is so existing pages
    // that look at `result.error` keep working — only fall back to
    // throwing when the response can't be turned into a JS object at all.
    const raw = await res.text();
    if (raw.length === 0) {
      // Empty body = failed request, not a value. Previously we returned
      // `null` here, which just pushed the failure into every caller as a
      // confusing native crash ("can't access property 'length', sessions
      // is null"). Retry once for GETs, then throw an actionable error so
      // the page surfaces a clear toast instead of a null dereference.
      lastEmptyStatus = res.status;
      // If the navigation that triggered this read has been superseded,
      // don't bother retrying — the response is about to be discarded.
      // Surface it as an abort so the router swallows it silently rather
      // than showing the "empty response" toast for a load nobody wants.
      if (fetchOpts.signal?.aborted) {
        const aborted = new Error('Request superseded by navigation');
        aborted.name = 'AbortError';
        throw aborted;
      }
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        continue;
      }
      throw new Error(
        `The server returned an empty response${lastEmptyStatus ? ` (HTTP ${lastEmptyStatus})` : ''}. `
        + 'It may be busy finishing a scan — please try again in a moment.',
      );
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      const snippet = raw.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);
      const msg = snippet || `${res.status} ${res.statusText}`;
      throw new Error(`Server returned non-JSON response (${res.status}): ${msg}`);
    }

    if (data && typeof data === 'object' && Number.isFinite(data.gameDayRolloverUtcHour)) {
      setGameDayRolloverUtcHour(data.gameDayRolloverUtcHour);
    }
    return data;
  }

  // Unreachable: the loop either returns data or throws on the final
  // attempt. Present only so every code path has an explicit result.
  return null;
}

export function apiPost(path, body) {
  return api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

export function apiPut(path, body) {
  return api(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

export function apiPatch(path, body) {
  return api(path, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

export function apiDelete(path) {
  return api(path, { method: 'DELETE' });
}

/**
 * Toast-on-error helper for fire-and-forget admin clicks. Many call
 * sites just `await apiPost(...)` without inspecting the result, so a
 * server-side error (`{ error: '...' }` body or a thrown 500) silently
 * disappears and the user is left wondering why nothing happened.
 *
 * Wrap a single API call:
 *
 *   if (!await mustOk(apiPost('/admin/chest-types', payload), 'Save failed')) return;
 *
 * Returns the resolved value on success, or `null` on failure (after
 * showing a toast). Callers that want the data should null-check.
 */
export async function mustOk(promise, title = 'Request failed') {
  try {
    const result = await promise;
    if (result && typeof result === 'object' && typeof result.error === 'string') {
      notify(result.error, title);
      return null;
    }
    return result;
  } catch (err) {
    if (err && err.name === 'UnauthenticatedError') return null;
    notify(err && err.message ? err.message : String(err), title);
    return null;
  }
}
