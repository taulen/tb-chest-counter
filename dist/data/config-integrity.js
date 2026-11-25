"use strict";
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
 * So the invariant this enforces is not "use ids everywhere" (the game's gift
 * type is a chest AND a source, and rows from the OCR era arrived as read
 * strings — a chest name is the only identity both share — and event-catalog.ts
 * is a committed source file that cannot reference a per-install
 * autoincrement id). It is: a stranded reference must never be
 * silent. Findings go to `log.warn`, which the System page already renders from
 * the 20-entry ring buffer — no new endpoint, no new card.
 *
 * Read-only, cheap (a few hundred rows), and quiet on a healthy database. Takes
 * the connection as an argument and imports nothing that imports database.ts, so
 * it can be called from initDatabase without an import cycle.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkConfigIntegrity = checkConfigIntegrity;
exports.reportConfigIntegrity = reportConfigIntegrity;
const logger_js_1 = require("../utils/logger.js");
const event_catalog_js_1 = require("../config/event-catalog.js");
const source_names_js_1 = require("./source-names.js");
const log = (0, logger_js_1.childLogger)('config-integrity');
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
function checkConfigIntegrity(database) {
    const anyRecords = database.prepare('SELECT EXISTS (SELECT 1 FROM chest_records) AS n').get().n;
    if (!anyRecords)
        return [];
    const findings = [];
    const add = (f) => { findings.push(f); };
    const chests = database.prepare('SELECT id, name FROM chests ORDER BY id').all();
    const chestNames = new Set(chests.map((c) => c.name));
    const sources = database.prepare('SELECT id, source FROM chest_sources').all();
    const sourceTexts = sources.map((s) => (s.source || '').toLowerCase());
    // ── Event catalog ────────────────────────────────────────────────────
    for (const def of event_catalog_js_1.EVENT_CATALOG) {
        for (const rule of def.rules) {
            const declared = [...(rule.chestName ? [rule.chestName] : []), ...(rule.chestNames || [])];
            for (const name of declared) {
                if (chestNames.has(name))
                    continue;
                // Could equally be a chest the clan has simply never collected, which
                // the catalog explicitly allows — so this informs, it doesn't nag.
                add({
                    kind: 'event-catalog/chest-name-dead',
                    severity: 'warning',
                    subject: `${def.key}: "${name}"`,
                    detail: `No chest in the database is named "${name}", so its column on the "${def.key}" event reads 0.`,
                    fix: 'Fine if that chest has never been scanned; otherwise use the game\'s exact name in src/config/event-catalog.ts.',
                });
            }
            if (rule.sourceContains) {
                const needle = rule.sourceContains.toLowerCase();
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
    const liveSourceKeys = new Set();
    for (const s of sources) {
        const k = (0, source_names_js_1.getSourceKey)(s.source);
        if (k)
            liveSourceKeys.add((0, source_names_js_1.canonicalSourceKey)(k));
    }
    // Per clan since v86; most clans hold the same rows, so report each once.
    const overrides = database.prepare('SELECT DISTINCT source_key, chest_name FROM source_point_overrides').all();
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
        if (o.source_key && !liveSourceKeys.has((0, source_names_js_1.canonicalSourceKey)(o.source_key))) {
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
    const anyTriumphal = database.prepare('SELECT EXISTS (SELECT 1 FROM triumphal_chest_records) AS n').get().n;
    if (anyTriumphal) {
        const tp = database.prepare('SELECT chest_name FROM triumphal_chest_points').all();
        for (const t of tp) {
            if (chestNames.has(t.chest_name))
                continue;
            add({
                kind: 'triumphal-points/orphan',
                severity: 'warning',
                subject: t.chest_name,
                detail: 'This package value is joined to triumphal records by name, and no chest carries that name — anything matching it would score 0.',
                fix: 'Fine for a seeded value the clan has never received; otherwise fix it on the Triumphal Chest Points card.',
            });
        }
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
function reportConfigIntegrity(database) {
    let findings = [];
    try {
        findings = checkConfigIntegrity(database);
    }
    catch (err) {
        // Never let a diagnostic stop the app booting.
        log.warn({ noAlert: true }, `Config integrity check failed to run: ${err.message}`);
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
        log.warn({ noAlert: true }, `${warnings.length} configuration reference(s) point at something that no longer exists (${kinds}).`);
    }
    return findings;
}
//# sourceMappingURL=config-integrity.js.map