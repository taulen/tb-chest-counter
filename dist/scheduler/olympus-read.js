"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.readOlympusMatchup = readOlympusMatchup;
const messages_js_1 = require("../game-protocol/messages.js");
const game_event_repo_js_1 = require("../data/repositories/game-event-repo.js");
const game_protocol_repo_js_1 = require("../data/repositories/game-protocol-repo.js");
async function readOlympusMatchup(clanId, client, key, opts) {
    const ref = key.eventType * 1000 + key.run;
    const step = async (fn) => {
        try {
            return await fn();
        }
        catch {
            return null;
        }
        finally {
            await opts.pause?.();
        }
    };
    const groupId = await step(async () => (0, messages_js_1.parseOlympusGroup)(await client.olympusGroup(key.eventType, key.run)));
    const ranking = groupId === null ? [] : await step(async () => {
        const f = await client.olympusClanRanking(key.eventType, key.run, groupId);
        (0, game_protocol_repo_js_1.saveRawSnapshot)(clanId, 'olympus_clans', ref, opts.gameDate, f.body, opts.now);
        return (0, messages_js_1.parseOlympusClanRanking)(f);
    }) ?? [];
    const rewardMinPoints = await step(async () => {
        const f = await client.olympusRewards(key.eventType, key.run);
        (0, game_protocol_repo_js_1.saveRawSnapshot)(clanId, 'olympus_rewards', ref, opts.gameDate, f.body, opts.now);
        return (0, messages_js_1.parseOlympusRewardMinimum)(f);
    });
    await step(async () => {
        const f = await client.olympusClanTalents(key.eventType, key.run);
        (0, game_protocol_repo_js_1.saveRawSnapshot)(clanId, 'olympus_talents', ref, opts.gameDate, f.body, opts.now);
    });
    if (groupId === null && !ranking.length && rewardMinPoints === null)
        return 'olympus matchup unreadable';
    (0, game_event_repo_js_1.saveMatchup)(clanId, key, { groupId, rewardMinPoints, clans: ranking.map((c) => ({ gameClanId: c.clanId, rank: c.rank, points: c.points })) }, opts.now);
    // Each clan's headline, once per run: ours on our own server, a rival on
    // its kingdom's (the registration server says which).
    const missing = (0, game_event_repo_js_1.matchupClansWithoutName)(clanId, key);
    if (!missing.length)
        return `olympus: ${ranking.length} clans`;
    const own = opts.ownClanId;
    const rivals = missing.filter((id) => id !== own);
    const kingdoms = new Map(missing.includes(own) ? [[own, client.realmId]] : []);
    if (rivals.length) {
        const found = await step(() => client.clanKingdoms(rivals));
        rivals.forEach((id, i) => kingdoms.set(id, found?.[i] ?? null));
    }
    const named = [];
    for (const id of missing) {
        const scored = ranking.find((c) => c.clanId === id);
        if (!scored)
            continue;
        const kingdom = kingdoms.get(id) ?? null;
        const url = kingdom === null ? null : client.kingdomUrl(kingdom);
        const head = url ? (await step(async () => (0, messages_js_1.parseClanSummaries)(await client.clanSummaries([id], url))))?.find((s) => s.clanId === id) : undefined;
        named.push({
            gameClanId: id, rank: scored.rank, points: scored.points, kingdom,
            tag: head?.tag ?? null, name: head?.name ?? null, members: head?.members ?? null, memberLimit: head?.memberLimit ?? null, might: head?.might ?? null,
        });
    }
    if (named.length)
        (0, game_event_repo_js_1.saveMatchup)(clanId, key, { groupId, rewardMinPoints, clans: named }, opts.now);
    return `olympus: ${ranking.length} clans, ${named.filter((c) => c.name).length} named`;
}
//# sourceMappingURL=olympus-read.js.map