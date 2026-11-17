"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CLAN_RANKING_KINDS = exports.GIFT_LIFETIME_S = void 0;
exports.parseClanRecord = parseClanRecord;
exports.plainWire = plainWire;
exports.parseClanCapital = parseClanCapital;
exports.parseClanStats = parseClanStats;
exports.parseCapitalBorder = parseCapitalBorder;
exports.parseClanMedals = parseClanMedals;
exports.parseClanRanking = parseClanRanking;
exports.parseClanSummaries = parseClanSummaries;
exports.rankIn = rankIn;
exports.parsePlayers = parsePlayers;
exports.parseLedger = parseLedger;
exports.parseClaimRewards = parseClaimRewards;
exports.uidOf = uidOf;
exports.splitCityReply = splitCityReply;
exports.parseCityRecord = parseCityRecord;
exports.parseMapObjects = parseMapObjects;
exports.parseMapCities = parseMapCities;
exports.tileOf = tileOf;
exports.parseCityTechs = parseCityTechs;
const num = (v) => (typeof v === 'number' ? v : null);
const id1 = (v) => (Array.isArray(v) && typeof v[0] === 'number' ? v[0] : null);
const arr = (v) => (Array.isArray(v) ? v : []);
/** Gifts live 20 h; the clan record only carries the expiry. */
exports.GIFT_LIFETIME_S = 20 * 3600;
/** Message 15000. Only our own clan's record carries members and gifts. */
function parseClanRecord(frame) {
    const rec = arr(arr(arr(frame.body[0])[0])[0]);
    const clanId = id1(rec[0]);
    if (clanId === null)
        return null;
    const info = arr(rec[1]);
    const members = [];
    for (const m of arr(rec[2])) {
        const row = arr(m);
        const playerId = id1(row[0]);
        if (playerId !== null)
            members.push({ playerId, role: num(row[1]) ?? 0, joinedAt: num(row[2]) ?? 0 });
    }
    const gifts = [];
    for (const g of arr(rec[13])) {
        const row = arr(g);
        const giftId = num(row[0]);
        const senderId = id1(row[1]);
        const giftType = num(row[2]);
        const expiresAt = num(row[3]);
        if (giftId === null || senderId === null || giftType === null || expiresAt === null)
            continue;
        gifts.push({
            giftId,
            senderId,
            giftType,
            expiresAt,
            arrivedAt: expiresAt - exports.GIFT_LIFETIME_S,
            count: num(row[4]) ?? 1,
            tab: num(row[5]) ?? 1,
        });
    }
    return {
        clanId,
        tag: typeof info[0] === 'string' ? info[0] : '',
        name: typeof info[1] === 'string' ? info[1] : '',
        members,
        gifts,
        objects: arr(rec[5]).map(id1).filter((v) => v !== null),
        capitalId: id1(info[6]),
        memberLimit: num(rec[6]),
        might: num(rec[7]),
        foundedAt: num(info[8]),
        language: typeof info[13] === 'string' ? info[13] : '',
        logo: num(info[2]),
        extra: { f9: num(rec[9]), f11: num(rec[11]), f12: rec[12] ?? null },
    };
}
/** Unwrap one-element arrays (the reply envelopes) down to the payload. */
function unwrap(v) {
    let out = v;
    while (Array.isArray(out) && out.length === 1)
        out = out[0];
    return out;
}
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && !('$pairs' in v) && !('$bin' in v);
/** Big game numbers decode as bigint past 2^53; anything we keep raw goes through this. */
function plainWire(v) {
    return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
}
/**
 * 601 reply for the Clan Capital object: a 36-field record shaped like a
 * city's. Its f17 is the clan's research (Clan territories / Allies /
 * Fortifications), f5 the clan treasury.
 */
