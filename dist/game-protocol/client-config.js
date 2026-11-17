"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TABLE_CLIENT_CONFIG = void 0;
exports.clientConfig = clientConfig;
exports.readBranchDefs = readBranchDefs;
exports.academyTabs = academyTabs;
exports.TABLE_CLIENT_CONFIG = 1;
const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
/** T1 as rows, whether it was decoded as an array or re-keyed by index. */
function configRows(t1) {
    if (Array.isArray(t1))
        return t1;
    return isRecord(t1) ? Object.values(t1) : [];
}
/** Parsed JSON of one client-config key; null when the key is missing or not a JSON object. */
function clientConfig(t1, str, key) {
    for (const row of configRows(t1)) {
        if (!Array.isArray(row) || str(row[0]) !== key)
            continue;
        try {
            const v = JSON.parse(str(row[1]) ?? '');
            return isRecord(v) ? v : null;
        }
        catch {
            return null;
        }
    }
    return null;
}
/** Every tree the client config declares, wherever it is declared, names resolved through `text`. */
function readBranchDefs(t1, str, text) {
    const resolve = (k) => (typeof k === 'string' ? (text.get(k) ?? '') : '');
    const out = new Map();
    const walk = (v, depth) => {
        if (depth > 4)
            return;
        if (Array.isArray(v))
            return v.forEach((x) => walk(x, depth + 1));
        if (!isRecord(v))
            return;
        if (typeof v.id === 'number' && typeof v.tree === 'string' && typeof v.type === 'string' && !out.has(v.id)) {
            out.set(v.id, {
                id: v.id,
                name: resolve(v.name),
                description: resolve(v.description),
                tree: v.tree,
                type: v.type,
                visual: typeof v.visual === 'string' ? v.visual : '',
            });
        }
        for (const x of Object.values(v))
            walk(x, depth + 1);
    };
    for (const key of ['academy/branches', 'hero_info', 'clan'])
        walk(clientConfig(t1, str, key), 0);
    return [...out.values()];
}
/** The Academy's tabs ("Unlock" / "Boost"): branch id → its tab's name. The first tab listing a branch wins. */
function academyTabs(t1, str, text) {
    const academy = clientConfig(t1, str, 'academy/branches');
    const out = new Map();
    for (const tab of Array.isArray(academy?.tabs) ? academy.tabs : []) {
        if (!isRecord(tab))
            continue;
        const name = typeof tab.name === 'string' ? (text.get(tab.name) ?? '') : '';
        for (const id of Array.isArray(tab.branches) ? tab.branches : []) {
            if (typeof id === 'number' && !out.has(id))
                out.set(id, name);
        }
    }
    return out;
}
//# sourceMappingURL=client-config.js.map