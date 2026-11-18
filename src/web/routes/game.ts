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
import { getDb } from '../../data/database.js';
import { gamePlayerNames } from '../../data/game-player-names.js';
import { getMemberById } from '../../data/repositories/member-repo.js';
import { photoUrlForPlayer } from '../../data/repositories/avatar-repo.js';
import {
  gamePlayerIdForMember,
  getGamePlayer,
  getGamePlayersByMember,
  getLatestCity,
  getPlayerArtifactChanges,
  getPlayerArtifacts,
  getPlayerCaptainChanges,
  getPlayerCaptains,
  getPlayerHeroEntry,
  getPlayerHeroLevelChanges,
  getPlayerEquipment,
  getPlayerEquipmentChanges,
  getPlayerGoldIngotsDaily,
  getPlayerTechChanges,
  getPlayerTechs,
  getPlayerTitles,
} from '../../data/repositories/game-profile-repo.js';
import { titleViews } from '../../game-protocol/titles.js';
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
import { buildRosterChanges, countRosterChanges, filterRosterChanges } from '../../data/roster-changes.js';
import { loadRosterSources, rosterReadSince } from '../../data/repositories/roster-changes-repo.js';
import { pageNewestFirst } from '../../data/member-timeline.js';
import { loadConfig } from '../../config/index.js';
import { loadTechTrees, type TechTrees } from '../../game-protocol/tech-trees.js';
import { loadGameNames, type GameNames } from '../../game-protocol/static-data.js';
import { currentGameArt, gameArtUrl } from '../../game-art/index.js';
import { CLAN_RANKING_ICONS, safeArtName } from '../../game-art/selection.js';
import { clanLogoUrl } from '../../game-art/clan-logo.js';
import { itemIconUrls } from '../../game-art/item-icons.js';
import { CLAN_RANKING_KINDS } from '../../game-protocol/messages.js';
import { describeArtifact } from '../../game-protocol/artifacts.js';
import { CAPTAIN_GEAR_POSITIONS, describeItem, HERO_ENTRY_ID, HERO_GEAR_POSITIONS } from '../../game-protocol/equipment.js';
import { catalogKeyForEventTitle } from '../../game-protocol/event-mapping.js';
import { getEventRun, getEventStandings, latestEventRuns, listEventRuns, type StoredEventRun } from '../../data/repositories/game-event-repo.js';
import { heroLevelView } from '../../game-protocol/hero-levels.js';
import { hallOfFameView } from '../../game-protocol/factions.js';
import { dragonView } from '../../game-protocol/dragon.js';

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
/** Joins & leaves: a page, the most one request may ask for, and the header's window. */
const ROSTER_PAGE_DEFAULT = 50;
const ROSTER_PAGE_MAX = 200;
const ROSTER_COUNT_DAYS = 30;

/** A stored event run as the API sends it: the site's event key when the catalog knows the title. */
function eventRunApi(r: StoredEventRun, nowSec: number) {
  return {
    type: r.eventType,
    run: r.run,
    occurrence: r.occurrence,
    code: r.code,
    title: r.title,
    eventKey: catalogKeyForEventTitle(r.title),
    startsAt: r.startsAt ? new Date(r.startsAt * 1000).toISOString() : null,
    endsAt: r.endsAt ? new Date(r.endsAt * 1000).toISOString() : null,
    live: (r.startsAt ?? 0) <= nowSec && (r.endsAt === null || r.endsAt > nowSec),
    readAt: r.lastRead,
  };
}

/** game player id → the name the site shows (the linked member's) and the member id, for event standings. */
const playerNames = gamePlayerNames;

/**
 * names.json for the profile header (its titles). loadGameNames asks the
 * game's versions endpoint every call, and the header is on every profile
 * view: once names are in hand they are served at once and refreshed in the
 * background at most every 10 minutes. Only the very first call waits.
 */
const HEADER_NAMES_TTL_MS = 10 * 60_000;
let headerNamesCache: { at: number; names: GameNames | null; refreshing: Promise<GameNames | null> | null } = { at: 0, names: null, refreshing: null };
async function headerGameNames(): Promise<GameNames | null> {
  const c = headerNamesCache;
  if (c.names && Date.now() - c.at < HEADER_NAMES_TTL_MS) return c.names;
  if (!c.refreshing) {
    c.refreshing = loadGameNames()
      .then((n) => { headerNamesCache = { at: Date.now(), names: n, refreshing: null }; return n; })
      .catch(() => { headerNamesCache = { ...headerNamesCache, at: Date.now(), refreshing: null }; return headerNamesCache.names; });
  }
  return c.names ?? c.refreshing;
}

