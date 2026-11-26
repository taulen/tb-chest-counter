/**
 * The game client version the scan's login sends (`["webgl", version]` in
 * message 203). The real client sends its build's Application.version; ours
 * follows the live build's, read from the build's data file once per client
 * build (webgl-client.ts clientVersionFromBundle) — by the art run, which
 * downloads that file anyway, else by ensureClientVersion() for the watcher.
 *
 * Which one the login sends:
 *   GAME_CLIENT_VERSION (a manual override) >
 *   the live build's, once read, unless older than the fallback >
 *   FALLBACK_CLIENT_VERSION (set by hand Nov 17 2026).
 *
 * Until Nov 26 2026 the login always sent the hand-set version, refreshed
 * "when a login fails after an update" — finding out from a broken scan.
 * This module stays light (fs/path): the protocol client imports it.
 */
import fs from 'fs';
import path from 'path';
import { childLogger } from '../utils/logger.js';
import { reportReaderFailed, reportReaderOk } from './status.js';

const log = childLogger('game-patch');

export const FALLBACK_CLIENT_VERSION = '349.9.1116';
const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;
const FILE = 'client-version.json';
const RETRY_MS = 30 * 60_000;
const DOWNLOAD_TIMEOUT_MS = 300_000;

interface Saved {
  /** The client build hash (versions config webgl_client_version.default). */
  build: string;
  version: string;
  readAt: string;
}

/** Same default as game-art/store.ts gameArtDir(), without importing the art modules. */
function artDir(): string {
  return process.env.GAME_ART_DIR ? path.resolve(process.env.GAME_ART_DIR) : path.resolve('data', 'game-art');
}

const memo = new Map<string, Saved | null>();

function saved(dir: string = artDir()): Saved | null {
  if (memo.has(dir)) return memo.get(dir)!;
  let s: Saved | null = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8')) as Saved;
    if (typeof parsed.build === 'string' && typeof parsed.version === 'string' && VERSION_RE.test(parsed.version)) s = parsed;
  } catch {
    s = null; // not read yet
  }
  memo.set(dir, s);
  return s;
}

/** Numeric, part by part: "350.0.1122" > "349.9.1116". */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

export interface ClientVersionInfo {
  version: string;
  source: 'env' | 'game' | 'fallback';
  /** The client build it was read from (source 'game'). */
  build?: string;
  readAt?: string;
}

export function clientVersionInfo(dir?: string): ClientVersionInfo {
  const env = process.env.GAME_CLIENT_VERSION;
  if (env) return { version: env, source: 'env' };
  const s = saved(dir);
  if (s && compareVersions(s.version, FALLBACK_CLIENT_VERSION) >= 0) {
    return { version: s.version, source: 'game', build: s.build, readAt: s.readAt };
  }
  return { version: FALLBACK_CLIENT_VERSION, source: 'fallback' };
}

/** What the scan's login sends. */
export function gameClientVersion(): string {
  return clientVersionInfo().version;
}

/** Client build `build` is version `version` (read from its data file). */
export function rememberClientVersion(build: string, version: string, dir: string = artDir()): void {
  if (!VERSION_RE.test(version)) throw new Error(`not a client version: ${JSON.stringify(version)}`);
  const prev = saved(dir);
  const s: Saved = { build, version, readAt: new Date().toISOString() };
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s));
  fs.renameSync(tmp, file);
  memo.set(dir, s);
  reportReaderOk('client', build);
  if (prev?.version !== version) {
    log.info(`Game client version ${version} (build ${build})${prev ? `, was ${prev.version}` : ''}; the scan's login sends it from now on.`);
  }
}

let failed: { build: string; at: number } | null = null;

/** Lift the retry wait (System → Game Patch → Check now). */
export function clearClientVersionRetry(): void {
  failed = null;
}

/**
 * Read the live client build's version unless it is already known: one ~43 MB
 * download per client build, and none when the art run read it first. Never
 * throws; a failure is reported and the login keeps the version it had.
 */
export async function ensureClientVersion(fetchImpl: typeof fetch = fetch, dir: string = artDir()): Promise<ClientVersionInfo> {
  const { VERSIONS_URL } = await import('../game-art/catalog.js');
  const client = await import('../game-art/webgl-client.js');
  let build: string;
  try {
    const res = await fetchImpl(VERSIONS_URL, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`GET ${VERSIONS_URL} → HTTP ${res.status}`);
    build = client.webglClientVersionFromConfig(await res.json());
  } catch {
    return clientVersionInfo(dir); // the versions endpoint: the watcher reports that
  }
  const s = saved(dir);
  if (s?.build === build) {
    reportReaderOk('client', build);
    return clientVersionInfo(dir);
  }
  if (failed?.build === build && Date.now() - failed.at < RETRY_MS) return clientVersionInfo(dir);
  try {
    const url = client.webglDataUrl(build);
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
    const version = client.clientVersionFromBundle(client.readClientBundle(Buffer.from(await res.arrayBuffer())));
    rememberClientVersion(build, version, dir);
    failed = null;
  } catch (err) {
    failed = { build, at: Date.now() };
    reportReaderFailed('client', build, clientVersionInfo(dir).version, err);
  }
  return clientVersionInfo(dir);
}

/** Test seam. */
export function resetClientVersionMemo(): void {
  memo.clear();
  failed = null;
}
