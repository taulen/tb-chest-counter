"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BATTLE_DATA_FORMAT = exports.BATTLE_DATA_FILE = void 0;
exports.trainingSilver = trainingSilver;
exports.buildBattleData = buildBattleData;
exports.battleUnitNames = battleUnitNames;
exports.BATTLE_DATA_FILE = 'battle-data.json';
/** Bump when the file's shape changes (2: who may lead a target; 3: revival gold; 4: training silver). */
exports.BATTLE_DATA_FORMAT = 4;
/** T12 (the game's buy table) item id of Silver in a price. */
const SILVER = '2';
/** T7 f1 of an army on the map (monster squads, citadels, enemy cities, vaults). */
const MAP_ARMY = 6;
/** T7 f18 of a citadel (and an enemy city). */
const CLASS_CITADEL = 4;
/** A citadel's name key: `atom.name.<kind>_stronghold` (the citadels the names build keeps, static-data.ts). */
const CITADEL_KEY = /^atom\.name\.[a-z]+_stronghold$/;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const isRow = (r) => Array.isArray(r);
const nonEmpty = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0;
function rowsOf(t) {
    return Object.entries(t ?? {})
        .filter((e) => isRow(e[1]))
        .map(([id, row]) => [Number(id), row])
        .sort((a, b) => a[0] - b[0]);
}
/** How a player fields a priced unit: its march cost decides, then its tags. */
function kindOf(tags, lead, dom, auth) {
    if (auth > 0)
        return 'mercenaries';
    if (dom > 0)
        return 'monsters';
    if (lead <= 0)
        return null;
    if (tags.has('engine') || tags.has('siege'))
        return 'siege';
    if (tags.has('guardsmen'))
        return 'guardsmen';
    if (tags.has('specialist'))
        return 'specialists';
    return null;
}
/**
 * Silver to train one of each unit, from T12 — the game's buy table: f2[0] the
 * price `{itemId: amount}`, f4[1] the product `{unitId: count}` (a row's own id
 * is NOT the unit's). The lowest-id row selling exactly one unit for Silver.
 */