function parseClanCapital(frame) {
    const city = parseCityRecord(frame);
    if (!city)
        return null;
    let root = frame.body;
    while (Array.isArray(root) && root.length === 1)
        root = root[0];
    const r = arr(arr(arr(root)[0])[0]);
    const treasury = {};
    const t = r[5];
    if (isPlainObject(t)) {
        for (const [k, v] of Object.entries(t)) {
            const row = arr(v);
            if (typeof row[1] === 'number')
                treasury[k] = row[1];
        }
    }
    const pos = arr(arr(r[1])[13]);
    return {
        capitalId: city.cityId,
        techs: city.techs,
        treasury,
        position: pos.length >= 3 && pos.every((n) => typeof n === 'number') ? [pos[0], pos[1], pos[2]] : null,
    };
}
/** Message 25 (`[[[clanId]]]`): `{1: might, 3: …, 4: …, 5: …, 7: wealth points, 9: …}`. */
function parseClanStats(frame) {
    const o = unwrap(frame.body);
    if (!isPlainObject(o))
        return null;
    return { might: num(o['1']), wealth: num(o['7']), raw: plainWire(o) };
}
/** Message 14003 (`[[[capitalId]]]`): `[[ [[[key], value], …], …, … ]]`. */
function parseCapitalBorder(frame) {
    const lists = arr(arr(frame.body)[0]);
    const first = arr(lists[0]);
    const raw = {};
    for (const e of first) {
        const row = arr(e);
        const key = id1(row[0]);
        if (key !== null)
            raw[String(key)] = plainWire(row[1]);
    }
    if (!Object.keys(raw).length)
        return null;
    const help = raw['30'];
    return { helpPoints: typeof help === 'number' ? help : null, raw };
}
/** Message 28001 (`[[[clanId]]]`): the medals shown on the Information tab, `[[medalId, earnedAt], …]`. */
function parseClanMedals(frame) {
    const out = [];
    const walk = (v, depth) => {
        if (!Array.isArray(v) || depth > 5)
            return;
        if (v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number' && v[1] > 1_000_000_000) {
            out.push({ medalId: v[0], earnedAt: v[1] });
            return;
        }
        for (const x of v)
            walk(x, depth + 1);
    };
    walk(frame.body, 0);
    return out;
}
/**
 * Message 23 (`[[kind, count, [], false]]`): the kingdom's clan ranking,
 * `[[clanId, value], …]` — NOT sorted by value. Kind 7 = wealth points
 * (verified against the in-game list); other kinds unverified.
 */
function parseClanRanking(frame) {
    const out = [];
    const walk = (v, depth) => {
        if (!Array.isArray(v) || depth > 5)
            return;
        if (v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number' && v[0] > 1_000_000) {
            out.push({ clanId: v[0], value: v[1] });
            return;
        }
        for (const x of v)
            walk(x, depth + 1);
    };
    walk(frame.body, 0);
    return out;
}
/**
 * The clan ranking window's categories (message 23 kinds), in the game's
 * order: the client config's rating tabs (RATING_CLANS); each probed — 2 and 6
 * answer empty for clans.
 */
exports.CLAN_RANKING_KINDS = [7, 1, 3, 4, 5];
/**
 * Message 15200 (`[[[[clanId], …]]]`): any clans' headline — what the game's
 * ranking list shows per clan: `[[clanId], logo, tag, name, type, 0, 0,
 * memberLimit, members, language, might, 1]` (then a `{[1018,1] → [n]}` pair).
 */
