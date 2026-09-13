/**
 * Events breakdown — aggregates chest_records by in-game event for the
 * Events page. The event → chest mapping lives in the catalog
 * (src/config/event-catalog.ts); this module turns a catalog entry + a
 * clan + a time window into a per-player matrix, an event summary, and
 * (for vault-style events) a level distribution.
 *
 * The hot aggregations run directly on chest_records (not chest_records_v)
 * so they use the (clan_id, chest_id, captured_at) /
 * (clan_id, chest_source_id, captured_at) indexes; the small dimension
 * tables (chests, chest_sources) are consulted once up front to resolve
 * the catalog's match rules into concrete id sets.
 */

import { getDb } from '../database.js';
import { childLogger } from '../../utils/logger.js';
import {
  getEventDef,
  type EventDefinition,
  type EventLevelBucket,
} from '../../config/event-catalog.js';
import { parseSourceLevel, parseSourceLevelRange } from '../../vision/source-names.js';
import { correctChestName } from '../../vision/chest-names.js';
import { foldDiacritics } from '../../vision/ocr-normalize.js';

const log = childLogger('event-repo');

/**
 * Catalog literals that don't line up with the data. Surfaced on the page and
 * logged, because the alternative — what this code used to do — is a column of
 * zeros indistinguishable from a week nobody played. See the Jörmungandr fix.
 */
export interface EventConfigError {
  /** The literal as written in src/config/event-catalog.ts. */
  declared: string;
  /** The live `chests.name` we folded onto, or null when nothing matched. */
  resolvedTo: string | null;
  /** Which half of the rule was wrong. */
  kind: 'chest' | 'source';
}

// One warn per (event, declared name) per process. Deliberately NOT log-throttle:
// that coalesces bursts within a rolling window, and this is a permanent config
// defect — it should say its piece once and never evict the 20-entry ring buffer
// again however many times the page is loaded.
const warnedConfig = new Set<string>();

function warnOnce(eventKey: string, message: string): void {
  const k = `${eventKey}::${message}`;
  if (warnedConfig.has(k)) return;
  warnedConfig.add(k);
  log.warn(message);
}

