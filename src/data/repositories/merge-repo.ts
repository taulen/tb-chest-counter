import { getDb } from '../database.js';
import { childLogger } from '../../utils/logger.js';
import { transliterateCyrillicHomoglyphs, foldDiacritics, despace } from '../../vision/ocr-normalize.js';
import { notifyChestDataChanged } from './chest-summary-repo.js';
import { invalidate } from '../../utils/ttl-cache.js';

/**
 * Drop the nav-badge caches a merge invalidates.
 *
 * A player merge DELETES the source member row and remaps its chest records, which
 * changes both the review-queue member list and the blank/unknown sentinel set. Both
 * counts are memoized per clan, so without this the Admin dot stays lit for up to a
 * minute after the operator has already resolved the only thing it was pointing at —
 * with no button left to press, since the entry it belonged to is gone. Reported from
 * production: merging a new member instead of acknowledging it left a dot that looked
 * permanently stuck.
 *
 * The might caches go too, for the same reason: the merge folds and remaps
 * member_snapshots, so the per-member delta table and the clan totals are stale the
 * moment it commits. Without this they keep serving the pre-merge roster — two rows
 * for one player, one of them a name that no longer exists — for up to a minute.
 *
 * Invalidated by key prefix rather than by importing the repos' own invalidators,
 * to avoid an import cycle — same approach member-repo takes.
 */
function invalidateMergeDerivedCaches(clanId: number): void {
  invalidate(`reviewQueueCount:${clanId}`);
  invalidate(`unknownChestsCount:${clanId}`);
  invalidate(`might:${clanId}:`);
}

const log = childLogger('merge-repo');

/**
 * Generic tokens that are common to many chest/source names. A merge
 * rule whose normalized `from_value` is one of these (or empty) must
 * never drive the fuzzy substring tier — it would match essentially
 * everything and act as a catch-all. This is exactly how a Cyrillic
 * "Китс Chest" rule (which normalized to "chest") rewrote every chest
 * in clan 1 to "Runic Chest".
 */
const GENERIC_STOP_TOKENS = new Set([
  'chest', 'chests', 'squad', 'crypt', 'level', 'lvl', 'raid', 'the', 'of',
  'and', 'epic', 'rare', 'common', 'uncommon', 'legendary', 'arena',
]);

/**
 * True when a normalized value must not drive the fuzzy SUBSTRING tier:
 * empty, very short, or a generic word. Short tokens are still fine as
 * exact-match rules — they just don't get substring matching (a 3-char
 * substring matches far too much).
 */
function isDegenerateNorm(norm: string): boolean {
  return norm.length < 4 || GENERIC_STOP_TOKENS.has(norm);
}

/**
 * True when a `from_value` is unfit for a merge rule at all — its
 * normalized form is empty or a generic word, so the rule could never
 * be anything but a catch-all. Short-but-specific tokens are allowed
 * (they become exact-only rules).
 */
function isUnsafeRuleFrom(norm: string): boolean {
  return norm.length === 0 || GENERIC_STOP_TOKENS.has(norm);
}

/** Thrown when an admin tries to create a merge rule that would behave as a catch-all. */
export class InvalidMergeRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMergeRuleError';
  }
}

export type MergeRuleType = 'player' | 'chest' | 'source';

export interface MergeRule {
  id: number;
  type: MergeRuleType;
  fromValue: string;
  toValue: string;
  createdAt: string;
  /**
   * Set when the rule the admin asked for was folded into one that already exists
   * rather than added alongside it — see the redundancy check in {@link addMergeRule}.
   * The data merge still happened; this explains why the rules list didn't grow.
   */
  note?: string;
}

export interface ChestTypeOverride {
  id: number;
  chestName: string;
  chestType: string;
  createdAt: string;
}

// --- Merge Rules ---