function parseClanSummaries(frame) {
    const out = [];
    const walk = (v, depth) => {
        if (!Array.isArray(v) || depth > 6)
            return;
        if (v.length >= 11 && id1(v[0]) !== null && typeof v[2] === 'string' && typeof v[3] === 'string') {
            out.push({
                clanId: id1(v[0]),
                logo: num(v[1]),
                tag: v[2],
                name: v[3],
                memberLimit: num(v[7]),
                members: num(v[8]),
                language: typeof v[9] === 'string' ? v[9] : '',
                might: num(v[10]),
            });
            return;
        }
        for (const x of v)
            walk(x, depth + 1);
    };
    walk(frame.body, 0);
    return out;
}
/** 1-based rank of `clanId` by value (highest first), or null when it isn't in the list. */
function rankIn(list, clanId) {
    const sorted = [...list].sort((a, b) => b.value - a.value);
    const i = sorted.findIndex((e) => e.clanId === clanId);
    return i < 0 ? null : i + 1;
}
/** Message 402: player records, wherever they sit in the reply. */
function parsePlayers(frame) {
    const out = [];
    const walk = (v) => {
        if (!Array.isArray(v))
            return;
        if (id1(v[0]) !== null && Array.isArray(v[0]) && v[0].length === 1 && typeof v[1] === 'string' && typeof v[2] === 'string') {
            const pos = arr(v[15]);
            out.push({
                playerId: id1(v[0]),
                name: v[2],
                position: pos.length === 3 && pos.every((p) => typeof p === 'number') ? pos : null,
                heroAvatar: num(v[4]),
                heroLevel: num(v[7]),
                cityLevel: num(v[8]),
                vip: num(v[9]),
                might: num(v[10]),
                clanId: id1(v[11]),
                clanTag: typeof v[13] === 'string' ? v[13] : '',
                cityId: id1(v[16]),
                goldPass: Array.isArray(v[22]) && v[22][0] === 1,
                goldIngots: num(v[17]),
                avatarFrame: num(v[6]),
                cityAppearance: num(v[5]),
            });
            return;
        }
        v.forEach(walk);
    };
    frame.body.forEach(walk);
    return out;
}
/** Message 15031: Clan Capital ledger entries (newest-first on the wire). */
function parseLedger(frame) {
    let rows = frame.body;
    while (Array.isArray(rows) && rows.length === 1 && Array.isArray(rows[0]) && Array.isArray(rows[0][0]))
        rows = rows[0];
    const out = [];
    for (const e of arr(rows)) {
        const row = arr(e);
        const entryId = num(row[0]);
        const playerId = id1(row[1]);
        const occurredAt = num(row[4]);
        if (entryId === null || playerId === null || occurredAt === null)
            continue;
        const amounts = {};
        const a = arr(row[5])[0];
        if (a && typeof a === 'object' && !Array.isArray(a) && !('$bin' in a) && !('$pairs' in a)) {
            for (const [k, v] of Object.entries(a))
                if (typeof v === 'number')
                    amounts[k] = v;
        }
        out.push({ entryId, playerId, kind: num(row[2]) ?? 0, resource: num(row[3]) ?? 0, occurredAt, amounts });
    }
    return out;
}
/** Message 15013 (claim): the rewards granted, `{itemId: count}` (summed for a batch). */
function parseClaimRewards(frame) {
    const r = arr(arr(arr(frame.body[0])[0]))[0];
    const out = {};
    if (r && typeof r === 'object' && !Array.isArray(r) && !('$bin' in r) && !('$pairs' in r)) {
        for (const [k, v] of Object.entries(r))
            if (typeof v === 'number')
                out[k] = v;
    }
    return out;
}
/** A 64-bit id as the codec hands it over (number, or "123…n" past 2^53) → decimal string; '' for 0/none. */
function uidOf(v) {
    if (typeof v === 'number')
        return v > 0 ? String(v) : '';
    if (typeof v === 'string') {
        const s = v.replace(/n$/, '');
        return /^\d+$/.test(s) && s !== '0' ? s : '';
    }
    return '';
}
/**
 * A 601 reply for several cities (GameClient.cities) cut into one body per
 * city, each in exactly the shape a single-city reply has (`[[[record], []]]`),
 * so parseCityRecord and the raw archive treat them the same as before.
 */
function splitCityReply(frame) {
    let root = frame.body;
    while (Array.isArray(root) && root.length === 1)
        root = root[0];
    const out = [];
    for (const rec of arr(arr(root)[0])) {
        const cityId = id1(arr(rec)[0]);
        if (cityId !== null)
            out.push({ cityId, body: [[[rec], []]] });
    }
    return out;
}
/**
 * Message 601 for a player's city: [0] city id, [1][0] owner, [12] buildings
 * {slot: [slot, type, level, …]}, [17] techs, [26] hero {"1": [1, [heroId], xp,
 * level, …]}. Verified against Miana's and Kordobrek's cities (Nov 2026).
 */
