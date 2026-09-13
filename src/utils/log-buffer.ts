// In-process capture of warn/error log entries so admins can see
// recent problems in the System page without SSHing for `docker logs`.
//
// Two-tier storage:
//   - in-memory ring buffer (fast read for the API)
//   - JSONL append at data/warnings.jsonl (survives container restart)
//
// Wired into pino via multistream in logger.ts; once that's set up, every
// call to log.warn / log.error anywhere in the codebase lands here for
// free — no per-call-site changes required.

import fs from 'fs';
import path from 'path';
import { Writable } from 'stream';

export interface LogBufferEntry {
  ts: number;          // unix ms
  level: number;       // pino numeric level (40=warn, 50=error, 60=fatal)
  levelName: 'warn' | 'error' | 'fatal' | 'unknown';
  module: string;      // child logger name, or '' if root
  msg: string;
  // Whether this entry should light the System nav dot. Defaults true.
  // Call sites that are informational-but-warn-level (e.g. "new member
  // seen this scan", already surfaced on the Admin tab) pass
  // `log.warn({ noAlert: true }, ...)` to stay in the list without
  // demanding a second red dot.
  alert: boolean;
}

const MAX_ENTRIES = 20;
const FILE_PATH = path.join('data', 'warnings.jsonl');
// Soft cap on the on-disk file. When we'd exceed it on append we rewrite
// the file from the in-memory buffer so it stays bounded.
const MAX_FILE_BYTES = 16 * 1024;

const buffer: LogBufferEntry[] = [];

function levelNameFor(level: number): LogBufferEntry['levelName'] {
  if (level >= 60) return 'fatal';
  if (level >= 50) return 'error';
  if (level >= 40) return 'warn';
  return 'unknown';
}

function pushEntry(entry: LogBufferEntry): void {
  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) buffer.shift();
}

// Serializes the async appends below so a burst of warns/errors (e.g. during
// a scan) can't interleave writes, without blocking the event loop.
let writeChain: Promise<void> = Promise.resolve();
// In-memory estimate of the on-disk file size so we don't stat() per write.
// -1 means "unknown, re-stat on next write" (also the reset-on-error state).
let approxFileBytes = -1;
let dirEnsured = false;

function persistAppend(entry: LogBufferEntry): void {
  // Queue a non-blocking, best-effort write. Previously this did synchronous
  // fs.existsSync + statSync + appendFileSync on every warn/error, which
  // stalled the single event loop in bursts precisely when the app was already
  // busy (scans emit clusters of warnings). Now the fs work happens off the
  // hot path; the logger returns immediately.
  const line = JSON.stringify(entry) + '\n';
  const lineBytes = Buffer.byteLength(line);
  writeChain = writeChain
    .then(async () => {
      if (!dirEnsured) {
        await fs.promises.mkdir(path.dirname(FILE_PATH), { recursive: true });
        dirEnsured = true;
      }
      if (approxFileBytes < 0) {
        try {
          approxFileBytes = (await fs.promises.stat(FILE_PATH)).size;
        } catch {
          approxFileBytes = 0; // file doesn't exist yet
        }
      }
      // Keep the on-disk file bounded: rewrite from the in-memory ring buffer
      // when a plain append would exceed the soft cap.
      if (approxFileBytes + lineBytes > MAX_FILE_BYTES) {
        const dump = buffer.map((e) => JSON.stringify(e)).join('\n') + '\n';
        await fs.promises.writeFile(FILE_PATH, dump);
        approxFileBytes = Buffer.byteLength(dump);
      } else {
        await fs.promises.appendFile(FILE_PATH, line);
        approxFileBytes += lineBytes;
      }
    })
    .catch(() => {
      // Persisting must never break the logger. Re-stat next time.
      approxFileBytes = -1;
    });
}

export function loadPersistedEntries(): void {
  try {
    if (!fs.existsSync(FILE_PATH)) return;
    const text = fs.readFileSync(FILE_PATH, 'utf8');
    const lines = text.split('\n').filter((l) => l.trim().length > 0);
    // Keep at most the last MAX_ENTRIES lines so a long history doesn't
    // fight the in-memory cap.
    const tail = lines.slice(-MAX_ENTRIES);
    for (const line of tail) {
      try {
        const obj = JSON.parse(line);
        if (typeof obj?.ts === 'number' && typeof obj?.msg === 'string') {
          buffer.push({
            ts: obj.ts,
            level: typeof obj.level === 'number' ? obj.level : 40,
            levelName: levelNameFor(typeof obj.level === 'number' ? obj.level : 40),
            module: typeof obj.module === 'string' ? obj.module : '',
            msg: obj.msg,
            alert: obj.alert !== false, // missing/true → alerting (back-compat)
          });
        }
      } catch {
        // skip malformed line
      }
    }
  } catch {
    // best-effort load only
  }
}

export function getEntries(): LogBufferEntry[] {
  // Newest first for the API consumer.
  return buffer.slice().reverse();
}

export function countSince(sinceMs: number): number {
  let n = 0;
  for (let i = buffer.length - 1; i >= 0; i--) {
    if (buffer[i].ts <= sinceMs) break;
    if (buffer[i].alert !== false) n++;
  }
  return n;
}

// Timestamp of the newest *alerting* entry — this is what drives the
// System nav dot. Non-alerting entries (alert === false) still appear in
// the list via getEntries() but must not light the dot.
export function latestEntryAt(): number | null {
  for (let i = buffer.length - 1; i >= 0; i--) {
    if (buffer[i].alert !== false) return buffer[i].ts;
  }
  return null;
}

// Pino destination — receives one JSON-encoded log record per write.
// Each record is a single line because that's how pino's streams work.
export function createPinoSink(): Writable {
  return new Writable({
    write(chunk, _encoding, callback) {
      try {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue;
          }
          const level = typeof parsed.level === 'number' ? parsed.level : 0;
          if (level < 40) continue;
          const entry: LogBufferEntry = {
            ts: typeof parsed.time === 'number' ? parsed.time : Date.now(),
            level,
            levelName: levelNameFor(level),
            module: typeof parsed.module === 'string' ? parsed.module : '',
            msg: typeof parsed.msg === 'string' ? parsed.msg : '',
            // Opt-out flag from the call site: log.warn({ noAlert: true }, ...)
            alert: parsed.noAlert !== true,
          };
          pushEntry(entry);
          persistAppend(entry);
        }
      } catch {
        // never let the sink error out — that would back up pino
      }
      callback();
    },
  });
}
