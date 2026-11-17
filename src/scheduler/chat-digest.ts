/**
 * The daily digest, posted into one of the clan's in-game GROUP chats by the
 * clan's own scanner account — what CWB's leaders post by hand every evening
 * ("Daily Digest — 15 November / Our top 20 crypters / …", user, Nov 2026).
 * Opt-in per clan (Clans → In-game chat digest); see docs/chat-digest.md.
 *
 * Runs at the end of a scan (it needs the scan's game session for a chat
 * token). Clans mute spammers, so the rules are strict:
 *   - at most ONE message per clan per game day, scheduled or test, reserved
 *     in chat_digest_posts BEFORE sending (survives restarts and redeploys);
 *   - one message, never split — too long, and the list is shortened;
 *   - a send that verifiably failed (the chat said no) is retried once, on a
 *     later scan; one that may have gone out (no answer) is never resent;
 *   - only the named group chat the admins picked — never the clan chat, the
 *     kingdom chat or a private chat (game-protocol/chat-send.ts refuses);
 *   - nothing is posted when the day's scans left a gap > COVERAGE_MAX_GAP_H,
 *     and nothing at all while CHAT_SEND_DISABLED is set;
 *   - saving the settings never posts.
 */
import type { GameClient } from '../game-protocol/client.js';
import { listChannels } from '../game-protocol/chat.js';
import {
  MAX_POST_BYTES,
  MAX_POST_CHARS,
  POSTABLE_TYPES,
  assertPostableChannel,
  chatSendingDisabled,
  postToGroupChat,
  type SocketSender,
} from '../game-protocol/chat-send.js';
import { getDailyDigestData } from '../data/repositories/chest-repo.js';
import {
  attemptBlocker,
  clearTestRequest,
  finishDigestPost,
  getChatDigestSettings,
  getPostableChannels,
  reserveDigestPost,
  saveChatDigestSettings,
  setPostableChannels,
  type ChatDigestSettings,
  type PostableChannel,
} from '../data/repositories/chat-digest-repo.js';
import { getDb } from '../data/database.js';
import { gameDateFor } from '../utils/game-day.js';
import { resolveEntries } from '../utils/log-buffer.js';
import { childLogger } from '../utils/logger.js';
import { chatSessionFor } from './chat-capture.js';

const log = childLogger('chat-digest');