export function addMergeRule(
  type: MergeRuleType,
  fromValue: string,
  toValue: string,
  clanId: number,
): MergeRule {
  // Refuse rules that would behave as a catch-all. After normalization
  // the `from_value` must still be a specific token — not empty, not a
  // generic word like "chest". This is the guard that would have blocked
  // the "Китс Chest" rule that corrupted clan 1.
  const normFrom = normalize(fromValue);
  if (isUnsafeRuleFrom(normFrom)) {
    throw new InvalidMergeRuleError(
      `Merge rule "From" value "${fromValue}" is too generic — after normalization it is ` +
      `"${normFrom || '(empty)'}", which would match almost every ${type}. ` +
      `Use a more specific From value.`,
    );
  }

  const db = getDb();
  const now = new Date().toISOString();

  // Is an existing rule already going to catch this `from` value?
  //
  // applyMergeRulesCached matches on `normalize(from_value)`, which strips spacing and
  // punctuation — so "JIZZI C A", "JI ZZICA" and "JIZZICA" are one rule as far as
  // matching is concerned, and writing all three does nothing but fill the table. Four
  // rows for one player is exactly what the live roster accumulated, because the UI
  // gave no sign that rules two through four were no-ops.
  //
  // Deliberately does NOT reject the request. The rule and the data merge are two
  // different jobs sharing one function: the rule stops future scans re-splitting the
  // name, the merge remaps the chest records, might snapshots and resource
  // transactions that already exist. Throwing here to refuse a duplicate RULE would
  // also refuse the MERGE, stranding real rows under a member the admin is trying to
  // fold away. So the merge always runs; only the redundant row is suppressed, and the
  // caller gets a note explaining it.
  const redundant = db.prepare(
    'SELECT id, from_value, to_value FROM merge_rules WHERE clan_id = ? AND type = ? AND from_value != ?',
  ).all(clanId, type, fromValue) as { id: number; from_value: string; to_value: string }[];
  const covering = redundant.find((r) => normalize(r.from_value) === normFrom);

  let note: string | undefined;

  // Wrap the rule insert + dedupe + update in a transaction so a UNIQUE
  // constraint failure halfway through can't leave the rule persisted
  // without the records actually being updated.
  const tx = db.transaction(() => {
    if (!covering) {
      db.prepare(`
        INSERT INTO merge_rules (clan_id, type, from_value, to_value, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(clan_id, type, from_value) DO UPDATE SET to_value = ?, created_at = ?
      `).run(clanId, type, fromValue, toValue, now, toValue, now);
    } else if (covering.to_value === toValue) {
      note = `Rule not added — "${covering.from_value}" → "${covering.to_value}" already covers `
        + `"${fromValue}". Spacing and punctuation are ignored when rules are matched.`;
    } else {
      // Same key, different destination. Adding a second row would be worse than
      // useless: applyMergeRulesCached returns the FIRST rule whose key matches, so the
      // new one would sit there looking active while the old one kept winning. Redirect
      // the existing rule instead — that is what the admin just asked for.
      db.prepare(
        'UPDATE merge_rules SET to_value = ?, created_at = ? WHERE id = ?',
      ).run(toValue, now, covering.id);
      note = `Updated the existing "${covering.from_value}" rule to point at "${toValue}" `
        + `(it was "${covering.to_value}"). Spacing and punctuation are ignored when rules `
        + `are matched, so the two are the same rule.`;
    }

    if (type === 'player') {
      // Player merge post-D4: chest_records is keyed on member_id only
      // (no more denormalized player_name). Resolve from/to member ids,
      // dedup on (session, chest, captured_at), then remap member_id.
      const fromMember = db.prepare(
        'SELECT id FROM members WHERE clan_id = ? AND name = ? COLLATE NOCASE',
      ).get(clanId, fromValue) as { id: number } | undefined;
      if (!fromMember) {
        log.debug(`Player merge: source player "${fromValue}" not in members — no rows to remap`);
      } else {
        const toMember = db.prepare(
          'SELECT id FROM members WHERE clan_id = ? AND name = ? COLLATE NOCASE',
        ).get(clanId, toValue) as { id: number } | undefined;

        if (toMember && toMember.id !== fromMember.id) {
          // Dedup: rows that would collide on UNIQUE(session_id,
          // member_id, chest_id, captured_at) once member_id flips.
          const dedupeResult = db.prepare(`
            DELETE FROM chest_records
            WHERE clan_id = ?
              AND member_id = ?
              AND EXISTS (
                SELECT 1 FROM chest_records winner
                WHERE winner.clan_id = chest_records.clan_id
                  AND winner.member_id = ?
                  AND winner.session_id = chest_records.session_id
                  AND winner.chest_id = chest_records.chest_id
                  AND winner.captured_at = chest_records.captured_at
              )
          `).run(clanId, fromMember.id, toMember.id);
          if (dedupeResult.changes > 0) {
            log.debug(`Player merge: removed ${dedupeResult.changes} duplicate chest records that would collide with the merge target`);
          }

          const result = db.prepare(
            'UPDATE chest_records SET member_id = ? WHERE clan_id = ? AND member_id = ?',
          ).run(toMember.id, clanId, fromMember.id);
          log.debug(`Player merge: remapped ${result.changes} chest records ("${fromValue}" → "${toValue}")`);

          // Triumphal records have no UNIQUE constraint — straight remap.
          // Without this, the FK on members(id) blocks the DELETE below.
          db.prepare(
            'UPDATE triumphal_chest_records SET member_id = ? WHERE clan_id = ? AND member_id = ?',
          ).run(toMember.id, clanId, fromMember.id);

          // member_snapshots — the might (`power`) and hero-level (`level`)
          // history — also FKs members(id). It is CARRIED OVER, not dropped.
          //
          // It used to be deleted, on the reasoning that "the destination
          // already has its own history". That holds for a nameless phantom
          // (see deleteOrphanedEmptyMembers, which makes the same call) but not
          // for an OCR variant of a real player: the two names' histories are
          // disjoint ACROSS days, not duplicates of each other. A player appears
          // in the member list once, so whichever spelling was read that day is
          // the only row for it. And since the might capture is what creates the
          // misread member in the first place, the source is normally holding the
          // NEWEST reading while the destination has only older ones — so the
          // delete lost today's might and left the member charting a stale value
          // until the next day's capture, plus every day only the misread
          // spelling was seen, permanently.
          //
          // Three steps, because UNIQUE(member_id, game_date) means a day both
          // spellings were read has to be folded before the remap rather than
          // remapped into a constraint failure:
          //
          //   1. Fold the source's values into the destination row on shared days.
          //      Highest wins on BOTH power and level: the two rows are the same
          //      player on the same day, so the lower reading is the misread one
          //      (OCR drops a digit far more readily than it invents one). MAX on
          //      level is also exactly what saveSnapshots does for a same-day
          //      re-capture, and levels only ever go up.
          //   2. Delete the source rows just folded in, so step 3 cannot collide.
          //   3. Remap everything left — the days the destination has no row for.
          //
          // The partial index only covers game_date != '', so pre-v57 rows with a
          // blank game day are exempt from 1 and 2 and simply remap in step 3.
          db.prepare(`
            UPDATE member_snapshots AS dest
            SET power         = MAX(dest.power, src.power),
                level         = MAX(dest.level, src.level),
                captured_at   = MAX(dest.captured_at, src.captured_at),
                row_crop_path = COALESCE(dest.row_crop_path, src.row_crop_path)
            FROM (SELECT game_date, power, level, captured_at, row_crop_path
                    FROM member_snapshots WHERE member_id = ?) AS src
            WHERE dest.member_id = ?
              AND dest.game_date != ''
              AND dest.game_date = src.game_date
          `).run(fromMember.id, toMember.id);

          db.prepare(`
            DELETE FROM member_snapshots
            WHERE member_id = ?
              AND game_date != ''
              AND EXISTS (
                SELECT 1 FROM member_snapshots dest
                WHERE dest.member_id = ?
                  AND dest.game_date = member_snapshots.game_date
              )
          `).run(fromMember.id, toMember.id);

          const snapResult = db.prepare(
            'UPDATE member_snapshots SET member_id = ? WHERE member_id = ?',
          ).run(toMember.id, fromMember.id);
          if (snapResult.changes > 0) {
            log.debug(`Player merge: carried over ${snapResult.changes} might snapshots ("${fromValue}" → "${toValue}")`);
          }

          // resource_transactions is the third table FK'ing members(id).
          // Without this remap the DELETE below fails outright with
          // "FOREIGN KEY constraint failed" for any player who has ever
          // appeared in a resource upload.
          //
          // No dedupe pass here, unlike the chest_records remap above: v39
          // deliberately rebuilt this table WITHOUT its UNIQUE key, because
          // duplicate rows are legitimate (the same amount really can be
          // sent twice in a day, and overlapping uploads are cleaned up by
          // batch deletion instead). Nothing can collide, so a dedupe would
          // only destroy real transactions.
          const txResult = db.prepare(
            'UPDATE resource_transactions SET member_id = ? WHERE clan_id = ? AND member_id = ?',
          ).run(toMember.id, clanId, fromMember.id);
          if (txResult.changes > 0) {
            log.debug(`Player merge: remapped ${txResult.changes} resource transactions ("${fromValue}" → "${toValue}")`);
          }

          db.prepare('DELETE FROM members WHERE id = ?').run(fromMember.id);
        } else {
          // Destination doesn't exist yet — just rename the source.
          //
          // despaced_name moves too, exactly as renameMember does it. Leave it behind
          // and the row still answers to the misread spelling's key, so the next scan
          // to read the name correctly matches the OLD key, walks past this row and
          // mints the duplicate the merge just removed. Whitespace runs are collapsed
          // here as well — normalized_name is compared against normalizeName's output,
          // which does collapse them.
          db.prepare(
            'UPDATE members SET name = ?, normalized_name = ?, despaced_name = ? WHERE id = ?',
          ).run(
            toValue.trim(),
            toValue.trim().toLowerCase().replace(/\s+/g, ' '),
            despace(toValue),
            fromMember.id,
          );
        }
      }

      // Record the misread spelling as an ALIAS of the destination member.
      //
      // This is what makes a player merge rule stick. The rule table itself is
      // consulted in exactly ONE place — the gift scan (scan-pipeline.ts) — while
      // FOUR other paths turn an OCR'd name into a members row: the daily might
      // capture, the roster build, the automated resource-history read and the
      // manual resource upload. Those resolve names through fuzzy.ts and
      // upsertMember, neither of which has ever looked at merge_rules, so an
      // admin's rule was silently ignored by all of them and the same duplicate
      // member was minted again on the very next capture. Observed on the live
      // roster: "Ma Chaosraven", "Ma from Chaos", "FENRØTH Øf CHAOS" and
      // "185/ taulen302" all had rules and all reappeared in the New Members
      // queue day after day. None of the four is reachable by distance —
      // measured at 3, 3, 1-but-blocked and 3 edits against a budget of 2.
      //
      // An alias is the one mechanism EVERY read path already honours:
      // exactMatchMember and fuzzyMatchMember both check `m.aliases`, and
      // upsertMember checks them before inserting. So one write here fixes all
      // four paths at once, and keeps fixing them — no seam can be added later
      // that forgets to consult the rules.
      //
      // Aliases only ever produce EXACT matches (fuzzy.ts's distance loop reads
      // `normalizedName` alone), so this can never widen what a garbled read is
      // allowed to land on. And `upsertMember` checks a member's own
      // `normalized_name` before any alias, so an alias that happens to be some
      // other member's real name loses to that member.
      //
      // Resolved by name rather than reusing `toMember`, because the rename
      // branch above leaves the destination on `fromMember`'s row.
      const destination = db.prepare(
        'SELECT id, name, aliases FROM members WHERE clan_id = ? AND name = ? COLLATE NOCASE',
      ).get(clanId, toValue) as { id: number; name: string; aliases: string } | undefined;
      if (destination) {
        const alias = fromValue.trim();
        const aliases: string[] = JSON.parse(destination.aliases || '[]');
        const known = new Set(
          [destination.name, ...aliases].map((a) => a.trim().toLowerCase()),
        );
        if (alias && !known.has(alias.toLowerCase())) {
          aliases.push(alias);
          db.prepare('UPDATE members SET aliases = ? WHERE id = ?')
            .run(JSON.stringify(aliases), destination.id);
          log.debug(`Player merge: "${alias}" recorded as an alias of "${destination.name}"`);
        }
      }
    } else if (type === 'chest') {
      // Chest merge post-D3: chest_name lives in the global `chests`
      // table. Resolve from/to ids; remap chest_records to point at the
      // destination id; clean up the source row in `chests` if no
      // records reference it anymore.
      const fromRow = db.prepare(
        'SELECT id FROM chests WHERE name = ? COLLATE NOCASE',
      ).get(fromValue) as { id: number } | undefined;
      if (!fromRow) {
        log.debug(`Chest merge: source chest "${fromValue}" not in chests table — no rows to remap`);
      } else {
        // Upsert the destination — creates the row when admin merges
        // into a not-yet-observed name (rare but possible).
        const toRow = db.prepare(`
          INSERT INTO chests (name) VALUES (?)
          ON CONFLICT(name) DO UPDATE SET name = excluded.name
          RETURNING id
        `).get(toValue) as { id: number };

        // Dedup before remap: rows that would collide on the new
        // UNIQUE(session_id, member_id, chest_id, captured_at) when
        // their chest_id flips from `fromRow.id` to `toRow.id`. Post-D4
        // we match by member_id (not the dropped player_name column).
        const dedupeResult = db.prepare(`
          DELETE FROM chest_records
          WHERE clan_id = ?
            AND chest_id = ?
            AND EXISTS (
              SELECT 1 FROM chest_records winner
              WHERE winner.clan_id = chest_records.clan_id
                AND winner.chest_id = ?
                AND winner.session_id = chest_records.session_id
                AND winner.member_id = chest_records.member_id
                AND winner.captured_at = chest_records.captured_at
            )
        `).run(clanId, fromRow.id, toRow.id);
        if (dedupeResult.changes > 0) {
          log.debug(`Chest merge: removed ${dedupeResult.changes} duplicate chest records that would collide with the merge target`);
        }

        const result = db.prepare(
          'UPDATE chest_records SET chest_id = ? WHERE clan_id = ? AND chest_id = ?',
        ).run(toRow.id, clanId, fromRow.id);
        log.debug(`Chest merge: updated ${result.changes} chest records ("${fromValue}" → "${toValue}")`);

        // Deliberately NOT remapping triumphal_chest_records: a chest
        // merge rule must never change a triumphal row's chest. Triumphal
        // chests are locked to the six canonical types; the orphan-cleanup
        // below still checks triumphal references and simply keeps the
        // `chests` row alive if a triumphal record still points at it.

        // Drop the orphan chest row if nothing in either table references it.
        const stillReferenced = db.prepare(`
          SELECT 1 WHERE EXISTS (SELECT 1 FROM chest_records WHERE chest_id = ?)
             OR EXISTS (SELECT 1 FROM triumphal_chest_records WHERE chest_id = ?)
        `).get(fromRow.id, fromRow.id);
        if (!stillReferenced && fromRow.id !== toRow.id) {
          db.prepare('DELETE FROM chests WHERE id = ?').run(fromRow.id);
        }

        // Carry the one name-keyed config table that is safe to move here.
        // cleanupChestNames carries three, but this branch is different: it is
        // clan-scoped, and it deliberately leaves triumphal records on the old
        // `chests` row (above). source_point_overrides and triumphal_chest_points
        // are GLOBAL — no clan_id — and triumphal_chest_points is joined at read
        // time on `chest_name = chests.name`, so moving a value off a name whose
        // row is still alive and still carrying triumphal records would silently
        // score every one of them 0, in every clan. chest_type_overrides is
        // per-clan and keyed the same way, so it moves with the clan's merge.
        if (fromRow.id !== toRow.id) {
          db.prepare(
            'UPDATE OR IGNORE chest_type_overrides SET chest_name = ? WHERE clan_id = ? AND chest_name = ?',
          ).run(toValue, clanId, fromValue);
          db.prepare(
            'DELETE FROM chest_type_overrides WHERE clan_id = ? AND chest_name = ?',
          ).run(clanId, fromValue);
        }
      }
    } else if (type === 'source') {
      // Same shape as chest merge but operates on chest_sources.
      const fromRow = db.prepare(
        'SELECT id FROM chest_sources WHERE source = ? COLLATE NOCASE',
      ).get(fromValue) as { id: number } | undefined;
      if (!fromRow) {
        log.debug(`Source merge: source "${fromValue}" not in chest_sources — no rows to remap`);
      } else {
        const toRow = db.prepare(`
          INSERT INTO chest_sources (source) VALUES (?)
          ON CONFLICT(source) DO UPDATE SET source = excluded.source
          RETURNING id
        `).get(toValue) as { id: number };

        const result = db.prepare(
          'UPDATE chest_records SET chest_source_id = ? WHERE clan_id = ? AND chest_source_id = ?',
        ).run(toRow.id, clanId, fromRow.id);
        log.debug(`Source merge: updated ${result.changes} chest records ("${fromValue}" → "${toValue}")`);

        // Same reason as the chest-merge case: triumphal records also
        // reference chest_sources, so without this remap the orphan
        // cleanup keeps the old source row alive.
        db.prepare(
          'UPDATE triumphal_chest_records SET chest_source_id = ? WHERE clan_id = ? AND chest_source_id = ?',
        ).run(toRow.id, clanId, fromRow.id);

        const stillReferenced = db.prepare(`
          SELECT 1 WHERE EXISTS (SELECT 1 FROM chest_records WHERE chest_source_id = ?)
             OR EXISTS (SELECT 1 FROM triumphal_chest_records WHERE chest_source_id = ?)
        `).get(fromRow.id, fromRow.id);
        if (!stillReferenced && fromRow.id !== toRow.id) {
          db.prepare('DELETE FROM chest_sources WHERE id = ?').run(fromRow.id);
        }
      }
    }
  });
  tx();

  // A merge can remap member_id / delete colliding rows / change point-bearing
  // rows, so the per-(member, day) rollup and analytics caches are now stale.
  notifyChestDataChanged(clanId);
  invalidateMergeDerivedCaches(clanId);

  return { id: 0, type, fromValue, toValue, createdAt: now, note };
}

