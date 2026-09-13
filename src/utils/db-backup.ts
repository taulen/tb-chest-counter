import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { pipeline } from 'stream/promises';
import { getDb } from '../data/database.js';
import { childLogger } from './logger.js';

const log = childLogger('db-backup');

/**
 * Per-kind retention. This in-app rotation is only a convenience layer
 * for quick restores from the dashboard — the authoritative backups run
 * daily in Proxmox Backup Server (off-box). So we bias toward few,
 * well-spread files rather than deep history.
 *
 *   daily:      keep one-per-day for the most recent `denseDays`, then
 *               thin older ones to roughly one every `thinStepDays`,
 *               capped at `keep` files within `maxAgeDays`. With the
 *               defaults that's the last few days daily then every ~3rd
 *               day out to two weeks — ~7 snapshots max.
 *   pre-action: short-lived undo for a destructive admin action; a few
 *               is plenty. Also debounced (PREACTION_DEBOUNCE_MS) so a
 *               burst of deletes doesn't snapshot on every click.
 *   manual:     snapshots the operator took deliberately; keep a handful,
 *               no age cap.
 *
 * `pre-import` snapshots are never touched here — they're the forward-undo
 * for an operator's restore and are managed separately.
 */
interface RetentionPolicy {
  /** Max files retained for this kind. */
  keep: number;
  /** Files older than this are always pruned. `Infinity` = no age cap. */
  maxAgeDays: number;
  /** daily only: keep one-per-day for the most recent N days. */
  denseDays?: number;
  /** daily only: beyond the dense window, keep ~one every N days. */
  thinStepDays?: number;
}

const RETENTION: Record<'daily' | 'pre-action' | 'manual', RetentionPolicy> = {
  daily: { keep: 7, maxAgeDays: 14, denseDays: 3, thinStepDays: 3 },
  'pre-action': { keep: 3, maxAgeDays: 14 },
  manual: { keep: 5, maxAgeDays: Infinity },
};

/**
 * Skip writing a fresh pre-action snapshot if one was written within this
 * window — a burst of deletes (or repeated clan re-imports) would
 * otherwise snapshot a near-identical DB on every click.
 */
const PREACTION_DEBOUNCE_MS = 10 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

function resolveDbPath(): string {
  return path.resolve(process.env.DB_PATH || './data/tb-chests.db');
}

function backupsDir(): string {
  return path.join(path.dirname(resolveDbPath()), 'backups');
}

/**
 * Snapshot the live SQLite file to a gzipped .db.gz before performing a
 * destructive admin action (delete user, delete clan, etc.). Mirrors
 * the format of the manual `/api/export/backup` download so the same
 * `/api/import/backup-db` restore path can ingest these files.
 *
 * Returns the absolute path of the new backup. Throws on failure — the
 * caller should let the error propagate so the destructive action is
 * aborted; doing the action without a backup defeats the purpose.
 *
 * After a successful write, prunes the backups directory per-kind (see
 * RETENTION). Pruning is best-effort (failures here are logged but don't
 * propagate).
 */