function trainingSilver(t12) {
    const out = new Map();
    for (const [, row] of rowsOf(t12)) {
        const price = Array.isArray(row[2]) ? row[2][0] : undefined;
        const product = Array.isArray(row[4]) ? row[4][1] : undefined;
        if (!nonEmpty(price) || !nonEmpty(product))
            continue;
        const silver = num(price[SILVER]);
        const items = Object.entries(product);
        if (!(silver > 0) || items.length !== 1 || num(items[0][1]) !== 1)
            continue;
        const unitId = Number(items[0][0]);
        if (!out.has(unitId))
            out.set(unitId, silver);
    }
    return out;
}
function buildBattleData(t7, t9, look, version, t12) {
    const tagList = (v) => (Array.isArray(v) ? v : []).map((r) => look.str(r)?.toLowerCase()).filter((s) => !!s);
    const trainPrice = trainingSilver(t12);
    // Every unit that can fight, by id.
    const all = new Map();
    for (const [id, row] of rowsOf(t9)) {
        const str = num(row[10]);
        const hp = num(row[12]);
        const name = look.name(row[1]);
        if (!(str > 0) || !(hp > 0) || !name)
            continue;
        const tags = tagList(row[23]);
        const vs = [];
        for (const f of Array.isArray(row[38]) ? row[38] : []) {
            if (!Array.isArray(f) || !Array.isArray(f[0]))
                continue;
            const on = tagList(f[0]);
            const pct = num(f[1]);
            const mult = num(f[2]) > 0 ? num(f[2]) / 100 : 1;
            if (on.length && (pct || mult !== 1))
                vs.push([on, pct, mult]);
        }
        const lead = num(row[16]) / 100;
        const auth = num(row[17]) / 100;
        const dom = num(row[18]) / 100;
        const priced = Array.isArray(row[6]) && nonEmpty(row[6][0]);
        const unit = { name, tier: num(row[2]), str, hp, tags, vs, icon: look.str(row[4]) ?? '', priced };
        const kind = priced ? kindOf(new Set(tags), lead, dom, auth) : null;
        if (kind) {
            unit.kind = kind;
            const gold = num(row[6][0] && typeof row[6][0] === 'object' ? row[6][0]['1'] : undefined);
            if (gold > 0)
                unit.revive = gold;
            const silver = trainPrice.get(id);
            if (silver && kind !== 'mercenaries')
                unit.train = silver;
            if (kind === 'mercenaries')
                unit.auth = auth;
            else if (kind === 'monsters')
                unit.dom = dom;
            else
                unit.lead = lead;
        }
        all.set(id, unit);
    }
    // A trained troop or mercenary appears again under a higher id with the same
    // numbers and no march cost (75xxx): the lowest id is the one armies carry.
    const seen = new Map();
    const fieldable = new Set();
    for (const [id, u] of all) {
        if (!u.kind)
            continue;
        const key = `${u.name}|${u.str}|${u.hp}|${u.kind}`;
        const kept = seen.get(key);
        if (kept) {
            // Should the shop sell the copy, the one armies carry takes its price.
            if (u.train && !kept.train)
                kept.train = u.train;
            delete u.kind;
            delete u.train;
            continue;
        }
        seen.set(key, u);
        fieldable.add(id);
    }
    const groups = new Map();
    const citadelNames = new Set();
    for (const [id, row] of rowsOf(t7)) {
        if (row[1] !== MAP_ARMY)
            continue;
        const name = look.name(row[3]);
        const raw = Array.isArray(row[6]) ? row[6][1] : undefined;
        if (!name || !nonEmpty(raw))
            continue;
        if (CITADEL_KEY.test(look.key?.(row[3]) ?? ''))
            citadelNames.add(name);
        const army = Object.entries(raw)
            .map(([u, n]) => [Number(u), num(n)])
            .filter(([, n]) => n > 0);
        if (!army.length || army.some(([u]) => !all.has(u)))
            continue;
        army.sort((a, b) => all.get(b[0]).str * b[1] - all.get(a[0]).str * a[1] || a[0] - b[0]);
        const level = num(row[15]);
        const g = `${name}|${level}`;
        if (!groups.has(g))
            groups.set(g, []);
        const hero = row[10] === 1;
        const captains = num(row[11]);
        // Who may lead is part of a target's identity: one version can be the Hero's, another a captain's.
        groups.get(g).push({ id, name, level, cls: num(row[18]), hero, captains, army, key: JSON.stringify([hero, captains, [...army].sort((a, b) => a[0] - b[0])]) });
    }
    // Which class of a family is the live one. Class 0 never is (older versions:
    // a "Common Elf squad" of legacy Inferno units, the old Legendary and Epic
    // Elf/Barbarian/Cursed squads — no shared report ever hit one, Nov 28 2026).
    // A citadel family keeps its citadels (class 4; its class-2 objects are the
    // old citadels, 0 of 29 hits); any other its main class (Common Elf squad:
    // 30 of class 1, 5 stray class-2 objects).
    const liveClass = new Map();
    {
        const counts = new Map();
        for (const list of groups.values()) {
            for (const c of list) {
                if (c.cls === 0)
                    continue;
                const m = counts.get(c.name) ?? new Map();
                m.set(c.cls, (m.get(c.cls) ?? 0) + 1);
                counts.set(c.name, m);
            }
        }
        for (const [name, m] of counts) {
            // A citadel is live only as class 4: Barbarian 25 and Inferno 15 exist only as
            // class 2 and are not in the game (the user, Nov 28 2026: Elven and Cursed only).
            if (citadelNames.has(name) || m.has(CLASS_CITADEL)) {
                if (m.has(CLASS_CITADEL))
                    liveClass.set(name, CLASS_CITADEL);
                continue;
            }
            liveClass.set(name, [...m].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0]);
        }
    }
    const targets = [];
    const used = new Set(fieldable);
    for (const list of groups.values()) {
        const pick = list.filter((c) => c.cls !== 0 && c.cls === liveClass.get(c.name));
        const byArmy = new Map();
        for (const c of pick) {
            const t = byArmy.get(c.key);
            if (t)
                t.ids.push(c.id);
            else
                byArmy.set(c.key, { ids: [c.id], name: c.name, level: c.level, cls: c.cls, hero: c.hero, captains: c.captains, army: c.army });
        }
        for (const t of byArmy.values()) {
            targets.push(t);
            for (const [u] of t.army)
                used.add(u);
        }
    }
    targets.sort((a, b) => a.name.localeCompare(b.name) || a.level - b.level || a.ids[0] - b.ids[0]);
    const units = {};
    for (const id of [...used].sort((a, b) => a - b)) {
        const { priced: _p, ...u } = all.get(id);
        units[String(id)] = u;
    }
    return { format: exports.BATTLE_DATA_FORMAT, version, units, targets };
}
/** The English names of the units battle data carries, for names.json (and so the game's own text in every site language). */
function battleUnitNames(data) {
    return Object.fromEntries(Object.entries(data.units).map(([id, u]) => [id, u.name]));
}
//# sourceMappingURL=battle-data.js.map