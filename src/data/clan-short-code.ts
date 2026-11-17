/**
 * Clan short codes (v124): clans were named "CWB - ChaosWithoutBorders"; the
 * code now has its own column. Split once, by migration v124: a name of the
 * form "<2–6 letters/digits> - <name>" becomes short code + name. The slug is
 * untouched (share URLs resolve on it); the clan's label stays "CWB -
 * ChaosWithoutBorders" (clan-repo clanLabel). Replay-safe: a split name no
 * longer matches, and only clans without a code are looked at.
 */
import type Database from 'better-sqlite3';

const LABEL = /^\s*([A-Za-z0-9]{2,6})\s+-\s+(\S.*?)\s*$/;

export function splitClanShortCodes(database: Database.Database): number {
  const cols = database.prepare('PRAGMA table_info(clans)').all() as { name: string }[];
  if (!cols.some((c) => c.name === 'short_code')) {
    database.exec("ALTER TABLE clans ADD COLUMN short_code TEXT NOT NULL DEFAULT ''");
  }
  const rows = database.prepare("SELECT id, name FROM clans WHERE short_code = ''").all() as Array<{ id: number; name: string }>;
  const split = database.prepare('UPDATE clans SET short_code = ?, name = ? WHERE id = ?');
  let n = 0;
  for (const r of rows) {
    const m = LABEL.exec(r.name);
    if (m) n += split.run(m[1], m[2], r.id).changes;
  }
  return n;
}
