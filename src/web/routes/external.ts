import { Router } from 'express';
import { childLogger } from '../../utils/logger.js';
import {
  listSnapshots,
  listSnapshotWeeks,
  listClanShareCodes,
  getSnapshot,
  getLatestSnapshot,
  getLatestPollAt,
  listPollLog,
} from '../../data/repositories/external-repo.js';
import { ingestSnapshot } from '../../external/ingest.js';
import {
  ExternalLoop,
  MultiClanExternalLoop,
  DEFAULTS,
  MAX_BACKFILL_WEEKS,
  readClanSettings,
  readSettings,
  writeSettings,
} from '../../scheduler/external-loop.js';
import { getClanById, setClanChestTrackerSettings } from '../../data/repositories/clan-repo.js';
import { logAction } from '../../data/repositories/user-repo.js';
import { requireAdmin } from '../middleware/auth.js';
import { parseBoundedInt, parseBoundedFloat } from '../../utils/parse-int.js';

const log = childLogger('external-routes');

function validShareCode(raw: unknown): string | null {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return null;
  // The share code appears in the URL path (/counts/XQOOZXYGBC) — keep it
  // conservative: letters + digits only, 4–32 chars. Stops anyone putting
  // a path or URL in the field.
  if (!/^[A-Za-z0-9]{4,32}$/.test(s)) return null;
  return s;
}

