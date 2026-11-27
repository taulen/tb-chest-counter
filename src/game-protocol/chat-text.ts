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

export type ChatSub = Record<string, unknown> & { type?: string; entryType?: string };

/** The placeholder → content map of a message's data payload (empty when none or unreadable). */
export function parseChatSubs(data: string): Record<string, ChatSub> {
  if (!data || data[0] !== '{') return {};
  try {
    const subs = (JSON.parse(data) as { subs?: unknown }).subs;
    if (!subs || typeof subs !== 'object' || Array.isArray(subs)) return {};
    const out: Record<string, ChatSub> = {};
    for (const [k, v] of Object.entries(subs as Record<string, unknown>)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = v as ChatSub;
    }
    return out;
  } catch {
    return {};
  }
}

/** A report shared in chat: its journal id (journal.ts opens it by this), kind and target map object. */
export interface ChatReportLink {
  entryId: string;
  /** attack / crypt / scout / clan_announcement / pvpladder. */
  entryType: string;
  /** The target's T7 map object (0 when the link doesn't say). */
  staticId: number;
  /** The link's subject as the game names it: the target, or an announcement's author ('' when none). */
  name: string;
}

/** Every shared report in a message's data payload (docs/battle-reports.md). */
export function chatReportLinks(data: string): ChatReportLink[] {
  if (!data || !data.includes('journalV2EntryId')) return [];
  const out: ChatReportLink[] = [];
  for (const sub of Object.values(parseChatSubs(data))) {
    if (sub.type !== 'journal') continue;
    const entryId = sub.journalV2EntryId;
    if (typeof entryId !== 'string' || !/^[0-9a-f-]{36}$/i.test(entryId)) continue;
    out.push({
      entryId: entryId.toLowerCase(),
      entryType: typeof sub.entryType === 'string' ? sub.entryType : '',
      staticId: typeof sub.staticId === 'number' ? sub.staticId : 0,
      name: typeof sub.name === 'string' ? sub.name : '',
    });
  }
  return out;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

/** `K:260 X:808 Y:40` for a sub carrying realm/x/y (also `atomCoord`), else ''. */
export function chatSubCoords(sub: ChatSub): string {
  const c = (sub.atomCoord && typeof sub.atomCoord === 'object' ? sub.atomCoord : sub) as Record<string, unknown>;
  const k = c.realmId, x = c.x, y = c.y;
  return typeof k === 'number' && typeof x === 'number' && typeof y === 'number' ? `K:${k} X:${x} Y:${y}` : '';
}

/** The words of a sub a search should find: names and coordinates. */
function subWords(sub: ChatSub): string {
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
export function chatSearchText(message: string, data: string): string {
  const subs = parseChatSubs(data);
  let out = message ?? '';
  for (const [ph, sub] of Object.entries(subs)) out = out.split(ph).join(` ${subWords(sub)} `);
  return out.replace(/\/%\d+%\//g, ' ').replace(/\s+/g, ' ').trim();
}

function infoField(senderInfo: string, i: number): string {
  return (senderInfo ?? '').split(',')[i] ?? '';
}

/** The sender's game player id from sender_info (hex), or null. */
export function chatSenderPlayerId(senderInfo: string): number | null {
  const hex = infoField(senderInfo, 1);
  if (!/^[0-9a-f]+$/i.test(hex)) return null;
  const n = Number.parseInt(hex, 16);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** The sender's clan rank (1 leader … 5) when the message was sent, or null. */
export function chatSenderRank(senderInfo: string): number | null {
  const n = Number(infoField(senderInfo, 4));
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
}

/** The sender's clan tag when the message was sent ('' when none). */
export function chatSenderTag(senderInfo: string): string {
  return infoField(senderInfo, 5);
}