/** A scan gap longer than this inside the digest's day means the day may be incomplete: no post. */
export const COVERAGE_MAX_GAP_H = 3;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "2026-11-15" → "15 November" (the game day, as the hand-written digest dates it). */
export function digestDayLabel(gameDate: string): string {
  const [, m, d] = gameDate.split('-').map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1] ?? ''}`.trim();
}

export interface DigestRow {
  name: string;
  chests: number;
  points: number;
}

/** A name on one line: no line breaks or control characters smuggled into the post. */
const cleanName = (s: string): string => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim() || '?';
const fits = (text: string): boolean => text.length <= MAX_POST_CHARS && Buffer.byteLength(text, 'utf8') <= MAX_POST_BYTES;

/**
 * The post, as CWB writes it by hand:
 *
 *   Daily Digest — 15 November
 *   Our top 20 crypters
 *    1) Princess of Chaos ··· 35 chests (5,815)
 *    2) jass ················ 13 chests (3,560)
 *
 * Names are padded with middle dots to 20 characters (at least two dots), so
 * the counts line up roughly in the game's proportional font. The whole post
 * never exceeds the hand-written one's size (MAX_POST_CHARS / MAX_POST_BYTES):
 * longer names shorten the dot leaders first, then the names themselves
 * ("…"), and only then are entries dropped from the bottom. Never split.
 */
export function formatChatDigest(rows: DigestRow[], gameDate: string, entries: number): { text: string; shown: number } {
  const list = rows.slice(0, Math.max(0, entries)).map((r) => ({ ...r, name: cleanName(r.name) }));
  const head = (n: number) => [`Daily Digest — ${digestDayLabel(gameDate)}`, `Our top ${n} crypters`];
  const render = (n: number, width: number, minDots: number, maxName: number): string => {
    const lines = head(n);
    list.slice(0, n).forEach((r, i) => {
      const chars = [...r.name];
      const name = chars.length > maxName ? `${chars.slice(0, Math.max(1, maxName - 1)).join('')}…` : r.name;
      const dots = '·'.repeat(Math.max(minDots, width - [...name].length));
      const chests = `${r.chests.toLocaleString('en-US')} ${r.chests === 1 ? 'chest' : 'chests'}`;
      lines.push(`${String(i + 1).padStart(2)}) ${name} ${dots} ${chests} (${r.points.toLocaleString('en-US')})`);
    });
    return lines.join('\n');
  };
  if (!list.length) return { text: '', shown: 0 };
  for (let n = list.length; n >= 1; n--) {
    // 1. The hand-written layout.
    let text = render(n, 20, 2, Infinity);
    if (fits(text)) return { text, shown: n };
    // 2. Shorter dot leaders.
    for (let width = 19; width >= 0; width--) {
      text = render(n, width, 1, Infinity);
      if (fits(text)) return { text, shown: n };
    }
    // 3. Shorter names.
    for (let maxName = 20; maxName >= 8; maxName--) {
      text = render(n, 0, 1, maxName);
      if (fits(text)) return { text, shown: n };
    }
    // 4. One entry fewer (the loop).
  }
  return { text: '', shown: 0 };
}

/** The digest day a moment belongs to: the game day that closed last. */
export function digestSchedule(nowMs: number, rolloverUtcHour: number, postUtcMinute: number): {
  gameDate: string; sentGameDate: string; dayStartMs: number; dayEndMs: number; postAtMs: number;
} {
  const sentGameDate = gameDateFor(nowMs, rolloverUtcHour);
  const dayEndMs = Date.parse(`${sentGameDate}T00:00:00Z`) + rolloverUtcHour * HOUR;
  const dayStartMs = dayEndMs - DAY;
  const offsetMin = (((postUtcMinute - rolloverUtcHour * 60) % 1440) + 1440) % 1440;
  return {
    gameDate: gameDateFor(dayStartMs, rolloverUtcHour),
    sentGameDate,
    dayStartMs,
    dayEndMs,
    postAtMs: dayEndMs + offsetMin * 60_000,
  };
}

/**
 * Whether the scans covered a day: the last scan before it began, every scan
 * inside it and the first after it closed, with no gap over the limit.
 * `waiting` = the day's closing scan hasn't finished yet.
 */
export function coverageOf(completedMs: number[], dayStartMs: number, dayEndMs: number, maxGapH = COVERAGE_MAX_GAP_H): {
  ok: boolean; waiting: boolean; maxGapMs: number; reason: string | null; code: 'ok' | 'waiting' | 'no-scan-before' | 'gap';
} {
  const times = [...completedMs].sort((a, b) => a - b);
  const before = times.filter((t) => t < dayStartMs).pop();
  const after = times.find((t) => t >= dayEndMs);
  if (after === undefined) return { ok: false, waiting: true, maxGapMs: 0, reason: "the day's closing scan has not run yet", code: 'waiting' };
  if (before === undefined) return { ok: false, waiting: false, maxGapMs: 0, reason: 'no scan before the day began', code: 'no-scan-before' };
  const points = [before, ...times.filter((t) => t >= dayStartMs && t < dayEndMs), after];
  let maxGapMs = 0;
  for (let i = 1; i < points.length; i++) maxGapMs = Math.max(maxGapMs, points[i] - points[i - 1]);
  if (maxGapMs > maxGapH * HOUR) {
    return { ok: false, waiting: false, maxGapMs, reason: `a ${(maxGapMs / HOUR).toFixed(1)} h gap between scans (more than ${maxGapH} h)`, code: 'gap' };
  }
  return { ok: true, waiting: false, maxGapMs, reason: null, code: 'ok' };
}

/** Completed (non-import) scans of a clan around a day, as epoch ms. */
export function completedScanTimes(clanId: number, fromMs: number, toMs: number): number[] {
  return (getDb().prepare(
    `SELECT completed_at FROM scan_sessions
      WHERE clan_id = ? AND status = 'completed' AND trigger_source <> 'import' AND completed_at IS NOT NULL
        AND completed_at >= ? AND completed_at <= ?`,
  ).all(clanId, new Date(fromMs).toISOString(), new Date(toMs).toISOString()) as Array<{ completed_at: string }>)
    .map((r) => Date.parse(r.completed_at))
    .filter((t) => Number.isFinite(t));
}

/** The day's ranking: every member's chests and points (the Discord digest's numbers). */
export function digestRows(clanId: number, dayStartMs: number, dayEndMs: number): DigestRow[] {
  return getDailyDigestData(new Date(dayStartMs).toISOString(), new Date(dayEndMs).toISOString(), clanId)
    .topContributors.map((r) => ({ name: r.memberName, chests: r.chests, points: r.points }));
}

/** The group chat a clan's settings point at, among the chats its scanner account is in. */
export function resolveTargetChannel(settings: ChatDigestSettings, channels: PostableChannel[]): PostableChannel | null {
  if (settings.channelUrl) return channels.find((c) => c.url === settings.channelUrl) ?? null;
  const name = settings.channelName.trim();
  return name ? channels.find((c) => c.name.trim() === name) ?? null : null;
}

/** The warning key a resolved post clears (System → Needs attention). */
export const digestWarningKey = (clanId: number): string => `chat-digest:clan:${clanId}`;

// One warning per clan per digest day for a condition that repeats every scan.
const warnedDays = new Set<string>();
function warnOncePerDay(clanId: number, gameDate: string, message: string): void {
  const k = `${clanId}:${gameDate}:${message}`;
  if (warnedDays.has(k)) return;
  warnedDays.add(k);
  log.warn({ resolveKey: digestWarningKey(clanId) }, `Clan #${clanId} chat digest (${gameDate}): ${message}`);
}

