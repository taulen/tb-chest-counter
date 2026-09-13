/**
 * Boot-time check that every name-keyed piece of configuration still points at
 * something real.
 *
 * The chest data itself is keyed properly — `chest_records.chest_id` is a real
 * FK, so the Jörmungandr rename lost nothing. What is keyed by NAME is the
 * configuration layer: the event catalog's literals, and the `chest_name` /
 * `source_key` columns on the scoring and override tables. A rename detaches
 * those silently, and every one of them fails the same way: a zero that looks
 * like a result. That is what took weeks to notice on the Events page.
 *
 * So the invariant this enforces is not "use ids everywhere" (the game exposes
 * no chest id — a name is the only thing that arrives from OCR, and
 * event-catalog.ts is a committed source file that cannot reference a
 * per-install autoincrement id). It is: a stranded reference must never be
 * silent. Findings go to `log.warn`, which the System page already renders from
 * the 20-entry ring buffer — no new endpoint, no new card.
 *
 * Read-only, cheap (a few hundred rows), and quiet on a healthy database. Takes
 * the connection as an argument and imports nothing that imports database.ts, so
 * it can be called from initDatabase without an import cycle.
 */

import type Database from 'better-sqlite3';
import { childLogger } from '../utils/logger.js';
import { EVENT_CATALOG } from '../config/event-catalog.js';
import { correctChestName } from '../vision/chest-names.js';
import { foldDiacritics } from '../vision/ocr-normalize.js';
import { getSourceKey, canonicalSourceKey, sourceSpellingKey } from '../vision/source-names.js';

const log = childLogger('config-integrity');

export type IntegritySeverity = 'error' | 'warning';

export interface IntegrityFinding {
  /** Stable slug, e.g. 'event-catalog/chest-name-stale'. */
  kind: string;
  severity: IntegritySeverity;
  /** The offending value. */
  subject: string;
  /** What is wrong. */
  detail: string;
  /** What to do about it. */
  fix: string;
}