export async function createPreActionBackup(label: string): Promise<string> {
  const dbPath = resolveDbPath();
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Cannot create pre-action backup: ${dbPath} does not exist`);
  }

  const dir = backupsDir();
  fs.mkdirSync(dir, { recursive: true });

  // Debounce destructive-action snapshots: if a pre-action backup was
  // written within the window, reuse it instead of writing a near-identical
  // one. Only applies to pre-action labels — daily/manual always write.
  if (/^(pre-delete|pre-action)/.test(label)) {
    const recent = findRecentPreAction(dir, PREACTION_DEBOUNCE_MS);
    if (recent) {
      log.info(`Reusing pre-action backup written <${Math.round(PREACTION_DEBOUNCE_MS / 60000)}m ago (debounced): ${recent}`);
      return recent;
    }
  }

  // Force a checkpoint so the .db file on disk includes the latest WAL
  // contents. Without this, backups taken right after a write would
  // miss recent rows that haven't been flushed back to the main file.
  try {
    getDb().pragma('wal_checkpoint(TRUNCATE)');
  } catch (err) {
    log.warn(`wal_checkpoint failed before pre-action backup: ${err instanceof Error ? err.message : String(err)}`);
  }

  const safeLabel = label.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'auto';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(dir, `${timestamp}-${safeLabel}.db.gz`);

  await pipeline(
    fs.createReadStream(dbPath),
    zlib.createGzip({ level: 6 }),
    fs.createWriteStream(outPath),
  );

  log.info(`Pre-action backup created: ${outPath}`);

  pruneOldBackups(dir);
  return outPath;
}

interface BackupFile {
  full: string;
  mtimeMs: number;
}

/**
 * Most recent pre-action snapshot written within `windowMs`, or null.
 * Used to debounce a burst of destructive actions.
 */
function findRecentPreAction(dir: string, windowMs: number): string | null {
  if (!fs.existsSync(dir)) return null;
  const now = Date.now();
  let best: BackupFile | null = null;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.db.gz')) continue;
    if (classifyBackup(name) !== 'pre-action') continue;
    const full = path.join(dir, name);
    const mtimeMs = fs.statSync(full).mtimeMs;
    if (now - mtimeMs > windowMs) continue;
    if (!best || mtimeMs > best.mtimeMs) best = { full, mtimeMs };
  }
  return best ? best.full : null;
}

/**
 * Prune the backups directory per-kind (see RETENTION). `pre-import`
 * snapshots are left untouched. Best-effort: enumeration/unlink failures
 * are logged, never thrown.
 */
function pruneOldBackups(dir: string): void {
  try {
    const now = Date.now();
    const byKind = new Map<string, BackupFile[]>();
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.db.gz') && !name.endsWith('.db')) continue;
      const kind = classifyBackup(name);
      if (kind === 'pre-import') continue; // forward-undo; never auto-pruned
      const full = path.join(dir, name);
      const list = byKind.get(kind) ?? [];
      list.push({ full, mtimeMs: fs.statSync(full).mtimeMs });
      byKind.set(kind, list);
    }

    for (const [kind, files] of byKind) {
      const policy = RETENTION[kind as keyof typeof RETENTION];
      if (!policy) continue;
      files.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
      const keep = new Set(selectSurvivors(files, policy, now).map((f) => f.full));
      for (const f of files) {
        if (keep.has(f.full)) continue;
        try {
          fs.unlinkSync(f.full);
          log.debug(`Pruned ${kind} backup: ${f.full}`);
        } catch (err) {
          log.warn(`Failed to prune ${f.full}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  } catch (err) {
    log.warn(`Failed to enumerate backups for pruning: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Given a kind's files newest-first, return the subset to retain.
 * Non-daily kinds keep the newest `keep` within the age cap. Daily also
 * thins: one-per-day for the most recent `denseDays`, then ~one every
 * `thinStepDays` beyond that — so a small file count still spans ~2 weeks.
 */
function selectSurvivors(files: BackupFile[], policy: RetentionPolicy, now: number): BackupFile[] {
  const kept: BackupFile[] = [];
  const dense = policy.denseDays ?? Infinity;
  const step = policy.thinStepDays ?? 0;
  let lastOlderAge = dense - step; // so the first older-tier entry qualifies
  const seenDays = new Set<string>();

  for (const f of files) {
    if (kept.length >= policy.keep) break;
    const ageDays = (now - f.mtimeMs) / DAY_MS;
    if (ageDays > policy.maxAgeDays) break; // newest-first: everything after is older

    if (policy.denseDays === undefined) {
      kept.push(f); // simple newest-N (pre-action, manual)
      continue;
    }

    // daily: at most one representative per calendar day
    const dayKey = new Date(f.mtimeMs).toISOString().slice(0, 10);
    if (seenDays.has(dayKey)) continue;
    seenDays.add(dayKey);

    if (ageDays < dense) {
      kept.push(f);
    } else if (ageDays - lastOlderAge >= step) {
      kept.push(f);
      lastOlderAge = ageDays;
    }
    // else: thinned out
  }
  return kept;
}

export interface BackupListEntry {
  fileName: string;
  bytes: number;
  mtimeMs: number;
  /**
   * Best-effort categorization for the dashboard:
   *   - `daily`: scheduled rotation
   *   - `pre-action`: taken before a destructive admin action
   *   - `pre-import`: taken before a restore (created by the import route,
   *     uncompressed `.db`)
   *   - `manual`: anything else found in the directory
   */
  kind: 'daily' | 'pre-action' | 'pre-import' | 'manual';
}

/**
 * List every backup file currently in the data/backups directory.
 * Returned newest-first so the dashboard table can render directly.
 */
export function listBackups(): BackupListEntry[] {
  const dir = backupsDir();
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.db.gz') || name.endsWith('.db'))
    .map((name) => {
      const stat = fs.statSync(path.join(dir, name));
      return {
        fileName: name,
        bytes: stat.size,
        mtimeMs: stat.mtimeMs,
        kind: classifyBackup(name),
      };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function classifyBackup(fileName: string): BackupListEntry['kind'] {
  if (fileName.includes('-daily')) return 'daily';
  if (fileName.includes('-pre-delete-') || fileName.includes('-pre-action-')) return 'pre-action';
  if (fileName.startsWith('pre-import-')) return 'pre-import';
  return 'manual';
}

/**
 * Resolve a basename against the backups directory while refusing
 * anything that tries to escape via `..` or absolute paths. Returns
 * the absolute path if valid, or null otherwise.
 *
 * Used by the restore route — `fileName` comes from request input, so
 * accepting it without normalization would let a caller read from any
 * path on disk.
 */
export function resolveBackupPath(fileName: string): string | null {
  if (!fileName) return null;
  const base = path.basename(fileName);
  if (base !== fileName) return null;
  if (!base.endsWith('.db.gz') && !base.endsWith('.db')) return null;
  const dir = backupsDir();
  const full = path.join(dir, base);
  // Defense-in-depth: ensure the resolved path stays inside the
  // backups dir even if path.basename was somehow fooled.
  const dirReal = path.resolve(dir);
  const fullReal = path.resolve(full);
  if (!fullReal.startsWith(dirReal + path.sep) && fullReal !== dirReal) return null;
  if (!fs.existsSync(fullReal)) return null;
  return fullReal;
}

/**
 * Daily backup scheduler. On boot, takes a backup immediately if one
 * hasn't already been written today (so a server that crashed and
 * restarts mid-day doesn't end up skipping a day). Then schedules a
 * fresh `daily` backup every 24 hours.
 *
 * Returns a cleanup function that clears the timer — handy for tests,
 * not used by the running server.
 */
export function startDailyBackupSchedule(): () => void {
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;

  const runOnce = (): void => {
    createPreActionBackup('daily').catch((err) => {
      log.error(`Daily backup failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  };

  // If today already has a `daily` snapshot, skip the immediate run.
  const todayKey = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const hasTodayBackup = listBackups().some((b) => b.kind === 'daily' && b.fileName.startsWith(todayKey));
  if (!hasTodayBackup) {
    // Defer one tick so the rest of startup (DB init, etc.) finishes
    // before we read from the file.
    setImmediate(runOnce);
  }

  const timer = setInterval(runOnce, ONE_DAY_MS);
  // Don't keep the event loop alive solely for the backup timer.
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}
