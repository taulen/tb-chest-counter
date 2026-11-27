/**
 * Opens the battle reports and announcements shared in a clan's chats
 * (battle-report-repo.ts) on the game's journal service (journal.ts) and keeps
 * what they say. Runs with the between-scans chat poll (chat-capture.ts), on
 * the journal token of the clan's last scan login, a batch a minute, newest
 * share first. Read-only in the game; never fails anything around it.
 */
import { JournalSession, fetchJournalItem, fetchSharedEntry } from '../game-protocol/journal.js';
import { journalTokenExpiry } from '../game-protocol/journal-token.js';
import { parseAnnouncement, parseBattleReport, parseStrikeLog, type Strike } from '../game-protocol/battle-report.js';
import { markReportFailed, pendingReportsForClan, saveFetchedReport } from '../data/repositories/battle-report-repo.js';
import { childLogger } from '../utils/logger.js';
import { createCoalescedWarner } from '../utils/log-throttle.js';

const log = childLogger('battle-reports');
const warner = createCoalescedWarner((m) => log.warn({ noAlert: true }, m), 60 * 60_000);

/** Reports opened per clan per poll: a backlog (the v143 queue held ~2,500) drains in hours without a burst. */
export const REPORTS_PER_RUN = 20;

const running = new Set<number>();

export interface ReportFetchOptions {
  now?: number;
  limit?: number;
  /** Tests hand in a fake connection. */
  open?: (token: string) => Promise<Pick<JournalSession, 'call' | 'close'>>;
}

export interface ReportFetchResult {
  note: string;
  /** The token was refused or has run out: the caller drops it until the next scan's login. */
  tokenBad: boolean;
}

/** Open what waits for this clan. Never throws. */
export async function fetchSharedReports(clanId: number, token: string | null | undefined, opts: ReportFetchOptions = {}): Promise<ReportFetchResult> {
  const now = opts.now ?? Date.now();
  if (!token) return { note: '', tokenBad: false };
  const exp = journalTokenExpiry(token);
  if (exp !== null && exp * 1000 < now + 60_000) return { note: '', tokenBad: true };
  if (running.has(clanId)) return { note: '', tokenBad: false };
  const pending = pendingReportsForClan(clanId, now, opts.limit ?? REPORTS_PER_RUN);
  if (!pending.length) return { note: '', tokenBad: false };
  running.add(clanId);
  let session: Pick<JournalSession, 'call' | 'close'> | null = null;
  try {
    try {
      session = await (opts.open ?? JournalSession.open)(token);
    } catch (err) {
      const msg = String(err);
      const refused = /HTTP 40[13]/.test(msg);
      warner.warn(`open:${clanId}`, `Clan #${clanId}: could not reach the battle-report service: ${msg}`);
      return { note: '', tokenBad: refused };
    }
    let read = 0;
    let gone = 0;
    for (const p of pending) {
      try {
        const r = await fetchSharedEntry(session as JournalSession, p.entryId);
        if (!r.ok) {
          // The game answered and said no (expired, or not readable): asked once more later, then left.
          if (markReportFailed(p.entryId, `status ${r.status}${r.error ? `: ${r.error}` : ''}`, { gone: r.status !== -1, nowMs: now }) === 'unavailable') gone++;
          continue;
        }
        const report = r.type === 'battle' ? parseBattleReport(r.report) : null;
        let strikeLog: Buffer | null = null;
        let strikes: Strike[] | null = null;
        if (report?.strikeLogId) {
          strikeLog = await fetchJournalItem(session as JournalSession, p.entryId, report.strikeLogId).catch(() => null);
          strikes = strikeLog ? parseStrikeLog(strikeLog) : null;
        }
        const announcement = r.type === 'clan_announcement' ? parseAnnouncement(r.report)?.text ?? null : null;
        saveFetchedReport(p.entryId, { at: r.at, type: r.type, report, raw: r.report, strikeLog, strikes, announcement });
        read++;
      } catch (err) {
        // The connection went: the rest wait for the next poll.
        markReportFailed(p.entryId, String(err), { gone: false, nowMs: now });
        warner.warn(`fetch:${clanId}`, `Clan #${clanId}: reading a shared battle report failed: ${String(err)}`);
        break;
      }
    }
    const parts = [read ? `${read} read` : '', gone ? `${gone} no longer in the game` : ''].filter(Boolean);
    return { note: parts.length ? `battle reports: ${parts.join(', ')}` : '', tokenBad: false };
  } finally {
    session?.close();
    running.delete(clanId);
  }
}