export function getMergeRules(clanId: number, type?: MergeRuleType): MergeRule[] {
  const db = getDb();
  let query = 'SELECT * FROM merge_rules WHERE clan_id = ?';
  const params: unknown[] = [clanId];
  if (type) {
    query += ' AND type = ?';
    params.push(type);
  }
  query += ' ORDER BY created_at DESC';
  const rows = db.prepare(query).all(...params) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as number,
    type: r.type as MergeRuleType,
    fromValue: r.from_value as string,
    toValue: r.to_value as string,
    createdAt: r.created_at as string,
  }));
}

export function deleteMergeRule(id: number, clanId: number): void {
  const db = getDb();
  db.prepare('DELETE FROM merge_rules WHERE id = ? AND clan_id = ?').run(id, clanId);
}

/**
 * Normalize a string for fuzzy comparison: lowercase, strip non-alphanumeric,
 * remove common OCR artifacts (trailing periods, leading symbols, etc.)
 *
 * Cyrillic homoglyphs are transliterated to their Latin lookalikes FIRST.
 * Without this, an OCR misread like "Китс Chest" (Cyrillic К/и/т/с) had
 * all four letters deleted by the `[^a-z0-9]` strip and collapsed to the
 * bare token "chest" — turning the rule into a catch-all.
 *
 * Diacritics are FOLDED, for the same reason and after the transliteration:
 * without the fold, `[^a-z0-9]` deletes the "ö" of "Jörmungandr Shop" outright
 * (giving "jrmungandrshop") rather than turning it into an "o", so the accented
 * and unaccented readings of one source never compare equal. This was the last
 * unfolded normalizer left after v61/v62 fixed the same defect elsewhere.
 */