/** Accent-, case- and punctuation-insensitive identity of a chest name. */
function foldKey(s: string): string {
  return foldDiacritics(s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

// captured_at is INTEGER ms post-v30; convert at the boundary (same shape
// as chest-repo.ts / triumphal-chest-repo.ts).
function isoToMs(iso: string): number {
  return Date.parse(iso);
}
function aggMsToIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return new Date(n).toISOString();
}

export interface EventColumn {
  key: string;
  label: string;
  /** Whether this column feeds the per-player Total (and Avg/Participant). */
  countInTotal: boolean;
  /**
   * Rendered as a top-of-page info card instead of a matrix column (a
   * rarely-awarded chest like Dark Omens' leader "Finish Reward"). Never
   * counts toward Total/Points. Absent/false for normal columns.
   */
  infoCard?: boolean;
  /**
   * For a column that aggregates several chests into one (a chestNames rule),
   * the component chest names in catalog order — so the UI can show the split
   * (e.g. Minor/Major/Epic) as a hover tooltip. Absent for single-chest columns.
   */
  parts?: string[];
  /**
   * The rule behind this column resolved to nothing, so its zeros are a config
   * error rather than a result. The UI marks the header instead of letting it
   * read as "nobody earned this".
   */
  unresolved?: boolean;
  /** Which half of the rule died — the chest names, or the source needle. */
  unresolvedReason?: 'chest' | 'source';
}
export interface EventPlayerRow {
  memberId: number | null;
  memberName: string;
  counts: Record<string, number>;
  /**
   * Per-chest split for aggregated columns only: columnKey → chestName → count.
   * Powers the hover tooltip on a combined cell. Empty for players with no
   * chests in any aggregated column.
   */
  breakdown: Record<string, Record<string, number>>;
  /** Chests across all matched columns (for the event's grand total). */
  totalChests: number;
  /** Points across all matched columns (for the event's grand total). */
  totalPoints: number;
  /** Chests from columns flagged countInTotal — the table's Total column. */
  countableChests: number;
  /** Points from columns flagged countInTotal — the table's Points column. */
  countablePoints: number;
  lastSeen: string | null;
}
export interface EventLevelRow {
  level: number | null;
  label: string;
  participants: number;
  chests: number;
  points: number;
}
export interface EventBreakdown {
  key: string;
  name: string;
  description: string;
  columnMode: 'chest' | 'level';
  showLevelCard: boolean;
  /** Label for the "vaults taken down" lead card, or null. */
  levelSummaryLabel: string | null;
  /** Row-header label for the "By level" card (defaults to "Vault"). */
  levelCardLabel: string;
  columns: EventColumn[];
  players: EventPlayerRow[];
  totalChests: number;
  totalPoints: number;
  uniqueParticipants: number;
  firstSeen: string | null;
  lastSeen: string | null;
  levelCard: EventLevelRow[];
  /**
   * Catalog literals that disagree with the data. Empty on a healthy config.
   * Carried on the breakdown rather than only on the columns because level-mode
   * events derive their columns FROM the data — when their sole rule dies there
   * is no column left to mark and the whole tab would otherwise read as a quiet
   * week.
   */
  configErrors: EventConfigError[];
}

export interface EventMemberDetailRow {
  chestName: string;
  chestType: string;
  source: string;
  chests: number;
  points: number;
  lastSeen: string | null;
}

const LEVEL_UNKNOWN_KEY = 'unknown';

// ── Bucketed level mode (see `levelBuckets` in the catalog) ────────────────
// Column keys are namespaced so a bucket ("bucket::16-19"), a loose level
// outside every bucket ("bucket::lvl-50") and the no-level column
// ("bucket::unknown") can never collide — including the degenerate case of a
// one-level bucket, whose key is "bucket::45" and so still differs from a
// loose level 45.

const BUCKET_UNKNOWN_COLUMN = `bucket::${LEVEL_UNKNOWN_KEY}`;

/** "16-19" for a range, "45" for a bucket that is a single level. */
function bucketSpan(b: EventLevelBucket): string {
  return b.to === b.from ? `${b.from}` : `${b.from}-${b.to}`;
}
function bucketColumnKey(b: EventLevelBucket): string {
  return `bucket::${bucketSpan(b)}`;
}
function bucketColumnLabel(b: EventLevelBucket): string {
  return `Lvl ${bucketSpan(b)}`;
}
/** A level no declared bucket contains — its own column rather than dropped. */
function looseLevelColumnKey(level: number): string {
  return `bucket::lvl-${level}`;
}

function findBucket(buckets: EventLevelBucket[], level: number): EventLevelBucket | null {
  return buckets.find((b) => level >= b.from && level <= b.to) ?? null;
}

function columnKeyForRule(rule: EventDefinition['rules'][number], index: number): string {
  return rule.label || rule.chestName || rule.chestNames?.[0] || `col-${index}`;
}

function columnLabelForRule(rule: EventDefinition['rules'][number], index: number): string {
  return rule.label || rule.chestName || rule.chestNames?.[0] || `col-${index}`;
}

interface ResolvedPredicate {
  /** False when no rule resolved at all — the caller returns a zeroed result. */
  hasMatches: boolean;
  /** SQL fragment (already `c.`-aliased) OR-ing all resolvable rules. */
  sql: string;
  params: unknown[];
  /** Catalog literals that were stale or dead (empty on a healthy config). */
  configErrors: EventConfigError[];
  /** Column key → which half of its rule resolved to nothing. */
  deadColumns: Map<string, 'chest' | 'source'>;
  /** chest_id → matrix column key (chest mode). */
  chestIdToColumn: Map<number, string>;
  /** chest_id → chest name (for the aggregated-column tooltip split). */
  chestIdToName: Map<number, string>;
  /**
   * chest_id → chest name for EVERY chest, not just the rule-resolved ones.
   * Bucketed level mode needs it because a source-only rule resolves no chest
   * ids at all, yet its tooltip still names the monster behind each level.
   */
  chestIdToNameAll: Map<number, string>;
  /**
   * Column key → component chest names in catalog order, only for columns that
   * aggregate more than one chest (a chestNames rule). Feeds EventColumn.parts.
   */
  columnParts: Map<string, string[]>;
  /** chest_source_id → parsed level (for level mode + level card). */
  sourceIdToLevel: Map<number, number | null>;
  /** chest_source_id → raw source string (for full-name level labels). */
  sourceIdToText: Map<number, string>;
}

/**
 * Resolve the catalog rules to concrete id sets and build the WHERE predicate.
 *
 * The name→id lookup here is the single boundary between a hand-written literal
 * in event-catalog.ts and the data, and it used to be a byte-exact
 * `WHERE name IN (…)`. That is what made the Jörmungandr rename silent: the
 * plain-o literal matched nothing, the rule was dropped with a bare `return`,
 * and the column was emitted anyway as a permanent 0.
 *
 * Now it resolves in three tiers — exact, then through `correctChestName` (which
 * already knows the canonical spelling, so a rename self-heals the moment it
 * ships), then on an accent/case/punctuation-folded key — and records anything
 * that didn't land on tier 1 as a config error, so a stale literal still gets
 * the right number AND says it needs fixing. `hasMatches` is false when nothing
 * resolved at all; the errors are still populated so the caller can report why.
 */
function resolvePredicate(def: EventDefinition): ResolvedPredicate {
  const db = getDb();

  const allChests = db.prepare('SELECT id, name FROM chests').all() as Array<{
    id: number;
    name: string;
  }>;
  const byExact = new Map<string, { id: number; name: string }>();
  const byFold = new Map<string, { id: number; name: string }>();
  const chestIdToNameAll = new Map<number, string>();
  for (const c of allChests) {
    byExact.set(c.name, c);
    chestIdToNameAll.set(c.id, c.name);
    const k = foldKey(c.name);
    if (!k) continue;
    // Two rows folding to the same key shouldn't happen (config-integrity flags
    // it if it ever does); prefer the canonical spelling, matching how migration
    // v61 picks a survivor, so the tie-break can't disagree with the DB.
    const held = byFold.get(k);
    if (!held || (correctChestName(c.name) === c.name && correctChestName(held.name) !== held.name)) {
      byFold.set(k, c);
    }
  }

  const configErrors: EventConfigError[] = [];
  const deadColumns = new Map<string, 'chest' | 'source'>();

  /** Exact → corrected → folded. Records a config error for anything past tier 1. */
  const resolveName = (declared: string): { id: number; name: string } | null => {
    const exact = byExact.get(declared);
    if (exact) return exact;

    const corrected = correctChestName(declared);
    const hit = (corrected !== declared ? byExact.get(corrected) : undefined) ?? byFold.get(foldKey(declared));
    configErrors.push({ declared, resolvedTo: hit ? hit.name : null, kind: 'chest' });
    if (hit) {
      warnOnce(
        def.key,
        `Events catalog: "${declared}" is a stale spelling of "${hit.name}" — its chests are still `
        + `counted, but fix the literal in src/config/event-catalog.ts (event "${def.key}").`,
      );
    } else {
      warnOnce(
        def.key,
        `Events catalog: "${declared}" matches no chest — its column on the "${def.key}" event `
        + 'will read 0. Fix the literal in src/config/event-catalog.ts, or ignore if the chest '
        + 'has genuinely never been scanned.',
      );
    }
    return hit ?? null;
  };

  const allSources = db.prepare('SELECT id, source FROM chest_sources').all() as Array<{
    id: number;
    source: string;
  }>;
  const sourceIdToLevel = new Map<number, number | null>();
  const sourceIdToText = new Map<number, string>();
  for (const s of allSources) {
    sourceIdToLevel.set(s.id, parseSourceLevel(s.source));
    sourceIdToText.set(s.id, s.source);
  }
  // Fold BOTH sides. Lowercasing alone was the source-side twin of the chest bug:
  // an unaccented needle could never match "Jörmungandr Shop", and migration v63
  // makes the accented spelling the surviving one for every duplicated source.
  const sourcesMatching = (contains: string): number[] => {
    const needle = foldDiacritics(contains).toLowerCase();
    return allSources
      .filter((s) => foldDiacritics(s.source || '').toLowerCase().includes(needle))
      .map((s) => s.id);
  };

  const chestIdToColumn = new Map<number, string>();
  const chestIdToName = new Map<number, string>();
  const columnParts = new Map<string, string[]>();
  const orParts: string[] = [];
  const params: unknown[] = [];

  def.rules.forEach((rule, index) => {
    const conds: string[] = [];
    const p: unknown[] = [];
    const colKey = columnKeyForRule(rule, index);
    // A rule can name one chest (chestName) and/or several (chestNames); all
    // resolved ids feed the same column.
    const ruleNames = [...(rule.chestName ? [rule.chestName] : []), ...(rule.chestNames || [])];
    const resolved = ruleNames
      .map((n) => resolveName(n))
      .filter((r): r is { id: number; name: string } => r !== null);
    const chestIds = resolved.map((r) => r.id);
    if (ruleNames.length > 0 && chestIds.length === 0) {
      deadColumns.set(colKey, 'chest'); // all names dead → dead rule
      return;
    }
    if (chestIds.length > 0) {
      conds.push(`c.chest_id IN (${chestIds.map(() => '?').join(',')})`);
      p.push(...chestIds);
    }
    if (rule.sourceContains) {
      const ids = sourcesMatching(rule.sourceContains);
      if (ids.length === 0) {
        // Kills the whole rule including its chest half, so mark it too — this
        // is the second silent-zero exit, not just the chest-name one.
        deadColumns.set(colKey, 'source');
        configErrors.push({ declared: rule.sourceContains, resolvedTo: null, kind: 'source' });
        warnOnce(
          def.key,
          `Events catalog: sourceContains "${rule.sourceContains}" matches no chest source — the `
          + `"${colKey}" column on the "${def.key}" event will read 0.`,
        );
        return;
      }
      conds.push(`c.chest_source_id IN (${ids.map(() => '?').join(',')})`);
      p.push(...ids);
    }
    if (conds.length === 0) return;
    for (const id of chestIds) {
      if (!chestIdToColumn.has(id)) chestIdToColumn.set(id, colKey);
    }
    // Resolved component names in catalog order — only meaningful (and only
    // recorded) when this column aggregates more than one chest. Uses the LIVE
    // chest name, not the declared literal, so a stale spelling can't leak into
    // the tooltip.
    if (resolved.length > 1) columnParts.set(colKey, resolved.map((r) => r.name));
    for (const r of resolved) chestIdToName.set(r.id, r.name);
    orParts.push(conds.length > 1 ? `(${conds.join(' AND ')})` : conds[0]);
    params.push(...p);
  });

  return {
    hasMatches: orParts.length > 0,
    sql: orParts.length > 0 ? `(${orParts.join(' OR ')})` : '',
    params,
    configErrors,
    deadColumns,
    chestIdToColumn,
    chestIdToName,
    chestIdToNameAll,
    columnParts,
    sourceIdToLevel,
    sourceIdToText,
  };
}

function levelColumnLabel(level: number | null): string {
  return level === null ? 'Unknown' : `Lvl ${level}`;
}

function zeroedBreakdown(def: EventDefinition, resolved?: ResolvedPredicate): EventBreakdown {
  let columns: EventColumn[] = [];
  if (def.columnMode === 'chest') {
    columns = def.rules.map((r, i) => {
      const key = columnKeyForRule(r, i);
      const dead = resolved?.deadColumns.get(key);
      return {
        key,
        label: columnLabelForRule(r, i),
        countInTotal: r.countInTotal !== false,
        ...(dead ? { unresolved: true, unresolvedReason: dead } : {}),
      };
    });
  } else if (def.levelBuckets?.length) {
    // Bucketed level mode declares its columns, so unlike plain level mode
    // (which derives them from data it doesn't have here) there IS something
    // to mark. A dead rule takes every bucket down with it — there is only one
    // rule feeding them — so the reason from any dead column applies to all.
    const dead = [...(resolved?.deadColumns.values() ?? [])][0];
    columns = def.levelBuckets.map((b) => ({
      key: bucketColumnKey(b),
      label: bucketColumnLabel(b),
      countInTotal: true,
      ...(dead ? { unresolved: true, unresolvedReason: dead } : {}),
    }));
  }
  return {
    key: def.key,
    name: def.name,
    description: def.description,
    columnMode: def.columnMode,
    showLevelCard: def.showLevelCard,
    levelSummaryLabel: def.levelSummaryLabel ?? null,
    levelCardLabel: def.levelCardLabel ?? 'Vault',
    columns,
    players: [],
    totalChests: 0,
    totalPoints: 0,
    uniqueParticipants: 0,
    firstSeen: null,
    lastSeen: null,
    levelCard: [],
    configErrors: resolved?.configErrors ?? [],
  };
}

/**
 * Build the full event breakdown for one event / clan / window.
 * `from`/`to` are ISO timestamps ([from, to], inclusive); omit for all-time.
 * Returns null only for an unknown event key.
 */
export function getEventBreakdown(
  eventKey: string,
  clanId: number,
  from?: string,
  to?: string,
): EventBreakdown | null {
  const def = getEventDef(eventKey);
  if (!def) return null;

  const resolved = resolvePredicate(def);
  if (!resolved.hasMatches) return zeroedBreakdown(def, resolved);

  const db = getDb();
  const {
    sql: predicate,
    params: predicateParams,
    chestIdToColumn,
    chestIdToName,
    chestIdToNameAll,
    columnParts,
    sourceIdToLevel,
    sourceIdToText,
  } = resolved;

  const where: string[] = ['c.clan_id = ?', predicate];
  const whereParams: unknown[] = [clanId, ...predicateParams];
  // Window on effective_at (accurate in-game earn time, falling back to scan
  // time for rows without it) so a chest earned before an event's reset but
  // claimed by a later scan still lands in the right occurrence. captured_at
  // stays the dedup/scan clock. See migration v49 / src/utils/gift-time.ts.
  if (from) {
    where.push('c.effective_at >= ?');
    whereParams.push(isoToMs(from));
  }
  if (to) {
    where.push('c.effective_at < ?');
    whereParams.push(isoToMs(to));
  }
  const whereSql = `WHERE ${where.join(' AND ')}`;

  // ── Per-player matrix ────────────────────────────────────────────────
  // Level mode splits each column by citadel type AND level, so it groups by
  // both chest_id (type) and chest_source_id (level); chest mode groups by
  // chest_id alone.
  const isLevelMode = def.columnMode === 'level';
  const selectCols = isLevelMode
    ? 'c.chest_id AS chestId, c.chest_source_id AS sourceId'
    : 'c.chest_id AS chestId';
  const groupCols = isLevelMode ? 'c.chest_id, c.chest_source_id' : 'c.chest_id';
  const matrixRows = db
    .prepare(
      `SELECT c.member_id AS memberId, m.name AS memberName, ${selectCols},
              COUNT(*) AS chests, SUM(c.point_value) AS points, MAX(c.effective_at) AS lastSeen
       FROM chest_records c
       JOIN members m ON m.id = c.member_id AND m.clan_id = c.clan_id
       ${whereSql}
       GROUP BY c.member_id, m.name, ${groupCols}`,
    )
    .all(...whereParams) as Array<{
    memberId: number | null;
    memberName: string;
    chestId: number | null;
    sourceId?: number | null;
    chests: number;
    points: number;
    lastSeen: number | null;
  }>;

  // Which columns feed the countable Total / Points (chest mode only; every
  // level column counts). Built once so the loop can split grand vs countable.
  const countableColKeys = new Set<string>();
  if (def.columnMode === 'chest') {
    def.rules.forEach((r, i) => {
      if (r.countInTotal !== false && !r.infoCard) countableColKeys.add(columnKeyForRule(r, i));
    });
  }
  // Catalog order of each column key (chest-mode key = rule label), so level
  // columns can be ordered by citadel type then level.
  const ruleOrder = new Map<string, number>();
  def.rules.forEach((r, i) => ruleOrder.set(columnKeyForRule(r, i), i));

  const playerMap = new Map<number | string, EventPlayerRow>();
  // Level-mode column metadata (key → citadel type + level) for ordering/labels.
  // rangeCounts tracks how many chests came from each level-range spelling
  // (e.g. "20-24") so the column header can show the full tier range, picking
  // the dominant one the same way the level card picks the dominant source.
  const levelColMeta = new Map<
    string,
    { key: string; type: string; level: number | null; rangeCounts: Map<string, number> }
  >();
  // Bucketed level mode (Heroics). `buckets` non-null switches the loop from
  // one column per (type × level) to one per declared range.
  const buckets = isLevelMode && def.levelBuckets?.length ? def.levelBuckets : null;
  // Column key → the levels folded into it, and (for a loose out-of-bucket
  // column) its sort position. Levels drive both the column's `parts` and the
  // per-player tooltip split.
  const bucketColLevels = new Map<string, Set<number>>();
  const looseLevelCols = new Map<string, number>();
  // A matched chest whose source carries no level at all. Only gets a column
  // when it actually happens — unlike the buckets, there is nothing to declare.
  let hasUnbucketedLevel = false;
  // level → chest name → chests, so each level's tooltip part can name the
  // monster behind it ("Lvl 16 (Undead)"). Dominant name wins, the same
  // tie-break the level card uses for its dominant source string.
  const levelNameCounts = new Map<number, Map<string, number>>();
  for (const row of matrixRows) {
    let colKey: string | undefined;
    // Set for a bucketed row, so the per-level split can be recorded below
    // once the player row exists. null = this row's source carries no level.
    let bucketLevel: number | null = null;
    if (!isLevelMode) {
      colKey = row.chestId != null ? chestIdToColumn.get(row.chestId) : undefined;
    } else if (buckets) {
      // No chestIdToColumn lookup: the column is decided by the level alone,
      // which is what lets a source-only rule (Heroics) work here at all.
      const level = row.sourceId != null ? sourceIdToLevel.get(row.sourceId) ?? null : null;
      bucketLevel = level;
      if (level === null) {
        colKey = BUCKET_UNKNOWN_COLUMN;
        hasUnbucketedLevel = true;
      } else {
        const bucket = findBucket(buckets, level);
        if (bucket) {
          colKey = bucketColumnKey(bucket);
        } else {
          // Outside every declared range — the game extended past the tier list.
          // Give it a column of its own; dropping it would read as nobody playing.
          colKey = looseLevelColumnKey(level);
          looseLevelCols.set(colKey, level);
        }
        let levels = bucketColLevels.get(colKey);
        if (!levels) {
          levels = new Set();
          bucketColLevels.set(colKey, levels);
        }
        levels.add(level);
        const name = row.chestId != null ? chestIdToNameAll.get(row.chestId) : undefined;
        if (name) {
          let names = levelNameCounts.get(level);
          if (!names) {
            names = new Map();
            levelNameCounts.set(level, names);
          }
          names.set(name, (names.get(name) || 0) + row.chests);
        }
      }
    } else {
      const type = row.chestId != null ? chestIdToColumn.get(row.chestId) : undefined;
      if (!type) continue;
      const level = row.sourceId != null ? sourceIdToLevel.get(row.sourceId) ?? null : null;
      colKey = `${type}::${level === null ? LEVEL_UNKNOWN_KEY : level}`;
      let meta = levelColMeta.get(colKey);
      if (!meta) {
        meta = { key: colKey, type, level, rangeCounts: new Map() };
        levelColMeta.set(colKey, meta);
      }
      if (level !== null) {
        const text = row.sourceId != null ? sourceIdToText.get(row.sourceId) || '' : '';
        const range = parseSourceLevelRange(text);
        if (range) meta.rangeCounts.set(range, (meta.rangeCounts.get(range) || 0) + row.chests);
      }
    }
    if (!colKey) continue;

    const pk = row.memberId ?? `name:${row.memberName}`;
    let player = playerMap.get(pk);
    if (!player) {
      player = {
        memberId: row.memberId,
        memberName: row.memberName,
        counts: {},
        breakdown: {},
        totalChests: 0,
        totalPoints: 0,
        countableChests: 0,
        countablePoints: 0,
        lastSeen: null,
      };
      playerMap.set(pk, player);
    }
    player.counts[colKey] = (player.counts[colKey] || 0) + row.chests;
    // For aggregated columns, keep the per-chest split for the hover tooltip.
    if (!isLevelMode && columnParts.has(colKey) && row.chestId != null) {
      const name = chestIdToName.get(row.chestId);
      if (name) {
        const split = (player.breakdown[colKey] ||= {});
        split[name] = (split[name] || 0) + row.chests;
      }
    }
    // Bucketed columns split by LEVEL instead. Keyed by the bare level number
    // for now and relabelled in one pass below, because the part label carries
    // the dominant chest name — which isn't known until every row has been read.
    // The Unknown column has no levels to split, so it gets no tooltip.
    if (buckets && bucketLevel !== null) {
      const split = (player.breakdown[colKey] ||= {});
      const lk = String(bucketLevel);
      split[lk] = (split[lk] || 0) + row.chests;
    }
    player.totalChests += row.chests;
    player.totalPoints += row.points;
    const countable = def.columnMode === 'level' || countableColKeys.has(colKey);
    if (countable) {
      player.countableChests += row.chests;
      player.countablePoints += row.points;
    }
    const iso = aggMsToIso(row.lastSeen);
    if (iso && (!player.lastSeen || iso > player.lastSeen)) player.lastSeen = iso;
  }

  // Bucketed tooltip labels: "Lvl 16 (Undead)" — the level, plus the monster
  // that drops at it, named by whichever chest dominates that level. Built once
  // here so the column's `parts` and every player's breakdown key agree
  // exactly; the frontend joins them by string equality.
  const levelPartLabel = new Map<number, string>();
  if (buckets) {
    for (const [level, names] of levelNameCounts) {
      let best = '';
      let max = -1;
      for (const [name, count] of names) {
        if (count > max) {
          max = count;
          best = name;
        }
      }
      // "Undead Chest" → "Undead": the word adds nothing when every part of the
      // tooltip is a chest, and five of these have to fit on one line.
      const short = best.replace(/\s*Chest$/i, '').trim();
      levelPartLabel.set(level, short ? `Lvl ${level} (${short})` : `Lvl ${level}`);
    }
    for (const player of playerMap.values()) {
      for (const [colKey, split] of Object.entries(player.breakdown)) {
        const relabelled: Record<string, number> = {};
        for (const [levelKey, count] of Object.entries(split)) {
          const level = Number(levelKey);
          const label = levelPartLabel.get(level) ?? `Lvl ${levelKey}`;
          relabelled[label] = (relabelled[label] || 0) + count;
        }
        player.breakdown[colKey] = relabelled;
      }
    }
  }

  const players = [...playerMap.values()];
  let totalChests = 0;
  let totalPoints = 0;
  for (const p of players) {
    totalChests += p.totalChests;
    totalPoints += p.totalPoints;
  }

  // ── Columns ──────────────────────────────────────────────────────────
  let columns: EventColumn[];
  if (def.columnMode === 'chest') {
    // Stable: one column per rule, in catalog order (even if zero this window).
    columns = def.rules.map((r, i) => {
      const key = columnKeyForRule(r, i);
      const parts = columnParts.get(key);
      const dead = resolved.deadColumns.get(key);
      return {
        key,
        label: columnLabelForRule(r, i),
        countInTotal: r.countInTotal !== false && !r.infoCard,
        ...(r.infoCard ? { infoCard: true } : {}),
        ...(parts ? { parts } : {}),
        ...(dead ? { unresolved: true, unresolvedReason: dead } : {}),
      };
    });
  } else if (buckets) {
    // Fixed: every declared bucket, present in the data or not, so the header
    // doesn't reshuffle between timeframes — then any level that fell outside
    // them, then the no-level column. Ordered by level throughout, so a loose
    // level lands where it belongs rather than being exiled to the end.
    const partsFor = (key: string): string[] | undefined => {
      const levels = bucketColLevels.get(key);
      if (!levels || !levels.size) return undefined;
      return [...levels]
        .sort((a, b) => a - b)
        .map((l) => levelPartLabel.get(l) ?? `Lvl ${l}`);
    };
    const ordered: Array<{ sortLevel: number; col: EventColumn }> = [];
    const push = (sortLevel: number, key: string, label: string): void => {
      const parts = partsFor(key);
      ordered.push({
        sortLevel,
        col: { key, label, countInTotal: true, ...(parts ? { parts } : {}) },
      });
    };
    for (const b of buckets) push(b.from, bucketColumnKey(b), bucketColumnLabel(b));
    for (const [key, level] of looseLevelCols) push(level, key, levelColumnLabel(level));
    // MAX_SAFE_INTEGER rather than Infinity: only one Unknown column can exist
    // today, but Infinity - Infinity is NaN, and a comparator that can return
    // NaN is a trap to leave lying around for whoever adds the second one.
    if (hasUnbucketedLevel) push(Number.MAX_SAFE_INTEGER, BUCKET_UNKNOWN_COLUMN, 'Unknown');
    columns = ordered.sort((a, b) => a.sortLevel - b.sortLevel).map((o) => o.col);
  } else {
    // Dynamic: one column per (citadel type × level) actually present,
    // ordered by catalog type order then level ascending (Unknown last).
    // With a single level rule the type prefix is redundant (every column is
    // the same chest), so columns read just "Lvl 20-24"; multi-type events
    // (Citadels: Elven/Cursed) keep the prefix to stay distinguishable.
    const omitTypePrefix = def.rules.length === 1;
    columns = [...levelColMeta.values()]
      .sort((a, b) => {
        const ta = ruleOrder.get(a.type) ?? 99;
        const tb = ruleOrder.get(b.type) ?? 99;
        if (ta !== tb) return ta - tb;
        const la = a.level === null ? Infinity : a.level;
        const lb = b.level === null ? Infinity : b.level;
        return la - lb;
      })
      .map((m) => {
        // Prefer the full tier range ("20-24") over the bare start level,
        // taking the most common spelling seen across this column's chests.
        let rangeLabel = m.level === null ? null : String(m.level);
        let max = -1;
        for (const [range, cnt] of m.rangeCounts) {
          if (cnt > max) {
            max = cnt;
            rangeLabel = range;
          }
        }
        let label: string;
        if (m.level === null) {
          label = omitTypePrefix ? 'Unknown' : `${m.type} · Unknown`;
        } else {
          label = omitTypePrefix ? `Lvl ${rangeLabel}` : `${m.type} Lvl ${rangeLabel}`;
        }
        return { key: m.key, label, countInTotal: true };
      });
  }

  // ── Level distribution card (vault-style events only) ────────────────
  const levelCard: EventLevelRow[] = [];
  if (def.showLevelCard) {
    const cardRows = db
      .prepare(
        `SELECT c.member_id AS memberId, c.chest_source_id AS sourceId,
                COUNT(*) AS chests, SUM(c.point_value) AS points
         FROM chest_records c
         ${whereSql}
         GROUP BY c.member_id, c.chest_source_id`,
      )
      .all(...whereParams) as Array<{
      memberId: number | null;
      sourceId: number | null;
      chests: number;
      points: number;
    }>;

    const byLevel = new Map<
      number,
      { chests: number; points: number; members: Set<number>; sourceCounts: Map<string, number> }
    >();
    for (const row of cardRows) {
      const level = row.sourceId != null ? sourceIdToLevel.get(row.sourceId) ?? null : null;
      if (level === null) continue; // reward chests without a level aren't part of the level card
      let bucket = byLevel.get(level);
      if (!bucket) {
        bucket = { chests: 0, points: 0, members: new Set(), sourceCounts: new Map() };
        byLevel.set(level, bucket);
      }
      bucket.chests += row.chests;
      bucket.points += row.points;
      if (row.memberId != null) bucket.members.add(row.memberId);
      // Track which raw source string dominates this level, so the card
      // can show the full name (e.g. "Lvl 20-24 Vault of the Ancients")
      // rather than a terse "Lvl 20", merging OCR variants under the top one.
      const text = row.sourceId != null ? sourceIdToText.get(row.sourceId) || '' : '';
      if (text) bucket.sourceCounts.set(text, (bucket.sourceCounts.get(text) || 0) + row.chests);
    }
    for (const [level, b] of [...byLevel.entries()].sort((a, b) => a[0] - b[0])) {
      let label = levelColumnLabel(level);
      let max = -1;
      for (const [text, cnt] of b.sourceCounts) {
        if (cnt > max) {
          max = cnt;
          label = text;
        }
      }
      levelCard.push({
        level,
        label,
        participants: b.members.size,
        chests: b.chests,
        points: b.points,
      });
    }
  }

  // ── First / last seen across the whole event ─────────────────────────
  const seen = db
    .prepare(
      `SELECT MIN(c.effective_at) AS firstSeen, MAX(c.effective_at) AS lastSeen
       FROM chest_records c ${whereSql}`,
    )
    .get(...whereParams) as { firstSeen: number | null; lastSeen: number | null };

  log.debug(
    `Event breakdown: event=${def.key} clan=${clanId} from=${from || 'none'} to=${to || 'none'} players=${players.length}`,
  );

  return {
    key: def.key,
    name: def.name,
    description: def.description,
    columnMode: def.columnMode,
    showLevelCard: def.showLevelCard,
    levelSummaryLabel: def.levelSummaryLabel ?? null,
    levelCardLabel: def.levelCardLabel ?? 'Vault',
    columns,
    players,
    totalChests,
    totalPoints,
    uniqueParticipants: players.length,
    firstSeen: aggMsToIso(seen?.firstSeen),
    lastSeen: aggMsToIso(seen?.lastSeen),
    levelCard,
    configErrors: resolved.configErrors,
  };
}

/**
 * ISO timestamp of the OLDEST chest this event has for a clan (by effective_at,
 * the same clock the windows filter on), or null when it has none.
 *
 * Used by the rolling-cycle occurrence list (src/external/event-calendar.ts):
 * a cycle schedule is infinite in both directions, so the "older" arrow needs a
 * floor — the cycle holding this timestamp is the oldest one worth offering.
 */
export function getEventDataStart(eventKey: string, clanId: number): string | null {
  const def = getEventDef(eventKey);
  if (!def) return null;
  const resolved = resolvePredicate(def);
  if (!resolved.hasMatches) return null;
  const row = getDb()
    .prepare(
      `SELECT MIN(c.effective_at) AS firstSeen FROM chest_records c
       WHERE c.clan_id = ? AND ${resolved.sql}`,
    )
    .get(clanId, ...resolved.params) as { firstSeen: number | null } | undefined;
  return aggMsToIso(row?.firstSeen);
}

/**
 * For one member within an event + window, the breakdown of exactly which
 * chests they collected — grouped by chest name + source (so vault/citadel
 * levels and shop vs. reward sources are distinguished). Powers the
 * expandable participant row on the Events page. Returns [] for an unknown
 * event or when the event's rules resolve to nothing.
 */
export function getEventMemberDetail(
  eventKey: string,
  clanId: number,
  memberId: number,
  from?: string,
  to?: string,
): EventMemberDetailRow[] {
  const def = getEventDef(eventKey);
  if (!def) return [];
  const resolved = resolvePredicate(def);
  if (!resolved.hasMatches) return [];

  const db = getDb();
  const where = ['c.clan_id = ?', 'c.member_id = ?', resolved.sql];
  const params: unknown[] = [clanId, memberId, ...resolved.params];
  if (from) {
    where.push('c.effective_at >= ?');
    params.push(isoToMs(from));
  }
  if (to) {
    where.push('c.effective_at < ?');
    params.push(isoToMs(to));
  }

  const rows = db
    .prepare(
      `SELECT ch.name AS chestName, ch.chest_type AS chestType,
              COALESCE(cs.source, '') AS source,
              COUNT(*) AS chests, SUM(c.point_value) AS points, MAX(c.effective_at) AS lastSeen
       FROM chest_records c
       JOIN chests ch ON ch.id = c.chest_id
       LEFT JOIN chest_sources cs ON cs.id = c.chest_source_id
       WHERE ${where.join(' AND ')}
       GROUP BY c.chest_id, c.chest_source_id
       ORDER BY points DESC, chests DESC`,
    )
    .all(...params) as Array<{
    chestName: string;
    chestType: string;
    source: string;
    chests: number;
    points: number;
    lastSeen: number | null;
  }>;

  return rows.map((r) => ({
    chestName: r.chestName,
    chestType: r.chestType,
    source: r.source,
    chests: r.chests,
    points: r.points,
    lastSeen: aggMsToIso(r.lastSeen),
  }));
}
