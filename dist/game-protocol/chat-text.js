"use strict";
/**
 * What a stored chat message says, beyond its raw text. Pure; no imports, so
 * the v113 migration can use it to fill existing rows.
 *
 * The game sends structured content as a placeholder in the text plus a
 * `data` payload: text `"/%0%/"` (or `"meet me /%0%/"`) and
 * `{"subs": {"/%0%/": {"type": "coord", "entryType": "user", "x": 808, "y": 40,
 * "realmId": 260, "staticId": 4, "name": "Kajim", "v": 1}}}`. Kinds seen in
 * clan chat (Nov 2026): `coord` (a shared map location: entryType user / poi /
 * tile / clan / landmark), `raid` (created), `clan` (join / leave / kicked /
 * archived), `journal` (attack / crypt / scout / clan_announcement /
 * pvpladder — a shared report), `spawn_sabotage_spawn_to_enemy`, `clan_spawn`.
 *
 * `sender_info` is the sender's Sendbird metadata.memberInfo at the time:
 * `realmHex,playerHex,clanHex,0,rank,tag` (rank = the game's clan rank 1–5).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseChatSubs = parseChatSubs;
exports.chatReportLinks = chatReportLinks;
exports.chatSubCoords = chatSubCoords;
exports.chatSearchText = chatSearchText;
exports.chatSenderPlayerId = chatSenderPlayerId;
exports.chatSenderRank = chatSenderRank;
exports.chatSenderTag = chatSenderTag;
/** The placeholder → content map of a message's data payload (empty when none or unreadable). */
function parseChatSubs(data) {
    if (!data || data[0] !== '{')
        return {};
    try {
        const subs = JSON.parse(data).subs;
        if (!subs || typeof subs !== 'object' || Array.isArray(subs))
            return {};
        const out = {};
        for (const [k, v] of Object.entries(subs)) {
            if (v && typeof v === 'object' && !Array.isArray(v))
                out[k] = v;
        }
        return out;
    }
    catch {
        return {};
    }
}
/** Every shared report in a message's data payload (docs/battle-reports.md). */
function chatReportLinks(data) {
    if (!data || !data.includes('journalV2EntryId'))
        return [];
    const out = [];
    for (const sub of Object.values(parseChatSubs(data))) {
        if (sub.type !== 'journal')
            continue;
        const entryId = sub.journalV2EntryId;
        if (typeof entryId !== 'string' || !/^[0-9a-f-]{36}$/i.test(entryId))
            continue;
        out.push({
            entryId: entryId.toLowerCase(),
            entryType: typeof sub.entryType === 'string' ? sub.entryType : '',
            staticId: typeof sub.staticId === 'number' ? sub.staticId : 0,
        });
    }
    return out;
}
const str = (v) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
/** `K:260 X:808 Y:40` for a sub carrying realm/x/y (also `atomCoord`), else ''. */
function chatSubCoords(sub) {
    const c = (sub.atomCoord && typeof sub.atomCoord === 'object' ? sub.atomCoord : sub);
    const k = c.realmId, x = c.x, y = c.y;
    return typeof k === 'number' && typeof x === 'number' && typeof y === 'number' ? `K:${k} X:${x} Y:${y}` : '';
}
/** The words of a sub a search should find: names and coordinates. */
function subWords(sub) {
    const parts = [
        str(sub.name), str(sub.kicker), str(sub.spawnerName), str(sub.targetClanName), str(sub.targetClanInitials),
        chatSubCoords(sub),
    ];
    return parts.filter(Boolean).join(' ');
}
/**
 * The text the chat search indexes: the message with every placeholder
 * replaced by its content's names and coordinates (object names from the
 * game's tables are resolved only at display time).
 */
function chatSearchText(message, data) {
    const subs = parseChatSubs(data);
    let out = message ?? '';
    for (const [ph, sub] of Object.entries(subs))
        out = out.split(ph).join(` ${subWords(sub)} `);
    return out.replace(/\/%\d+%\//g, ' ').replace(/\s+/g, ' ').trim();
}
function infoField(senderInfo, i) {
    return (senderInfo ?? '').split(',')[i] ?? '';
}
/** The sender's game player id from sender_info (hex), or null. */
function chatSenderPlayerId(senderInfo) {
    const hex = infoField(senderInfo, 1);
    if (!/^[0-9a-f]+$/i.test(hex))
        return null;
    const n = Number.parseInt(hex, 16);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
}
/** The sender's clan rank (1 leader … 5) when the message was sent, or null. */
function chatSenderRank(senderInfo) {
    const n = Number(infoField(senderInfo, 4));
    return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
}
/** The sender's clan tag when the message was sent ('' when none). */
function chatSenderTag(senderInfo) {
    return infoField(senderInfo, 5);
}
//# sourceMappingURL=chat-text.js.map