function normalize(s: string): string {
  return foldDiacritics(transliterateCyrillicHomoglyphs(s))
    .replace(/^[\d\W]*\]\s*/, '')
    .replace(/^["|'™|=]+\s*/, '')
    .replace(/[.'",|]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Apply all merge rules to a value using fuzzy matching.
 * Handles OCR inconsistencies like trailing periods, extra spaces,
 * leading garbage characters, etc.
 *
 * NOTE: Inside hot loops (like the scan flow), prefer loading the
 * rules once via loadMergeRules() and calling applyMergeRulesCached()
 * to avoid hitting the DB on every chest.
 */
export function applyMergeRules(
  type: MergeRuleType,
  value: string,
  clanId: number,
): string {
  const db = getDb();

  const exact = db.prepare(
    'SELECT to_value FROM merge_rules WHERE clan_id = ? AND type = ? AND from_value = ?',
  ).get(clanId, type, value) as { to_value: string } | undefined;
  if (exact) return exact.to_value;

  const rules = db.prepare(
    'SELECT from_value, to_value FROM merge_rules WHERE clan_id = ? AND type = ?',
  ).all(clanId, type) as { from_value: string; to_value: string }[];

  return applyRulesInMemory(value, rules);
}

interface CachedRule {
  fromValue: string;
  toValue: string;
  normFrom: string;
  normTo: string;
}

export interface MergeRulesCache {
  exact: Map<string, string>;
  fuzzy: CachedRule[];
}

/**
 * Load all merge rules of a type into an in-memory cache. Pass the result
 * to applyMergeRulesCached() inside hot loops to avoid per-call DB hits.
 */
export function loadMergeRules(type: MergeRuleType, clanId: number): MergeRulesCache {
  const db = getDb();
  const rules = db.prepare(
    'SELECT from_value, to_value FROM merge_rules WHERE clan_id = ? AND type = ?',
  ).all(clanId, type) as { from_value: string; to_value: string }[];

  const exact = new Map<string, string>();
  const fuzzy: CachedRule[] = [];
  for (const r of rules) {
    exact.set(r.from_value, r.to_value);
    fuzzy.push({
      fromValue: r.from_value,
      toValue: r.to_value,
      normFrom: normalize(r.from_value),
      normTo: normalize(r.to_value),
    });
  }
  return { exact, fuzzy };
}

export function applyMergeRulesCached(cache: MergeRulesCache, value: string): string {
  const exact = cache.exact.get(value);
  if (exact) return exact;

  const normInput = normalize(value);
  for (const rule of cache.fuzzy) {
    if (normInput === rule.normFrom) return rule.toValue;
    // Substring tier: only for specific `from` tokens. A degenerate
    // normFrom (empty or a generic word like "chest") is skipped here so
    // it can never act as a catch-all, even if such a rule already exists.
    if (!isDegenerateNorm(rule.normFrom) && normInput.includes(rule.normFrom)) return rule.toValue;
    if (normInput === rule.normTo) return rule.toValue;
  }
  return value;
}

/**
 * The player-name canonicaliser every path that reads a name off the screen must
 * run its readings through, before matching and before creating anything.
 *
 * A player merge rule is the admin saying "this string IS that player". For years
 * only the gift scan honoured that (scan-pipeline.ts), while the daily might
 * capture, the roster build, the automated resource-history read and the manual
 * resource upload each resolved names on their own — so a rule an admin had
 * already written was ignored by every one of them and the duplicate member it
 * existed to prevent was recreated on the next capture. `addMergeRule` now also
 * records the rule as an alias, which fixes it for rules with a live destination;
 * this covers the rest — a rule written ahead of the player existing, or one whose
 * destination has since been renamed.
 *
 * One cache per run, not per name: the rule set is small but this sits inside a
 * per-row loop.
 *
 * Returns the reading unchanged when no rule matches, so it is safe to wrap any
 * name in it unconditionally.
 */
export function loadPlayerNameCanonicaliser(clanId: number): (rawName: string) => string {
  const cache = loadMergeRules('player', clanId);
  return (rawName: string): string => applyMergeRulesCached(cache, rawName);
}

function applyRulesInMemory(
  value: string,
  rules: { from_value: string; to_value: string }[],
): string {
  const normInput = normalize(value);
  for (const rule of rules) {
    const normRule = normalize(rule.from_value);
    if (normInput === normRule) return rule.to_value;
    if (!isDegenerateNorm(normRule) && normInput.includes(normRule)) return rule.to_value;
    const normTarget = normalize(rule.to_value);
    if (normInput === normTarget) return rule.to_value;
  }
  return value;
}

/**
 * Load all chest type overrides as a Map for use inside scan loops.
 */
export function loadChestTypeOverrides(clanId: number): Map<string, string> {
  const db = getDb();
  const rows = db.prepare(
    'SELECT chest_name, chest_type FROM chest_type_overrides WHERE clan_id = ?',
  ).all(clanId) as { chest_name: string; chest_type: string }[];
  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(row.chest_name, row.chest_type);
  }
  return map;
}

// --- Chest Type Overrides ---

export function setChestTypeOverride(
  chestName: string,
  chestType: string,
  clanId: number,
): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO chest_type_overrides (clan_id, chest_name, chest_type, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(clan_id, chest_name) DO UPDATE SET chest_type = ?, created_at = ?
  `).run(clanId, chestName, chestType, now, chestType, now);

  // Post-D4 chest_type lives on chests, not chest_records. A single
  // UPDATE on the reference table flips every record's view-resolved
  // rarity in one shot — no per-row backfill needed. The override
  // table (chest_type_overrides) still keys on chest_name as the
  // admin-facing identifier.
  db.prepare('UPDATE chests SET chest_type = ? WHERE name = ?').run(chestType, chestName);
}

export function getChestTypeOverrides(clanId: number): ChestTypeOverride[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM chest_type_overrides WHERE clan_id = ? ORDER BY chest_name',
  ).all(clanId) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as number,
    chestName: r.chest_name as string,
    chestType: r.chest_type as string,
    createdAt: r.created_at as string,
  }));
}

export function getChestTypeOverride(chestName: string, clanId: number): string | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT chest_type FROM chest_type_overrides WHERE clan_id = ? AND chest_name = ?',
  ).get(clanId, chestName) as { chest_type: string } | undefined;
  return row?.chest_type ?? null;
}

export function deleteChestTypeOverride(id: number, clanId: number): void {
  const db = getDb();
  db.prepare('DELETE FROM chest_type_overrides WHERE id = ? AND clan_id = ?').run(id, clanId);
}
