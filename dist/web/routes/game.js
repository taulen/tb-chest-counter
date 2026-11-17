"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createGameRouter = createGameRouter;
/**
 * Read API for what the game protocol collects about players: the profile
 * header (role, joined, city level, VIP, Gold Pass, hero), research and hero
 * talents with their change history, and per-member hero avatars for lists.
 *
 * Mounted at /api/game behind requireAuth + requireClanContext, so `req.clanId`
 * is the caller's active clan and every query is scoped to it. A member that is
 * not linked to a game player yet answers `{ linked: false }`, not an error.
 */
const express_1 = require("express");
const member_repo_js_1 = require("../../data/repositories/member-repo.js");
const game_profile_repo_js_1 = require("../../data/repositories/game-profile-repo.js");
const game_clan_repo_js_1 = require("../../data/repositories/game-clan-repo.js");
const member_tiers_js_1 = require("../../data/member-tiers.js");
const tech_trees_js_1 = require("../../game-protocol/tech-trees.js");
const static_data_js_1 = require("../../game-protocol/static-data.js");
const index_js_1 = require("../../game-art/index.js");
const selection_js_1 = require("../../game-art/selection.js");
const clan_logo_js_1 = require("../../game-art/clan-logo.js");
const item_icons_js_1 = require("../../game-art/item-icons.js");
const messages_js_1 = require("../../game-protocol/messages.js");
const artifacts_js_1 = require("../../game-protocol/artifacts.js");
const equipment_js_1 = require("../../game-protocol/equipment.js");
const factions_js_1 = require("../../game-protocol/factions.js");
/**
 * The trees with each tree's and node's sprite as a URL (the game's own icon
 * from the art pipeline), memoised per trees + art version.
 */
