"use strict";
/**
 * Restore ONE clan out of a backup file and into the live database.
 *
 * The existing restore path (`/api/import/backup-db`, `/api/admin/backups/restore`)
 * swaps the whole file: every clan goes back to the state the backup was taken in.
 * That is useless for the case this module exists for — a clan was deleted weeks
 * ago and the surviving clans have been scanning ever since, so rolling the file
 * back would trade one loss for a bigger one.
 *
 * So this is additive: it reads the clan's rows out of the backup and inserts them
 * alongside whatever is already live, touching no other clan's data.
 *
 * ── How the id remapping works ────────────────────────────────────────────────
 *
 * Every id in the backup is meaningless in the live database — `members.id` 4200
 * over there is somebody else's member over here. Two mechanisms cover it:
 *
 *  1. **Offsets** for the clan's OWN tables. For each table whose id is referenced
 *     by another table we take `MAX(id)` live and add it to every source id, so
 *     `new = old + offset` is a complete mapping with no lookup table. Referencing
 *     columns get the same arithmetic. Tables nothing points at simply drop their
 *     id and let AUTOINCREMENT assign.
 *
 *  2. **Name maps** for the GLOBAL reference tables — `chests`, `chest_sources`,
 *     `resource_types`, `chest_definition_ref`. These are shared across clans, so
 *     the restore must land on the row the live database already has rather than
 *     mint a second one. Only the rows this clan actually referenced are
 *     considered; a restore should not import chest names the install never saw.
 *     Chest names go through `correctChestName` on the way in, so a historical
 *     spelling lands on the canonical row instead of being re-created as a
 *     duplicate that `cleanupChestNames` would have to merge on the next boot.
 *
 * Foreign keys stay ON throughout and the whole thing is one transaction: a
 * mapping mistake aborts the restore rather than writing half a clan.
 *
 * ── What is deliberately NOT restored ─────────────────────────────────────────
 *
 *  - `users`. Accounts are not clan data, and re-inserting password hashes and
 *    roles from a file is a security-relevant act that deserves its own
 *    deliberate feature rather than riding along inside a data restore. The
 *    inspect step reports how many were attached so the operator knows to
 *    recreate them. Rows that pointed at a user (`uploaded_by`, `created_by`,
 *    `revoked_by`) are matched by USERNAME against the live table and left NULL
 *    when there is no match — all three columns are nullable.
 *  - `audit_log`. History, with a nullable clan_id that the delete already
 *    cleared; interleaving two logs' ids is not worth the mess.
 *  - Global config (`source_point_overrides`, `triumphal_chest_points`,
 *    `ct_config`). Shared and current — the live values win.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.inspectBackupClans = inspectBackupClans;
exports.restoreClanFromBackup = restoreClanFromBackup;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const zlib_1 = __importDefault(require("zlib"));
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const database_js_1 = require("./database.js");
const chest_names_js_1 = require("../vision/chest-names.js");
const logger_js_1 = require("../utils/logger.js");
const log = (0, logger_js_1.childLogger)('clan-restore');
/** Schema name the backup is attached under. */
const SRC = 'restore_src';
/**
 * Decompress (or copy) a backup into a scratch file we own, so the restore can
 * ATTACH it without SQLite creating -wal/-shm siblings next to the operator's
 * backup. Caller must call the returned cleanup.
 */
