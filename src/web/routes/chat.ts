/**
 * /api/chat — the stored in-game chat for the Chats page.
 *
 * Only the CLAN chat (the clan's `clanGroup` channel) is served, to any
 * signed-in member of the active clan. Private messages (whisper channels) are
 * collected too but are never reachable through this router: every query is
 * pinned to clanChatChannels(clanId), which only ever lists clanGroup channels
 * of the caller's own clan.
 *
 * The history is what we stored, not what the game still serves — see
 * chat-repo.ts: lines the game no longer returns stay readable here.
 */
import { Router, type Request } from 'express';
import { getDb } from '../../data/database.js';
import {
  chatAnchorAt, chatHistoryInfo, chatSenders, clanChatChannels, countChatMatches, readChatAround, readChatPage,
  type ChatCursor, type StoredChatMessage,
} from '../../data/repositories/chat-repo.js';
import { avatarFrameUrl, heroAvatarUrl } from '../../data/repositories/game-profile-repo.js';
import { chatSenderRank, chatSenderTag, parseChatSubs, type ChatSub } from '../../game-protocol/chat-text.js';
import { loadGameNames, type GameNames } from '../../game-protocol/static-data.js';

/** The game's map-object and terrain names, refreshed at most every 10 minutes (the page polls). */
let namesCache: { at: number; names: GameNames | null } = { at: 0, names: null };
async function chatNames(): Promise<{ objects: GameNames['objects']; terrains: Record<string, string> }> {
  if (Date.now() - namesCache.at > 10 * 60_000) {
    namesCache = { at: Date.now(), names: await loadGameNames().catch(() => namesCache.names) };
  }
  return { objects: namesCache.names?.objects ?? {}, terrains: namesCache.names?.terrains ?? {} };
}

/** Test seam. */
export function resetChatNamesCache(names: GameNames | null = null): void {
  namesCache = { at: names ? Date.now() : 0, names };
}

function cursor(v: unknown): ChatCursor | null {
  const m = /^(\d{1,15}):(\d{1,20})$/.exec(String(v ?? ''));
  return m ? { at: Number(m[1]), id: Number(m[2]) } : null;
}

