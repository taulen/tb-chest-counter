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
const game_player_names_js_1 = require("../../data/game-player-names.js");
const member_repo_js_1 = require("../../data/repositories/member-repo.js");
const game_profile_repo_js_1 = require("../../data/repositories/game-profile-repo.js");
const titles_js_1 = require("../../game-protocol/titles.js");
const game_clan_repo_js_1 = require("../../data/repositories/game-clan-repo.js");
const member_tiers_js_1 = require("../../data/member-tiers.js");
const avatar_repo_js_1 = require("../../data/repositories/avatar-repo.js");
const account_invite_repo_js_1 = require("../../data/repositories/account-invite-repo.js");
const roster_changes_js_1 = require("../../data/roster-changes.js");
const roster_changes_repo_js_1 = require("../../data/repositories/roster-changes-repo.js");
const member_timeline_js_1 = require("../../data/member-timeline.js");
const index_js_1 = require("../../config/index.js");
const tech_trees_js_1 = require("../../game-protocol/tech-trees.js");
const static_data_js_1 = require("../../game-protocol/static-data.js");
const index_js_2 = require("../../game-art/index.js");
const selection_js_1 = require("../../game-art/selection.js");
const clan_logo_js_1 = require("../../game-art/clan-logo.js");
const item_icons_js_1 = require("../../game-art/item-icons.js");
const messages_js_1 = require("../../game-protocol/messages.js");
const artifacts_js_1 = require("../../game-protocol/artifacts.js");
const equipment_js_1 = require("../../game-protocol/equipment.js");
const event_mapping_js_1 = require("../../game-protocol/event-mapping.js");
const olympus_js_1 = require("../../game-protocol/olympus.js");
const game_event_repo_js_1 = require("../../data/repositories/game-event-repo.js");
const hero_levels_js_1 = require("../../game-protocol/hero-levels.js");
const factions_js_1 = require("../../game-protocol/factions.js");
const dragon_js_1 = require("../../game-protocol/dragon.js");
/**
 * The trees with each tree's and node's sprite as a URL (the game's own icon
 * from the art pipeline), memoised per trees + art version.
 */
let withIconsMemo = null;
function treesWithIcons(trees) {
    const art = (0, index_js_2.currentGameArt)();
    const key = `${trees.version}|${art?.version ?? ''}`;
    if (withIconsMemo?.key === key)
        return withIconsMemo.value;
    const techIcons = art?.mappings?.techs ?? {};
    const value = {
        ...trees,
        trees: trees.trees.map((tr) => ({
            ...tr,
            // Image names are safeArtName forms (lower case); the tree data keeps the game's spelling.
            iconUrl: tr.icon ? (0, index_js_2.gameArtUrl)((0, selection_js_1.safeArtName)(tr.icon)) : null,
            nodes: tr.nodes.map((n) => {
                const name = techIcons[String(n.techId)] ?? (n.icon ? (0, selection_js_1.safeArtName)(n.icon) : '');
                return { ...n, iconUrl: name ? (0, index_js_2.gameArtUrl)(name) : null };
            }),
        })),
    };
    withIconsMemo = { key, value };
    return value;
}
const CHANGES_DAYS = 90;
/** Joins & leaves: a page, the most one request may ask for, and the header's window. */
const ROSTER_PAGE_DEFAULT = 50;
const ROSTER_PAGE_MAX = 200;
const ROSTER_COUNT_DAYS = 30;
/** A stored event run as the API sends it: the site's event key when the catalog knows the title. */
function eventRunApi(r, nowSec) {
    return {
        type: r.eventType,
        run: r.run,
        occurrence: r.occurrence,
        code: r.code,
        title: r.title,
        /** The event it is a run of (Events → In-game rankings ?event=). */
        group: (0, game_event_repo_js_1.eventGroupKey)(r),
        /** One of the short rotating tournaments (2–5 h). */
        short: (0, game_event_repo_js_1.isShortRun)(r),
        eventKey: (0, event_mapping_js_1.catalogKeyForEventTitle)(r.title),
        /** Ranked across its matchup (Sealed in Flame): ranks are the game's Ranking tab's, members outside its top 100 have none. */
        matchupRanked: (0, olympus_js_1.isMatchupRankedRun)(r),
        startsAt: r.startsAt ? new Date(r.startsAt * 1000).toISOString() : null,
        endsAt: r.endsAt ? new Date(r.endsAt * 1000).toISOString() : null,
        live: (r.startsAt ?? 0) <= nowSec && (r.endsAt === null || r.endsAt > nowSec),
        readAt: r.lastRead,
    };
}
/** game player id → the name the site shows (the linked member's) and the member id, for event standings. */
const playerNames = game_player_names_js_1.gamePlayerNames;
/**
 * names.json for the profile header (its titles). loadGameNames asks the
 * game's versions endpoint every call, and the header is on every profile
 * view: once names are in hand they are served at once and refreshed in the
 * background at most every 10 minutes. Only the very first call waits.
 */
