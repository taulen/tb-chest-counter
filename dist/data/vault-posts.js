"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.vaultLevel = void 0;
exports.isVaultType = isVaultType;
exports.matchVault = matchVault;
exports.listVaultPosts = listVaultPosts;
/**
 * Vaults members link in the clan's vault chat (v144: a picked group chat read
 * for 'vaults', e.g. CWB's "-CWB VAULTS-"; docs/battle-reports.md), matched to
 * the Vaults of the Ancients the map pass saw (game_map_objects,
 * listRaisedVaults) for Events → Ancients → Vaults.
 *
 * A link is a shared map location: `coord` with x, y, realmId and staticId —
 * the vault's T7 type, 150201–150499, whose last two digits are its level
 * (150244 = level 44; true for all 237 vaults seen by Nov 27 2026). A link
 * counts for the member who posted it.
 *
 * Matching: one tile holds several vaults over a run (CWB's 790:162 held a
 * level 39, then a level 44, then another 39 within a day), so a link matches
 * a map vault on the same kingdom and tile, the same type (level), and a time
 * that fits — posted at most MATCH_SLACK_MS before the map first saw it or
 * after it last saw it. The poster's own vault wins; else the one first seen
 * nearest the post.
 */
const database_js_1 = require("./database.js");
const chat_text_js_1 = require("../game-protocol/chat-text.js");
const battle_report_repo_js_1 = require("./repositories/battle-report-repo.js");
/** A Vault of the Ancients' T7 type, or not. */
function isVaultType(id) {
    return typeof id === 'number' && Number.isInteger(id) && id >= 150201 && id <= 150499;
}
/** Its level: the type's last two digits. */
const vaultLevel = (type) => type % 100;
exports.vaultLevel = vaultLevel;
const MATCH_SLACK_MS = 12 * 3_600_000;
/** Pick the map vault a link points at, or null. */
function matchVault(post, vaults) {
    const fits = vaults.filter((v) => v.x === post.x && v.y === post.y && v.objectType === post.objectType
        && (post.realm === null || v.realm === null || v.realm === post.realm)
        && post.atMs >= Date.parse(v.firstSeen) - MATCH_SLACK_MS
        && post.atMs <= Date.parse(v.lastSeen) + MATCH_SLACK_MS);
    if (!fits.length)
        return null;
    const own = fits.filter((v) => post.playerId !== null && v.ownerId === post.playerId);
    const pool = own.length ? own : fits;
    return [...pool].sort((a, b) => Math.abs(Date.parse(a.firstSeen) - post.atMs) - Math.abs(Date.parse(b.firstSeen) - post.atMs))[0];
}
/**
 * Vault links posted in the clan's vault chats in [fromIso, toIso), oldest
 * first, each matched to `vaults` (the map's, any owner). Empty when the clan
 * has no vault chat.
 */
function listVaultPosts(clanId, fromIso, toIso, vaults) {
    const chats = (0, battle_report_repo_js_1.vaultChats)(clanId);
    if (!chats.length)
        return [];
    const names = new Map(chats.map((c) => [c.url, c.name]));
    const ph = chats.map(() => '?').join(',');
    const fromMs = fromIso ? Date.parse(fromIso) : null;
    const toMs = toIso ? Date.parse(toIso) : null;
    const db = (0, database_js_1.getDb)();
    const rows = db.prepare(`SELECT channel_url, message_id, created_at, sender_player_id, sender_name, data FROM chat_messages
     WHERE clan_id = ? AND channel_url IN (${ph}) AND data LIKE '%"coord"%'
       AND (? IS NULL OR created_at >= ?) AND (? IS NULL OR created_at < ?)
     ORDER BY created_at, message_id`).all(clanId, ...chats.map((c) => c.url), fromMs, fromMs, toMs, toMs);
    const posters = [...new Set(rows.map((r) => r.sender_player_id).filter((p) => p !== null))];
    const members = new Map();
    if (posters.length) {
        for (const m of db.prepare(`SELECT id, name, game_player_id FROM members WHERE clan_id = ? AND game_player_id IN (${posters.map(() => '?').join(',')})`)
            .all(clanId, ...posters)) {
            members.set(m.game_player_id, { id: m.id, name: m.name });
        }
    }
    const out = [];
    for (const r of rows) {
        for (const sub of Object.values((0, chat_text_js_1.parseChatSubs)(r.data))) {
            if (sub.type !== 'coord' || !isVaultType(sub.staticId) || typeof sub.x !== 'number' || typeof sub.y !== 'number')
                continue;
            const realm = typeof sub.realmId === 'number' ? sub.realmId : null;
            const m = r.sender_player_id !== null ? members.get(r.sender_player_id) : undefined;
            const hit = matchVault({ realm, x: sub.x, y: sub.y, objectType: sub.staticId, atMs: r.created_at, playerId: r.sender_player_id }, vaults);
            out.push({
                messageId: r.message_id,
                chatName: names.get(r.channel_url) ?? '',
                at: new Date(r.created_at).toISOString(),
                playerId: r.sender_player_id,
                memberId: m?.id ?? null,
                name: m?.name ?? r.sender_name,
                realm,
                x: sub.x,
                y: sub.y,
                objectType: sub.staticId,
                level: (0, exports.vaultLevel)(sub.staticId),
                objectId: hit?.objectId ?? null,
            });
        }
    }
    return out;
}
//# sourceMappingURL=vault-posts.js.map