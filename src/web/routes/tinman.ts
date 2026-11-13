/**
 * Rise of the Ancients (Tinman) standings, pasted in after each summon — shown
 * on Events → Ancients. See data/repositories/tinman-repo.ts.
 *
 * The same router serves Trials of Olympus, Ragnarok and Dark Omens' Spoils of
 * Dread damage ranking (Events → Olympus / Ragnarok / Dark Omens), pasted per
 * day: a "summon" in the paths below is then the run's day (1–5 for Olympus,
 * 1–2 for the other two). None has targets or a Tinman cadence, so those parts
 * are Ancients-only.
 *
 * Mounted at /api/tinman (Ancients) and /api/event-scores/<event> behind
 * requireAuth + requireClanContext. Reading is open to every member;
 * uploading, deleting and settling who a name is are admin-only, and every
 * query is scoped to the caller's active clan.
 */
import { Router } from 'express';
import * as tinmanRepo from '../../data/repositories/tinman-repo.js';
import { parseTinmanStandings, parseTierTargets, missingRanks } from '../../data/tinman-parse.js';
import { getGuardsSummaries } from '../../data/repositories/guards-repo.js';
import { logAction } from '../../data/repositories/user-repo.js';
import { requireAdmin } from '../middleware/auth.js';
import { loadConfig } from '../../config/index.js';
import {
  currentGameDate,
  daysBetweenGameDates,
  gameDateFor,
  isTinmanDay,
  ANCIENTS_CYCLE_DAYS,
} from '../../utils/game-day.js';
import { clanCalendarRealm } from '../../data/repositories/clan-repo.js';
import { getEventOccurrences } from '../../external/event-calendar.js';

const MAX_TEXT_LENGTH = 200_000;