export function createExternalRouter(externalLoop: ExternalLoop | MultiClanExternalLoop): Router {
  const router = Router();

  // The legacy /api/external/* endpoints predate the multi-clan refactor
  // and operate against clan #1's settings. Multi-clan deployments
  // configure other clans through PUT /api/clans/:id/chesttracker.
  // Reading status from MultiClanExternalLoop returns an array — we
  // pick the one matching the requested clan, or synthesize an "idle"
  // record.
  const IDLE_BACKFILL = { running: false, done: 0, total: 0, inserted: 0, empty: 0, failed: 0 };

  function statusForClan(clanId: number): {
    running: boolean;
    inFlight: boolean;
    nextFetchAt: number | null;
    lastError: { message: string; at: string } | null;
    lastSuccessAt: string | null;
    backfill: typeof IDLE_BACKFILL;
  } {
    if (externalLoop instanceof MultiClanExternalLoop) {
      const all = externalLoop.getStatus();
      const found = all.find((s) => s.clanId === clanId);
      return found ?? {
        running: false,
        inFlight: false,
        nextFetchAt: null,
        lastError: null,
        lastSuccessAt: null,
        backfill: IDLE_BACKFILL,
      };
    }
    return externalLoop.getStatus();
  }

  /**
   * Resolve which share code a read should target for `clanId`.
   *
   * A clan's share code is mutable, but its snapshots aren't: repointing
   * a clan at a different ChestTracker archives the old code's history
   * rather than deleting it. Reads therefore accept an optional
   * `?shareCode=` so the UI can browse an archive, validated against the
   * codes THIS clan actually holds rows under (plus its current one).
   * The allow-list comes from clan_id, so naming another clan's code
   * just falls through to this clan's current code — never a leak.
   *
   * Returns null only when the clan has no current code and no history.
   */
  function resolveShareCode(clanId: number, requested: unknown): string | null {
    const current = getClanById(clanId)?.ctShareCode || '';
    const asked = typeof requested === 'string' ? requested.trim() : '';
    if (asked && asked !== current) {
      const archived = listClanShareCodes(clanId);
      if (archived.some((a) => a.shareCode === asked)) return asked;
    } else if (asked) {
      return asked;
    }
    if (current) return current;
    // No current code (integration disabled) but history may still exist —
    // fall back to the most recently active archive so it stays readable.
    return listClanShareCodes(clanId)[0]?.shareCode ?? null;
  }

  // GET /api/external/share-codes — every ChestTracker code this clan has
  // history under, newest activity first, with the current one flagged.
  // Powers the archive picker on the ChestTracker tab so a share-code
  // change hides nothing.
  router.get('/share-codes', (req, res) => {
    const clanId = req.clanId ?? 1;
    const current = getClanById(clanId)?.ctShareCode || '';
    const rows = listClanShareCodes(clanId).map((r) => ({
      ...r,
      isCurrent: r.shareCode === current,
    }));
    // A freshly-repointed clan has a current code with no rows yet — list
    // it anyway so the picker can show where new data will land.
    if (current && !rows.some((r) => r.isCurrent)) {
      rows.unshift({
        shareCode: current,
        snapshots: 0,
        weeks: 0,
        firstWindow: '',
        lastWindow: '',
        firstFetch: '',
        lastFetch: '',
        kingdom: null,
        isCurrent: true,
      });
    }
    res.json({ current, rows });
  });

  // GET /api/external/status — config + loop state + latest snapshot summary
  // for the request's active clan (req.clanId). Drives the ChestTracker tab
  // visibility: when the active clan has no share code, settings.enabled is
  // false and the tab stays hidden.
  router.get('/status', (req, res) => {
    const clanId = req.clanId ?? 1;
    const clan = getClanById(clanId);
    const settings = clan ? readClanSettings(clan) : readSettings();
    const status = statusForClan(clanId);
    // `viewShareCode` is what the page is currently looking at — the clan's
    // live code by default, or an archived one when the picker asks for it.
    // The loop/settings block below stays keyed on the live code, since
    // polling state describes the active integration only.
    const viewShareCode = resolveShareCode(clanId, req.query.shareCode);
    const latest = viewShareCode
      ? getLatestSnapshot({ clanId, shareCode: viewShareCode })
      : null;
    // Fall back to the poll_log timestamp so manual fetches and pre-restart
    // polls still surface as "last checked". The in-memory loop value only
    // moves on scheduled cycles and doesn't survive a container restart.
    const lastPolledAt = viewShareCode
      ? getLatestPollAt({ clanId, shareCode: viewShareCode })
      : null;
    res.json({
      settings: {
        enabled: settings.enabled,
        shareCode: settings.shareCode ?? '',
        viewShareCode: viewShareCode ?? '',
        viewIsArchived: !!viewShareCode && viewShareCode !== (settings.shareCode ?? ''),
        pollIntervalHours: settings.pollIntervalHours,
        backfillWeeks: settings.backfillWeeks,
        initialBackfillDone: settings.initialBackfillDone,
      },
      defaults: DEFAULTS,
      // Last poll recorded for the tracker being VIEWED. When that's an
      // archived code the loop's in-memory timestamp belongs to a
      // different tracker entirely, so the UI reads this instead.
      viewLastPolledAt: lastPolledAt,
      loop: {
        running: status.running,
        inFlight: status.inFlight,
        nextFetchAt: status.nextFetchAt ? new Date(status.nextFetchAt).toISOString() : null,
        lastSuccessAt: status.lastSuccessAt ?? lastPolledAt,
        lastError: status.lastError,
        backfill: status.backfill,
      },
      latestSnapshot: latest,
    });
  });

  // POST /api/external/backfill — { weeks } — fetch the last N game weeks
  // for the clan's current share code, on demand.
  //
  // The `backfillWeeks` setting only fires once, at first enable, behind a
  // per-share-code marker. Setting it too low left no way back except
  // "Fetch a past week…" one week at a time. Admin only, same as the other
  // ingest triggers.
  //
  // Returns as soon as the run starts — a 52-week range would otherwise
  // outlive the proxy's request timeout. Progress lands in
  // /status → loop.backfill.
  router.post('/backfill', requireAdmin, (req, res) => {
    const clanId = req.clanId ?? 1;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const weeks = parseBoundedInt(body.weeks, DEFAULTS.BACKFILL_WEEKS, {
      min: 1,
      max: MAX_BACKFILL_WEEKS,
    });

    const result = externalLoop instanceof MultiClanExternalLoop
      ? externalLoop.startBackfillForClan(clanId, weeks)
      : externalLoop.startBackfill(weeks);

    if (!result.started) {
      // 409: the request was well-formed, the clan just isn't in a state
      // to accept it (already backfilling, or no share code).
      return res.status(409).json({ error: result.reason ?? 'Could not start backfill.' });
    }

    logAction(req.user!.id, 'external_backfill', { clanId, weeks: result.total });
    return res.json({ ok: true, weeks: result.total });
  });

  // PUT /api/external/config — { enabled?, shareCode?, pollIntervalHours?, backfillWeeks? }
  // Admin only: regular users can view the External tab but not reconfigure it.
  // Writes to the request's active clan (req.clanId), not the legacy global
  // ct_config table — so a superadmin viewing clan #N saves to clan #N's row.
  router.put('/config', requireAdmin, (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const clanId = req.clanId ?? 1;
    const clan = getClanById(clanId);
    if (!clan) {
      return res.status(404).json({ error: 'Active clan not found' });
    }

    let nextShareCode = clan.ctShareCode ?? '';
    let nextPollIntervalHours = clan.ctPollIntervalHours ?? DEFAULTS.POLL_INTERVAL_HOURS;
    let nextBackfillWeeks = clan.ctBackfillWeeks ?? DEFAULTS.BACKFILL_WEEKS;
    let shareCodeChanged = false;

    if ('shareCode' in body) {
      const code = validShareCode(body.shareCode);
      if (body.shareCode && !code) {
        return res.status(400).json({
          error: 'Share code must be 4–32 letters/digits (the code portion of /counts/XXXXX).',
        });
      }
      const newCode = code ?? '';
      if (newCode !== nextShareCode) shareCodeChanged = true;
      nextShareCode = newCode;
    }

    // The per-clan model derives `enabled` from `!!shareCode`, so unchecking
    // the Enable box clears the share code (preserves the legacy "uncheck to
    // disable" UX). The user's code is recoverable by re-pasting it.
    if ('enabled' in body) {
      const enabled = body.enabled === true || body.enabled === 'true';
      if (!enabled && nextShareCode !== '') {
        shareCodeChanged = true;
        nextShareCode = '';
      }
    }

    if ('pollIntervalHours' in body) {
      nextPollIntervalHours = parseBoundedFloat(
        body.pollIntervalHours,
        DEFAULTS.POLL_INTERVAL_HOURS,
        { min: 5 / 60, max: 24 },
      );
    }

    if ('backfillWeeks' in body) {
      nextBackfillWeeks = parseBoundedInt(body.backfillWeeks, DEFAULTS.BACKFILL_WEEKS, { min: 0, max: 52 });
    }

    setClanChestTrackerSettings(clanId, {
      shareCode: nextShareCode,
      pollIntervalHours: nextPollIntervalHours,
      backfillWeeks: nextBackfillWeeks,
    });

    // Changing share code invalidates the per-share "backfill done" marker
    // so the next enable does an initial backfill for the new clan.
    if (shareCodeChanged && nextShareCode) {
      writeSettings({ shareCode: nextShareCode, initialBackfillDone: false });
    }

    logAction(req.user!.id, 'update_external_config', {
      clanId,
      shareCode: nextShareCode,
      pollIntervalHours: nextPollIntervalHours,
      backfillWeeks: nextBackfillWeeks,
    });

    if (externalLoop instanceof MultiClanExternalLoop) {
      externalLoop.restartClan(clanId);
    } else {
      externalLoop.restart();
    }

    const fresh = getClanById(clanId);
    const settings = fresh ? readClanSettings(fresh) : readSettings();
    return res.json({
      ok: true,
      settings: {
        enabled: settings.enabled,
        shareCode: settings.shareCode ?? '',
        pollIntervalHours: settings.pollIntervalHours,
        backfillWeeks: settings.backfillWeeks,
        initialBackfillDone: settings.initialBackfillDone,
      },
    });
  });

  // GET /api/external/poll-log.csv — admin-only download of every poll
  // outcome (200/304/error). Used to find the upstream update cadence.
  // Always scoped to the active clan's share code; any user-supplied
  // ?shareCode= is ignored.
  router.get('/poll-log.csv', requireAdmin, (req, res) => {
    const clanId = req.clanId ?? 1;
    const limit = parseBoundedInt(req.query.limit, 5000, { min: 1, max: 50000 });
    // No ?shareCode= means the clan's whole poll history across every code
    // it has used — that's the useful view for diagnosing cadence over a
    // tracker switch. Pass one to narrow to a single archive.
    const shareCode = typeof req.query.shareCode === 'string'
      ? resolveShareCode(clanId, req.query.shareCode) ?? undefined
      : undefined;
    const rows = listPollLog({ clanId, shareCode, limit });

    const escape = (v: unknown): string => {
      if (v == null) return '';
      const s = String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const header = 'polled_at,share_code,window_start,window_end,trigger,status,etag_changed,prior_etag,new_etag,error_message\n';
    const body = rows.map((r) => [
      r.polledAt, r.shareCode, r.windowStart, r.windowEnd, r.trigger,
      r.status, r.etagChanged ? 1 : 0, r.priorEtag, r.newEtag, r.errorMessage,
    ].map(escape).join(',')).join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="chesttracker-poll-log.csv"');
    res.send(header + body + '\n');
  });

  // GET /api/external/snapshots?limit=&offset=
  // Always scoped to the request's active clan (req.clanId). Any user-
  // supplied ?shareCode= is ignored — clan B's session can't read clan A's
  // snapshots even if B knows A's share code.
  router.get('/snapshots', (req, res) => {
    const limit = parseBoundedInt(req.query.limit, 50, { min: 1, max: 500 });
    const offset = parseBoundedInt(req.query.offset, 0, { min: 0, max: 1_000_000 });
    const clanId = req.clanId ?? 1;
    const shareCode = resolveShareCode(clanId, req.query.shareCode);
    if (!shareCode) {
      return res.json({ total: 0, limit, offset, rows: [] });
    }

    const result = listSnapshots({ limit, offset, clanId, shareCode });
    return res.json({
      total: result.total,
      limit,
      offset,
      rows: result.rows,
    });
  });

  // GET /api/external/weeks — one canonical snapshot per distinct game-week
  // window for the active clan, newest week first. Powers the detail card's
  // week-stepper arrows: each row is the *last* snapshot captured for that
  // week (the most complete data for it), so stepping back loads correct,
  // settled week data rather than a mid-week partial. Scoped to the active
  // clan's share code exactly like /snapshots.
  router.get('/weeks', (req, res) => {
    const clanId = req.clanId ?? 1;
    const shareCode = resolveShareCode(clanId, req.query.shareCode);
    if (!shareCode) {
      return res.json({ rows: [] });
    }
    const limit = parseBoundedInt(req.query.limit, 520, { min: 1, max: 520 });
    const rows = listSnapshotWeeks({ clanId, shareCode, limit });
    return res.json({ rows });
  });

  // GET /api/external/snapshots/:id — full detail (players, categories, definitions)
  // Returns 404 if the snapshot belongs to a different clan, so sequential
  // IDs can't be enumerated across clans.
  //
  // The check is on clan_id, not on the clan's current share code. Share
  // codes change; ownership doesn't. Matching on the live code used to
  // 404 every snapshot the clan had captured under a previous tracker —
  // which is exactly what made a code swap look like data loss.
  router.get('/snapshots/:id', (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: 'Invalid snapshot id' });
    }
    const detail = getSnapshot(id);
    if (!detail) {
      return res.status(404).json({ error: 'Snapshot not found' });
    }
    const clanId = req.clanId ?? 1;
    if (detail.clanId !== clanId) {
      return res.status(404).json({ error: 'Snapshot not found' });
    }
    return res.json(detail);
  });

  // POST /api/external/fetch — one-off manual fetch.
  // Admin only.
  //
  // Body shapes (all optional):
  //   { }                      → fetch the CURRENT game week (same as scheduled cycle)
  //   { weeksAgo: 3 }          → fetch the weekly window starting N weeks before "now"
  //   { weekContaining: "ISO" }→ fetch the weekly window containing that timestamp
  //   { start, end }           → explicit window (admin hatch; durationDays = days between)
  router.post('/fetch', requireAdmin, async (req, res) => {
    const clanId = req.clanId ?? 1;
    const clan = getClanById(clanId);
    const settings = clan ? readClanSettings(clan) : readSettings();
    if (!settings.shareCode) {
      return res.status(400).json({ error: 'No share code configured for this clan. Set one on the Admin tab first.' });
    }

    const body = (req.body ?? {}) as Record<string, unknown>;

    let start: string | undefined;
    let end: string | undefined;
    let durationDays = 7;

    if (typeof body.start === 'string' && typeof body.end === 'string' && body.start && body.end) {
      start = body.start;
      end = body.end;
      const spanMs = new Date(end).getTime() - new Date(start).getTime();
      if (!Number.isFinite(spanMs) || spanMs <= 0) {
        return res.status(400).json({ error: 'Invalid start/end window.' });
      }
      durationDays = Math.max(1, Math.round(spanMs / (24 * 60 * 60 * 1000)));
    } else if ((body.start && !body.end) || (body.end && !body.start)) {
      return res.status(400).json({ error: 'Provide both start and end, or neither.' });
    } else {
      const { computeWeekWindowContaining, computeCurrentWeekWindow } = await import('../../external/chesttracker-client.js');
      const { loadConfig } = await import('../../config/index.js');
      const rolloverHour = loadConfig().gameDayRolloverUtcHour;

      if (typeof body.weekContaining === 'string' && body.weekContaining) {
        const anchor = new Date(body.weekContaining);
        if (Number.isNaN(anchor.getTime())) {
          return res.status(400).json({ error: 'Invalid weekContaining date.' });
        }
        const w = computeWeekWindowContaining(anchor.getTime(), rolloverHour);
        start = w.start;
        end = w.end;
      } else if (body.weeksAgo !== undefined) {
        const n = parseBoundedInt(body.weeksAgo, 0, { min: 0, max: 520 });
        const anchorMs = Date.now() - n * 7 * 24 * 60 * 60 * 1000;
        const w = computeWeekWindowContaining(anchorMs, rolloverHour);
        start = w.start;
        end = w.end;
      } else {
        const w = computeCurrentWeekWindow(rolloverHour);
        start = w.start;
        end = w.end;
      }
    }

    try {
      const result = await ingestSnapshot({
        clanId,
        shareCode: settings.shareCode,
        start,
        end,
        durationDays,
        trigger: 'manual',
      });
      logAction(req.user!.id, 'external_manual_fetch', {
        clanId,
        start: start ?? null,
        end: end ?? null,
        durationDays,
        status: result.status,
        snapshotId: result.snapshotId,
      });
      return res.json({ ok: true, ...result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err }, `Manual external fetch failed: ${msg}`);
      return res.status(502).json({ error: `Fetch failed: ${msg}` });
    }
  });

  return router;
}
