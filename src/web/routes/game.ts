/**
 * Read API for what the game protocol collects about players: the profile
 * header (role, joined, city level, VIP, Gold Pass, hero), research and hero
 * talents with their change history, and per-member hero avatars for lists.
 *
 * Mounted at /api/game behind requireAuth + requireClanContext, so `req.clanId`
 * is the caller's active clan and every query is scoped to it. A member that is
 * not linked to a game player yet answers `{ linked: false }`, not an error.
 */
import { Router } from 'express';
import { getMemberById } from '../../data/repositories/member-repo.js';
import {
  gamePlayerIdForMember,
  getGamePlayer,
  getGamePlayersByMember,
  getLatestCity,
  getPlayerArtifactChanges,
  getPlayerArtifacts,
  getPlayerCaptainChanges,
  getPlayerCaptains,
  getPlayerEquipment,
  getPlayerEquipmentChanges,
  getPlayerGoldIngotsDaily,
  getPlayerTechChanges,
  getPlayerTechs,
} from '../../data/repositories/game-profile-repo.js';
import {
  getClanInfo,
  getClanRankHistory,
  getClanRankingLists,
  getClanLeader,
  getClanMedals,
  getClanTechChanges,
  getClanTechs,
  getClanTreasury,
  getDailyClanStats,
  getLatestClanStats,
} from '../../data/repositories/game-clan-repo.js';
import { getMemberTiers } from '../../data/member-tiers.js';
import { loadTechTrees, type TechTrees } from '../../game-protocol/tech-trees.js';
import { loadGameNames } from '../../game-protocol/static-data.js';
import { currentGameArt, gameArtUrl } from '../../game-art/index.js';
import { CLAN_RANKING_ICONS, safeArtName } from '../../game-art/selection.js';
import { clanLogoUrl } from '../../game-art/clan-logo.js';
import { itemIconUrls } from '../../game-art/item-icons.js';
import { CLAN_RANKING_KINDS } from '../../game-protocol/messages.js';
import { describeArtifact } from '../../game-protocol/artifacts.js';
import { describeItem, HERO_ENTRY_ID } from '../../game-protocol/equipment.js';

/**
 * The trees with each tree's and node's sprite as a URL (the game's own icon
 * from the art pipeline), memoised per trees + art version.
 */
let withIconsMemo: { key: string; value: unknown } | null = null;
function treesWithIcons(trees: TechTrees): unknown {
  const art = currentGameArt();
  const key = `${trees.version}|${art?.version ?? ''}`;
  if (withIconsMemo?.key === key) return withIconsMemo.value;
  const techIcons = art?.mappings?.techs ?? {};
  const value = {
    ...trees,
    trees: trees.trees.map((tr) => ({
      ...tr,
      iconUrl: tr.icon ? gameArtUrl(tr.icon) : null,
      nodes: tr.nodes.map((n) => {
        const name = techIcons[String(n.techId)] ?? n.icon;
        return { ...n, iconUrl: name ? gameArtUrl(name) : null };
      }),
    })),
  };
  withIconsMemo = { key, value };
  return value;
}

const CHANGES_DAYS = 90;