export interface ChatDigestRunOptions {
  client: Pick<GameClient, 'suid' | 'nickname' | 'chatToken'>;
  rolloverUtcHour: number;
  now?: number;
  /** The chat transport; the real socket unless a test swaps it. */
  send?: SocketSender;
  /** Lists the scanner account's group chats; defaults to the scan's chat session. */
  listGroupChats?: () => Promise<Array<{ url: string; customType: string; name: string; memberCount: number }> | null>;
  /** The day's ranking; defaults to the Discord digest's numbers (tests supply rows). */
  rows?: (dayStartMs: number, dayEndMs: number) => DigestRow[];
}

/**
 * After a scan: refresh which group chats the scanner account is in, then post
 * the closed day's digest if it is due (or an admin asked for a test post) and
 * every rule allows it. Returns a short note for the scan log ('' = nothing to
 * say). Never throws.
 */
export async function runChatDigest(clanId: number, opts: ChatDigestRunOptions): Promise<string> {
  try {
    return await runChatDigestInner(clanId, opts);
  } catch (err) {
    log.warn({ noAlert: true }, `Clan #${clanId} chat digest failed (the scan is unaffected): ${String(err)}`);
    return 'chat digest failed';
  }
}

async function runChatDigestInner(clanId: number, opts: ChatDigestRunOptions): Promise<string> {
  const now = opts.now ?? Date.now();
  let settings = getChatDigestSettings(clanId);
  const test = settings.testRequestedAt !== null;
  if (!settings.enabled && !test) return '';
  const done = (note: string): string => {
    if (test) clearTestRequest(clanId);
    return note;
  };
  if (chatSendingDisabled()) return done('chat digest: sending is disabled (CHAT_SEND_DISABLED)');

  // Which group chats the scanner account is in — the only ones it may post into.
  const list = opts.listGroupChats ?? (async () => {
    const session = chatSessionFor(clanId);
    return session ? listChannels(session, [...POSTABLE_TYPES]) : null;
  });
  try {
    const channels = await list();
    if (channels) setPostableChannels(clanId, channels, { userId: opts.client.suid, name: opts.client.nickname }, new Date(now).toISOString());
  } catch (err) {
    log.warn({ noAlert: true }, `Clan #${clanId} chat digest: could not list the account's group chats: ${String(err)}`);
  }

  const sch = digestSchedule(now, opts.rolloverUtcHour, settings.postUtcMinute);
  if (!test && now < sch.postAtMs) return '';

  const blocked = attemptBlocker(clanId, sch.gameDate, sch.sentGameDate);
  if (blocked) return test ? done(`chat digest test not sent: ${blocked.message}`) : '';

  const coverage = coverageOf(completedScanTimes(clanId, sch.dayStartMs - DAY, now), sch.dayStartMs, sch.dayEndMs);
  if (coverage.waiting) return test ? done(`chat digest test not sent: ${coverage.reason}`) : '';
  if (!coverage.ok) {
    warnOncePerDay(clanId, sch.gameDate, `not posted — the day may be incomplete: ${coverage.reason}`);
    return done(`chat digest skipped: ${coverage.reason}`);
  }

  const target = resolveTargetChannel(settings, getPostableChannels(clanId));
  if (!target) {
    const who = opts.client.nickname || 'the scanner account';
    warnOncePerDay(clanId, sch.gameDate, `${who} is not a member of the group chat "${settings.channelName || settings.channelUrl}" — add the account to it, or pick another chat`);
    return done('chat digest: the account is not in the chosen chat');
  }
  try {
    assertPostableChannel(target);
  } catch (err) {
    warnOncePerDay(clanId, sch.gameDate, `refused: ${(err as Error).message}`);
    return done(`chat digest refused: ${(err as Error).message}`);
  }
  if (!settings.channelUrl) {
    // Seeded by name: pin the resolved chat, so a renamed chat can't redirect the post.
    settings = saveChatDigestSettings(clanId, { ...settings, channelUrl: target.url, channelName: target.name });
  }

  const rows = opts.rows ? opts.rows(sch.dayStartMs, sch.dayEndMs) : digestRows(clanId, sch.dayStartMs, sch.dayEndMs);
  const { text, shown } = formatChatDigest(rows, sch.gameDate, settings.entries);
  if (!shown) return test ? done('chat digest test not sent: nothing collected that day') : '';

  const reserved = reserveDigestPost({
    clanId, gameDate: sch.gameDate, sentGameDate: sch.sentGameDate, channelUrl: target.url, channelName: target.name,
    text, trigger: test ? 'test' : 'scheduled',
  }, new Date(now).toISOString());
  if ('blocked' in reserved) return done(`chat digest not sent: ${reserved.blocked}`);

  let token: string;
  try {
    token = await opts.client.chatToken();
  } catch (err) {
    // Nothing went out: a verified failure (one retry on a later scan).
    finishDigestPost(reserved.id, { status: 'failed', error: `no chat token: ${String(err)}` });
    warnOncePerDay(clanId, sch.gameDate, `not posted: no chat token (${String(err)})`);
    return done('chat digest failed: no chat token');
  }
  const outcome = await postToGroupChat({ userId: opts.client.suid, token, channel: target, text }, opts.send);
  if (outcome.status === 'sent') {
    finishDigestPost(reserved.id, outcome);
    resolveEntries(digestWarningKey(clanId));
    log.info(`Clan #${clanId} chat digest for ${sch.gameDate} posted to "${target.name}" (${shown} entries, message ${outcome.messageId})`);
    return done(`chat digest posted to "${target.name}"`);
  }
  if (outcome.status === 'refused') {
    finishDigestPost(reserved.id, { status: 'failed', error: outcome.error });
    warnOncePerDay(clanId, sch.gameDate, `not posted: ${outcome.error}`);
    return done(`chat digest refused: ${outcome.error}`);
  }
  finishDigestPost(reserved.id, { status: 'unknown', error: outcome.error });
  warnOncePerDay(clanId, sch.gameDate, `may or may not have been posted (${outcome.error}) — it will not be resent`);
  return done(`chat digest outcome unknown: ${outcome.error}`);
}

/** What the next post would say, for the settings page (never sends). */
export function previewChatDigest(clanId: number, rolloverUtcHour: number, now = Date.now()): {
  gameDate: string; postAt: string; text: string; shown: number; chars: number; bytes: number;
  maxChars: number; maxBytes: number; blocked: ReturnType<typeof attemptBlocker>; coverage: ReturnType<typeof coverageOf>;
} {
  const settings = getChatDigestSettings(clanId);
  const sch = digestSchedule(now, rolloverUtcHour, settings.postUtcMinute);
  const { text, shown } = formatChatDigest(digestRows(clanId, sch.dayStartMs, sch.dayEndMs), sch.gameDate, settings.entries);
  return {
    gameDate: sch.gameDate,
    postAt: new Date(sch.postAtMs).toISOString(),
    text,
    shown,
    chars: text.length,
    bytes: Buffer.byteLength(text, 'utf8'),
    maxChars: MAX_POST_CHARS,
    maxBytes: MAX_POST_BYTES,
    blocked: attemptBlocker(clanId, sch.gameDate, sch.sentGameDate),
    coverage: coverageOf(completedScanTimes(clanId, sch.dayStartMs - DAY, now), sch.dayStartMs, sch.dayEndMs),
  };
}