function parseCityRecord(frame) {
    let root = frame.body;
    while (Array.isArray(root) && root.length === 1)
        root = root[0];
    const rec = arr(arr(root)[0])[0];
    const r = arr(rec);
    const cityId = id1(r[0]);
    if (cityId === null)
        return null;
    const buildings = {};
    const b = r[12];
    if (b && typeof b === 'object' && !Array.isArray(b) && !('$bin' in b) && !('$pairs' in b)) {
        for (const [slot, v] of Object.entries(b)) {
            const row = arr(v);
            if (typeof row[1] === 'number' && typeof row[2] === 'number')
                buildings[slot] = { type: row[1], level: row[2] };
        }
    }
    const d = r[26];
    const dragonRow = d && typeof d === 'object' && !Array.isArray(d) && !('$bin' in d) && !('$pairs' in d) ? arr(Object.values(d)[0]) : [];
    return {
        cityId,
        ownerId: id1(arr(r[1])[0]),
        techs: parseCityTechs(frame),
        buildings,
        dragon: { level: num(dragonRow[3]), xp: num(dragonRow[2]) },
        troops: arr(r[30])
            .map((e) => arr(e))
            .filter((e) => typeof e[0] === 'number' && typeof e[1] === 'number')
            .map((e) => ({ id: e[0], count: e[1] })),
        captains: arr(r[9])
            .map((e) => arr(e))
            .filter((e) => typeof e[0] === 'number' && typeof e[10] === 'number')
            .map((e) => ({
            id: e[0],
            level: e[10],
            stars: num(e[18]) ?? 0,
            xp: num(e[9]),
            slot: num(e[1]) ?? 0,
            equipment: arr(e[12]).map((s) => uidOf(arr(s)[2])),
        })),
        effects: arr(r[14])
            .map((e) => arr(e))
            .filter((e) => typeof e[0] === 'number')
            .map((e) => ({ id: e[0], source: num(e[1]) ?? 0, count: num(e[2]) ?? 1 })),
        items: arr(r[10])
            .map((e) => arr(e))
            .filter((e) => uidOf(e[0]) && typeof e[1] === 'number')
            .map((e) => ({
            uid: uidOf(e[0]),
            type: e[1],
            enchantment: num(e[7]) ?? 0,
            gems: arr(e[8]).filter((g) => typeof g === 'number' && g > 0),
            presetId: num(e[9]) ?? 0,
            raw: [num(e[3]), num(e[4]), num(e[5]), num(e[6])],
        })),
    };
}
/** Message 312 (map tiles): `[[id], type, …, level@5, …, [realm,x,y]@8, [owner]@9, expiresAt@10, …]`. */
function parseMapObjects(frame) {
    const out = [];
    const walk = (v) => {
        if (!Array.isArray(v))
            return;
        const pos = arr(v[8]);
        if (id1(v[0]) !== null && Array.isArray(v[0]) && v[0].length === 1 && typeof v[1] === 'number' && pos.length === 3) {
            out.push({
                objectId: id1(v[0]),
                type: v[1],
                level: num(v[5]),
                realm: num(pos[0]),
                x: num(pos[1]),
                y: num(pos[2]),
                ownerId: id1(v[9]),
                expiresAt: num(v[10]),
            });
            return;
        }
        v.forEach(walk);
    };
    frame.body.forEach(walk);
    return out;
}
/**
 * Cities on the map tiles of a 312 reply: each tile's [4] lists the cities on
 * it as 43-field records `[[cityId], [0], [ownerId], 2, [clanId], …,
 * level@13, avatar@14, [realm,x,y]@17, …, burning@25 (1/0), …, shielded@39
 * (true/false), …]`. Confirmed by the user against the map (Nov 2026): 54 of
 * CWB's 68 cities shielded, field 25 = 1 the burning ones.
 */
function parseMapCities(frame) {
    const out = [];
    const walk = (v) => {
        if (!Array.isArray(v))
            return;
        const pos = arr(v[17]);
        if (v.length >= 40 && v[3] === 2 && id1(v[0]) !== null && Array.isArray(v[0]) && v[0].length === 1 && id1(v[2]) !== null && typeof v[39] === 'boolean') {
            out.push({
                cityId: id1(v[0]),
                ownerId: id1(v[2]),
                clanId: id1(v[4]),
                level: num(v[13]),
                position: pos.length === 3 && pos.every((p) => typeof p === 'number') ? pos : null,
                shielded: v[39] === true,
                burning: v[25] === 1,
            });
            return;
        }
        v.forEach(walk);
    };
    frame.body.forEach(walk);
    return out;
}
/** Map tile id (20×20 squares, 50 tiles per row) holding a coordinate. */
function tileOf(x, y) {
    return Math.floor(y / 20) * 50 + Math.floor(x / 20);
}
/**
 * Message 601: a city's tech levels (research + hero talents) — the city
 * record's field 17, `{techId: [techId, level]}`. Read from the field itself:
 * the first version searched the reply for a map holding tech 1215, so a
 * player who had not researched 1215 got no research at all (6 members on
 * Nov 17 2026, their captains from the same reply stored fine).
 */
function parseCityTechs(frame) {
    let root = frame.body;
    while (Array.isArray(root) && root.length === 1)
        root = root[0];
    const t = arr(arr(arr(root)[0])[0])[17];
    const out = {};
    if (t && typeof t === 'object' && !Array.isArray(t) && !('$pairs' in t) && !('$bin' in t)) {
        for (const [k, v] of Object.entries(t)) {
            if (Array.isArray(v) && typeof v[1] === 'number')
                out[k] = v[1];
        }
    }
    return out;
}
//# sourceMappingURL=messages.js.map