let withIconsMemo = null;
function treesWithIcons(trees) {
    const art = (0, index_js_1.currentGameArt)();
    const key = `${trees.version}|${art?.version ?? ''}`;
    if (withIconsMemo?.key === key)
        return withIconsMemo.value;
    const techIcons = art?.mappings?.techs ?? {};
    const value = {
        ...trees,
        trees: trees.trees.map((tr) => ({
            ...tr,
            iconUrl: tr.icon ? (0, index_js_1.gameArtUrl)(tr.icon) : null,
            nodes: tr.nodes.map((n) => {
                const name = techIcons[String(n.techId)] ?? n.icon;
                return { ...n, iconUrl: name ? (0, index_js_1.gameArtUrl)(name) : null };
            }),
        })),
    };
    withIconsMemo = { key, value };
    return value;
}
const CHANGES_DAYS = 90;
function createGameRouter() {
    const router = (0, express_1.Router)();
    /** Profile header data for one member. */
    router.get('/members/:memberId', (req, res) => {
        const clanId = req.clanId;
        const memberId = Number.parseInt(String(req.params.memberId), 10);
        if (!Number.isFinite(memberId) || !(0, member_repo_js_1.getMemberById)(memberId, clanId)) {
            res.status(404).json({ error: 'Member not found' });
            return;
        }
        const playerId = (0, game_profile_repo_js_1.gamePlayerIdForMember)(memberId, clanId);
        if (playerId === null) {
            res.json({ linked: false });
            return;
        }
        res.json({
            linked: true,
            player: (0, game_profile_repo_js_1.getGamePlayer)(clanId, playerId),
            city: (0, game_profile_repo_js_1.getLatestCity)(clanId, playerId),
            // G/S/E/M tiers and crypt level from the member's research (null until read).
            tiers: (0, member_tiers_js_1.getMemberTiers)(clanId).get(memberId) ?? null,
        });
    });
    /** Research + hero talent levels for one member, and their recent changes. */
    router.get('/members/:memberId/techs', (req, res) => {
        const clanId = req.clanId;
        const memberId = Number.parseInt(String(req.params.memberId), 10);
        if (!Number.isFinite(memberId) || !(0, member_repo_js_1.getMemberById)(memberId, clanId)) {
            res.status(404).json({ error: 'Member not found' });
            return;
        }
        const playerId = (0, game_profile_repo_js_1.gamePlayerIdForMember)(memberId, clanId);
        if (playerId === null) {
            res.json({ linked: false, levels: {}, readAt: null, changes: [] });
            return;
        }
        const { levels, readAt } = (0, game_profile_repo_js_1.getPlayerTechs)(clanId, playerId);
        const since = new Date(Date.now() - CHANGES_DAYS * 86_400_000).toISOString();
        res.json({ linked: true, levels, readAt, changes: (0, game_profile_repo_js_1.getPlayerTechChanges)(clanId, playerId, since) });
    });
    /**
     * A member's captains as the game's Captains screen shows them — level, star
     * level, active line-up slot — with the portrait, full artwork, rarity and
     * the current star level's bonuses; plus recent level/star changes.
     */
    router.get('/members/:memberId/captains', async (req, res) => {
        const clanId = req.clanId;
        const memberId = Number.parseInt(String(req.params.memberId), 10);
        if (!Number.isFinite(memberId) || !(0, member_repo_js_1.getMemberById)(memberId, clanId)) {
            res.status(404).json({ error: 'Member not found' });
            return;
        }
        const playerId = (0, game_profile_repo_js_1.gamePlayerIdForMember)(memberId, clanId);
        if (playerId === null) {
            res.json({ linked: false, hero: null, hallOfFame: null, captains: [], changes: [], artifacts: [], artifactChanges: [], equipmentChanges: [] });
            return;
        }
        const names = await (0, static_data_js_1.loadGameNames)().catch(() => null);
        const mappings = (0, index_js_1.currentGameArt)()?.mappings;
        const portraits = mappings?.captains ?? {};
        // Artifact / equipment / gem icons from the game's bundles, null until extracted.
        const iconUrl = (map, id) => {
            const img = map?.[String(id)];
            return img ? (0, index_js_1.gameArtUrl)(img) : null;
        };
        const artifactIconUrl = (type) => iconUrl(mappings?.artifacts, type);
        const itemView = (type, enchantment, gems) => {
            const { icon: _icon, ...v } = (0, equipment_js_1.describeItem)(type, enchantment, gems, names);
            return {
                ...v,
                iconUrl: iconUrl(mappings?.equipment, type),
                enchantment: v.enchantment ? { ...v.enchantment, iconUrl: iconUrl(mappings?.inserts, v.enchantment.id) } : null,
                gems: v.gems.map((g) => ({ ...g, iconUrl: iconUrl(mappings?.inserts, g.id) })),
            };
        };
        // Every captain's worn items (city fields 9 + 10), by captain.
        const gear = new Map();
        for (const it of (0, game_profile_repo_js_1.getPlayerEquipment)(clanId, playerId)) {
            if (!gear.has(it.captainId))
                gear.set(it.captainId, []);
            gear.get(it.captainId).push({ position: it.position, itemType: it.itemType, firstSeen: it.firstSeen, ...itemView(it.itemType, it.enchantment, it.gems) });
        }
        // The game's captain tile pieces (rarity back + frame, level plate, stars)
        // and the captain screen's full-body art (carter_scaled), when extracted.
        const tile = mappings?.captainTile;
        const fullArt = mappings?.captainArt ?? {};
        const describe = (id) => {
            const c = names?.captains?.[String(id)];
            const portrait = portraits[String(id)];
            const starLevels = Object.keys(c?.stars ?? {}).map(Number).filter(Number.isFinite);
            const rarity = c?.rarity ?? 0;
            const full = fullArt[String(id)];
            return {
                name: c?.name ?? `#${id}`,
                rarity,
                rarityName: c?.rarityName ?? '',
                maxStars: starLevels.length ? Math.max(...starLevels) : 0,
                iconUrl: portrait ? (0, index_js_1.gameArtUrl)(portrait) : null,
                artUrl: full ? (0, index_js_1.gameArtUrl)(full) : c?.art ? (0, index_js_1.gameArtUrl)((0, selection_js_1.safeArtName)(c.art)) : null,
                tileBackUrl: tile?.backs?.[String(rarity)] ? (0, index_js_1.gameArtUrl)(tile.backs[String(rarity)]) : null,
                tileFrameUrl: tile?.frames?.[String(rarity)] ? (0, index_js_1.gameArtUrl)(tile.frames[String(rarity)]) : null,
            };
        };
        const since = new Date(Date.now() - CHANGES_DAYS * 86_400_000).toISOString();
        // The hero leads the tab: its portrait in the player's frame with the
        // level plate, its level / XP (the city's hero record) and what it wears
        // (city field 9's entry id 1 — gear tracked since Nov 2026).
        const player = (0, game_profile_repo_js_1.getGamePlayer)(clanId, playerId);
        const cityHero = (0, game_profile_repo_js_1.getLatestCity)(clanId, playerId)?.hero;
        const heroLevel = cityHero?.level ?? player?.heroLevel ?? null;
        const hero = player ? {
            name: names?.heroes?.[String(player.heroAvatar)]?.name || null,
            level: heroLevel,
            heroLevel,
            xp: cityHero?.xp ?? null,
            avatarUrl: player.avatarUrl,
            frameUrl: player.frameUrl,
            equipment: gear.get(equipment_js_1.HERO_ENTRY_ID) ?? [],
        } : null;
        // The Hall of Fame: faction levels are city techs 800–803 (factions.ts).
        const techs = (0, game_profile_repo_js_1.getPlayerTechs)(clanId, playerId);
        const hallOfFame = (0, factions_js_1.hallOfFameView)(names, techs.readAt ? techs.levels : null, (n) => (0, index_js_1.gameArtUrl)((0, selection_js_1.safeArtName)(n)));
        res.json({
            linked: true,
            hero,
            hallOfFame,
            // Shared tile art: the level plate and the star sprites (null until extracted).
            tileArt: {
                levelPlateUrl: tile?.levelPlate ? (0, index_js_1.gameArtUrl)(tile.levelPlate) : null,
                starOnUrl: tile?.starOn ? (0, index_js_1.gameArtUrl)(tile.starOn) : null,
                starOffUrl: tile?.starOff ? (0, index_js_1.gameArtUrl)(tile.starOff) : null,
            },
            captains: (0, game_profile_repo_js_1.getPlayerCaptains)(clanId, playerId).map((c) => ({
                ...c,
                ...describe(c.captainId),
                starBonuses: names?.captains?.[String(c.captainId)]?.stars?.[String(c.stars)] ?? [],
                equipment: gear.get(c.captainId) ?? [],
            })),
            changes: (0, game_profile_repo_js_1.getPlayerCaptainChanges)(clanId, playerId, since).map((c) => {
                const { name, iconUrl } = describe(c.captainId);
                return { ...c, name, iconUrl };
            }),
            // The artifacts the line-up captains wear (city field 14): what the
            // game's artifact book shows for each, at its level / star level / rolls.
            artifacts: (0, game_profile_repo_js_1.getPlayerArtifacts)(clanId, playerId).map((a) => {
                const { icon: _icon, ...view } = (0, artifacts_js_1.describeArtifact)(a.artifactType, a.level, a.star, a.bonuses, names?.artifacts);
                return { ...a, ...view, iconUrl: artifactIconUrl(a.artifactType) };
            }),
            artifactChanges: (0, game_profile_repo_js_1.getPlayerArtifactChanges)(clanId, playerId, since).map((c) => {
                const { name, rarity } = (0, artifacts_js_1.describeArtifact)(c.artifactType, c.level, c.star, [], names?.artifacts);
                return { ...c, name, rarity, iconUrl: artifactIconUrl(c.artifactType) };
            }),
            equipmentChanges: (0, game_profile_repo_js_1.getPlayerEquipmentChanges)(clanId, playerId, since).map((c) => ({
                ...c,
                name: c.itemType ? (0, equipment_js_1.describeItem)(c.itemType, 0, [], names).name : '',
                grade: c.itemType ? (0, equipment_js_1.describeItem)(c.itemType, 0, [], names).grade : 0,
                prevName: c.prevType ? (0, equipment_js_1.describeItem)(c.prevType, 0, [], names).name : null,
                iconUrl: c.itemType ? iconUrl(mappings?.equipment, c.itemType) : null,
            })),
        });
    });
    /**
     * The clan as the game's clan window shows it (Clan page): the Information
     * tab (tag, name, members / limit, might, founded, kingdom, capital, leader,
     * medals), wealth and help points with a daily history, the Clan Capital's
     * treasury, and the clan's research levels with their recent changes. The
     * trees themselves come from /tech-trees (kind 'clan').
     */
    router.get('/clan', async (req, res) => {
        const clanId = req.clanId;
        const info = (0, game_clan_repo_js_1.getClanInfo)(clanId);
        if (!info) {
            res.json({ linked: false });
            return;
        }
        const names = await (0, static_data_js_1.loadGameNames)().catch(() => null);
        const since = new Date(Date.now() - CHANGES_DAYS * 86_400_000).toISOString();
        const treasury = (0, game_clan_repo_js_1.getClanTreasury)(clanId);
        const icons = await (0, item_icons_js_1.itemIconUrls)(treasury.rows.map((r) => r.resourceId));
        res.json({
            linked: true,
            info: { ...info, leader: (0, game_clan_repo_js_1.getClanLeader)(clanId), logoUrl: (0, clan_logo_js_1.clanLogoUrl)(info.logo) },
            stats: (0, game_clan_repo_js_1.getLatestClanStats)(clanId),
            history: (0, game_clan_repo_js_1.getDailyClanStats)(clanId, since.slice(0, 10)),
            treasury: {
                ...treasury,
                // Each item's own icon, by id (Clan Shield of Peace, tournament proofs, …).
                rows: treasury.rows.map((r) => ({ ...r, name: names?.gifts?.[String(r.resourceId)]?.chest ?? '', iconUrl: icons.get(r.resourceId) ?? null })),
            },
            medals: (0, game_clan_repo_js_1.getClanMedals)(clanId).map((m) => {
                const g = names?.medals?.[String(m.medalId)];
                return {
                    ...m, name: g?.name ?? '', description: g?.description ?? '', tier: g?.tier ?? 0, tierName: g?.tierName ?? '',
                    iconUrl: g?.icon ? (0, index_js_1.gameArtUrl)((0, selection_js_1.safeArtName)(g.icon)) : null,
                };
            }),
            techs: { ...(0, game_clan_repo_js_1.getClanTechs)(clanId), changes: (0, game_clan_repo_js_1.getClanTechChanges)(clanId, since) },
        });
    });
    /**
     * The kingdom's clan rankings as the game's ranking window shows them: each
     * kind with its icon, the latest top-100 list (clans with their logo, tag,
     * name, members) and this clan's rank and value by game day. Loaded when the
     * Rankings tab opens.
     */
    router.get('/clan/rankings', (req, res) => {
        const clanId = req.clanId;
        const info = (0, game_clan_repo_js_1.getClanInfo)(clanId);
        const since = new Date(Date.now() - CHANGES_DAYS * 86_400_000).toISOString().slice(0, 10);
        const lists = new Map((0, game_clan_repo_js_1.getClanRankingLists)(clanId).map((l) => [l.kind, l]));
        res.json({
            gameClanId: info?.gameClanId ?? null,
            kinds: messages_js_1.CLAN_RANKING_KINDS.map((kind) => {
                const l = lists.get(kind);
                return {
                    kind,
                    iconUrl: (0, index_js_1.gameArtUrl)((0, selection_js_1.safeArtName)(selection_js_1.CLAN_RANKING_ICONS[kind] ?? '')),
                    capturedAt: l?.capturedAt ?? null,
                    entries: (l?.entries ?? []).map((e) => ({ ...e, logoUrl: (0, clan_logo_js_1.clanLogoUrl)(e.logo) })),
                };
            }),
            history: (0, game_clan_repo_js_1.getClanRankHistory)(clanId, since),
        });
    });
    /** memberId → hero avatar id and a few headline game facts, for avatars in lists. */
    router.get('/roster', (req, res) => {
        const clanId = req.clanId;
        const tiers = (0, member_tiers_js_1.getMemberTiers)(clanId);
        const out = {};
        for (const [memberId, p] of (0, game_profile_repo_js_1.getGamePlayersByMember)(clanId)) {
            out[memberId] = {
                heroAvatar: p.heroAvatar, avatarUrl: p.avatarUrl, frameUrl: p.frameUrl, heroLevel: p.heroLevel, role: p.role, goldPass: p.goldPass, vip: p.vip, cityLevel: p.cityLevel,
                tiers: tiers.get(memberId)?.tiers ?? null,
            };
        }
        res.json({ members: out });
    });
    /**
     * The game's research and talent trees (names, layout, prerequisites), for
     * drawing a member's levels. The same for every clan; the client caches it by
     * `version`.
     */
    router.get('/tech-trees', async (_req, res) => {
        try {
            res.json(treesWithIcons(await (0, tech_trees_js_1.loadTechTrees)()));
        }
        catch {
            res.status(503).json({ error: 'Research trees are not available yet' });
        }
    });
    return router;
}
//# sourceMappingURL=game.js.map