function foldKey(s: string): string {
  return foldDiacritics(s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Every name-keyed reference that no longer resolves.
 *
 * Returns [] on a database with no chest records at all. A fresh install has an
 * empty `chests` table — nothing is ever seeded into it, rows appear only when a
 * chest is first scanned — so every catalog literal and every seeded triumphal
 * point value would "fail" on first boot, before anyone has done anything wrong.
 * Pre-declaring a chest the clan hasn't collected yet is a documented, supported
 * thing to do (see the header of src/config/event-catalog.ts).
 */
export function checkConfigIntegrity(database: Database.Database): IntegrityFinding[] {
  const anyRecords = (database.prepare(
    'SELECT EXISTS (SELECT 1 FROM chest_records) AS n',
  ).get() as { n: number }).n;
  if (!anyRecords) return [];

  const findings: IntegrityFinding[] = [];
  const add = (f: IntegrityFinding): void => { findings.push(f); };

  const chests = database.prepare('SELECT id, name FROM chests').all() as
    { id: number; name: string }[];
  const chestNames = new Set(chests.map((c) => c.name));
  const chestByFold = new Map<string, string>();
  for (const c of chests) {
    const k = foldKey(c.name);
    if (k && !chestByFold.has(k)) chestByFold.set(k, c.name);
  }

  const sources = database.prepare('SELECT id, source FROM chest_sources').all() as
    { id: number; source: string }[];
  const sourceTexts = sources.map((s) => foldDiacritics(s.source || '').toLowerCase());

  // ── Event catalog ────────────────────────────────────────────────────
  for (const def of EVENT_CATALOG) {
    for (const rule of def.rules) {
      const declared = [...(rule.chestName ? [rule.chestName] : []), ...(rule.chestNames || [])];
      for (const name of declared) {
        if (chestNames.has(name)) continue;
        const live = (chestNames.has(correctChestName(name)) ? correctChestName(name) : undefined)
          ?? chestByFold.get(foldKey(name));
        if (live) {
          // The Jörmungandr shape: the literal disagrees with a name the DB
          // really carries. Unambiguous, and a one-line fix.
          add({
            kind: 'event-catalog/chest-name-stale',
            severity: 'error',
            subject: `${def.key}: "${name}"`,
            detail: `The Events catalog spells this chest "${name}" but the database has it as "${live}".`,
            fix: `Change it to "${live}" in src/config/event-catalog.ts (event "${def.key}").`,
          });
        } else {
          // Could equally be a chest the clan has simply never collected, which
          // the catalog explicitly allows — so this informs, it doesn't nag.
          add({
            kind: 'event-catalog/chest-name-dead',
            severity: 'warning',
            subject: `${def.key}: "${name}"`,
            detail: `No chest in the database is named "${name}", so its column on the "${def.key}" event reads 0.`,
            fix: 'Fine if that chest has never been scanned; otherwise fix the name in src/config/event-catalog.ts.',
          });
        }
      }
      if (rule.sourceContains) {
        const needle = foldDiacritics(rule.sourceContains).toLowerCase();
        if (!sourceTexts.some((s) => s.includes(needle))) {
          // Kills the whole rule, chest half included.
          add({
            kind: 'event-catalog/source-needle-dead',
            severity: 'warning',
            subject: `${def.key}: sourceContains "${rule.sourceContains}"`,
            detail: 'No chest source contains this text, which disables the entire rule it belongs to.',
            fix: `Check the spelling against the Sources list, or drop the sourceContains from that rule.`,
          });
        }
      }
    }
  }

  // ── Source point overrides ───────────────────────────────────────────
  const liveSourceKeys = new Set<string>();
  for (const s of sources) {
    const k = getSourceKey(s.source);
    if (k) liveSourceKeys.add(canonicalSourceKey(k));
  }
  const overrides = database.prepare(
    'SELECT source_key, chest_name FROM source_point_overrides',
  ).all() as { source_key: string; chest_name: string }[];
  for (const o of overrides) {
    if (o.chest_name && !chestNames.has(o.chest_name)) {
      // Worse than a dead bucket: a chest_name nothing matches also drops out of
      // backfillPointsForComposite's exclusion set, so the wildcard override for
      // that source clobbers the rows this one was meant to protect.
      add({
        kind: 'source-points/chest-name-orphan',
        severity: 'error',
        subject: `${o.source_key} + "${o.chest_name}"`,
        detail: `This point override is keyed to a chest name no chest has, so it scores nothing and stops shielding those chests from the source-wide value.`,
        fix: 'Re-save it against the current chest name on the Source Points admin page, or delete it.',
      });
    }
    if (o.source_key && !liveSourceKeys.has(canonicalSourceKey(o.source_key))) {
      add({
        kind: 'source-points/source-key-dead',
        severity: 'warning',
        subject: o.source_key,
        detail: 'No chest source derives this key any more, so the override applies to nothing and shows as a 0-chest bucket.',
        fix: 'Delete it on the Source Points admin page, unless it was pre-set for a source not yet scanned.',
      });
    }
  }

  // ── Triumphal points (a live scoring join: tp.chest_name = chests.name) ──
  const anyTriumphal = (database.prepare(
    'SELECT EXISTS (SELECT 1 FROM triumphal_chest_records) AS n',
  ).get() as { n: number }).n;
  if (anyTriumphal) {
    const tp = database.prepare('SELECT chest_name FROM triumphal_chest_points').all() as
      { chest_name: string }[];
    for (const t of tp) {
      if (chestNames.has(t.chest_name)) continue;
      add({
        kind: 'triumphal-points/orphan',
        severity: 'warning',
        subject: t.chest_name,
        detail: 'This package value is joined to triumphal records by name, and no chest carries that name — anything matching it would score 0.',
        fix: 'Fine for a seeded value the clan has never received; otherwise fix it on the Triumphal Chest Points card.',
      });
    }
  }

  // ── Per-clan rarity overrides ────────────────────────────────────────
  const typeOverrides = database.prepare(
    'SELECT clan_id, chest_name FROM chest_type_overrides',
  ).all() as { clan_id: number; chest_name: string }[];
  for (const t of typeOverrides) {
    if (chestNames.has(t.chest_name)) continue;
    add({
      kind: 'chest-types/orphan',
      severity: 'warning',
      subject: `clan ${t.clan_id}: ${t.chest_name}`,
      detail: 'Rarity override for a chest name that no longer exists.',
      fix: 'Re-apply it to the current chest name, or delete it.',
    });
  }

  // ── Merge rules ──────────────────────────────────────────────────────
  const rules = database.prepare(
    "SELECT clan_id, type, from_value, to_value FROM merge_rules WHERE type IN ('chest','source')",
  ).all() as { clan_id: number; type: string; from_value: string; to_value: string }[];
  for (const r of rules) {
    const live = r.type === 'chest'
      ? chestNames.has(r.to_value)
      : sources.some((s) => s.source === r.to_value);
    if (live) continue;
    add({
      kind: 'merge-rules/dead-target',
      severity: 'warning',
      subject: `clan ${r.clan_id}: "${r.from_value}" → "${r.to_value}"`,
      detail: `This ${r.type} merge rule rewrites onto a name nothing currently uses, so it would mint a fresh row rather than merge into an existing one.`,
      fix: 'Check the destination spelling on the Merge Rules admin page, or delete the rule.',
    });
  }

  // ── Player merge rules that have come undone ─────────────────────────
  //
  // The sweep above deliberately skipped type='player' — and that omission is
  // what let the bug this checks for run unseen for days. A player rule's
  // from_value should not exist as a member: the merge folded that row away when
  // the rule was written. If it is back, something re-created it, and the rule is
  // not going to stop it happening again on its own.
  //
  // That is a warning rather than an error because the reappearance is not itself
  // data loss — the rows are split between two members, both recoverable — and
  // because the whole point is that a duplicate is created by a capture, not by a
  // misconfiguration, so it can legitimately be true for a few minutes before an
  // admin acts on it.
  const playerRules = database.prepare(
    "SELECT clan_id, from_value, to_value FROM merge_rules WHERE type = 'player'",
  ).all() as { clan_id: number; from_value: string; to_value: string }[];
  const memberName = database.prepare(
    'SELECT id FROM members WHERE clan_id = ? AND name = ? COLLATE NOCASE',
  );
  for (const r of playerRules) {
    if (memberName.get(r.clan_id, r.from_value)) {
      add({
        kind: 'merge-rules/player-resplit',
        severity: 'warning',
        subject: `clan ${r.clan_id}: "${r.from_value}" → "${r.to_value}"`,
        detail: 'A merged-away spelling is back on the roster as its own member, so this '
          + "player's chests, might history and resources are splitting across two rows again.",
        fix: 'Re-submit the rule on the Merge Rules admin page (or merge the entry from the '
          + 'New Members queue) — that re-runs the data merge and deletes the duplicate row. '
          + 'It should not come back a third time: every capture path now resolves readings '
          + 'through the rules before creating anything.',
      });
      continue;
    }
    if (!memberName.get(r.clan_id, r.to_value)) {
      add({
        kind: 'merge-rules/dead-target',
        severity: 'warning',
        subject: `clan ${r.clan_id}: "${r.from_value}" → "${r.to_value}"`,
        detail: 'This player merge rule rewrites onto a name that is not on the roster, so it '
          + 'would create that member rather than merge into an existing one.',
        fix: 'Check the destination spelling on the Merge Rules admin page, or delete the rule.',
      });
    }
  }

  // ── Duplicate spellings (the tripwire for the whole bug class) ───────
  const bySpelling = new Map<string, string[]>();
  for (const s of sources) {
    const k = sourceSpellingKey(s.source);
    if (!k) continue;
    const g = bySpelling.get(k);
    if (g) g.push(s.source); else bySpelling.set(k, [s.source]);
  }
  for (const [, variants] of bySpelling) {
    if (variants.length < 2) continue;
    add({
      kind: 'chest-sources/duplicate-spelling',
      severity: 'warning',
      subject: variants.join('" / "'),
      detail: 'One real source is stored under several spellings, so it splits across two rows in analytics and drill-downs.',
      fix: 'Merge them on the Merge Rules admin page. Migration v63 cleared the historical ones, so a new pair means one got past getOrCreateChestSourceId.',
    });
  }

  // getOrCreateChestId has no canonical reuse scan (its chest_sources sibling
  // does), so every OCR variant of a chest outside KNOWN_CHESTS mints its own
  // row. Nothing has gone wrong yet; this is the guard that says when it does.
  const byChestFold = new Map<string, string[]>();
  for (const c of chests) {
    const k = foldKey(c.name);
    if (!k) continue;
    const g = byChestFold.get(k);
    if (g) g.push(c.name); else byChestFold.set(k, [c.name]);
  }
  for (const [, variants] of byChestFold) {
    if (variants.length < 2) continue;
    add({
      kind: 'chests/duplicate-spelling',
      severity: 'warning',
      subject: variants.join('" / "'),
      detail: 'One chest is stored under several spellings, splitting its records across two ids.',
      fix: 'Merge them on the Merge Rules admin page, or add the canonical spelling to KNOWN_CHESTS so the boot-time rename pass folds them.',
    });
  }

  return findings;
}

/**
 * Run the check and report it through the log buffer the System page shows.
 *
 * Errors light the System nav dot — each is unambiguously wrong and fixable in
 * one edit. Warnings are `noAlert`: real, worth reading, but several of them are
 * legitimately quiet forever (a chest the clan has never collected), and a dot
 * that can't be cleared is a dot people stop looking at.
 */
export function reportConfigIntegrity(database: Database.Database): IntegrityFinding[] {
  let findings: IntegrityFinding[] = [];
  try {
    findings = checkConfigIntegrity(database);
  } catch (err) {
    // Never let a diagnostic stop the app booting.
    log.warn({ noAlert: true }, `Config integrity check failed to run: ${(err as Error).message}`);
    return [];
  }

  const errors = findings.filter((f) => f.severity === 'error');
  const warnings = findings.filter((f) => f.severity === 'warning');

  const MAX_LOGGED = 10;
  for (const f of errors.slice(0, MAX_LOGGED)) {
    log.warn(`Config problem [${f.kind}] ${f.subject}: ${f.detail} ${f.fix}`);
  }
  if (errors.length > MAX_LOGGED) {
    log.warn(`…and ${errors.length - MAX_LOGGED} more configuration problem(s).`);
  }
  if (warnings.length > 0) {
    // One line, not one per finding — a burst evicts the whole ring buffer.
    const kinds = [...new Set(warnings.map((w) => w.kind))].join(', ');
    log.warn(
      { noAlert: true },
      `${warnings.length} configuration reference(s) point at something that no longer exists (${kinds}).`,
    );
  }

  return findings;
}
