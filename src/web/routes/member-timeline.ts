/**
 * A member's timeline (profile → Timeline): GET /api/game/members/:memberId/timeline
 * ?before=<cursor>&groups=clan,growth,research,captains,city&limit=60.
 *
 * Clan-scoped like the rest of /api/game (any member of the clan may read).
 * The timeline is built whole from what the member's history tables hold
 * (data/member-timeline.ts) and paged by a cursor (the last entry's time +
 * key), so new entries arriving at the top never shift what "load older"
 * returns.
 */
import { Router } from 'express';
import { loadConfig } from '../../config/index.js';
import { getMemberById } from '../../data/repositories/member-repo.js';
import { gamePlayerIdForMember, heroAvatarUrl } from '../../data/repositories/game-profile-repo.js';
import { loadTimelineSources } from '../../data/repositories/member-timeline-repo.js';
import {
  buildTimeline, pageTimeline, TIMELINE_GROUPS, type TimelineGroup, type TimelineLookups,
} from '../../data/member-timeline.js';
import { loadGameNames, type GameNames } from '../../game-protocol/static-data.js';
import { cachedTechTrees } from '../../game-protocol/tech-trees.js';
import { describeArtifact } from '../../game-protocol/artifacts.js';
import { describeItem } from '../../game-protocol/equipment.js';
import { currentGameArt, gameArtUrl } from '../../game-art/index.js';

const PAGE_DEFAULT = 60;
const PAGE_MAX = 200;
const GROUPS = new Set<TimelineGroup>(Object.values(TIMELINE_GROUPS));

/** `names`: the game's names (a test seam; the game's CDN by default). */
export function createMemberTimelineRouter(opts: { names?: () => Promise<GameNames | null> } = {}): Router {
  const router = Router();
  const namesOf = opts.names ?? (() => loadGameNames().catch(() => null));

  router.get('/members/:memberId/timeline', async (req, res) => {
    const clanId = req.clanId!;
    const memberId = Number.parseInt(String(req.params.memberId), 10);
    if (!Number.isFinite(memberId) || !getMemberById(memberId, clanId)) {
      res.status(404).json({ error: 'Member not found' });
      return;
    }
    const playerId = gamePlayerIdForMember(memberId, clanId);
    const src = loadTimelineSources(clanId, memberId, playerId);
    if (!src) {
      res.status(404).json({ error: 'Member not found' });
      return;
    }

    const names = await namesOf();
    const mappings = currentGameArt()?.mappings;
    const art = (map: Record<string, string> | undefined, id: number): string | null => {
      const img = map?.[String(id)];
      return img ? gameArtUrl(img) : null;
    };
    // Hero talents vs research, from the trees (talent trees are kind 'talent').
    const talentIds = new Set<number>();
    for (const tree of cachedTechTrees()?.trees ?? []) {
      if (tree.kind === 'talent') for (const n of tree.nodes) talentIds.add(n.techId);
    }
    const look: TimelineLookups = {
      techName: (id) => names?.techs?.[String(id)]?.name ?? `#${id}`,
      techIconUrl: (id) => art(mappings?.techs, id),
      techKind: (id) => (talentIds.has(id) ? 'talent' : 'research'),
      captainName: (id) => names?.captains?.[String(id)]?.name ?? `#${id}`,
      captainIconUrl: (id) => art(mappings?.captains, id),
      artifactName: (type) => describeArtifact(type, 0, 0, [], names?.artifacts).name,
      artifactIconUrl: (type) => art(mappings?.artifacts, type),
      itemName: (type) => describeItem(type, 0, [], names).name,
      itemIconUrl: (type) => art(mappings?.equipment, type),
      heroName: (id) => names?.heroes?.[String(id)]?.name ?? '',
      heroAvatarUrl: (id) => heroAvatarUrl(id),
    };

    const timeline = buildTimeline(src, look, loadConfig().gameDayRolloverUtcHour);
    const wanted = String(req.query.groups ?? '').split(',').filter((g): g is TimelineGroup => GROUPS.has(g as TimelineGroup));
    const limit = Math.min(Math.max(Number.parseInt(String(req.query.limit ?? ''), 10) || PAGE_DEFAULT, 1), PAGE_MAX);
    const page = pageTimeline(timeline, {
      before: typeof req.query.before === 'string' ? req.query.before.slice(0, 200) : null,
      groups: wanted.length ? new Set(wanted) : null,
      limit,
    });
    res.json({ linked: playerId !== null, ...page });
  });

  return router;
}
