/**
 * Rise of the Ancients (Tinman) standings, pasted in after each summon — shown
 * on Events → Ancients. See data/repositories/tinman-repo.ts.
 *
 * Mounted at /api/tinman behind requireAuth + requireClanContext. Reading is
 * open to every member; uploading, deleting and settling who a name is are
 * admin-only, and every query is scoped to the caller's active clan.
 */
import { Router } from 'express';
import * as tinmanRepo from '../../data/repositories/tinman-repo.js';
import { parseTinmanStandings, parseTierTargets, missingRanks } from '../../data/tinman-parse.js';
import { getGuardsSummaries } from '../../data/repositories/guards-repo.js';
import { logAction } from '../../data/repositories/user-repo.js';
import { requireAdmin } from '../middleware/auth.js';
import { loadConfig } from '../../config/index.js';
import { currentGameDate, daysBetweenGameDates, isTinmanDay, ANCIENTS_CYCLE_DAYS } from '../../utils/game-day.js';

const MAX_TEXT_LENGTH = 200_000;

function validDate(raw: unknown, today: string): string | null {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const ms = Date.parse(`${raw}T00:00:00Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== raw) return null;
  if (raw > today) return null;
  return raw;
}

/** 1–8 exactly, or null. Strict on purpose: clamping would file a "summon 9" paste under 8. */
function parseSummon(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= tinmanRepo.TINMAN_MAX_SUMMONS ? n : null;
}

/** The newest Tinman day at or before today on the cadence — the default run. */
function latestTinmanDay(today: string): string {
  for (let back = 0; back < ANCIENTS_CYCLE_DAYS; back++) {
    const d = new Date(Date.parse(`${today}T00:00:00Z`) - back * 86_400_000).toISOString().slice(0, 10);
    if (isTinmanDay(d)) return d;
  }
  return today;
}

export function createTinmanRouter(): Router {
  const router = Router();
  const today = () => currentGameDate(loadConfig().gameDayRolloverUtcHour);

  /** Standings for one run (`?date=` the Tinman game day; default: the newest). */
  router.get('/', (req, res) => {
    const clanId = req.clanId!;
    const t = today();
    const date = req.query.date === undefined ? latestTinmanDay(t) : validDate(req.query.date, t);
    if (!date) {
      res.status(400).json({ error: 'date must be a past or current game day, YYYY-MM-DD' });
      return;
    }
    // Each matched player's estimated guards level, so the page can hold their
    // total against their tier's target. Null = unknown (the page assumes G7).
    const standings = tinmanRepo.getTinmanStandings(clanId, date);
    const guards = getGuardsSummaries(clanId, t);
    res.json({
      ...standings,
      players: standings.players.map((p) => ({
        ...p,
        guardsLevel: p.memberId ? guards.get(p.memberId)?.level ?? null : null,
      })),
      targets: tinmanRepo.getTinmanTargets(clanId, date),
      isTinmanDay: isTinmanDay(date),
      dates: tinmanRepo.listTinmanDates(clanId),
      maxSummons: tinmanRepo.TINMAN_MAX_SUMMONS,
    });
  });

  /** Paste one summon's cumulative ranking. Re-sending a summon replaces it. */
  router.put('/:date/summons/:summon', requireAdmin, (req, res) => {
    const clanId = req.clanId!;
    const date = validDate(req.params.date, today());
    const summon = parseSummon(req.params.summon);
    if (!date || !summon) {
      res.status(400).json({ error: `Need a game day and a summon from 1 to ${tinmanRepo.TINMAN_MAX_SUMMONS}.` });
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
        error: 'No ranking rows found. Expected lines like "| 1 | Name | 63,965,364 |" or "1 Name 63,965,364".',
        skipped: parsed.skipped.slice(0, 5),
      });
      return;
    }
    const result = tinmanRepo.saveTinmanSummon({
      clanId, date, summon, rows: parsed.rows, uploadedBy: req.user!.username,
    });
    logAction(req.user!.id, 'tinman_upload', { clanId, date, summon, ...result });
    const ageDays = daysBetweenGameDates(date, today());
    res.json({
      ok: true,
      result: { ...result, skipped: parsed.skipped.length, skippedSample: parsed.skipped.slice(0, 5), missingRanks: missingRanks(parsed.rows) },
      warning: isTinmanDay(date) ? null : `${date} isn't a Tinman day on the usual 6-day cadence.`,
      staleWarning: ageDays !== null && ageDays > ANCIENTS_CYCLE_DAYS ? 'This run is more than a cycle old.' : null,
    });
  });

  router.delete('/:date/summons/:summon', requireAdmin, (req, res) => {
    const clanId = req.clanId!;
    const date = validDate(req.params.date, today());
    const summon = parseSummon(req.params.summon);
    if (!date || !summon || !tinmanRepo.deleteTinmanSummon(clanId, date, summon)) {
      res.status(404).json({ error: 'No upload for that summon.' });
      return;
    }
    logAction(req.user!.id, 'tinman_delete', { clanId, date, summon });
    res.json({ ok: true });
  });

  /**
   * The run's per-tier targets, pasted from the Ancient planner's "Points per
   * member" table. Re-sending replaces them.
   */
  router.put('/:date/targets', requireAdmin, (req, res) => {
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

  router.delete('/:date/targets', requireAdmin, (req, res) => {
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
    const changed = tinmanRepo.assignTinmanName(clanId, date, rawName, memberId);
    if (changed === -1) {
      res.status(404).json({ error: 'Member not found' });
      return;
    }
    if (changed === 0) {
      res.status(404).json({ error: 'That name is not in this run.' });
      return;
    }
    logAction(req.user!.id, 'tinman_assign', { clanId, date, rawName, memberId });
    res.json({ ok: true, changed });
  });

  return router;
}