export function createGameRouter(): Router {
  const router = Router();

  /** Profile header data for one member. */
  router.get('/members/:memberId', (req, res) => {
    const clanId = req.clanId!;
    const memberId = Number.parseInt(String(req.params.memberId), 10);
    if (!Number.isFinite(memberId) || !getMemberById(memberId, clanId)) {
      res.status(404).json({ error: 'Member not found' });
      return;
    }
    const playerId = gamePlayerIdForMember(memberId, clanId);
    if (playerId === null) {
      res.json({ linked: false });
      return;
    }
    res.json({
      linked: true,
      player: getGamePlayer(clanId, playerId),
      city: getLatestCity(clanId, playerId),
      // G/S/E/M tiers and crypt level from the member's research (null until read).
      tiers: getMemberTiers(clanId).get(memberId) ?? null,
    });
  });

  /**
   * A member's Gold Ingots: the current value and one reading per game day
   * (the Might tab's chart). `days` bounds the history; 0 or absent = all of it.
   */
  router.get('/members/:memberId/gold-ingots', (req, res) => {
    const clanId = req.clanId!;
    const memberId = Number.parseInt(String(req.params.memberId), 10);
    if (!Number.isFinite(memberId) || !getMemberById(memberId, clanId)) {
      res.status(404).json({ error: 'Member not found' });
      return;
    }
    const playerId = gamePlayerIdForMember(memberId, clanId);
    if (playerId === null) {
      res.json({ linked: false, current: null, readAt: null, points: [] });
      return;
    }
    const days = Math.min(Math.max(Number.parseInt(String(req.query.days ?? '0'), 10) || 0, 0), 3650);
    const since = days > 0 ? new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10) : '';
    res.json({ linked: true, ...getPlayerGoldIngotsDaily(clanId, playerId, since) });
  });

  /** Research + hero talent levels for one member, and their recent changes. */
  router.get('/members/:memberId/techs', (req, res) => {
    const clanId = req.clanId!;
    const memberId = Number.parseInt(String(req.params.memberId), 10);
    if (!Number.isFinite(memberId) || !getMemberById(memberId, clanId)) {
      res.status(404).json({ error: 'Member not found' });
      return;
    }
    const playerId = gamePlayerIdForMember(memberId, clanId);
    if (playerId === null) {
      res.json({ linked: false, levels: {}, readAt: null, changes: [] });
      return;
    }
    const { levels, readAt } = getPlayerTechs(clanId, playerId);
    const since = new Date(Date.now() - CHANGES_DAYS * 86_400_000).toISOString();
    res.json({ linked: true, levels, readAt, changes: getPlayerTechChanges(clanId, playerId, since) });
  });

  /**
   * A member's captains as the game's Captains screen shows them — level, star
   * level, active line-up slot — with the portrait, full artwork, rarity and
   * the current star level's bonuses; plus recent level/star changes.
   */
  router.get('/members/:memberId/captains', async (req, res) => {
    const clanId = req.clanId!;
    const memberId = Number.parseInt(String(req.params.memberId), 10);
    if (!Number.isFinite(memberId) || !getMemberById(memberId, clanId)) {
      res.status(404).json({ error: 'Member not found' });
      return;
    }
    const playerId = gamePlayerIdForMember(memberId, clanId);
    if (playerId === null) {
      res.json({ linked: false, hero: null, captains: [], changes: [], artifacts: [], artifactChanges: [], equipmentChanges: [] });
      return;
    }
    const names = await loadGameNames().catch(() => null);
    const mappings = currentGameArt()?.mappings;
    const portraits = mappings?.captains ?? {};
    // Artifact / equipment / gem icons from the game's bundles, null until extracted.
    const iconUrl = (map: Record<string, string> | undefined, id: number): string | null => {
      const img = map?.[String(id)];
      return img ? gameArtUrl(img) : null;
    };
    const artifactIconUrl = (type: number) => iconUrl(mappings?.artifacts, type);
    const itemView = (type: number, enchantment: number, gems: number[]) => {
      const { icon: _icon, ...v } = describeItem(type, enchantment, gems, names);
      return {
        ...v,
        iconUrl: iconUrl(mappings?.equipment, type),
        enchantment: v.enchantment ? { ...v.enchantment, iconUrl: iconUrl(mappings?.inserts, v.enchantment.id) } : null,
        gems: v.gems.map((g) => ({ ...g, iconUrl: iconUrl(mappings?.inserts, g.id) })),
      };
    };
    // Every captain's worn items (city fields 9 + 10), by captain.
    const gear = new Map<number, unknown[]>();
    for (const it of getPlayerEquipment(clanId, playerId)) {
      if (!gear.has(it.captainId)) gear.set(it.captainId, []);
      gear.get(it.captainId)!.push({ position: it.position, itemType: it.itemType, firstSeen: it.firstSeen, ...itemView(it.itemType, it.enchantment, it.gems) });
    }
    // The game's captain tile pieces (rarity back + frame, level plate, stars)
    // and the captain screen's full-body art (carter_scaled), when extracted.
    const tile = mappings?.captainTile;
    const fullArt = mappings?.captainArt ?? {};
    const describe = (id: number) => {
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
        iconUrl: portrait ? gameArtUrl(portrait) : null,
        artUrl: full ? gameArtUrl(full) : c?.art ? gameArtUrl(safeArtName(c.art)) : null,
        tileBackUrl: tile?.backs?.[String(rarity)] ? gameArtUrl(tile.backs[String(rarity)]) : null,
        tileFrameUrl: tile?.frames?.[String(rarity)] ? gameArtUrl(tile.frames[String(rarity)]) : null,
      };
    };
    const since = new Date(Date.now() - CHANGES_DAYS * 86_400_000).toISOString();
    // The hero leads the tab: its portrait in the player's frame with the
    // level plate, its level / XP (the city's hero record) and what it wears
    // (city field 9's entry id 1 — gear tracked since Nov 2026).
    const player = getGamePlayer(clanId, playerId);
    const cityHero = getLatestCity(clanId, playerId)?.hero;
    const heroLevel = cityHero?.level ?? player?.heroLevel ?? null;
    const hero = player ? {
      name: names?.heroes?.[String(player.heroAvatar)]?.name || null,
      level: heroLevel,
      heroLevel,
      xp: cityHero?.xp ?? null,
      avatarUrl: player.avatarUrl,
      frameUrl: player.frameUrl,
      equipment: gear.get(HERO_ENTRY_ID) ?? [],
    } : null;
    res.json({
      linked: true,
      hero,
      // Shared tile art: the level plate and the star sprites (null until extracted).
      tileArt: {
        levelPlateUrl: tile?.levelPlate ? gameArtUrl(tile.levelPlate) : null,
        starOnUrl: tile?.starOn ? gameArtUrl(tile.starOn) : null,
        starOffUrl: tile?.starOff ? gameArtUrl(tile.starOff) : null,
      },
      captains: getPlayerCaptains(clanId, playerId).map((c) => ({
        ...c,
        ...describe(c.captainId),
        starBonuses: names?.captains?.[String(c.captainId)]?.stars?.[String(c.stars)] ?? [],
        equipment: gear.get(c.captainId) ?? [],
      })),
      changes: getPlayerCaptainChanges(clanId, playerId, since).map((c) => {
        const { name, iconUrl } = describe(c.captainId);
        return { ...c, name, iconUrl };
      }),
      // The artifacts the line-up captains wear (city field 14): what the
      // game's artifact book shows for each, at its level / star level / rolls.
      artifacts: getPlayerArtifacts(clanId, playerId).map((a) => {
        const { icon: _icon, ...view } = describeArtifact(a.artifactType, a.level, a.star, a.bonuses, names?.artifacts);
        return { ...a, ...view, iconUrl: artifactIconUrl(a.artifactType) };
      }),
      artifactChanges: getPlayerArtifactChanges(clanId, playerId, since).map((c) => {
        const { name, rarity } = describeArtifact(c.artifactType, c.level, c.star, [], names?.artifacts);
        return { ...c, name, rarity, iconUrl: artifactIconUrl(c.artifactType) };
      }),
      equipmentChanges: getPlayerEquipmentChanges(clanId, playerId, since).map((c) => ({
        ...c,
        name: c.itemType ? describeItem(c.itemType, 0, [], names).name : '',
        grade: c.itemType ? describeItem(c.itemType, 0, [], names).grade : 0,
        prevName: c.prevType ? describeItem(c.prevType, 0, [], names).name : null,
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
    const clanId = req.clanId!;
    const info = getClanInfo(clanId);
    if (!info) {
      res.json({ linked: false });
      return;
    }
    const names = await loadGameNames().catch(() => null);
    const since = new Date(Date.now() - CHANGES_DAYS * 86_400_000).toISOString();
    const treasury = getClanTreasury(clanId);
    const icons = await itemIconUrls(treasury.rows.map((r) => r.resourceId));
    res.json({
      linked: true,
      info: { ...info, leader: getClanLeader(clanId), logoUrl: clanLogoUrl(info.logo) },
      stats: getLatestClanStats(clanId),
      history: getDailyClanStats(clanId, since.slice(0, 10)),
      treasury: {
        ...treasury,
        // Each item's own icon, by id (Clan Shield of Peace, tournament proofs, …).
        rows: treasury.rows.map((r) => ({ ...r, name: names?.gifts?.[String(r.resourceId)]?.chest ?? '', iconUrl: icons.get(r.resourceId) ?? null })),
      },
      medals: getClanMedals(clanId).map((m) => {
        const g = names?.medals?.[String(m.medalId)];
        return {
          ...m, name: g?.name ?? '', description: g?.description ?? '', tier: g?.tier ?? 0, tierName: g?.tierName ?? '',
          iconUrl: g?.icon ? gameArtUrl(safeArtName(g.icon)) : null,
        };
      }),
      techs: { ...getClanTechs(clanId), changes: getClanTechChanges(clanId, since) },
    });
  });

  /**
   * The kingdom's clan rankings as the game's ranking window shows them: each
   * kind with its icon, the latest top-100 list (clans with their logo, tag,
   * name, members) and this clan's rank and value by game day. Loaded when the
   * Rankings tab opens.
   */
  router.get('/clan/rankings', (req, res) => {
    const clanId = req.clanId!;
    const info = getClanInfo(clanId);
    const since = new Date(Date.now() - CHANGES_DAYS * 86_400_000).toISOString().slice(0, 10);
    const lists = new Map(getClanRankingLists(clanId).map((l) => [l.kind, l]));
    res.json({
      gameClanId: info?.gameClanId ?? null,
      kinds: CLAN_RANKING_KINDS.map((kind) => {
        const l = lists.get(kind);
        return {
          kind,
          iconUrl: gameArtUrl(safeArtName(CLAN_RANKING_ICONS[kind] ?? '')),
          capturedAt: l?.capturedAt ?? null,
          entries: (l?.entries ?? []).map((e) => ({ ...e, logoUrl: clanLogoUrl(e.logo) })),
        };
      }),
      history: getClanRankHistory(clanId, since),
    });
  });

  /** memberId → hero avatar id and a few headline game facts, for avatars in lists. */
  router.get('/roster', (req, res) => {
    const clanId = req.clanId!;
    const tiers = getMemberTiers(clanId);
    const out: Record<number, object> = {};
    for (const [memberId, p] of getGamePlayersByMember(clanId)) {
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
      res.json(treesWithIcons(await loadTechTrees()));
    } catch {
      res.status(503).json({ error: 'Research trees are not available yet' });
    }
  });

  return router;
}
