// Prepare an isolated local run against a COPY of the newest prod backup:
//   node .claude/skills/local-ui-check/prep.cjs [backup.db]
// Copies the DB (+ -wal/-shm) into RUN_DIR, makes it safe to run locally
// (no ChestTracker polling, no Discord credentials), adds a superadmin session
// and writes app.env + run.json. Never touches data/ or the backup itself.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require(path.resolve('node_modules/better-sqlite3'));
const { RUN_DIR, PORT } = require('./common.cjs');

const BACKUP_DIR = path.resolve('data/exports/dbbackup');
const source = process.argv[2]
  || fs.readdirSync(BACKUP_DIR)
    .filter((f) => f.endsWith('.db'))
    .map((f) => path.join(BACKUP_DIR, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
if (!source) throw new Error(`No backup found in ${BACKUP_DIR}`);

fs.mkdirSync(RUN_DIR, { recursive: true });
const dbFile = path.join(RUN_DIR, 'run.db');
for (const ext of ['', '-wal', '-shm']) {
  fs.rmSync(dbFile + ext, { force: true });
  if (fs.existsSync(source + ext)) fs.copyFileSync(source + ext, dbFile + ext);
}

const db = new Database(dbFile);
// Offline by construction: the ChestTracker loop starts even in dashboard-only
// mode, and the clan rows carry live Discord bot tokens.
db.exec('DELETE FROM ct_config');
const clanCols = db.prepare('PRAGMA table_info(clans)').all().map((c) => c.name);
for (const col of clanCols.filter((c) => /discord.*token|webhook/i.test(c))) {
  db.prepare(`UPDATE clans SET ${col} = ''`).run();
}
const superadmin = db.prepare("SELECT id FROM users WHERE role = 'superadmin' ORDER BY id LIMIT 1").get();
const activeClan = db.prepare('SELECT id FROM clans WHERE is_active = 1 ORDER BY id LIMIT 1').get();
const token = crypto.randomBytes(32).toString('hex');
db.prepare('INSERT INTO user_sessions (user_id, token, expires_at, created_at, active_clan_id) VALUES (?, ?, ?, ?, ?)')
  .run(superadmin.id, token, new Date(Date.now() + 30 * 864e5).toISOString(), new Date().toISOString(), activeClan?.id ?? null);
const member = activeClan ? db.prepare('SELECT id FROM members WHERE clan_id = ? ORDER BY id LIMIT 1').get(activeClan.id) : null;
const share = db.prepare('SELECT token FROM share_links WHERE revoked_at IS NULL ORDER BY is_vanity DESC, id DESC LIMIT 1').get();
db.close();

const fwd = (p) => p.replace(/\\/g, '/');
fs.writeFileSync(path.join(RUN_DIR, 'app.env'), `WEB_PORT=${PORT}\nDB_PATH=${fwd(dbFile)}\nDISCORD_ENABLED=false\n`);
const info = { source, dbFile: fwd(dbFile), token, memberId: member?.id ?? null, shareToken: share?.token ?? null, port: PORT };
fs.writeFileSync(path.join(RUN_DIR, 'run.json'), JSON.stringify(info, null, 1));

console.log(`Prepared ${fwd(RUN_DIR)} from ${path.basename(source)}`);
console.log('Start the server (from the repo root, after npm run build):');
console.log(`  APP_CONFIG_PATH="${fwd(path.join(RUN_DIR, 'app.env'))}" DB_PATH="${fwd(dbFile)}" WEB_PORT=${PORT} DISCORD_ENABLED=false node dist/index.js --dashboard-only`);
