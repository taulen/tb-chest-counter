import { childLogger } from '../utils/logger.js';
import {
  fetchCounts,
  fetchSettings,
  computeCurrentWeekWindow,
  type ChesttrackerPayload,
  type ChesttrackerPlayer,
} from './chesttracker-client.js';
import {
  insertSnapshot,
  getSnapshotEtagForWindow,
  recordPollOutcome,
  type NewSnapshotInput,
  type SnapshotTrigger,
} from '../data/repositories/external-repo.js';
import { loadConfig } from '../config/index.js';

const log = childLogger('external-ingest');

// These top-level keys on a player row are totals / metadata, not chest
// category buckets. Anything else in the object with a numeric .chests
// field is treated as a category (e.g. "common crypt", "ancients",
// "epic squad", …).
const PLAYER_META_KEYS = new Set(['name', 'guardsLevel', 'points', 'chests']);

function extractCategories(p: ChesttrackerPlayer): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, val] of Object.entries(p)) {
    if (PLAYER_META_KEYS.has(key)) continue;
    if (val && typeof val === 'object' && 'chests' in (val as object)) {
      const c = (val as { chests?: unknown }).chests;
      if (typeof c === 'number' && c > 0) {
        out[key] = c;
      }
    }
  }
  return out;
}

function normalizePayload(payload: ChesttrackerPayload): {
  players: NewSnapshotInput['players'];
  definitions: NewSnapshotInput['definitions'];
} {
  const [rawPlayers, rawDefs] = payload;

  const mappedPlayers = rawPlayers.map((p) => ({
    name: String(p.name ?? ''),
    guardsLevel: Number(p.guardsLevel ?? 0),
    points: Number(p.points ?? 0),
    chests: Number(p.chests ?? 0),
    categories: extractCategories(p),
  }));
  const players = mappedPlayers.filter((p) => p.name.length > 0);
  const droppedEmptyName = mappedPlayers.length - players.length;
  if (droppedEmptyName > 0) {
    log.warn(
      `Ingest dropped ${droppedEmptyName} chesttracker player row(s) with empty/missing name field — upstream returned ${mappedPlayers.length}, normalised ${players.length}`,
    );
  }

  const definitions = rawDefs.map((d) => ({
    type: String(d.type ?? ''),
    name: String(d.name ?? ''),
    source: String(d.source ?? ''),
    points: Number(d.points ?? 0),
    overridePoints: d.override == null ? null : Number(d.override),
  }));

  return { players, definitions };
}

export interface IngestOptions {
  /** Clan this snapshot belongs to. Required — every snapshot must be
   *  scoped to a specific clan so multi-clan deployments don't leak data
   *  across clans. The pre-multi-clan "defaults to clan #1" fallback was
   *  removed in Phase A of the refactoring plan once the multi-clan
   *  migration finished. */
  clanId: number;
  shareCode: string;
  /**
   * Optional explicit window. If omitted, defaults to the TB game week
   * that contains "now" (Sun rolloverUtcHour UTC → next Sun rolloverUtcHour UTC).
   */
  start?: string;
  end?: string;
  /** If both start and end are set, must be provided (default 7). */
  durationDays?: number;
  trigger: SnapshotTrigger;
  /** If true and server returns 304, skip insert (default). */
  useEtag?: boolean;
}

export interface IngestResult {
  status: 'inserted' | 'not_modified' | 'empty';
  snapshotId: number | null;
  windowStart: string;
  windowEnd: string;
  playerCount: number;
  totalChests: number;
  totalPoints: number;
}

/**
 * Fetch one snapshot from the chesttracker API and persist it. Returns a
 * summary for the caller (scheduler or HTTP route). Does not throw on a
 * 304 response — caller sees status='not_modified' and snapshotId=null.
 * Does throw on HTTP errors / malformed payloads so the scheduler can
 * log + retry.
 */
export async function ingestSnapshot(opts: IngestOptions): Promise<IngestResult> {
  const window = opts.start && opts.end
    ? { start: opts.start, end: opts.end, durationDays: opts.durationDays ?? 7 }
    : computeCurrentWeekWindow(loadConfig().gameDayRolloverUtcHour);

  const useEtag = opts.useEtag ?? true;
  const priorEtag = useEtag
    ? getSnapshotEtagForWindow(opts.clanId, opts.shareCode, window.start, window.end)
    : null;

  const polledAt = new Date().toISOString();
  let res;
  try {
    res = await fetchCounts({
      shareCode: opts.shareCode,
      start: window.start,
      end: window.end,
      durationDays: window.durationDays,
      etag: priorEtag,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    recordPollOutcome({
      clanId: opts.clanId,
      polledAt,
      shareCode: opts.shareCode,
      windowStart: window.start,
      windowEnd: window.end,
      trigger: opts.trigger,
      status: 0,
      etagChanged: false,
      priorEtag,
      newEtag: null,
      errorMessage: msg,
    });
    throw err;
  }

  // Persist every poll outcome (200 + 304) to chesttracker.db so the
  // upstream update cadence is recoverable later — docker stdout rotates
  // but the mounted volume survives.
  const etagChanged = res.etag != null && priorEtag != null && res.etag !== priorEtag;
  recordPollOutcome({
    clanId: opts.clanId ?? 1,
    polledAt,
    shareCode: opts.shareCode,
    windowStart: window.start,
    windowEnd: window.end,
    trigger: opts.trigger,
    status: res.status,
    etagChanged,
    priorEtag,
    newEtag: res.etag,
    errorMessage: null,
  });

  if (res.status === 304 || !res.body) {
    return {
      status: 'not_modified',
      snapshotId: null,
      windowStart: window.start,
      windowEnd: window.end,
      playerCount: 0,
      totalChests: 0,
      totalPoints: 0,
    };
  }

  const { players, definitions } = normalizePayload(res.body);

  if (players.length === 0) {
    log.info('Chesttracker payload had zero players — inserting empty snapshot for visibility');
  }

  const totalChests = players.reduce((s, p) => s + p.chests, 0);
  const totalPoints = players.reduce((s, p) => s + p.points, 0);

  // Also pull the clan's settings (targets + schedule) so the UI can
  // render green/yellow/red status cells against each player row. This
  // is best-effort: if the settings fetch fails we still insert the
  // snapshot — just without the requirement data.
  const settings = await fetchSettings(opts.shareCode);
  const settingsJson = settings ? JSON.stringify(settings) : null;

  const snapshotId = insertSnapshot({
    clanId: opts.clanId,
    fetchedAt: new Date().toISOString(),
    shareCode: opts.shareCode,
    windowStart: window.start,
    windowEnd: window.end,
    durationDays: window.durationDays,
    trigger: opts.trigger,
    etag: res.etag,
    settingsJson,
    players,
    definitions,
  });

  return {
    status: 'inserted',
    snapshotId,
    windowStart: window.start,
    windowEnd: window.end,
    playerCount: players.length,
    totalChests,
    totalPoints,
  };
}