const HEADER_NAMES_TTL_MS = 10 * 60_000;
let headerNamesCache = { at: 0, names: null, refreshing: null };
async function headerGameNames() {
    const c = headerNamesCache;
    if (c.names && Date.now() - c.at < HEADER_NAMES_TTL_MS)
        return c.names;
    if (!c.refreshing) {
        c.refreshing = (0, static_data_js_1.loadGameNames)()
            .then((n) => { headerNamesCache = { at: Date.now(), names: n, refreshing: null }; return n; })
            .catch(() => { headerNamesCache = { ...headerNamesCache, at: Date.now(), refreshing: null }; return headerNamesCache.names; });
    }
    return c.names ?? c.refreshing;
}
function createGameRouter() {
    const router = (0, express_1.Router)();
    /** Profile header data for one member. */
    router.get('/members/:memberId', async (req, res) => {
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
        // The titles they hold (402 field 19 / city field 21), still running:
        // names, bonus texts and durations from the titles table (T29), the
        // game's round icon and picture when extracted.
        const names = await headerGameNames();
        const art = (0, index_js_2.currentGameArt)()?.mappings;
        const titleUrl = (map) => (id) => {
            const img = map?.[String(id)];
            return img ? (0, index_js_2.gameArtUrl)(img) : null;
        };
        res.json({
            linked: true,
            player: (0, game_profile_repo_js_1.getGamePlayer)(clanId, playerId),
            // The photo the player's own account uploaded (the profile shows it before the hero portrait), or null.
            photoUrl: (0, avatar_repo_js_1.photoUrlForPlayer)(playerId),
            city: (0, game_profile_repo_js_1.getLatestCity)(clanId, playerId),
            // G/S/E/M tiers and crypt level from the member's research (null until read).
            tiers: (0, member_tiers_js_1.getMemberTiers)(clanId).get(memberId) ?? null,
            titles: (0, titles_js_1.titleViews)(names, (0, game_profile_repo_js_1.getPlayerTitles)(clanId, playerId), Math.floor(Date.now() / 1000), {
                icon: titleUrl(art?.titles),
                art: titleUrl(art?.titleArt),
            }),
        });
    });
    /**
     * A member's Gold Ingots: the current value and one reading per game day
     * (the Might tab's chart). `days` bounds the history; 0 or absent = all of it.
     */
    router.get('/members/:memberId/gold-ingots', (req, res) => {
        const clanId = req.clanId;
        const memberId = Number.parseInt(String(req.params.memberId), 10);
        if (!Number.isFinite(memberId) || !(0, member_repo_js_1.getMemberById)(memberId, clanId)) {
            res.status(404).json({ error: 'Member not found' });
            return;
        }
        const playerId = (0, game_profile_repo_js_1.gamePlayerIdForMember)(memberId, clanId);
        if (playerId === null) {
            res.json({ linked: false, current: null, readAt: null, points: [] });
            return;
        }
        const days = Math.min(Math.max(Number.parseInt(String(req.query.days ?? '0'), 10) || 0, 0), 3650);
        const since = days > 0 ? new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10) : '';
        res.json({ linked: true, ...(0, game_profile_repo_js_1.getPlayerGoldIngotsDaily)(clanId, playerId, since) });
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
            res.json({ linked: false, hero: null, dragon: null, hallOfFame: null, captains: [], changes: [], artifacts: [], artifactChanges: [], equipmentChanges: [] });
            return;
        }
        const names = await (0, static_data_js_1.loadGameNames)().catch(() => null);
        const mappings = (0, index_js_2.currentGameArt)()?.mappings;
        const portraits = mappings?.captains ?? {};
        // Artifact / equipment / gem icons from the game's bundles, null until extracted.
        const iconUrl = (map, id) => {
            const img = map?.[String(id)];
            return img ? (0, index_js_2.gameArtUrl)(img) : null;
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
                iconUrl: portrait ? (0, index_js_2.gameArtUrl)(portrait) : null,
                artUrl: full ? (0, index_js_2.gameArtUrl)(full) : c?.art ? (0, index_js_2.gameArtUrl)((0, selection_js_1.safeArtName)(c.art)) : null,
                tileBackUrl: tile?.backs?.[String(rarity)] ? (0, index_js_2.gameArtUrl)(tile.backs[String(rarity)]) : null,
                tileFrameUrl: tile?.frames?.[String(rarity)] ? (0, index_js_2.gameArtUrl)(tile.frames[String(rarity)]) : null,
            };
        };
        const since = new Date(Date.now() - CHANGES_DAYS * 86_400_000).toISOString();
        // The hero leads the tab: its portrait in the player's frame with the
        // level plate, its level / XP and what it wears — all city field 9's
        // entry id 1 (level / XP stored since Nov 2026; the player record's hero
        // level until then). NOT city field 26: that is the dragon. The player
        // record is read every scan, the city once a day: its level is the
        // fresher one, and the entry's XP only counts while it is at that level.
        const player = (0, game_profile_repo_js_1.getGamePlayer)(clanId, playerId);
        const heroEntry = (0, game_profile_repo_js_1.getPlayerHeroEntry)(clanId, playerId);
        const heroLevel = player?.heroLevel ?? heroEntry?.level ?? null;
        const heroXp = heroEntry && heroEntry.level === heroLevel ? heroEntry.xp : null;
        const heroView = heroLevel !== null && heroXp !== null ? (0, hero_levels_js_1.heroLevelView)(names, equipment_js_1.HERO_ENTRY_ID, heroLevel, 0, false) : null;
        const hero = player ? {
            name: names?.heroes?.[String(player.heroAvatar)]?.name || null,
            level: heroLevel,
            heroLevel,
            xp: heroXp,
            xpFloor: heroView?.xpFloor ?? null,
            xpNext: heroView?.xpNext ?? null,
            avatarUrl: player.avatarUrl,
            frameUrl: player.frameUrl,
            firstSeen: heroEntry?.firstSeen ?? null,
            // Level-ups from the player record (the hero has no captain history rows).
            changes: (0, game_profile_repo_js_1.getPlayerHeroLevelChanges)(clanId, playerId, since),
            equipment: gear.get(equipment_js_1.HERO_ENTRY_ID) ?? [],
            gearSlots: equipment_js_1.HERO_GEAR_POSITIONS,
        } : null;
        // The Hall of Fame: faction levels are city techs 800–803 (factions.ts).
        const techs = (0, game_profile_repo_js_1.getPlayerTechs)(clanId, playerId);
        const hallOfFame = (0, factions_js_1.hallOfFameView)(names, techs.readAt ? techs.levels : null, (n) => (0, index_js_2.gameArtUrl)((0, selection_js_1.safeArtName)(n)));
        // The dragon: city field 26 of the latest daily city snapshot, on the
        // Dragons table's levels and evolutions (dragon.ts).
        const city = (0, game_profile_repo_js_1.getLatestCity)(clanId, playerId);
        const dragon = city ? (0, dragon_js_1.dragonView)(names, city.dragon, (n) => (0, index_js_2.gameArtUrl)((0, selection_js_1.safeArtName)(n))) : null;
        res.json({
            linked: true,
            hero,
            dragon: dragon ? { ...dragon, readAt: city?.capturedAt ?? null } : null,
            hallOfFame,
            // Shared tile art: the level plate and the star sprites (null until extracted).
            tileArt: {
                levelPlateUrl: tile?.levelPlate ? (0, index_js_2.gameArtUrl)(tile.levelPlate) : null,
                starOnUrl: tile?.starOn ? (0, index_js_2.gameArtUrl)(tile.starOn) : null,
                starOffUrl: tile?.starOff ? (0, index_js_2.gameArtUrl)(tile.starOff) : null,
            },
            captains: (0, game_profile_repo_js_1.getPlayerCaptains)(clanId, playerId).map((c) => {
                // The XP window of its level and the Stats screen (Heroes table, T10).
                const view = (0, hero_levels_js_1.heroLevelView)(names, c.captainId, c.level, c.stars);
                return {
                    ...c,
                    ...describe(c.captainId),
                    xpFloor: view?.xpFloor ?? null,
                    xpNext: view?.xpNext ?? null,
                    stats: view?.stats ?? null,
                    starBonuses: names?.captains?.[String(c.captainId)]?.stars?.[String(c.stars)] ?? [],
                    equipment: gear.get(c.captainId) ?? [],
                    gearSlots: equipment_js_1.CAPTAIN_GEAR_POSITIONS,
                };
            }),
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
     * Event standings read from the game (Events → In-game rankings).
     * `events`: every event the scans saw standings for, one entry each (the
     * picker), less the nameless ones nobody scored in (listableEventRuns). `runs`, newest first: `?event=<group>` every run of that event;
     * else the runs overlapping `?from=&to=` (ISO; the last 7 days without
     * them). Each run carries its head count and leader, never its standings
     * (/events/standings).
     */
    router.get('/events', (req, res) => {
        const clanId = req.clanId;
        const nowSec = Math.floor(Date.now() / 1000);
        const q = req.query;
        const all = (0, game_event_repo_js_1.listableEventRuns)(clanId, (0, game_event_repo_js_1.listEventRuns)(clanId));
        const events = (0, game_event_repo_js_1.groupEventRuns)(all).map((g) => ({ ...g, eventKey: (0, event_mapping_js_1.catalogKeyForEventTitle)(g.title) }));
        let picked;
        if (q.event) {
            picked = all.filter((r) => (0, game_event_repo_js_1.eventGroupKey)(r) === q.event);
        }
        else {
            let from = q.from ? Math.floor(Date.parse(q.from) / 1000) : NaN;
            let to = q.to ? Math.ceil(Date.parse(q.to) / 1000) : NaN;
            if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
                from = nowSec - 7 * 86_400;
                to = nowSec + 1;
            }
            picked = all.filter((r) => (r.startsAt ?? 0) < to && (r.endsAt === null || r.endsAt > from));
        }
        const summaries = (0, game_event_repo_js_1.summarizeEventRuns)(clanId, picked);
        const names = playerNames(clanId, [...new Set(summaries.flatMap((s) => (s.leader ? [s.leader.playerId] : [])))]);
        res.json({
            events,
            runs: summaries.map((s) => ({
                ...eventRunApi(s, nowSec),
                members: s.members,
                withPoints: s.withPoints,
                leader: s.leader ? { points: s.leader.points, ...names.get(s.leader.playerId) } : null,
            })),
        });
    });
    /**
     * One run's standings: `?type=&run=&occurrence=`, or `?event=<catalog key>`
     * (+ optional `from`/`to` ISO window: the run overlapping it; else the
     * newest run of that event). Each row carries the member it links to and
     * the points before its last change (null on the run's first read).
     */
    router.get('/events/standings', (req, res) => {
        const clanId = req.clanId;
        const nowSec = Math.floor(Date.now() / 1000);
        const q = req.query;
        let run = null;
        if (q.type && q.run && q.occurrence) {
            const key = { eventType: Number(q.type), run: Number(q.run), occurrence: Number(q.occurrence) };
            if ([key.eventType, key.run, key.occurrence].every(Number.isInteger))
                run = (0, game_event_repo_js_1.getEventRun)(clanId, key);
        }
        else if (q.event) {
            const from = q.from ? Date.parse(q.from) / 1000 : NaN;
            const to = q.to ? Date.parse(q.to) / 1000 : NaN;
            const candidates = (0, game_event_repo_js_1.listEventRuns)(clanId).filter((r) => (0, event_mapping_js_1.catalogKeyForEventTitle)(r.title) === q.event);
            run = (Number.isFinite(from) && Number.isFinite(to)
                ? candidates.find((r) => (r.startsAt ?? 0) < to && (r.endsAt ?? Number.MAX_SAFE_INTEGER) > from)
                : candidates[0]) ?? null;
        }
        if (!run) {
            res.json({ run: null, standings: [] });
            return;
        }
        const standings = (0, game_event_repo_js_1.getEventStandings)(clanId, run);
        const names = playerNames(clanId, standings.map((s) => s.playerId));
        res.json({
            run: eventRunApi(run, nowSec),
            standings: standings.map((s) => ({
                // 0 = no rank (outside a matchup-ranked run's top 100).
                rank: s.rank || null,
                points: s.points,
                previousPoints: s.previousPoints,
                changedAt: s.changedAt,
                ...names.get(s.playerId),
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
                    iconUrl: g?.icon ? (0, index_js_2.gameArtUrl)((0, selection_js_1.safeArtName)(g.icon)) : null,
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
                    iconUrl: (0, index_js_2.gameArtUrl)((0, selection_js_1.safeArtName)(selection_js_1.CLAN_RANKING_ICONS[kind] ?? '')),
                    capturedAt: l?.capturedAt ?? null,
                    entries: (l?.entries ?? []).map((e) => ({ ...e, logoUrl: (0, clan_logo_js_1.clanLogoUrl)(e.logo) })),
                };
            }),
            history: (0, game_clan_repo_js_1.getClanRankHistory)(clanId, since),
        });
    });
    /**
     * In-game rank changes (Home → roster changes): every promotion or demotion
     * in the clan over the last `?days=` (1–30, default 7), newest first, with
     * the member each links to. Ranks are numbers (1 Leader … 5 Soldier); the
     * page names them with the game's own words.
     */
    router.get('/clan/rank-changes', (req, res) => {
        const clanId = req.clanId;
        const days = Math.min(30, Math.max(1, Number.parseInt(String(req.query.days ?? '7'), 10) || 7));
        const since = new Date(Date.now() - days * 86_400_000).toISOString();
        res.json({ days, entries: (0, roster_changes_repo_js_1.recentRankChanges)(clanId, since) });
    });
    /**
     * Joins & leaves (My Clan): who joined the clan, who left, who came back,
     * newest first — the rules are data/roster-changes.ts's. `?filter=joined|left`,
     * `?q=` part of a name, `?before=` the cursor of the last entry shown,
     * `?limit=`. `counts` are the last 30 days' whatever the filter, and
     * `readSince` is the game's first read of the roster (join times exist for
     * everyone in the clan from then on). Each entry carries the player's
     * portrait and frame when the game has them.
     */
    router.get('/clan/roster-changes', (req, res) => {
        const clanId = req.clanId;
        const all = (0, roster_changes_js_1.buildRosterChanges)((0, roster_changes_repo_js_1.loadRosterSources)(clanId), (0, index_js_1.loadConfig)().gameDayRolloverUtcHour);
        const filter = req.query.filter === 'joined' || req.query.filter === 'left' ? req.query.filter : null;
        const query = typeof req.query.q === 'string' ? req.query.q.slice(0, 80) : '';
        const list = (0, roster_changes_js_1.filterRosterChanges)(all, { filter, query });
        const limit = Math.min(Math.max(Number.parseInt(String(req.query.limit ?? ''), 10) || ROSTER_PAGE_DEFAULT, 1), ROSTER_PAGE_MAX);
        const page = (0, member_timeline_js_1.pageNewestFirst)(list, { before: typeof req.query.before === 'string' ? req.query.before.slice(0, 200) : null, limit });
        // The portrait: a join's own player (an alt's is its own), else the member's.
        const byMember = (0, game_profile_repo_js_1.getGamePlayersByMember)(clanId);
        const byPlayer = new Map([...byMember.values()].map((p) => [p.playerId, p]));
        const profileOf = (e) => (e.playerId !== null
            ? byPlayer.get(e.playerId) ?? (0, game_profile_repo_js_1.getGamePlayer)(clanId, e.playerId)
            : e.memberId !== null ? byMember.get(e.memberId) ?? null : null);
        const since = new Date(Date.now() - ROSTER_COUNT_DAYS * 86_400_000).toISOString();
        res.json({
            entries: page.entries.map((e) => {
                const p = profileOf(e);
                return { ...e, avatarUrl: p?.avatarUrl ?? null, frameUrl: p?.frameUrl ?? null, heroLevel: p?.heroLevel ?? null };
            }),
            next: page.next,
            total: list.length,
            counts: { days: ROSTER_COUNT_DAYS, ...(0, roster_changes_js_1.countRosterChanges)(all, since) },
            readSince: (0, roster_changes_repo_js_1.rosterReadSince)(clanId),
        });
    });
    /** memberId → hero avatar id and a few headline game facts, for avatars in lists. */
    router.get('/roster', (req, res) => {
        const clanId = req.clanId;
        const tiers = (0, member_tiers_js_1.getMemberTiers)(clanId);
        // The picture a member shows (Members board): the linked account's own
        // photo, else the hero portrait, else the initial — avatar-repo's order.
        const photos = (0, avatar_repo_js_1.linkedPhotoUrlsForClan)(clanId);
        // Which members are the signed-in account's own players (alts too), for the board's "You".
        const mine = new Set(req.user ? (0, account_invite_repo_js_1.linkedPlayerIds)(req.user.id, clanId) : []);
        const out = {};
        for (const [memberId, p] of (0, game_profile_repo_js_1.getGamePlayersByMember)(clanId)) {
            out[memberId] = {
                heroAvatar: p.heroAvatar, avatarUrl: p.avatarUrl, frameUrl: p.frameUrl, heroLevel: p.heroLevel, role: p.role, goldPass: p.goldPass, vip: p.vip, cityLevel: p.cityLevel,
                tiers: tiers.get(memberId)?.tiers ?? null,
                avatar: (0, avatar_repo_js_1.resolveMemberAvatar)(p.name, p.avatarUrl, photos.get(p.playerId) ?? null),
                isYou: mine.has(p.playerId),
                joinedAt: p.joinedAt, burning: p.burning, mapSeenAt: p.mapSeenAt, might: p.might,
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