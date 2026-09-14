import type { Router } from 'express';
import {
  getClanById,
  setClanDiscordSettings,
} from '../../../data/repositories/clan-repo.js';
import { logAction } from '../../../data/repositories/user-repo.js';
import { requireClanAdmin } from '../../middleware/auth.js';
import { reloadClanBot, sendClanTestMessage, sendClanDigestDmTest, isClanBotConnected } from '../../../discord/bot.js';
import { normalizeDigestRecipients } from '../../../discord/digest-recipients.js';
import { fetchDiscordDirectory, describeDiscordError } from '../../../discord/directory.js';
import { loadConfig } from '../../../config/index.js';
import { childLogger } from '../../../utils/logger.js';
import { createClanSubRouter } from './_shared.js';

const log = childLogger('clans-route');

/**
 * Per-clan Discord configuration. Superadmin/admin via requireClanAdmin
 * (clan ownership AND admin role — a plain member must not be able to
 * repoint the clan's bot token or spam its channel).
 * Saving settings persists synchronously and reports back to the browser
 * immediately; the actual gateway hot-reload (which can take many
 * seconds when Discord is slow) runs in the background so the UI
 * doesn't sit waiting on the response.
 */
export function createDiscordRouter(): Router {
  const router = createClanSubRouter();

  /**
   * Configure Discord per clan. The token is write-only — once set it
   * never round-trips to the browser; the GET endpoint exposes only
   * `discordTokenSet: boolean`.
   */
  router.put('/:clanId/discord', requireClanAdmin, async (req, res) => {
    const id = req.parsedClanId!;
    const existing = getClanById(id);
    if (!existing) {
      res.status(404).json({ error: 'Clan not found' });
      return;
    }
    const body = req.body ?? {};
    // Stored as a comma-separated list; normalised here so the field the
    // admin gets back is exactly what the bot will DM. A dropped entry
    // must not be silent, so the normalised list rides back on the
    // response and the page reflects it.
    const digestShareUserId = typeof body.dailyDigestShareUserId === 'string'
      ? normalizeDigestRecipients(body.dailyDigestShareUserId)
      : existing.discordDailyDigestShareUserId;
    setClanDiscordSettings(id, {
      enabled: !!body.enabled,
      token: typeof body.token === 'string' ? body.token : existing.discordToken,
      channelId: typeof body.channelId === 'string' ? body.channelId.trim() : existing.discordChannelId,
      guildId: typeof body.guildId === 'string' ? body.guildId.trim() : existing.discordGuildId,
      scanReportsEnabled: body.scanReportsEnabled ?? existing.discordScanReportsEnabled,
      onlyNewChests: body.onlyNewChests ?? existing.discordOnlyNewChests,
      dailyDigestEnabled: body.dailyDigestEnabled ?? existing.discordDailyDigestEnabled,
      dailyDigestShareUserId: digestShareUserId,
      commandsEnabled: body.commandsEnabled ?? existing.discordCommandsEnabled,
    });
    logAction(req.user!.id, 'clan.discord.update', { clanId: id });

    // Reply now — settings are persisted. The Discord client lifecycle
    // (gateway login, slash-command REST registration) can take many
    // seconds, sometimes minutes if Discord is slow or the token was
    // recently rotated. Holding the HTTP response open for that long
    // makes the browser fire its "Saved" / "Failed" alert long after
    // the user has navigated away. Hot-reload runs as a background task;
    // operators read the resulting state via the connection-status
    // indicator the UI polls.
    res.json({ ok: true, applying: true, connected: isClanBotConnected(id), digestShareUserId });

    void (async () => {
      try {
        const cfg = loadConfig();
        await reloadClanBot(id, cfg.gameDayRolloverUtcHour);
      } catch (err) {
        log.warn({ err, clanId: id }, 'Failed to hot-reload Discord bot for clan');
      }
    })();
  });

  /**
   * Send a one-off test message to the clan's Discord channel.
   */
  router.post('/:clanId/discord/test', requireClanAdmin, async (req, res) => {
    const id = req.parsedClanId!;
    const result = await sendClanTestMessage(id);
    if (result.ok) {
      res.json({ ok: true });
      return;
    }
    res.status(400).json({ error: result.error || 'Test failed' });
  });

  /**
   * Send a test plain-text digest DM to the configured recipient,
   * using the current game day's data so far. Lets the operator
   * verify the recipient's DM settings without waiting for the
   * scheduled daily digest.
   */
  router.post('/:clanId/discord/digest-dm-test', requireClanAdmin, async (req, res) => {
    const id = req.parsedClanId!;
    const result = await sendClanDigestDmTest(id);
    if (result.ok) {
      res.json({ ok: true, message: result.message });
      return;
    }
    res.status(400).json({ error: result.error || 'DM test failed' });
  });

  /**
   * Read the bot's own view of Discord so the settings form can offer
   * dropdowns of server / channel / member NAMES instead of snowflakes an
   * operator has to right-click-copy with Developer Mode on. Pasting the
   * wrong 18-digit number into the wrong field is the single most common
   * way this integration is misconfigured, and it fails silently: the bot
   * connects, and simply never posts anywhere.
   *
   * POST, not GET, for two reasons: the token may be supplied in the body
   * (so the lists can be browsed before the settings are saved — otherwise
   * the first-time flow is save-blind-then-fix), and a secret must not ride
   * in a query string where it lands in access logs.
   */
  router.post('/:clanId/discord/directory', requireClanAdmin, async (req, res) => {
    const id = req.parsedClanId!;
    const clan = getClanById(id);
    if (!clan) {
      res.status(404).json({ error: 'Clan not found' });
      return;
    }
    const body = req.body ?? {};
    // An unsaved token typed into the form wins over the stored one; it is
    // used for this lookup only and never persisted here.
    const typed = typeof body.token === 'string' ? body.token.trim() : '';
    const token = typed || clan.discordToken;
    if (!token) {
      res.status(400).json({ error: 'Add the bot token first — the dropdowns are read from Discord with it.' });
      return;
    }
    const requested = typeof body.guildId === 'string' ? body.guildId.trim() : '';
    const guildId = requested || clan.discordGuildId || null;
    try {
      res.json(await fetchDiscordDirectory(token, guildId));
    } catch (err) {
      log.warn({ err, clanId: id }, 'Discord directory lookup failed');
      res.status(400).json({ error: describeDiscordError(err) });
    }
  });

  return router;
}