/** A real YYYY-MM-DD day, or null. */
function parseDate(raw: unknown): string | null {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const ms = Date.parse(`${raw}T00:00:00Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== raw) return null;
  return raw;
}

/** A day that can be written to: a past or the current game day. */
function validDate(raw: unknown, today: string): string | null {
  const date = parseDate(raw);
  return date && date <= today ? date : null;
}

/** 1–max exactly, or null. Strict on purpose: clamping would file a "summon 9" paste under 8. */
function parseSummon(raw: unknown, max: number): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= max ? n : null;
}

/** The newest Tinman day at or before today on the cadence — the default run. */
function latestTinmanDay(today: string): string {
  for (let back = 0; back < ANCIENTS_CYCLE_DAYS; back++) {
    const d = new Date(Date.parse(`${today}T00:00:00Z`) - back * 86_400_000).toISOString().slice(0, 10);
    if (isTinmanDay(d)) return d;
  }
  return today;
}

/**
 * A Seasonal Kingdom clan's Tinman days, newest first, or null for a
 * normal-kingdom clan (whose fixed 6-day cadence answers instead).
 *
 * SK runs Ancients on its own rotation (every 5 days in SK 2026, and its first
 * run was a day off even that), so the only reliable list is the clan's own
 * calendar: each started Ancients run ends on its Tinman day. A feed outage
 * gives [] — the checks below then stay silent rather than guess.
 */
async function seasonalTinmanDays(clanId: number): Promise<string[] | null> {
  if (clanCalendarRealm(clanId) !== 'season') return null;
  const rollover = loadConfig().gameDayRolloverUtcHour;
  try {
    const runs = await getEventOccurrences('ancients', clanId);
    return runs.map((o) => gameDateFor(Date.parse(o.resetAt) - 1, rollover));
  } catch {
    return [];
  }
}

export function createTinmanRouter(eventKey: tinmanRepo.ScoreEventKey = 'ancients'): Router {
  const router = Router();
  const today = () => currentGameDate(loadConfig().gameDayRolloverUtcHour);
  const ancients = eventKey === 'ancients';
  const maxRounds = tinmanRepo.SCORE_EVENTS[eventKey].maxRounds;
  const round = ancients ? 'summon' : 'day';
  const action = (name: string) => (ancients ? `tinman_${name}` : `${eventKey}_${name}`);

  /**
   * Standings for one run (`?date=` its day; default: the newest). The per-day
   * events have no cadence to fall back on, so their default is the newest
   * pasted run.
   *
   * A future day reads as a run with nothing pasted yet, not an error: a live
   * Ancients run files its scores under its last (Tinman) day, which is still
   * ahead until that day, and the Events page opens on Participants only when
   * this read says the run is empty. Writes keep the past-or-today rule.
   */
  router.get('/', async (req, res) => {
    const clanId = req.clanId!;
    const t = today();
    const skDays = ancients ? await seasonalTinmanDays(clanId) : null;
    const newestPasted = () => tinmanRepo.listTinmanDates(clanId, 1, eventKey)[0] ?? t;
    const date = req.query.date !== undefined
      ? parseDate(req.query.date)
      : skDays ? skDays.find((d) => d <= t) ?? newestPasted()
      : ancients ? latestTinmanDay(t) : newestPasted();
    if (!date) {
      res.status(400).json({ error: 'date must be a game day, YYYY-MM-DD' });
      return;
    }
    // Each matched player's estimated guards level, so the page can hold their
    // total against their tier's target. Null = unknown (the page assumes G7).
    const standings = tinmanRepo.getTinmanStandings(clanId, date, eventKey);
    const guards = ancients ? getGuardsSummaries(clanId, t) : null;
    res.json({
      ...standings,
      players: standings.players.map((p) => ({
        ...p,
        guardsLevel: p.memberId ? guards?.get(p.memberId)?.level ?? null : null,
      })),
      targets: ancients ? tinmanRepo.getTinmanTargets(clanId, date) : null,
      isTinmanDay: !ancients ? null
        : skDays ? (skDays.length ? skDays.includes(date) : null)
        : isTinmanDay(date),
      // Which schedule isTinmanDay was judged by, so the card words its warning.
      seasonalKingdom: skDays !== null,
      dates: tinmanRepo.listTinmanDates(clanId, 30, eventKey),
      maxSummons: maxRounds,
    });
  });

  /** Paste one summon's cumulative ranking. Re-sending a summon replaces it. */
  router.put('/:date/summons/:summon', requireAdmin, async (req, res) => {
    const clanId = req.clanId!;
    const date = validDate(req.params.date, today());
    const summon = parseSummon(req.params.summon, maxRounds);
    if (!date || !summon) {
      res.status(400).json({ error: `Need a game day and a ${round} from 1 to ${maxRounds}.` });
      return;
    }
    const text = typeof req.body?.text === 'string' ? req.body.text : '';
    if (!text.trim() || text.length > MAX_TEXT_LENGTH) {
      res.status(400).json({ error: 'Paste the ranking text first.' });
      return;
    }
    const parsed = parseTinmanStandings(text);
    if (parsed.rows.length === 0) {
      res.status(400).json({
        error: 'No ranking rows found. Expected lines like "| 1 | Name | 63,965,364 |", "1,Name,\\"63,965,364\\"" or "1 Name 63,965,364".',
        skipped: parsed.skipped.slice(0, 5),
      });
      return;
    }
    const result = tinmanRepo.saveTinmanSummon({
      clanId, date, summon, rows: parsed.rows, uploadedBy: req.user!.username, eventKey,
    });
    logAction(req.user!.id, action('upload'), { clanId, date, summon, ...result });
    const t = today();
    const ageDays = daysBetweenGameDates(date, t);
    const skDays = ancients ? await seasonalTinmanDays(clanId) : null;
    // An SK run is "more than a cycle old" once a later Tinman day has fully
    // passed — the 6-day count below is the normal kingdom's cadence.
    const stale = skDays
      ? skDays.some((d) => d > date && d < t)
      : ageDays !== null && ageDays > ANCIENTS_CYCLE_DAYS;
    let warning: string | null = null;
    if (skDays) {
      if (skDays.length && !skDays.includes(date)) warning = `${date} isn't a Tinman day on the Seasonal Kingdom calendar.`;
    } else if (ancients && !isTinmanDay(date)) {
      warning = `${date} isn't a Tinman day on the usual 6-day cadence.`;
    }
    res.json({
      ok: true,
      result: { ...result, skipped: parsed.skipped.length, skippedSample: parsed.skipped.slice(0, 5), missingRanks: missingRanks(parsed.rows) },
      warning,
      staleWarning: ancients && stale ? 'This run is more than a cycle old.' : null,
    });
  });

  router.delete('/:date/summons/:summon', requireAdmin, (req, res) => {
    const clanId = req.clanId!;
    const date = validDate(req.params.date, today());
    const summon = parseSummon(req.params.summon, maxRounds);
    if (!date || !summon || !tinmanRepo.deleteTinmanSummon(clanId, date, summon, eventKey)) {
      res.status(404).json({ error: `No upload for that ${round}.` });
      return;
    }
    logAction(req.user!.id, action('delete'), { clanId, date, summon });
    res.json({ ok: true });
  });

  /**
   * The run's per-tier targets, pasted from the Ancient planner's "Points per
   * member" table. Re-sending replaces them. Ancients only.
   */
  if (ancients) router.put('/:date/targets', requireAdmin, (req, res) => {
    const clanId = req.clanId!;
    const date = validDate(req.params.date, today());
    const text = typeof req.body?.text === 'string' ? req.body.text : '';
    if (!date || !text.trim() || text.length > MAX_TEXT_LENGTH) {
      res.status(400).json({ error: 'Paste the Points per member table first.' });
      return;
    }
    const parsed = parseTierTargets(text);
    if (Object.keys(parsed.tiers).length === 0) {
      res.status(400).json({
        error: 'No tier targets found. Expected lines like "G9  6 members  61.3M  368M  19.2%".',
        skipped: parsed.skipped.slice(0, 5),
      });
      return;
    }
    tinmanRepo.saveTinmanTargets({ clanId, date, tiers: parsed.tiers, kills: parsed.kills, savedBy: req.user!.username });
    logAction(req.user!.id, 'tinman_targets', { clanId, date, kills: parsed.kills, tiers: parsed.tiers });
    res.json({ ok: true, targets: tinmanRepo.getTinmanTargets(clanId, date), skipped: parsed.skipped });
  });

  if (ancients) router.delete('/:date/targets', requireAdmin, (req, res) => {
    const clanId = req.clanId!;
    const date = validDate(req.params.date, today());
    if (!date || !tinmanRepo.deleteTinmanTargets(clanId, date)) {
      res.status(404).json({ error: 'No targets for that run.' });
      return;
    }
    logAction(req.user!.id, 'tinman_targets_delete', { clanId, date });
    res.json({ ok: true });
  });

  /** Settle who a pasted name is, for the whole run: { rawName, memberId | null }. */
  router.put('/:date/assign', requireAdmin, (req, res) => {
    const clanId = req.clanId!;
    const date = validDate(req.params.date, today());
    const rawName = typeof req.body?.rawName === 'string' ? req.body.rawName : '';
    const memberIdRaw = req.body?.memberId;
    const memberId = memberIdRaw === null ? null : Number(memberIdRaw);
    if (!date || !rawName.trim() || (memberId !== null && !Number.isInteger(memberId))) {
      res.status(400).json({ error: 'Need a run date, the pasted name, and a member id (or null).' });
      return;
    }
    const changed = tinmanRepo.assignTinmanName(clanId, date, rawName, memberId, eventKey);
    if (changed === -1) {
      res.status(404).json({ error: 'Member not found' });
      return;
    }
    if (changed === 0) {
      res.status(404).json({ error: 'That name is not in this run.' });
      return;
    }
    logAction(req.user!.id, action('assign'), { clanId, date, rawName, memberId });
    res.json({ ok: true, changed });
  });

  return router;
}
