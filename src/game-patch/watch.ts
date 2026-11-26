/**
 * Notice a game patch within minutes and read it at once.
 *
 * Every POLL_MS the watcher reads the game's versions config (~16 KB) and
 * compares the parts a patch changes (PatchFingerprint). On a change it runs
 * every reader — names and texts, research trees, art, client version — instead
 * of each waiting for its own trigger (a scan, a page load, the daily art run).
 * Each reader reports its own outcome to status.ts, which is what alerts; a
 * reader that failed is retried every RETRY_MS. See docs/game-patches.md.
 */
import { childLogger } from '../utils/logger.js';
import { createCoalescedWarner } from '../utils/log-throttle.js';
import { PATCH_READERS, readPatchStatus, updatePatchStatus, type PatchFingerprint, type PatchReader } from './status.js';

const log = childLogger('game-patch');
const versionsWarner = createCoalescedWarner((m) => log.warn({ noAlert: true }, m), 6 * 3600_000);

/** The same endpoint the readers use (game-art/catalog.ts VERSIONS_URL). */
const VERSIONS_URL = 'https://versions.totalbattle.com/config?branch=current&simple=true';
const POLL_MS = 10 * 60_000;
const RETRY_MS = 30 * 60_000;
const FIRST_CHECK_MS = 90_000;

export function fingerprintFromConfig(body: unknown): PatchFingerprint {
  const r = ((body as { result?: Record<string, unknown> })?.result ?? {}) as {
    client_static_version?: Record<string, { composite_hash?: string }>;
    client_translations_catalog_version?: string;
    unity_catalog_version?: { webgl?: string };
    webgl_client_version?: { default?: string };
  };
  const fp = {
    static: r.client_static_version?.production?.composite_hash ?? '',
    translations: r.client_translations_catalog_version ?? '',
    catalog: r.unity_catalog_version?.webgl ?? '',
    client: r.webgl_client_version?.default ?? '',
  };
  const missing = Object.entries(fp).filter(([, v]) => typeof v !== 'string' || !v).map(([k]) => k);
  if (missing.length) throw new Error(`versions config has no ${missing.join(', ')} version`);
  return fp;
}

export type PatchReaderRuns = Record<PatchReader, () => Promise<unknown>> & { clearRetries(): void };

async function defaultRuns(): Promise<PatchReaderRuns> {
  // Imported lazily: each pulls in its own (large) module graph.
  const [names, trees, art, client] = await Promise.all([
    import('../game-protocol/static-data.js'),
    import('../game-protocol/tech-trees.js'),
    import('../game-art/store.js'),
    import('./client-version.js'),
  ]);
  return {
    names: () => names.loadGameNames(),
    trees: () => trees.loadTechTrees(),
    art: () => art.ensureGameArt(),
    client: () => client.ensureClientVersion(),
    clearRetries: () => {
      names.clearGameNamesRetry();
      trees.clearTechTreesRetry();
      client.clearClientVersionRetry();
    },
  };
}

export interface PatchCheckResult {
  /** Fingerprint parts that changed since the last check. */
  changed: Array<keyof PatchFingerprint>;
  /** Readers that ran. */
  ran: PatchReader[];
  error?: string;
}

export interface PatchCheckOptions {
  /** Run every reader now, retry waits lifted (System → Game Patch → Check now). */
  force?: boolean;
  runs?: PatchReaderRuns;
  fetchImpl?: typeof fetch;
}

let running: Promise<PatchCheckResult> | null = null;

export function gamePatchCheckRunning(): boolean {
  return running !== null;
}

/** One check; concurrent calls share it. Never throws. */
export function checkGamePatch(opts: PatchCheckOptions = {}): Promise<PatchCheckResult> {
  if (running) return running;
  running = runCheck(opts)
    .catch((err: unknown): PatchCheckResult => ({ changed: [], ran: [], error: String(err) }))
    .finally(() => {
      running = null;
    });
  return running;
}

async function runCheck(opts: PatchCheckOptions): Promise<PatchCheckResult> {
  const now = new Date().toISOString();
  let fp: PatchFingerprint;
  try {
    const res = await (opts.fetchImpl ?? fetch)(VERSIONS_URL, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`GET ${VERSIONS_URL} → HTTP ${res.status}`);
    fp = fingerprintFromConfig(await res.json());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    updatePatchStatus((s) => {
      s.lastCheckAt = now;
      s.lastCheckError = msg;
    });
    versionsWarner.warn('versions', `Game patch check: the versions endpoint failed (${msg}); readers keep what they have.`);
    return { changed: [], ran: [], error: msg };
  }

  const prev = readPatchStatus();
  const changed = prev.fingerprint
    ? (Object.keys(fp) as Array<keyof PatchFingerprint>).filter((k) => prev.fingerprint![k] !== fp[k])
    : [];
  const isNew = !prev.fingerprint || changed.length > 0;
  updatePatchStatus((s) => {
    s.lastCheckAt = now;
    s.lastCheckError = null;
    if (isNew) {
      s.fingerprint = fp;
      s.patchSeenAt = now;
    }
  });
  if (changed.length) log.info(`Game patch: ${changed.join(', ')} changed — reading it now.`);

  const due = (r: PatchReader): boolean => {
    if (opts.force || isNew) return true;
    const st = prev.readers[r];
    if (!st) return true; // never read: a fresh volume or a new reader
    return !st.ok && Date.now() - Date.parse(st.checkedAt) >= RETRY_MS;
  };
  const toRun = PATCH_READERS.filter(due);
  if (!toRun.length) return { changed, ran: [] };

  const runs = opts.runs ?? (await defaultRuns());
  if (opts.force) runs.clearRetries();
  // In order: art selects by name (names), and its client download records the
  // client version, sparing the client reader a second download.
  for (const r of toRun) {
    try {
      await runs[r]();
    } catch {
      // each reader reports its own failure to status.ts
    }
  }
  return { changed, ran: toRun };
}

let firstTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

/** Check shortly after startup, then every POLL_MS. Timers don't hold the process. */
export function startGamePatchWatch(firstDelayMs = FIRST_CHECK_MS, intervalMs = POLL_MS): void {
  if (firstTimer || pollTimer) return;
  const run = (): void => {
    void checkGamePatch();
  };
  firstTimer = setTimeout(run, firstDelayMs);
  firstTimer.unref?.();
  pollTimer = setInterval(run, intervalMs);
  pollTimer.unref?.();
}

export function stopGamePatchWatch(): void {
  if (firstTimer) clearTimeout(firstTimer);
  if (pollTimer) clearInterval(pollTimer);
  firstTimer = null;
  pollTimer = null;
}
