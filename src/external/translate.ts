/**
 * Chat translation, one message at a time, on request (the Chats page's
 * Translate button). Uses Google Translate's free web-client endpoint
 * (`translate_a/t?client=gtx`): no key, `sl=auto` detects the language and the
 * answer names it. Unofficial, so it is used sparingly: only a message
 * someone asked for, one request at a time, each answer cached in memory, and
 * a 5-minute pause after the service refuses (429/403) or fails.
 *
 * Only stored chat lines are ever sent — the route looks the text up itself,
 * so the endpoint can't be used to translate arbitrary text.
 */

const ENDPOINT = 'https://translate.googleapis.com/translate_a/t';
const FETCH_TIMEOUT_MS = 8_000;
const PAUSE_AFTER_FAILURE_MS = 5 * 60_000;
const CACHE_MAX = 2_000;
/** Longer than any chat line the game allows; a cap on what one request sends. */
const MAX_CHARS = 4_000;

/** The game's placeholder for a chip (a shared location, a report): `/%1%/`. */
const PLACEHOLDER = /\/%\d+%\//g;

export interface Translation {
  /** The language Google detected (`ru`, `zh-CN` …), or null when it named none. */
  from: string | null;
  /** The translated text, the game's placeholders kept where they were. */
  text: string;
}

export class TranslateUnavailableError extends Error {
  constructor(message = 'Translation is not available right now') {
    super(message);
    this.name = 'TranslateUnavailableError';
  }
}

type Fetch = typeof fetch;
let fetchImpl: Fetch = (...args) => fetch(...args);
let pausedUntil = 0;
let chain: Promise<unknown> = Promise.resolve();
const cache = new Map<string, Translation>();

/** Test seam: swap the network and clear the cache and pause. */
export function resetTranslateForTests(f?: Fetch): void {
  fetchImpl = f ?? ((...args) => fetch(...args));
  pausedUntil = 0;
  chain = Promise.resolve();
  cache.clear();
}

/** One request at a time: the endpoint is free and throttles bursts. */
function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

/** Google's answer for `q`s, in order: `[[text, lang], …]` (a bare string when it names no language). */
async function request(texts: string[], target: string): Promise<Translation[]> {
  if (Date.now() < pausedUntil) throw new TranslateUnavailableError();
  const body = new URLSearchParams();
  for (const q of texts) body.append('q', q);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${ENDPOINT}?client=gtx&sl=auto&tl=${encodeURIComponent(target)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8', 'user-agent': 'Mozilla/5.0' },
      body,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json() as unknown;
    if (!Array.isArray(json) || json.length !== texts.length) throw new Error('unexpected answer');
    return json.map((row): Translation => {
      if (typeof row === 'string') return { from: null, text: row };
      if (Array.isArray(row) && typeof row[0] === 'string') {
        return { from: typeof row[1] === 'string' && row[1] ? row[1] : null, text: row[0] };
      }
      throw new Error('unexpected answer');
    });
  } catch (err) {
    pausedUntil = Date.now() + PAUSE_AFTER_FAILURE_MS;
    throw new TranslateUnavailableError(`Translation failed: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

const placeholders = (s: string): string => (s.match(PLACEHOLDER) ?? []).join('');

/**
 * Translate one chat line into `target`. The whole line goes as one text so
 * the words around a chip keep their context; if the answer lost or moved a
 * placeholder, the pieces between placeholders are translated separately and
 * put back around them.
 */
async function translateLine(text: string, target: string): Promise<Translation> {
  const [whole] = await request([text], target);
  if (placeholders(whole.text) === placeholders(text)) return whole;
  const marks = text.match(PLACEHOLDER) ?? [];
  const pieces = text.split(PLACEHOLDER);
  const wanted = pieces.map((p, i) => ({ p, i })).filter(({ p }) => /\p{L}/u.test(p));
  const done = wanted.length ? await request(wanted.map(({ p }) => p), target) : [];
  const out = [...pieces];
  wanted.forEach(({ i, p }, k) => {
    // Keep the spacing the writer put around the chip.
    const lead = /^\s*/.exec(p)![0];
    const trail = /\s*$/.exec(p)![0];
    out[i] = lead + done[k].text.trim() + trail;
  });
  return { from: whole.from ?? done[0]?.from ?? null, text: out.map((p, i) => p + (marks[i] ?? '')).join('') };
}

/**
 * The translation of a stored chat line, cached by `cacheKey` (the message's
 * row, its edit time and the target) so a line is sent at most once per
 * language while the process runs.
 */
export async function translateChatLine(cacheKey: string, text: string, target: string): Promise<Translation> {
  const key = `${cacheKey}:${target}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const result = await oneAtATime(() => translateLine(text.slice(0, MAX_CHARS), target));
  cache.set(key, result);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return result;
}
