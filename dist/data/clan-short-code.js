"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.splitClanShortCodes = splitClanShortCodes;
const LABEL = /^\s*([A-Za-z0-9]{2,6})\s+-\s+(\S.*?)\s*$/;
function splitClanShortCodes(database) {
    const cols = database.prepare('PRAGMA table_info(clans)').all();
    if (!cols.some((c) => c.name === 'short_code')) {
        database.exec("ALTER TABLE clans ADD COLUMN short_code TEXT NOT NULL DEFAULT ''");
    }
    const rows = database.prepare("SELECT id, name FROM clans WHERE short_code = ''").all();
    const split = database.prepare('UPDATE clans SET short_code = ?, name = ? WHERE id = ?');
    let n = 0;
    for (const r of rows) {
        const m = LABEL.exec(r.name);
        if (m)
            n += split.run(m[1], m[2], r.id).changes;
    }
    return n;
}
//# sourceMappingURL=clan-short-code.js.map