function materializeBackup(sourcePath) {
    // Beside the live database, not `./data` — db-backup.ts derives its directory
    // the same way, and in the container those are the same mounted volume. A
    // cwd-relative path only agrees with DB_PATH by coincidence.
    const liveDb = path_1.default.resolve(process.env.DB_PATH || './data/tb-chests.db');
    const tempDir = path_1.default.join(path_1.default.dirname(liveDb), 'backups', 'uploads');
    fs_1.default.mkdirSync(tempDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dbPath = path_1.default.join(tempDir, `clan-restore-${stamp}.db`);
    const head = Buffer.alloc(2);
    const fd = fs_1.default.openSync(sourcePath, 'r');
    try {
        fs_1.default.readSync(fd, head, 0, 2, 0);
    }
    finally {
        fs_1.default.closeSync(fd);
    }
    if (head[0] === 0x1f && head[1] === 0x8b) {
        fs_1.default.writeFileSync(dbPath, zlib_1.default.gunzipSync(fs_1.default.readFileSync(sourcePath)));
    }
    else {
        fs_1.default.copyFileSync(sourcePath, dbPath);
    }
    const header = Buffer.alloc(16);
    const fd2 = fs_1.default.openSync(dbPath, 'r');
    try {
        fs_1.default.readSync(fd2, header, 0, 16, 0);
    }
    finally {
        fs_1.default.closeSync(fd2);
    }
    if (!header.toString('utf8').startsWith('SQLite format 3')) {
        fs_1.default.unlinkSync(dbPath);
        throw new Error('File does not appear to be a valid SQLite backup');
    }
    const cleanup = () => {
        for (const suffix of ['', '-wal', '-shm']) {
            try {
                if (fs_1.default.existsSync(dbPath + suffix))
                    fs_1.default.unlinkSync(dbPath + suffix);
            }
            catch {
                // Best effort — a leftover scratch file is harmless.
            }
        }
    };
    return { dbPath, cleanup };
}
/** COUNT(*) that answers 0 rather than throwing when the table predates the backup. */
function safeCount(db, sql, ...params) {
    try {
        const row = db.prepare(sql).get(...params);
        return row?.c ?? 0;
    }
    catch {
        return 0;
    }
}
/**
 * List every clan inside a backup file, with the row counts the operator needs
 * to pick the right one. Read-only: opens a scratch copy and throws it away.
 */
function inspectBackupClans(sourcePath) {
    const { dbPath, cleanup } = materializeBackup(sourcePath);
    let src = null;
    try {
        src = new better_sqlite3_1.default(dbPath, { fileMustExist: true });
        const live = (0, database_js_1.getDb)();
        const schemaVersion = src.prepare('SELECT MAX(version) AS v FROM schema_version').get()?.v ?? null;
        const liveClans = live.prepare('SELECT id, name, slug FROM clans').all();
        const liveIds = new Set(liveClans.map((c) => c.id));
        const liveNames = new Set(liveClans.map((c) => c.name.toLowerCase()));
        const liveSlugs = new Set(liveClans.map((c) => c.slug.toLowerCase()));
        const rows = src.prepare('SELECT id, name, slug, created_at FROM clans ORDER BY id').all();
        const clans = rows.map((c) => {
            const newest = (() => {
                try {
                    const r = src.prepare('SELECT MAX(captured_at) AS m FROM chest_records WHERE clan_id = ?').get(c.id);
                    return r?.m ? new Date(r.m).toISOString() : null;
                }
                catch {
                    return null;
                }
            })();
            return {
                clanId: c.id,
                name: c.name,
                slug: c.slug,
                createdAt: c.created_at,
                counts: {
                    members: safeCount(src, 'SELECT COUNT(*) AS c FROM members WHERE clan_id = ?', c.id),
                    chestRecords: safeCount(src, 'SELECT COUNT(*) AS c FROM chest_records WHERE clan_id = ?', c.id),
                    triumphalRecords: safeCount(src, 'SELECT COUNT(*) AS c FROM triumphal_chest_records WHERE clan_id = ?', c.id),
                    scanSessions: safeCount(src, 'SELECT COUNT(*) AS c FROM scan_sessions WHERE clan_id = ?', c.id),
                    memberSnapshots: safeCount(src, 'SELECT COUNT(*) AS c FROM member_snapshots WHERE member_id IN (SELECT id FROM members WHERE clan_id = ?)', c.id),
                    resourceTransactions: safeCount(src, 'SELECT COUNT(*) AS c FROM resource_transactions WHERE clan_id = ?', c.id),
                    users: safeCount(src, 'SELECT COUNT(*) AS c FROM users WHERE clan_id = ?', c.id),
                },
                newestChestAt: newest,
                idTakenLive: liveIds.has(c.id),
                nameTakenLive: liveNames.has(c.name.toLowerCase()) || liveSlugs.has(c.slug.toLowerCase()),
            };
        });
        return { schemaVersion, clans };
    }
    finally {
        if (src)
            src.close();
        cleanup();
    }
}
/** Columns present in BOTH schemas, so an older backup restores what it has. */
function copyableColumns(db, table, drop) {
    const main = db.prepare(`PRAGMA main.table_info(${table})`).all()
        .map((c) => c.name);
    const srcCols = new Set(db.prepare(`PRAGMA ${SRC}.table_info(${table})`).all().map((c) => c.name));
    return main.filter((c) => srcCols.has(c) && !drop.includes(c));
}
function copyTable(db, spec) {
    const cols = copyableColumns(db, spec.table, spec.drop ?? []);
    if (cols.length === 0)
        return 0;
    const selects = cols.map((c) => spec.map?.[c] ?? `s.${c}`);
    const sql = `INSERT ${spec.orIgnore ? 'OR IGNORE ' : ''}INTO main.${spec.table} (${cols.join(', ')}) `
        + `SELECT ${selects.join(', ')} FROM ${SRC}.${spec.table} s WHERE ${spec.where}`;
    return db.prepare(sql).run().changes;
}
function maxId(db, table) {
    const row = db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM main.${table}`).get();
    return row.m;
}
/**
 * Build `temp.map_<kind>(old, new)` for one global reference table: insert
 * whatever the live database is missing, then pair every source id with the
 * live id that now represents it.
 *
 * `keyExpr` is the SQL that identifies "the same row" on both sides.
 */
function buildRefMap(db, kind, table, keyExpr, usedIdsSql) {
    db.prepare(`CREATE TEMP TABLE map_${kind} (old INTEGER PRIMARY KEY, new INTEGER NOT NULL)`).run();
    db.prepare(`INSERT INTO temp.map_${kind} (old, new)
     SELECT s.id, m.id
       FROM ${SRC}.${table} s
       JOIN main.${table} m ON ${keyExpr}
      WHERE s.id IN (${usedIdsSql})`).run();
}
/**
 * Restore `sourceClanId` out of `sourcePath` into the live database.
 *
 * Refuses when a live clan already holds the backup's name or slug — that is
 * either the same clan (restoring would double every row) or a genuine name
 * clash, and neither is something to resolve silently.
 */
function restoreClanFromBackup(sourcePath, sourceClanId, options = {}) {
    const { dbPath, cleanup } = materializeBackup(sourcePath);
    const db = (0, database_js_1.getDb)();
    try {
        db.prepare(`ATTACH DATABASE ? AS ${SRC}`).run(dbPath);
    }
    catch (err) {
        cleanup();
        throw err;
    }
    try {
        const srcClan = db.prepare(`SELECT * FROM ${SRC}.clans WHERE id = ?`).get(sourceClanId);
        if (!srcClan) {
            throw new Error(`Backup holds no clan with id ${sourceClanId}`);
        }
        const name = String(srcClan.name);
        const slug = String(srcClan.slug);
        const clash = db.prepare('SELECT id, name FROM main.clans WHERE LOWER(name) = LOWER(?) OR LOWER(slug) = LOWER(?)').get(name, slug);
        if (clash) {
            throw new Error(`Clan "${clash.name}" (id ${clash.id}) is already live under that name. `
                + 'Rename or delete it first — restoring on top of it would duplicate every row.');
        }
        // Land on the original id when it is still free, so member-facing things
        // that were written down (share links, bookmarked URLs) keep working.
        const idFree = !db.prepare('SELECT 1 AS ok FROM main.clans WHERE id = ?').get(sourceClanId);
        if (!idFree && options.requireSameId) {
            throw new Error(`Clan id ${sourceClanId} is taken by a live clan.`);
        }
        const targetId = idFree ? sourceClanId : maxId(db, 'clans') + 1;
        const offMember = maxId(db, 'members');
        const offSession = maxId(db, 'scan_sessions');
        const offBatch = maxId(db, 'resource_upload_batches');
        const offSnapshot = maxId(db, 'snapshot');
        const offPlayerRef = maxId(db, 'ct_player_ref');
        const offShareLink = maxId(db, 'share_links');
        const tables = {};
        const record = (table, n) => {
            if (n > 0)
                tables[table] = (tables[table] ?? 0) + n;
        };
        // Temp tables are connection-scoped, not transaction-scoped, so drop any
        // left over from an earlier attempt before rebuilding them.
        for (const kind of ['chest', 'source', 'restype', 'chestdef', 'user']) {
            db.prepare(`DROP TABLE IF EXISTS temp.map_${kind}`).run();
        }
        const tx = db.transaction(() => {
            // ── 1. The clan row itself ────────────────────────────────────────────
            const clanCols = copyableColumns(db, 'clans', []);
            db.prepare(`INSERT INTO main.clans (${clanCols.join(', ')}) `
                + `SELECT ${clanCols.map((c) => (c === 'id' ? '?' : c === 'created_by' ? 'NULL' : `s.${c}`)).join(', ')} `
                + `FROM ${SRC}.clans s WHERE s.id = ?`).run(targetId, sourceClanId);
            record('clans', 1);
            // ── 2. Global reference tables, by name ───────────────────────────────
            // Only the rows this clan referenced, canonicalised on the way in.
            const usedChestIds = db.prepare(`SELECT DISTINCT chest_id AS id FROM ${SRC}.chest_records WHERE clan_id = @c
         UNION SELECT DISTINCT chest_id FROM ${SRC}.triumphal_chest_records WHERE clan_id = @c`).all({ c: sourceClanId });
            if (usedChestIds.length > 0) {
                const idList = usedChestIds.map((r) => r.id).join(',');
                const srcChests = db.prepare(`SELECT id, name FROM ${SRC}.chests WHERE id IN (${idList})`).all();
                const insertChest = db.prepare('INSERT OR IGNORE INTO main.chests (name, chest_type) VALUES (?, ?)');
                let added = 0;
                for (const c of srcChests) {
                    const canonical = (0, chest_names_js_1.correctChestName)(c.name);
                    added += insertChest.run(canonical, (0, chest_names_js_1.getChestRarity)(canonical)).changes;
                }
                record('chests', added);
                // The map pairs the SOURCE id with the live row for the CANONICAL
                // spelling, so a record captured under an old name lands on the right
                // chest instead of resurrecting the variant.
                db.prepare('CREATE TEMP TABLE map_chest (old INTEGER PRIMARY KEY, new INTEGER NOT NULL)').run();
                const insertMap = db.prepare('INSERT INTO temp.map_chest (old, new) VALUES (?, ?)');
                const liveChestId = db.prepare('SELECT id FROM main.chests WHERE name = ?');
                for (const c of srcChests) {
                    const live = liveChestId.get((0, chest_names_js_1.correctChestName)(c.name));
                    if (!live)
                        throw new Error(`Could not map chest "${c.name}" into the live chests table`);
                    insertMap.run(c.id, live.id);
                }
            }
            else {
                db.prepare('CREATE TEMP TABLE map_chest (old INTEGER PRIMARY KEY, new INTEGER NOT NULL)').run();
            }
            record('chest_sources', db.prepare(`INSERT OR IGNORE INTO main.chest_sources (source)
         SELECT s.source FROM ${SRC}.chest_sources s
          WHERE s.id IN (
            SELECT chest_source_id FROM ${SRC}.chest_records WHERE clan_id = @c AND chest_source_id IS NOT NULL
            UNION SELECT chest_source_id FROM ${SRC}.triumphal_chest_records WHERE clan_id = @c AND chest_source_id IS NOT NULL
          )`).run({ c: sourceClanId }).changes);
            buildRefMap(db, 'source', 'chest_sources', 'm.source = s.source', `SELECT chest_source_id FROM ${SRC}.chest_records WHERE clan_id = ${sourceClanId} AND chest_source_id IS NOT NULL
         UNION SELECT chest_source_id FROM ${SRC}.triumphal_chest_records WHERE clan_id = ${sourceClanId} AND chest_source_id IS NOT NULL`);
            const usedResourceTypes = `SELECT resource_type_id FROM ${SRC}.resource_transactions WHERE clan_id = ${sourceClanId} AND resource_type_id IS NOT NULL
         UNION SELECT resource_type_id FROM ${SRC}.resource_icon_templates WHERE clan_id = ${sourceClanId}`;
            record('resource_types', db.prepare(`INSERT OR IGNORE INTO main.resource_types (name, slug)
         SELECT s.name, s.slug FROM ${SRC}.resource_types s WHERE s.id IN (${usedResourceTypes})`).run().changes);
            buildRefMap(db, 'restype', 'resource_types', 'm.slug = s.slug', usedResourceTypes);
            const usedChestDefs = `SELECT chest_definition_ref_id FROM ${SRC}.snapshot_chest_definition
          WHERE snapshot_id IN (SELECT id FROM ${SRC}.snapshot WHERE clan_id = ${sourceClanId})`;
            record('chest_definition_ref', db.prepare(`INSERT INTO main.chest_definition_ref (type, name, source, points, override_points)
         SELECT s.type, s.name, s.source, s.points, s.override_points
           FROM ${SRC}.chest_definition_ref s
          WHERE s.id IN (${usedChestDefs})
            AND NOT EXISTS (
              SELECT 1 FROM main.chest_definition_ref m
               WHERE m.type = s.type AND m.name = s.name AND m.source = s.source
            )`).run().changes);
            buildRefMap(db, 'chestdef', 'chest_definition_ref', 'm.type = s.type AND m.name = s.name AND m.source = s.source', usedChestDefs);
            // Users are not restored; rows that pointed at one are matched by
            // username against whoever is live now, and left NULL otherwise.
            db.prepare('CREATE TEMP TABLE map_user (old INTEGER PRIMARY KEY, new INTEGER NOT NULL)').run();
            db.prepare(`INSERT INTO temp.map_user (old, new)
         SELECT s.id, m.id FROM ${SRC}.users s JOIN main.users m ON m.username = s.username`).run();
            const userExpr = (col) => `(SELECT new FROM temp.map_user WHERE old = s.${col})`;
            // ── 3. The clan's own tables, deepest-first ───────────────────────────
            record('members', copyTable(db, {
                table: 'members',
                where: `s.clan_id = ${sourceClanId}`,
                map: { id: `s.id + ${offMember}`, clan_id: String(targetId) },
            }));
            record('scan_sessions', copyTable(db, {
                table: 'scan_sessions',
                where: `s.clan_id = ${sourceClanId}`,
                map: { id: `s.id + ${offSession}`, clan_id: String(targetId) },
            }));
            // OR IGNORE for one reason only: `chest_records` has
            // UNIQUE(session_id, member_id, chest_id, captured_at), and two historical
            // spellings can canonicalise onto the same live chest. A row that collides
            // is the same physical chest read twice, so dropping it is the correct
            // outcome — `cleanupChestNames` resolves the identical merge the same way.
            // It never masks a foreign-key problem: SQLite's conflict clauses do not
            // apply to FK violations, which still abort the whole restore.
            for (const table of ['chest_records', 'triumphal_chest_records']) {
                record(table, copyTable(db, {
                    table,
                    where: `s.clan_id = ${sourceClanId}`,
                    drop: ['id'],
                    orIgnore: true,
                    map: {
                        clan_id: String(targetId),
                        session_id: `s.session_id + ${offSession}`,
                        member_id: `s.member_id + ${offMember}`,
                        chest_id: '(SELECT new FROM temp.map_chest WHERE old = s.chest_id)',
                        chest_source_id: '(SELECT new FROM temp.map_source WHERE old = s.chest_source_id)',
                    },
                }));
            }
            record('member_snapshots', copyTable(db, {
                table: 'member_snapshots',
                where: `s.member_id IN (SELECT id FROM ${SRC}.members WHERE clan_id = ${sourceClanId})`,
                drop: ['id'],
                map: { member_id: `s.member_id + ${offMember}`, clan_id: String(targetId) },
            }));
            record('chest_daily_summary', copyTable(db, {
                table: 'chest_daily_summary',
                where: `s.clan_id = ${sourceClanId}`,
                map: { clan_id: String(targetId), member_id: `s.member_id + ${offMember}` },
            }));
            record('discord_member_links', copyTable(db, {
                table: 'discord_member_links',
                where: `s.clan_id = ${sourceClanId}`,
                map: { clan_id: String(targetId), member_id: `s.member_id + ${offMember}` },
                orIgnore: true,
            }));
            for (const table of ['merge_rules', 'chest_type_overrides']) {
                record(table, copyTable(db, {
                    table,
                    where: `s.clan_id = ${sourceClanId}`,
                    drop: ['id'],
                    map: { clan_id: String(targetId) },
                    orIgnore: true,
                }));
            }
            record('review_acknowledgments', copyTable(db, {
                table: 'review_acknowledgments',
                where: `s.clan_id = ${sourceClanId}`,
                map: { clan_id: String(targetId) },
                orIgnore: true,
            }));
            // ── 4. Resources ──────────────────────────────────────────────────────
            record('resource_upload_batches', copyTable(db, {
                table: 'resource_upload_batches',
                where: `s.clan_id = ${sourceClanId}`,
                map: {
                    id: `s.id + ${offBatch}`,
                    clan_id: String(targetId),
                    uploaded_by: userExpr('uploaded_by'),
                },
            }));
            record('resource_transactions', copyTable(db, {
                table: 'resource_transactions',
                where: `s.clan_id = ${sourceClanId}`,
                drop: ['id'],
                map: {
                    clan_id: String(targetId),
                    batch_id: `s.batch_id + ${offBatch}`,
                    member_id: `s.member_id + ${offMember}`,
                    resource_type_id: '(SELECT new FROM temp.map_restype WHERE old = s.resource_type_id)',
                },
            }));
            record('resource_icon_templates', copyTable(db, {
                table: 'resource_icon_templates',
                where: `s.clan_id = ${sourceClanId}`,
                drop: ['id'],
                map: {
                    clan_id: String(targetId),
                    resource_type_id: '(SELECT new FROM temp.map_restype WHERE old = s.resource_type_id)',
                },
                orIgnore: true,
            }));
            record('resource_capture_cursor', copyTable(db, {
                table: 'resource_capture_cursor',
                where: `s.clan_id = ${sourceClanId}`,
                map: { clan_id: String(targetId) },
                orIgnore: true,
            }));
            // ── 5. Share links ────────────────────────────────────────────────────
            record('share_links', copyTable(db, {
                table: 'share_links',
                where: `s.clan_id = ${sourceClanId}`,
                map: {
                    id: `s.id + ${offShareLink}`,
                    clan_id: String(targetId),
                    created_by: userExpr('created_by'),
                    revoked_by: userExpr('revoked_by'),
                },
            }));
            record('share_link_daily', copyTable(db, {
                table: 'share_link_daily',
                where: `s.link_id IN (SELECT id FROM ${SRC}.share_links WHERE clan_id = ${sourceClanId})`,
                map: { link_id: `s.link_id + ${offShareLink}` },
                orIgnore: true,
            }));
            // ── 6. ChestTracker ingest ────────────────────────────────────────────
            record('ct_player_ref', copyTable(db, {
                table: 'ct_player_ref',
                where: `s.clan_id = ${sourceClanId}`,
                map: { id: `s.id + ${offPlayerRef}`, clan_id: String(targetId) },
            }));
            record('snapshot', copyTable(db, {
                table: 'snapshot',
                where: `s.clan_id = ${sourceClanId}`,
                map: { id: `s.id + ${offSnapshot}`, clan_id: String(targetId) },
            }));
            const snapshotScope = `s.snapshot_id IN (SELECT id FROM ${SRC}.snapshot WHERE clan_id = ${sourceClanId})`;
            for (const table of ['player_snapshot', 'player_category']) {
                record(table, copyTable(db, {
                    table,
                    where: snapshotScope,
                    drop: ['id'],
                    map: {
                        clan_id: String(targetId),
                        snapshot_id: `s.snapshot_id + ${offSnapshot}`,
                        player_ref_id: `s.player_ref_id + ${offPlayerRef}`,
                    },
                }));
            }
            record('snapshot_chest_definition', copyTable(db, {
                table: 'snapshot_chest_definition',
                where: snapshotScope,
                map: {
                    clan_id: String(targetId),
                    snapshot_id: `s.snapshot_id + ${offSnapshot}`,
                    chest_definition_ref_id: '(SELECT new FROM temp.map_chestdef WHERE old = s.chest_definition_ref_id)',
                },
                orIgnore: true,
            }));
            record('poll_log', copyTable(db, {
                table: 'poll_log',
                where: `s.clan_id = ${sourceClanId}`,
                drop: ['id'],
                map: { clan_id: String(targetId) },
            }));
        });
        tx();
        for (const kind of ['chest', 'source', 'restype', 'chestdef', 'user']) {
            db.prepare(`DROP TABLE IF EXISTS temp.map_${kind}`).run();
        }
        const totalRows = Object.values(tables).reduce((a, b) => a + b, 0);
        log.info(`Restored clan "${name}" from backup as clan #${targetId}: ${totalRows} row(s) across `
            + `${Object.keys(tables).length} table(s)`);
        return { sourceClanId, clanId: targetId, name, tables, totalRows };
    }
    finally {
        try {
            db.prepare(`DETACH DATABASE ${SRC}`).run();
        }
        catch (err) {
            log.warn(`Failed to detach restore source: ${err instanceof Error ? err.message : String(err)}`);
        }
        cleanup();
    }
}
//# sourceMappingURL=clan-restore.js.map