export function createGameRouter(): Router {
  const router = Router();

  /** Profile header data for one member. */
  router.get('/members/:memberId', async (req, res) => {
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
    // The titles they hold (402 field 19 / city field 21), still running:
    // names, bonus texts and durations from the titles table (T29), the
    // game's round icon and picture when extracted.
    const names = await headerGameNames();
    const art = currentGameArt()?.mappings;
    const titleUrl = (map: Record<string, string> | undefined) => (id: number): string | null => {
      const img = map?.[String(id)];
      return img ? gameArtUrl(img) : null;
    };
    res.json({
      linked: true,
      player: getGamePlayer(clanId, playerId),
      // The photo the player's own account uploaded (the profile shows it before the hero portrait), or null.
      photoUrl: photoUrlForPlayer(playerId),
      city: getLatestCity(clanId, playerId),
      // G/S/E/M tiers and crypt level from the member's research (null until read).
      tiers: getMemberTiers(clanId).get(memberId) ?? null,
      titles: titleViews(names, getPlayerTitles(clanId, playerId), Math.floor(Date.now() / 1000), {
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
      res.json({ linked: false, hero: null, dragon: null, hallOfFame: null, captains: [], changes: [], artifacts: [], artifactChanges: [], equipmentChanges: [] });
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
    // level plate, its level / XP and what it wears — all city field 9's
    // entry id 1 (level / XP stored since Nov 2026; the player record's hero
    // level until then). NOT city field 26: that is the dragon. The player
    // record is read every scan, the city once a day: its level is the
    // fresher one, and the entry's XP only counts while it is at that level.
    const player = getGamePlayer(clanId, playerId);
    const heroEntry = getPlayerHeroEntry(clanId, playerId);
    const heroLevel = player?.heroLevel ?? heroEntry?.level ?? null;
    const heroXp = heroEntry && heroEntry.level === heroLevel ? heroEntry.xp : null;
    const heroView = heroLevel !== null && heroXp !== null ? heroLevelView(names, HERO_ENTRY_ID, heroLevel, 0, false) : null;
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
      changes: getPlayerHeroLevelChanges(clanId, playerId, since),
      equipment: gear.get(HERO_ENTRY_ID) ?? [],
      gearSlots: HERO_GEAR_POSITIONS,
    } : null;
    // The Hall of Fame: faction levels are city techs 800–803 (factions.ts).
    const techs = getPlayerTechs(clanId, playerId);
    const hallOfFame = hallOfFameView(names, techs.readAt ? techs.levels : null, (n) => gameArtUrl(safeArtName(n)));
    // The dragon: city field 26 of the latest daily city snapshot, on the
    // Dragons table's levels and evolutions (dragon.ts).
    const city = getLatestCity(clanId, playerId);
    const dragon = city ? dragonView(names, city.dragon, (n) => gameArtUrl(safeArtName(n))) : null;
    res.json({
      linked: true,
      hero,
      dragon: dragon ? { ...dragon, readAt: city?.capturedAt ?? null } : null,
      hallOfFame,
      // Shared tile art: the level plate and the star sprites (null until extracted).
      tileArt: {
        levelPlateUrl: tile?.levelPlate ? gameArtUrl(tile.levelPlate) : null,
        starOnUrl: tile?.starOn ? gameArtUrl(tile.starOn) : null,
        starOffUrl: tile?.starOff ? gameArtUrl(tile.starOff) : null,
      },
      captains: getPlayerCaptains(clanId, playerId).map((c) => {
        // The XP window of its level and the Stats screen (Heroes table, T10).
        const view = heroLevelView(names, c.captainId, c.level, c.stars);
        return {
          ...c,
          ...describe(c.captainId),
          xpFloor: view?.xpFloor ?? null,
          xpNext: view?.xpNext ?? null,
          stats: view?.stats ?? null,
          starBonuses: names?.captains?.[String(c.captainId)]?.stars?.[String(c.stars)] ?? [],
          equipment: gear.get(c.captainId) ?? [],
          gearSlots: CAPTAIN_GEAR_POSITIONS,
        };
      }),
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
   * Event standings read from the game (Events page): the latest run of every
   * event the scans saw, with the site's event key where the catalog knows it,
   * its window and its top three.
   */
  router.get('/events', (req, res) => {
    const clanId = req.clanId!;
    const nowSec = Math.floor(Date.now() / 1000);
    const runs = latestEventRuns(clanId).map((r) => {
      const standings = getEventStandings(clanId, r);
      const names = playerNames(clanId, standings.slice(0, 3).map((s) => s.playerId));
      return {
        ...eventRunApi(r, nowSec),
        members: standings.length,
        withPoints: standings.filter((s) => s.points > 0).length,
        top: standings.slice(0, 3).map((s) => ({ rank: s.rank, points: s.points, ...names.get(s.playerId) })),
      };
    });
    res.json({ runs });
  });

  /**
   * One run's standings: `?type=&run=&occurrence=`, or `?event=<catalog key>`
   * (+ optional `from`/`to` ISO window: the run overlapping it; else the
   * newest run of that event). Each row carries the member it links to and
   * the points before its last change (null on the run's first read).
   */
  router.get('/events/standings', (req, res) => {
    const clanId = req.clanId!;
    const nowSec = Math.floor(Date.now() / 1000);
    const q = req.query as Record<string, string | undefined>;
    let run = null as ReturnType<typeof listEventRuns>[number] | null;
    if (q.type && q.run && q.occurrence) {
      const key = { eventType: Number(q.type), run: Number(q.run), occurrence: Number(q.occurrence) };
      if ([key.eventType, key.run, key.occurrence].every(Number.isInteger)) run = getEventRun(clanId, key);
    } else if (q.event) {
      const from = q.from ? Date.parse(q.from) / 1000 : NaN;
      const to = q.to ? Date.parse(q.to) / 1000 : NaN;
      const candidates = listEventRuns(clanId).filter((r) => catalogKeyForEventTitle(r.title) === q.event);
      run = (Number.isFinite(from) && Number.isFinite(to)
        ? candidates.find((r) => (r.startsAt ?? 0) < to && (r.endsAt ?? Number.MAX_SAFE_INTEGER) > from)
        : candidates[0]) ?? null;
    }
    if (!run) {
      res.json({ run: null, standings: [] });
      return;
    }
    const standings = getEventStandings(clanId, run);
    const names = playerNames(clanId, standings.map((s) => s.playerId));
    res.json({
      run: eventRunApi(run, nowSec),
      standings: standings.map((s) => ({
        rank: s.rank,
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
    const clanId = req.clanId!;
    const all = buildRosterChanges(loadRosterSources(clanId), loadConfig().gameDayRolloverUtcHour);
    const filter = req.query.filter === 'joined' || req.query.filter === 'left' ? req.query.filter : null;
    const query = typeof req.query.q === 'string' ? req.query.q.slice(0, 80) : '';
    const list = filterRosterChanges(all, { filter, query });
    const limit = Math.min(Math.max(Number.parseInt(String(req.query.limit ?? ''), 10) || ROSTER_PAGE_DEFAULT, 1), ROSTER_PAGE_MAX);
    const page = pageNewestFirst(list, { before: typeof req.query.before === 'string' ? req.query.before.slice(0, 200) : null, limit });
    // The portrait: a join's own player (an alt's is its own), else the member's.
    const byMember = getGamePlayersByMember(clanId);
    const byPlayer = new Map([...byMember.values()].map((p) => [p.playerId, p]));
    const profileOf = (e: (typeof page.entries)[number]) => (e.playerId !== null
      ? byPlayer.get(e.playerId) ?? getGamePlayer(clanId, e.playerId)
      : e.memberId !== null ? byMember.get(e.memberId) ?? null : null);
    const since = new Date(Date.now() - ROSTER_COUNT_DAYS * 86_400_000).toISOString();
    res.json({
      entries: page.entries.map((e) => {
        const p = profileOf(e);
        return { ...e, avatarUrl: p?.avatarUrl ?? null, frameUrl: p?.frameUrl ?? null, heroLevel: p?.heroLevel ?? null };
      }),
      next: page.next,
      total: list.length,
      counts: { days: ROSTER_COUNT_DAYS, ...countRosterChanges(all, since) },
      readSince: rosterReadSince(clanId),
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
