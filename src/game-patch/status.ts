/**
 * What each reader of the game's files made of the live game patch.
 *
 * Four things are rebuilt from the game's own files whenever it publishes a
 * patch: names and texts (static-data.ts), research trees (tech-trees.ts), art
 * (game-art/store.ts) and the client version the scan's login sends
 * (client-version.ts). Each reports here when it reads a patch or fails to.
 *
 * A failure is one alerting warning (it lights the System dot) per reader and
 * game version, cleared by `resolveEntries` when that reader next succeeds —
 * the warning says what can't be read; the System page's Game Patch card shows
 * every reader at once. Meanwhile each reader serves the previous patch's data.
 * See docs/game-patches.md.
 *
 * Kept in data/game-patch.json (GAME_PATCH_FILE overrides it), so a restart
 * neither forgets a failure nor raises it again.
 */
import fs from 'fs';
import path from 'path';
import { childLogger } from '../utils/logger.js';
import { resolveEntries } from '../utils/log-buffer.js';

const log = childLogger('game-patch');

export const PATCH_READERS = ['names', 'trees', 'art', 'client'] as const;
export type PatchReader = (typeof PATCH_READERS)[number];

export const READER_LABELS: Record<PatchReader, string> = {
  names: 'Game names and texts',
  trees: 'Research trees',
  art: 'Game art',
  client: 'Client version',
};

export interface ReaderStatus {
  /** The game version this reader last tried (its own key: static data, catalogue, client build…). */
  live: string | null;
  /** What it serves: `live` when ok; the previous patch's when it failed; null = nothing. */
  served: string | null;
  ok: boolean;
  error: string | null;
  checkedAt: string;
  /** First failure on this `live` version; absent when ok. */
  failingSince?: string;
}

/** The parts of the game's versions config a patch changes. */
export interface PatchFingerprint {
  static: string;
  translations: string;
  catalog: string;
  client: string;
}

export interface PatchStatusFile {
  readers: Partial<Record<PatchReader, ReaderStatus>>;
  fingerprint?: PatchFingerprint;
  /** When the watcher first saw `fingerprint`. */
  patchSeenAt?: string;
  lastCheckAt?: string;
  /** The versions endpoint's last failure; null once it answers again. */
  lastCheckError?: string | null;
}

export function warningKey(reader: PatchReader): string {
  return `game-patch:${reader}`;
}

function statusFile(): string | null {
  if (process.env.GAME_PATCH_FILE) return path.resolve(process.env.GAME_PATCH_FILE);
  // Tests that drive a reader don't leave a status file in the working copy.
  if (process.env.VITEST) return null;
  return path.resolve('data', 'game-patch.json');
}

let memo: PatchStatusFile | null = null;

export function readPatchStatus(): PatchStatusFile {
  if (memo) return memo;
  const file = statusFile();
  try {
    if (file && fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as PatchStatusFile;
      memo = { ...parsed, readers: parsed.readers ?? {} };
      return memo;
    }
  } catch (err) {
    log.warn({ noAlert: true }, `Game patch status unreadable, starting afresh (${String(err)})`);
  }
  memo = { readers: {} };
  return memo;
}

export function updatePatchStatus(change: (s: PatchStatusFile) => void): PatchStatusFile {
  const s = readPatchStatus();
  change(s);
  const file = statusFile();
  if (file) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
      fs.renameSync(tmp, file);
    } catch (err) {
      log.warn({ noAlert: true }, `Game patch status could not be saved (${String(err)})`);
    }
  }
  return s;
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** `reader` read game version `live`. Clears its warning when it had one. */
export function reportReaderOk(reader: PatchReader, live: string): void {
  const prev = readPatchStatus().readers[reader];
  if (prev?.ok && prev.live === live) return;
  updatePatchStatus((s) => {
    s.readers[reader] = { live, served: live, ok: true, error: null, checkedAt: new Date().toISOString() };
  });
  if (!prev || !prev.ok) {
    if (prev && !prev.ok) log.info(`Game patch: ${READER_LABELS[reader]} read for game version ${live}.`);
    resolveEntries(warningKey(reader));
  }
}

/**
 * `reader` could not read game version `live` (null = it couldn't tell which)
 * and serves `served` meanwhile. Warns once per reader and version.
 */
export function reportReaderFailed(reader: PatchReader, live: string | null, served: string | null, err: unknown): void {
  const prev = readPatchStatus().readers[reader];
  const now = new Date().toISOString();
  const again = !!prev && !prev.ok && prev.live === live;
  updatePatchStatus((s) => {
    s.readers[reader] = {
      live,
      served,
      ok: false,
      error: errText(err),
      checkedAt: now,
      failingSince: again ? prev!.failingSince ?? now : now,
    };
  });
  if (again) return;
  log.warn(
    { resolveKey: warningKey(reader) },
    `Game patch: ${READER_LABELS[reader]} can't be read for game version ${live ?? '(unknown)'}: ${errText(err)}. ` +
    (served ? `Serving the previous patch's (${served}) until it can.` : 'Nothing to serve until it can.') +
    ' System → Game Patch has every reader; docs/game-patches.md says how to fix it.',
  );
}

/** Test seam. */
export function resetPatchStatusMemo(): void {
  memo = null;
}
