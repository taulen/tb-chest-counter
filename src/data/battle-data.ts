/**
 * The newest battle-data.json the names build wrote (game-protocol/battle-data.ts),
 * ready to send: GET /api/tools/battle-data serves it to Tools → Monsters as
 * is, with an ETag (the static-data version) and a gzipped copy.
 *
 * Kept in memory until a newer file appears; null when none was built yet
 * (the names build runs on the first game-data request after a deploy).
 */
import fs from 'fs';
import zlib from 'zlib';
import { newestStaticFile } from '../game-protocol/static-data.js';
import { BATTLE_DATA_FILE, BATTLE_DATA_FORMAT, type BattleData } from '../game-protocol/battle-data.js';

export interface BattleDataResponse {
  version: string;
  etag: string;
  body: Buffer;
  gzip: Buffer;
}

let memo: { file: string; mtimeMs: number; res: BattleDataResponse; data: BattleData } | null = null;

function load(): typeof memo {
  const file = newestStaticFile(BATTLE_DATA_FILE);
  if (!file) return null;
  const mtimeMs = fs.statSync(file).mtimeMs;
  if (memo?.file === file && memo.mtimeMs === mtimeMs) return memo;
  try {
    const body = fs.readFileSync(file);
    const data = JSON.parse(body.toString('utf8')) as BattleData;
    if (data.format !== BATTLE_DATA_FORMAT) return null;
    memo = {
      file,
      mtimeMs,
      data,
      res: { version: data.version, etag: `"battle-${data.version}"`, body, gzip: zlib.gzipSync(body) },
    };
    return memo;
  } catch {
    return null;
  }
}

/** The file as sent, or null when there is none. */
export function battleDataResponse(): BattleDataResponse | null {
  return load()?.res ?? null;
}

/** The parsed data (server-side readers), or null when there is none. */
export function loadBattleData(): BattleData | null {
  return load()?.data ?? null;
}