function positiveInt(v: unknown): number | null {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** staticIds a sub refers to (a map object, a raid target, a sabotage squad), for name lookup. */
function subStaticIds(sub: ChatSub): number[] {
  const ids: number[] = [];
  for (const k of ['staticId', 'targetStaticId', 'staticAtomId']) {
    const v = sub[k];
    if (typeof v === 'number' && v > 0) ids.push(v);
  }
  return ids;
}

function parseTranslations(json: string): Record<string, string> | null {
  if (!json) return null;
  try {
    const t = JSON.parse(json) as unknown;
    return t && typeof t === 'object' && !Array.isArray(t) ? (t as Record<string, string>) : null;
  } catch {
    return null;
  }
}

function toApi(m: StoredChatMessage) {
  return {
    key: `${m.createdAt}:${m.messageId}`,
    at: m.createdAt,
    kind: m.customType === 'service' ? 'service' : 'user',
    sender: {
      name: m.senderName,
      playerId: m.senderPlayerId,
      // The game's clan rank and tag when the message was sent.
      rank: chatSenderRank(m.senderInfo),
      tag: chatSenderTag(m.senderInfo),
    },
    text: m.message,
    subs: parseChatSubs(m.data),
    translations: parseTranslations(m.translations),
    edited: m.previousMessage !== null,
    previousText: m.previousMessage,
  };
}

/**
 * Who the senders are on the site: their member (for the profile link), hero
 * portrait and current clan rank. Clan-scoped.
 */
type ChatPerson = { memberId: number | null; avatarUrl: string | null; frameUrl: string | null; heroLevel: number | null; role: number | null };
function people(clanId: number, playerIds: number[]): Record<number, ChatPerson> {
  const out: Record<number, ChatPerson> = {};
  const ids = [...new Set(playerIds)];
  if (!ids.length) return out;
  const db = getDb();
  const ph = ids.map(() => '?').join(',');
  for (const id of ids) out[id] = { memberId: null, avatarUrl: null, frameUrl: null, heroLevel: null, role: null };
  const players = db.prepare(`SELECT player_id, hero_avatar, avatar_frame, hero_level, role FROM game_players WHERE clan_id = ? AND player_id IN (${ph})`)
    .all(clanId, ...ids) as Array<{ player_id: number; hero_avatar: number | null; avatar_frame: number | null; hero_level: number | null; role: number | null }>;
  for (const p of players) Object.assign(out[p.player_id], {
    // The portrait the game draws: hero art in the player's own frame, with the hero level.
    avatarUrl: heroAvatarUrl(p.hero_avatar), frameUrl: avatarFrameUrl(p.avatar_frame), heroLevel: p.hero_level, role: p.role,
  });
  const members = db.prepare(`SELECT id, game_player_id FROM members WHERE clan_id = ? AND game_player_id IN (${ph})`)
    .all(clanId, ...ids) as Array<{ id: number; game_player_id: number }>;
  for (const m of members) out[m.game_player_id].memberId = m.id;
  return out;
}

export function createChatRouter(): Router {
  const router = Router();

  /**
   * One page of the clan chat. Newest first; `before=<at>:<messageId>` pages
   * back, `after=<at>:<messageId>` reads the newer side (oldest first — the
   * live poll and "load newer"). `q` searches (every word, prefix), `sender`
   * is a game player id, `from` / `to` bound the time (ms, to exclusive).
   */
  router.get('/clan', async (req: Request, res) => {
    const clanId = req.clanId!;
    const channels = clanChatChannels(clanId);
    const limit = Math.min(positiveInt(req.query.limit) ?? 100, 200);
    const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 200) : '';
    const senderPlayerId = positiveInt(req.query.sender);
    const before = cursor(req.query.before);
    const after = cursor(req.query.after);
    const rows = readChatPage(clanId, channels, {
      before, after, q, senderPlayerId,
      fromMs: positiveInt(req.query.from),
      toMs: positiveInt(req.query.to),
      limit,
    });
    const messages = rows.map(toApi);
    res.json({
      ...(await pageExtras(clanId, channels, messages)),
      messages,
      hasMore: rows.length === limit,
      // A search / writer filter's size over the WHOLE stored history, on its first page.
      matches: (q || senderPlayerId) && !before && !after ? countChatMatches(clanId, channels, q, senderPlayerId) : null,
    });
  });

  /**
   * The conversation at one message (`around=<at>:<messageId>`, a search hit)
   * or at a time (`at=<ms>`: the first message at or after it — a date jump):
   * up to 50 messages either side, oldest first, unfiltered. `focus` is the
   * message it opened at.
   */
  router.get('/clan/context', async (req: Request, res) => {
    const clanId = req.clanId!;
    const channels = clanChatChannels(clanId);
    const atMs = positiveInt(req.query.at);
    const anchor = cursor(req.query.around) ?? (atMs ? chatAnchorAt(clanId, channels, atMs) : null);
    if (!anchor) {
      res.json({ ...(await pageExtras(clanId, channels, [])), messages: [], hasOlder: false, hasNewer: false, focus: null });
      return;
    }
    const around = readChatAround(clanId, channels, anchor, 50);
    const messages = around.messages.map(toApi);
    const focus = messages.find((m) => m.at === anchor.at && m.key.endsWith(`:${anchor.id}`))?.key ?? null;
    res.json({
      ...(await pageExtras(clanId, channels, messages)),
      messages,
      hasOlder: around.hasOlder,
      hasNewer: around.hasNewer,
      focus,
    });
  });

  /** What every page of messages carries: senders, object and terrain names, the history's extent. */
  async function pageExtras(clanId: number, channels: string[], messages: ReturnType<typeof toApi>[]) {
    const objects: Record<number, string> = {};
    // A shared map TILE's staticId is a terrain type (T4: "Dense forest"), not a
    // map object — the two id spaces overlap (2 = Grasslands / Player's City).
    const terrains: Record<number, string> = {};
    const names = await chatNames();
    for (const m of messages) {
      for (const sub of Object.values(m.subs)) {
        if (sub.type === 'coord' && sub.entryType === 'tile') {
          const id = sub.staticId;
          if (typeof id === 'number' && names.terrains[id]) terrains[id] = names.terrains[id];
          continue;
        }
        for (const id of subStaticIds(sub)) if (names.objects[id]) objects[id] = names.objects[id];
      }
    }
    return {
      available: channels.length > 0,
      history: chatHistoryInfo(clanId, channels),
      people: people(clanId, messages.map((m) => m.sender.playerId).filter((p): p is number => p !== null)),
      objects,
      terrains,
    };
  }

  /** Everyone who has written in the clan chat, busiest first (the sender filter). */
  router.get('/clan/senders', (req: Request, res) => {
    const clanId = req.clanId!;
    const senders = chatSenders(clanId, clanChatChannels(clanId));
    const who = people(clanId, senders.map((s) => s.playerId));
    res.json({
      senders: senders.map((s) => ({ ...s, memberId: who[s.playerId]?.memberId ?? null })),
    });
  });

  return router;
}
