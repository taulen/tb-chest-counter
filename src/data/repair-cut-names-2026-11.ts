/**
 * One-time data repair, run by migration v101: give back the names the member-list
 * reader cut off at a kingdom number, which a merge had then made the surviving name.
 *
 * Until Nov 13 2026 the reader took a member's name as everything before the FIRST
 * "K<digit>" on the row, meaning the coordinate marker "(K:7 X:… Y:…)". A name that
 * carries its own kingdom number was cut there instead: "Living SK7" → "Living S",
 * "Tigger K260 SK" → "Tigger". SK7 (clan 5) is full of those, so the Nov 13 read minted
 * 41 cut-off members next to the ones an admin had just named by hand. Likely Renames
 * took the pairs for an in-game retag, and "Merge all name matches" folded every
 * hand-named member INTO its cut-off twin. Each player's data did end up on one row
 * (correct), but under the cut-off name, with the real name as an alias and a player
 * merge rule pointing real → cut-off.
 *
 * So: a member whose name is the cut-off form of one of its own aliases (the alias is
 * the name plus a K-number tail) takes that alias back as its name. The cut-off form
 * stays as an alias, the way clan 3 already carries "Fiin S" on "Fiin SK 2", so a stray
 * cut read still lands on the right player. Player merge rules into the cut-off name
 * are re-pointed at the real one, and a rule left mapping a name onto itself is dropped.
 *
 * Generic and guarded, so it is a no-op on any database without the damage and safe to
 * replay: once renamed, a member's name is no longer a cut-off form of its aliases. A
 * member is skipped if another member of the clan already holds the real name, or if
 * two different aliases both fit.
 */
import type Database from 'better-sqlite3';
import { despace } from '../vision/ocr-normalize.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger('repair-cut-names');

/** What the old reader cut off: a tail starting at a K-number. */
const CUT_TAIL = /^\s*\(?\s*[Kk]\s*[:.]?\s*\d/;

/** member-repo's normalizeName: what `normalized_name` holds. */
const normalizeName = (name: string): string => name.trim().toLowerCase().replace(/\s+/g, ' ');

/** The one alias whose cut-off form `name` is, or null (none, or ambiguous). */
export function realNameBehindCut(name: string, aliases: string[]): string | null {
  const fits = [...new Set(aliases.map((a) => a.trim()).filter(
    (a) => a.length > name.length && a.startsWith(name) && CUT_TAIL.test(a.slice(name.length)),
  ))];
  return fits.length === 1 ? fits[0] : null;
}

export function repairCutNames(database: Database.Database): number {
  const members = database.prepare(
    "SELECT id, clan_id AS clanId, name, aliases FROM members WHERE aliases IS NOT NULL AND aliases != '[]'",
  ).all() as { id: number; clanId: number; name: string; aliases: string }[];

  const taken = database.prepare(
    'SELECT name FROM members WHERE clan_id = ? AND id != ? AND (normalized_name = ? OR despaced_name = ?)',
  );
  const rename = database.prepare(
    'UPDATE members SET name = ?, normalized_name = ?, despaced_name = ?, aliases = ? WHERE id = ?',
  );
  const repointRules = database.prepare(
    "UPDATE merge_rules SET to_value = ? WHERE clan_id = ? AND type = 'player' AND to_value = ?",
  );
  const dropSelfRule = database.prepare(
    "DELETE FROM merge_rules WHERE clan_id = ? AND type = 'player' AND from_value = ? AND to_value = ?",
  );

  const restored: string[] = [];
  for (const m of members) {
    let aliases: string[];
    try { aliases = JSON.parse(m.aliases); } catch { continue; }
    if (!Array.isArray(aliases)) continue;
    const real = realNameBehindCut(m.name, aliases);
    if (!real) continue;

    const holder = taken.get(m.clanId, m.id, normalizeName(real), despace(real)) as { name: string } | undefined;
    if (holder) {
      log.warn(`Clan #${m.clanId}: left "${m.name}" as is — "${holder.name}" already holds the name "${real}"`);
      continue;
    }

    const kept = aliases.filter((a) => a.trim().toLowerCase() !== real.toLowerCase());
    if (!kept.some((a) => a.trim().toLowerCase() === m.name.toLowerCase())) kept.push(m.name);
    rename.run(real, normalizeName(real), despace(real), JSON.stringify(kept), m.id);
    repointRules.run(real, m.clanId, m.name);
    dropSelfRule.run(m.clanId, real, real);
    restored.push(`#${m.clanId} "${m.name}" → "${real}"`);
  }
  if (restored.length > 0) {
    log.info(`Restored ${restored.length} member name(s) cut at a kingdom number: ${restored.join(', ')}`);
  }
  return restored.length;
}
