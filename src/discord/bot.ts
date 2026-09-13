import { Client, GatewayIntentBits, REST, Routes, EmbedBuilder, MessageFlags, type TextChannel } from 'discord.js';
import { commands, handleCommand, autocompleteMembers } from './commands.js';
import { formatScanReportMessage, formatDailyDigestMessage, formatDailyDigestShareText } from './embeds.js';
import { parseDigestRecipients } from './digest-recipients.js';
import * as chestRepo from '../data/repositories/chest-repo.js';
import {
  listClans,
  getClanById,
  setClanLastDigestStatus,
  type Clan,
} from '../data/repositories/clan-repo.js';
import { childLogger } from '../utils/logger.js';
import type { ScanResult } from '../scheduler/loop.js';

const log = childLogger('discord');

/**
 * One Discord Client per *token*, not per clan. Two clans that share the
 * same bot application (same token) reuse a single gateway connection,
 * because Discord's gateway will disconnect/reconnect a token in a loop
 * if two Identify payloads arrive simultaneously. Per-clan state
 * (channelId, guildId, toggles, digest timer) lives in ClanCtx and is
 * keyed by clanId; the SharedClient is reference-counted so the last
 * clan to stop tears down the underlying connection.
 */
interface ClanCtx {
  clanId: number;
  clanName: string;
  token: string;
  channelId: string;
  guildId: string;
  scanReportsEnabled: boolean;
  onlyPostWithNewChests: boolean;
  commandsEnabled: boolean;
  digestEnabled: boolean;
  digestShareUserIds: string[];
  digestUtcHour: number;
  digestTimer: ReturnType<typeof setTimeout> | null;
}

interface SharedClient {
  client: Client;
  token: string;
  ready: boolean;
  // Set of clanIds currently using this Client. Using a Set instead of a
  // refcount integer keeps the ownership idempotent: attaching the same
  // clan twice or detaching a clan that was never attached can't drift
  // the count out of sync with reality.
  clanIds: Set<number>;
}

const clients: Map<string, SharedClient> = new Map();
const clans: Map<number, ClanCtx> = new Map();

function maskToken(token: string): string {
  if (!token) return '<empty>';
  if (token.length <= 8) return '****';
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

function findClanByChannel(channelId: string | null | undefined): ClanCtx | undefined {
  if (!channelId) return undefined;
  for (const ctx of clans.values()) {
    if (ctx.channelId === channelId) return ctx;
  }
  return undefined;
}

async function ensureClient(token: string): Promise<SharedClient> {
  const existing = clients.get(token);
  if (existing) return existing;

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const shared: SharedClient = { client, token, ready: false, clanIds: new Set() };
  clients.set(token, shared);

  client.on('clientReady', async () => {
    shared.ready = true;
    const usingThisToken = Array.from(clans.values()).filter((c) => c.token === token);
    log.info(
      `Discord client ${maskToken(token)} logged in as ${client.user?.tag} (clans: ${usingThisToken.map((c) => `#${c.clanId}`).join(', ') || 'none yet'})`,
    );
    const guildIds = new Set(usingThisToken.map((c) => c.guildId).filter((g) => g));
    for (const gid of guildIds) {
      try {
        await registerCommandsForGuild(token, gid);
      } catch (err) {
        log.error(`Failed to register commands for guild ${gid}: ${String(err)}`);
      }
    }
    // Now that the gateway is up, replay any digest missed while the
    // process was down (e.g. the container wasn't running at rollover).
    for (const c of usingThisToken) {
      try {
        await catchUpMissedDigest(c.clanId);
      } catch (err) {
        log.error(`Clan #${c.clanId}: digest catch-up failed: ${String(err)}`);
      }
    }
  });

  client.on('interactionCreate', async (interaction) => {
    // Autocomplete arrives as its own interaction type, before the command is
    // ever submitted. It answers with choices and nothing else — no reply, no
    // deferral — and Discord shows the user nothing at all if we throw, so it
    // is guarded and silently falls back to an empty list.
    if (interaction.isAutocomplete()) {
      const ctx = findClanByChannel(interaction.channelId);
      if (!ctx || ctx.token !== token || !ctx.commandsEnabled) {
        await interaction.respond([]).catch(() => {});
        return;
      }
      try {
        const focused = interaction.options.getFocused(true);
        const choices = focused.name === 'player'
          ? autocompleteMembers(ctx.clanId, String(focused.value ?? ''))
          : [];
        await interaction.respond(choices);
      } catch (err) {
        log.warn({ noAlert: true }, `Clan #${ctx.clanId}: autocomplete failed: ${String(err)}`);
        await interaction.respond([]).catch(() => {});
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;
    const ctx = findClanByChannel(interaction.channelId);
    if (!ctx || ctx.token !== token) {
      // Slash commands are gated to each clan's single configured channel,
      // matched by ID. Log the mismatch so an operator can compare the
      // channel the command actually came from against what's configured —
      // the usual causes are a stray space in the pasted Channel ID (now
      // trimmed on save and on context build) or the command being run in a
      // thread, which has its own ID distinct from its parent channel.
      log.info(
        `Slash command in channel ${interaction.channelId} matched no configured clan channel ` +
          `(configured: ${Array.from(clans.values()).map((c) => `#${c.clanId}=${c.channelId || '<unset>'}`).join(', ') || 'none'})`,
      );
      await interaction
        .reply({
          content:
            "This channel isn't the configured channel for any clan. Slash commands only work in the exact channel set in the clan's Discord settings — note that a thread counts as a different channel from its parent.",
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
      return;
    }
    if (!ctx.commandsEnabled) {
      await interaction
        .reply({ content: 'Slash commands are disabled for this clan.', flags: MessageFlags.Ephemeral })
        .catch(() => {});
      return;
    }
    try {
      await handleCommand(interaction, ctx.channelId, ctx.clanId);
    } catch (err) {
      log.error(`Clan #${ctx.clanId}: command error: ${String(err)}`);
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply('An error occurred.').catch(() => {});
      } else {
        await interaction.reply('An error occurred.').catch(() => {});
      }
    }
  });

  await client.login(token);
  return shared;
}

/**
 * Register slash commands for a (token, guildId) pair. Commands are
 * registered if *any* clan attached to that token+guild has
 * commandsEnabled, otherwise cleared. Safe to call repeatedly; idempotent
 * from Discord's side.
 */
async function registerCommandsForGuild(token: string, guildId: string): Promise<void> {
  const shared = clients.get(token);
  if (!shared || !shared.ready || !shared.client.user) return;

  const applicationId = shared.client.user.id;
  const rest = new REST().setToken(token);

  const anyEnabled = Array.from(clans.values()).some(
    (c) => c.token === token && c.guildId === guildId && c.commandsEnabled,
  );
  const body = anyEnabled ? commands.map((c) => c.toJSON()) : [];

  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(applicationId, guildId), { body });
    try {
      await rest.put(Routes.applicationCommands(applicationId), { body: [] });
    } catch (cleanupErr) {
      log.warn(`Could not clear global command scope for ${maskToken(token)}: ${String(cleanupErr)}`);
    }
    log.debug(
      `Token ${maskToken(token)}: slash commands ${anyEnabled ? 'registered' : 'cleared'} for guild ${guildId}`,
    );
  } else {
    await rest.put(Routes.applicationCommands(applicationId), { body });
    log.debug(
      `Token ${maskToken(token)}: slash commands ${anyEnabled ? 'registered globally' : 'cleared globally'}`,
    );
  }
}

async function startBotForClan(clan: Clan, gameDayRolloverUtcHour: number): Promise<void> {
  if (!clan.discordEnabled || !clan.discordToken) {
    log.info(`Clan #${clan.id} (${clan.name}): Discord disabled or no token, skipping`);
    return;
  }
  if (clans.has(clan.id)) {
    log.warn(`Clan #${clan.id} bot is already running; stop it before starting again`);
    return;
  }

  const ctx: ClanCtx = {
    clanId: clan.id,
    clanName: clan.name,
    token: clan.discordToken,
    channelId: clan.discordChannelId.trim(),
    guildId: clan.discordGuildId.trim(),
    scanReportsEnabled: clan.discordScanReportsEnabled,
    onlyPostWithNewChests: clan.discordOnlyNewChests,
    commandsEnabled: clan.discordCommandsEnabled,
    digestEnabled: clan.discordDailyDigestEnabled,
    digestShareUserIds: parseDigestRecipients(clan.discordDailyDigestShareUserId),
    digestUtcHour: gameDayRolloverUtcHour,
    digestTimer: null,
  };
  clans.set(clan.id, ctx);

  const shared = await ensureClient(ctx.token);
  shared.clanIds.add(clan.id);

  // If the Client was already ready before this clan attached, register
  // its guild's commands now — the clientReady handler won't fire again.
  // The same applies to the missed-digest catch-up, which needs a live
  // gateway to send: clientReady already ran, so replay it here instead.
  if (shared.ready) {
    if (ctx.guildId) {
      try {
        await registerCommandsForGuild(ctx.token, ctx.guildId);
      } catch (err) {
        log.error(`Clan #${clan.id}: failed to register slash commands: ${String(err)}`);
      }
    }
    try {
      await catchUpMissedDigest(clan.id);
    } catch (err) {
      log.error(`Clan #${clan.id}: digest catch-up failed: ${String(err)}`);
    }
  }

  scheduleNextDigest(clan.id);
}

/**
 * Start one Discord bot per clan that has Discord enabled. Called once at
 * startup. Skips clans where discordEnabled is false or the token is empty.
 *
 * Clans that share the same token share one underlying Client; the
 * gameDayRolloverUtcHour comes from the global config — daily digests
 * fire at the same UTC hour for every clan because the rollover is a
 * game-wide attribute, not a per-clan choice.
 */
export async function startAllClanBots(gameDayRolloverUtcHour: number): Promise<void> {
  for (const clan of listClans()) {
    try {
      await startBotForClan(clan, gameDayRolloverUtcHour);
    } catch (err) {
      log.error(`Failed to start Discord bot for clan #${clan.id}: ${String(err)}`);
    }
  }
}

/**
 * Stop and remove a single clan's Discord bot. Used by the admin
 * "save Discord settings" hot-reload path before re-launching with the
 * fresh token/channel. Idempotent. Tears down the shared Client only
 * when the last clan using its token has stopped.
 */
export async function stopClanBot(clanId: number): Promise<void> {
  const ctx = clans.get(clanId);
  if (!ctx) return;
  if (ctx.digestTimer) clearTimeout(ctx.digestTimer);
  clans.delete(clanId);

  const shared = clients.get(ctx.token);
  if (!shared) return;
  shared.clanIds.delete(clanId);

  if (shared.clanIds.size === 0) {
    try {
      await shared.client.destroy();
    } catch (err) {
      log.warn(`Token ${maskToken(ctx.token)}: error destroying client: ${String(err)}`);
    }
    clients.delete(ctx.token);
    log.info(`Clan #${clanId} Discord bot stopped (last ref on token ${maskToken(ctx.token)})`);
  } else {
    // Other clans still using this token — re-register commands for the
    // guild we just left, in case the command set changed.
    if (shared.ready && ctx.guildId) {
      try {
        await registerCommandsForGuild(ctx.token, ctx.guildId);
      } catch (err) {
        log.warn(`Clan #${clanId}: failed to refresh commands after detach: ${String(err)}`);
      }
    }
    log.info(
      `Clan #${clanId} Discord bot stopped (token ${maskToken(ctx.token)} still used by clans: ${Array.from(shared.clanIds).map((id) => `#${id}`).join(', ')})`,
    );
  }
}

/**
 * Start (or restart) a single clan's Discord bot. Called by the admin
 * UI after saving per-clan settings so the new token/channel/toggles
 * take effect without a container restart.
 */
export async function startClanBot(clanId: number, gameDayRolloverUtcHour: number): Promise<void> {
  await stopClanBot(clanId);
  const clan = getClanById(clanId);
  if (!clan) {
    log.warn(`startClanBot: clan #${clanId} not found`);
    return;
  }
  await startBotForClan(clan, gameDayRolloverUtcHour);
}

/**
 * Apply freshly-saved per-clan Discord settings to the already-running bot.
 *
 * The common case — an operator flips a toggle or edits the channel without
 * changing the token — updates the live ClanCtx in place and re-registers
 * commands / reschedules the digest, leaving the gateway connection alone.
 * The previous approach (always stop → destroy client → re-login the same
 * token) churned Discord's gateway with a back-to-back disconnect/identify,
 * which left the rebuilt context unreliable so toggle changes didn't take
 * effect until a full container restart. Because clans.set() updates the
 * very object postScanReport() and the interaction handler read, an
 * in-place update is also immediate and race-free.
 *
 * A token change, a disable, or a clan with no running bot still takes the
 * full stop/start path (a new token genuinely needs a fresh login).
 */
export async function reloadClanBot(clanId: number, gameDayRolloverUtcHour: number): Promise<void> {
  const clan = getClanById(clanId);

  // Disabled or no token → make sure it's stopped and gone.
  if (!clan || !clan.discordEnabled || !clan.discordToken) {
    await stopClanBot(clanId);
    return;
  }

  const existing = clans.get(clanId);

  // Running already, same token → hot-update in place, no gateway churn.
  if (existing && existing.token === clan.discordToken) {
    existing.clanName = clan.name;
    existing.channelId = clan.discordChannelId.trim();
    existing.guildId = clan.discordGuildId.trim();
    existing.scanReportsEnabled = clan.discordScanReportsEnabled;
    existing.onlyPostWithNewChests = clan.discordOnlyNewChests;
    existing.commandsEnabled = clan.discordCommandsEnabled;
    existing.digestEnabled = clan.discordDailyDigestEnabled;
    existing.digestShareUserIds = parseDigestRecipients(clan.discordDailyDigestShareUserId);
    existing.digestUtcHour = gameDayRolloverUtcHour;

    // Commands may have been toggled or the guild changed; the digest
    // schedule may have been enabled/disabled or the recipient changed.
    const shared = clients.get(existing.token);
    if (shared && shared.ready && existing.guildId) {
      try {
        await registerCommandsForGuild(existing.token, existing.guildId);
      } catch (err) {
        log.error(`Clan #${clanId}: failed to re-register commands on settings update: ${String(err)}`);
      }
    }
    scheduleNextDigest(clanId);
    log.info(`Clan #${clanId}: Discord settings applied in place (token unchanged, no reconnect)`);
    return;
  }

  // New clan, or the token changed → full restart with a fresh login.
  await startClanBot(clanId, gameDayRolloverUtcHour);
}

/**
 * Stop every clan's Discord bot. Called on graceful shutdown.
 */
export async function stopAllBots(): Promise<void> {
  const ids = Array.from(clans.keys());
  await Promise.all(ids.map((id) => stopClanBot(id)));
}

/**
 * Post a scan report to the clan whose scan just completed. The scan
 * loop calls this with the active clan's id; if no bot is running for
 * that clan (Discord disabled, token unset, or shutdown in progress),
 * this is a no-op.
 */
export async function postScanReport(clanId: number, result: ScanResult): Promise<void> {
  const ctx = clans.get(clanId);
  if (!ctx || !ctx.channelId) return;
  if (!ctx.scanReportsEnabled) return;
  if (ctx.onlyPostWithNewChests && result.newChests === 0) return;

  const shared = clients.get(ctx.token);
  if (!shared || !shared.ready) return;

  try {
    const channel = (await shared.client.channels.fetch(ctx.channelId)) as TextChannel;
    if (channel) {
      const message = formatScanReportMessage(result, clanId);
      await channel.send({ content: message });
    }
  } catch (err) {
    log.error(`Clan #${clanId}: failed to post scan report: ${String(err)}`);
  }
}

interface DigestDmOutcome {
  userId: string;
  /** The user's tag once resolved, else the raw ID — for logs and the UI. */
  label: string;
  error?: string;
}

/**
 * DM one digest body to every configured recipient.
 *
 * Sequential and individually caught on purpose: recipients share one
 * REST rate limit, and one person with DMs closed must not cost everyone
 * else their digest.
 */
async function dmDigestToRecipients(
  shared: SharedClient,
  ctx: ClanCtx,
  text: string,
): Promise<DigestDmOutcome[]> {
  const outcomes: DigestDmOutcome[] = [];
  for (const userId of ctx.digestShareUserIds) {
    try {
      const user = await shared.client.users.fetch(userId);
      await user.send(text);
      outcomes.push({ userId, label: user.tag || userId });
    } catch (err) {
      outcomes.push({ userId, label: userId, error: shortenError(err) });
    }
  }
  return outcomes;
}

/**
 * Send the latest daily digest on demand to the clan's configured
 * digest-share recipients — the same completed game day the scheduled
 * digest posts. Used by the admin UI to verify each recipient has DMs
 * from server members allowed without waiting for the cron, and as a
 * manual re-send.
 */
export async function sendClanDigestDmTest(
  clanId: number,
): Promise<{ ok: boolean; error?: string; message?: string }> {
  const ctx = clans.get(clanId);
  if (!ctx) {
    return { ok: false, error: 'Discord bot is not running for this clan. Enable it and save first.' };
  }
  if (ctx.digestShareUserIds.length === 0) {
    return { ok: false, error: 'No DM recipients configured. Set at least one Discord user ID and save first.' };
  }
  const shared = clients.get(ctx.token);
  if (!shared || !shared.ready) {
    return { ok: false, error: 'Discord client is not connected yet. Try again in a few seconds.' };
  }

  const now = new Date();
  const { fromIso, toIso, gameDayKey } = resolveCompletedGameDay(now, ctx.digestUtcHour);
  const data = chestRepo.getDailyDigestData(fromIso, toIso, clanId);
  const text = `[Test DM]\n${formatDailyDigestShareText(data, { gameDayDate: gameDayKey })}`;

  const outcomes = await dmDigestToRecipients(shared, ctx, text);
  const sent = outcomes.filter((o) => !o.error);
  const failed = outcomes.filter((o) => o.error);

  if (failed.length === 0) {
    return { ok: true, message: `DM sent to ${sent.map((o) => o.label).join(', ')}.` };
  }
  // Partial success is still success worth reporting: the admin needs to
  // know exactly which recipients to chase, not just that "the DM failed".
  const detail = failed.map((o) => `${o.label} (${o.error})`).join('; ');
  if (sent.length > 0) {
    return {
      ok: true,
      message: `DM sent to ${sent.map((o) => o.label).join(', ')}. Failed for ${detail}.`,
    };
  }
  return {
    ok: false,
    error: `Couldn't DM ${failed.length === 1 ? 'that user' : 'those users'} — they may not share a server with the bot, or have DMs from server members disabled. ${detail}`,
  };
}

/**
 * True when this clan's underlying Client is logged in and ready. Used
 * by the admin UI to render connection status per clan.
 */
export function isClanBotConnected(clanId: number): boolean {
  const ctx = clans.get(clanId);
  if (!ctx) return false;
  const shared = clients.get(ctx.token);
  return !!shared && shared.client.user !== null;
}

/**
 * Notify the clan's Discord channel that their saved Total Battle
 * session has expired and needs the admin to sign in again. Best-
 * effort: silently no-ops when the bot isn't configured / connected,
 * because the Clans page badge already covers users who reach the
 * admin UI directly. Caller is responsible for only invoking this on
 * the first failure of a streak (see markClanNeedsReauth) so the
 * channel doesn't get pinged once per scan interval.
 */
export async function postReauthRequiredNotice(clanId: number): Promise<void> {
  const ctx = clans.get(clanId);
  if (!ctx || !ctx.channelId) return;

  const shared = clients.get(ctx.token);
  if (!shared || !shared.ready) return;

  try {
    const channel = (await shared.client.channels.fetch(ctx.channelId)) as TextChannel | null;
    if (!channel) return;
    const embed = new EmbedBuilder()
      .setTitle('⚠ Total Battle login expired')
      .setDescription(
        `The saved login session for **${ctx.clanName}** has expired and scans will fail until an admin re-authenticates.\n\n` +
          'Open the **Clans** page in TB Chest Counter and click **Refresh login** to sign back in. Scans will resume on the next cycle.',
      )
      .setColor(0xf0883e)
      .setTimestamp();
    await channel.send({ embeds: [embed] });
  } catch (err) {
    log.warn(`Clan #${clanId}: failed to post re-auth notice: ${String(err)}`);
  }
}

/**
 * Retract the notice above: the saved session has been verified working
 * again, either because an admin re-authenticated or because whatever
 * failed earlier turned out to be transient (a canvas that timed out under
 * memory pressure is indistinguishable from expired cookies at the moment
 * it happens).
 *
 * Posted only on the needs-reauth 1 → 0 transition, so it appears once per
 * streak like the warning it answers. Without it an admin is left chasing an
 * alert for a problem that has already resolved itself.
 *
 * Same best-effort contract: silently no-ops when the bot isn't connected.
 */
export async function postReauthResolvedNotice(clanId: number): Promise<void> {
  const ctx = clans.get(clanId);
  if (!ctx || !ctx.channelId) return;

  const shared = clients.get(ctx.token);
  if (!shared || !shared.ready) return;

  try {
    const channel = (await shared.client.channels.fetch(ctx.channelId)) as TextChannel | null;
    if (!channel) return;
    const embed = new EmbedBuilder()
      .setTitle('✅ Total Battle login is working again')
      .setDescription(
        `The saved login session for **${ctx.clanName}** loaded the game successfully, so no ` +
          're-authentication is needed after all. Scans are running normally — you can ignore the ' +
          'earlier login-expired notice.',
      )
      .setColor(0x3fb950)
      .setTimestamp();
    await channel.send({ embeds: [embed] });
  } catch (err) {
    log.warn(`Clan #${clanId}: failed to post re-auth resolved notice: ${String(err)}`);
  }
}

/**
 * Send a one-off "integration is working" message to the configured
 * channel for one clan. Used by the admin UI's per-clan Test button.
 */
export async function sendClanTestMessage(clanId: number): Promise<{ ok: boolean; error?: string }> {
  const ctx = clans.get(clanId);
  if (!ctx) {
    return { ok: false, error: 'Discord bot is not running for this clan. Enable it and save first.' };
  }
  if (!ctx.channelId) {
    return { ok: false, error: 'No channel ID configured for this clan.' };
  }
  const shared = clients.get(ctx.token);
  if (!shared || !shared.ready) {
    return { ok: false, error: 'Discord client is not connected yet. Try again in a few seconds.' };
  }
  try {
    const channel = (await shared.client.channels.fetch(ctx.channelId)) as TextChannel | null;
    if (!channel) {
      return { ok: false, error: 'Channel not found. Check the channel ID and that the bot has access.' };
    }
    const embed = new EmbedBuilder()
      .setTitle('Discord integration test')
      .setDescription('TB Chest Counter is connected to this channel and will post scan reports here.')
      .setColor(0x3fb950)
      .setTimestamp();
    await channel.send({ embeds: [embed] });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err) };
  }
}

// ---- Daily digest scheduling (per-clan) ----

function scheduleNextDigest(clanId: number): void {
  const ctx = clans.get(clanId);
  if (!ctx) return;
  if (ctx.digestTimer) {
    clearTimeout(ctx.digestTimer);
    ctx.digestTimer = null;
  }
  if (!ctx.digestEnabled) return;
  if (!Number.isFinite(ctx.digestUtcHour) || ctx.digestUtcHour < 0 || ctx.digestUtcHour > 23) {
    log.info(`Clan #${clanId}: digest UTC hour ${ctx.digestUtcHour} out of range — digest disabled`);
    return;
  }

  const now = new Date();
  const target = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    ctx.digestUtcHour, 0, 0, 0,
  ));
  if (target.getTime() <= now.getTime()) {
    target.setUTCDate(target.getUTCDate() + 1);
  }
  const delayMs = target.getTime() - now.getTime();
  log.debug(`Clan #${clanId}: daily digest scheduled for ${target.toISOString()} (in ~${Math.round(delayMs / 60_000)} min)`);

  ctx.digestTimer = setTimeout(async () => {
    ctx.digestTimer = null;
    try {
      await sendDailyDigestForClan(clanId);
    } catch (err) {
      log.error(`Clan #${clanId}: daily digest failed: ${String(err)}`);
    }
    scheduleNextDigest(clanId);
  }, delayMs);
}

/**
 * The most recent rollover instant at or before `now`. Mirror of the
 * "next rollover" math in scheduleNextDigest, stepped one day back
 * instead of forward: the game day this instant closes is the one a
 * scheduled digest fired at this rollover would have reported.
 */
function lastRolloverInstant(now: Date, rolloverHour: number): Date {
  const target = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    rolloverHour, 0, 0, 0,
  ));
  if (target.getTime() > now.getTime()) {
    target.setUTCDate(target.getUTCDate() - 1);
  }
  return target;
}

/**
 * Fire a one-off catch-up digest if the most recent rollover elapsed
 * while the process was down and was never digested. Called once per
 * clan after its Discord gateway is ready (a digest can't send before
 * then). Idempotent across boots and safe to call more than once per
 * boot: it re-reads persisted state and bails the moment a send has
 * been recorded for the target game day.
 *
 * Deliberately catches up ONLY the single most recent missed game day.
 * After a multi-day outage the older days are stale and reporting one
 * digest per missed day would flood the channel; the latest completed
 * game day is the one that still matters.
 */
async function catchUpMissedDigest(clanId: number): Promise<void> {
  const ctx = clans.get(clanId);
  // Digest turned off / not configured → nothing to catch up. Debug-only:
  // these are steady config states, not a decision worth an INFO line on
  // every boot of a clan that simply doesn't run digests.
  if (!ctx || !ctx.digestEnabled) {
    log.debug(`Clan #${clanId}: digest catch-up skipped — digest not enabled`);
    return;
  }
  if (!ctx.channelId) {
    log.debug(`Clan #${clanId}: digest catch-up skipped — no channel configured`);
    return;
  }
  if (!Number.isFinite(ctx.digestUtcHour) || ctx.digestUtcHour < 0 || ctx.digestUtcHour > 23) {
    log.info(`Clan #${clanId}: digest catch-up skipped — rollover hour ${ctx.digestUtcHour} out of range`);
    return;
  }

  const now = new Date();
  const rollover = lastRolloverInstant(now, ctx.digestUtcHour);
  const { gameDayKey } = resolveCompletedGameDay(rollover, ctx.digestUtcHour);

  // Re-read persisted state (ClanCtx doesn't carry the last-digest
  // record) so concurrent/repeat calls converge on the DB truth.
  const clan = getClanById(clanId);
  if (!clan) {
    log.warn(`Clan #${clanId}: digest catch-up skipped — clan row not found`);
    return;
  }

  // From here on we log the decision at INFO: this runs once per clan per
  // boot (not per cycle), so a single line is a useful paper trail of
  // exactly why a catch-up did or didn't send — which is what an operator
  // needs when a digest looks missing after a deploy.

  // Already reported this game day → nothing to catch up (the common
  // no-op on a routine redeploy where today's digest already went out,
  // or a second call within the same boot after we just sent it).
  if (clan.lastDigestGameDay === gameDayKey) {
    log.info(
      `Clan #${clanId}: digest catch-up not needed — game day ${gameDayKey} already sent (at ${clan.lastDigestAt || 'unknown'})`,
    );
    return;
  }
  // Never sent a digest at all → this clan has no missed run to replay;
  // the normal scheduler will handle its first one.
  if (!clan.lastDigestAt) {
    log.info(
      `Clan #${clanId}: digest catch-up not needed — no prior digest recorded; leaving the first run to the scheduler (would be game day ${gameDayKey})`,
    );
    return;
  }
  // The last real send already lands at/after the missed rollover, so
  // that rollover was covered (or a manual/scheduled run beat us to it).
  // This is what stops a routine redeploy — where today's digest already
  // went out — from re-sending it before last_digest_game_day exists.
  if (new Date(clan.lastDigestAt).getTime() >= rollover.getTime()) {
    log.info(
      `Clan #${clanId}: digest catch-up not needed — last digest (${clan.lastDigestAt}) already covers rollover ${rollover.toISOString()}`,
    );
    return;
  }

  log.info(
    `Clan #${clanId}: daily digest for game day ${gameDayKey} (rollover ${rollover.toISOString()}) ` +
      `was missed while offline (last sent ${clan.lastDigestAt}) — sending catch-up now`,
  );
  await sendDailyDigestForClan(clanId, rollover);
}

function shortenError(err: unknown, max = 200): string {
  const msg = String(err instanceof Error ? err.message : err);
  return msg.length > max ? `${msg.slice(0, max - 1)}…` : msg;
}

/**
 * Resolve the game day a digest should report, given the wall-clock
 * time it actually fired.
 *
 * The digest is scheduled for the rollover hour, but the real fire
 * time drifts — event-loop lag, a late `setTimeout`, NTP nudging the
 * host clock, a suspended/resumed VM. The old logic derived the date
 * straight from a rolling `[now-24h, now)` window, so any drift moved
 * the reported date with it: a fire that landed at 16:55 instead of
 * 17:05 re-reported the *previous* game day, so two daily digests in
 * a row showed the same date with different rosters.
 *
 * Snapping `now` to the NEAREST rollover removes that fragility —
 * anything within ±12h of a rollover resolves to that rollover — and
 * yields a window aligned exactly to one game day, so two fires for
 * the same game day produce byte-identical output instead of a
 * confusing "same date, different leaderboard".
 *
 * Returns the completed game day's [from, to) window and its
 * YYYY-MM-DD key, which matches the site's daily leaderboard label.
 */
function resolveCompletedGameDay(now: Date, rolloverHour: number): {
  fromIso: string;
  toIso: string;
  gameDayKey: string;
} {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const rolloverMs = rolloverHour * 60 * 60 * 1000;
  // Shift so the rollover maps to UTC midnight, round to the nearest
  // day boundary, shift back: the rollover instant closest to `now`.
  const shiftedMs = now.getTime() - rolloverMs;
  const nearestMidnightMs = Math.round(shiftedMs / DAY_MS) * DAY_MS;
  const nearestRolloverMs = nearestMidnightMs + rolloverMs;
  return {
    fromIso: new Date(nearestRolloverMs - DAY_MS).toISOString(),
    toIso: new Date(nearestRolloverMs).toISOString(),
    // Key = shifted-UTC date of the window start, i.e. the day before
    // the snapped rollover's own date.
    gameDayKey: new Date(nearestMidnightMs - DAY_MS).toISOString().slice(0, 10),
  };
}

/**
 * Post (and DM) the daily digest for one clan.
 *
 * `windowRef` selects which game day is reported: the scheduled fire
 * passes nothing, so the window is resolved from the current clock (the
 * timer fires ~at the rollover, and resolveCompletedGameDay snaps to the
 * nearest rollover, absorbing drift). The boot-time catch-up passes the
 * exact missed rollover instant so the reported window is that day's
 * closed [rollover-24h, rollover) — the correct historical data — rather
 * than whatever "now" resolves to after an outage.
 */
async function sendDailyDigestForClan(clanId: number, windowRef?: Date): Promise<void> {
  const ctx = clans.get(clanId);
  if (!ctx) return;

  // Pre-flight: bail early without recording status. These conditions
  // mean the digest physically can't run (no channel configured, or
  // the gateway isn't connected) — they're not run-time failures of
  // an attempt, so we don't want to overwrite the previous good
  // status with "failed: no channel" every time.
  if (!ctx.channelId) {
    log.info(`Clan #${clanId}: digest fired but no channel ID — skipping`);
    return;
  }
  const shared = clients.get(ctx.token);
  if (!shared || !shared.ready) {
    log.debug(`Clan #${clanId}: digest fired but client not ready — skipping`);
    return;
  }

  const now = new Date();
  const { fromIso, toIso, gameDayKey } = resolveCompletedGameDay(windowRef ?? now, ctx.digestUtcHour);
  const data = chestRepo.getDailyDigestData(fromIso, toIso, clanId);
  log.info(`Clan #${clanId}: digest for game day ${gameDayKey} (window ${fromIso} → ${toIso})`);

  // Channel post and DM are tracked independently. Each step gets
  // its own try/catch so a failure in one doesn't block the other —
  // partial success is real (channel post worked, DM recipient
  // blocked DMs → still useful for everyone in the channel). The
  // outcomes are persisted at the end so the clan card can surface
  // "Last digest: ✓" or "Last digest: ⚠ — <reason>".
  let channelError = '';
  let dmError = '';

  try {
    const channel = (await shared.client.channels.fetch(ctx.channelId)) as TextChannel | null;
    if (!channel) {
      throw new Error(`Channel ${ctx.channelId} not found — check the ID and that the bot has access.`);
    }
    const { loadConfig } = await import('../config/index.js');
    const config = loadConfig();
    const message = formatDailyDigestMessage(data, {
      webExternalUrl: config.webExternalUrl || undefined,
      gameDayDate: gameDayKey,
    });
    await channel.send({ content: message });
    log.info(
      `Clan #${clanId} digest posted: ${data.totalChests} chests, ${data.totalPoints} pts, ${data.activePlayers} active players, ${data.scanCount} scans`,
    );
  } catch (err) {
    channelError = shortenError(err);
    log.error(`Clan #${clanId}: failed to post daily digest: ${channelError}`);
  }

  if (ctx.digestShareUserIds.length > 0) {
    const text = formatDailyDigestShareText(data, { gameDayDate: gameDayKey });
    const outcomes = await dmDigestToRecipients(shared, ctx, text);
    const sent = outcomes.filter((o) => !o.error);
    const failed = outcomes.filter((o) => o.error);
    if (sent.length > 0) {
      log.info(
        `Clan #${clanId} digest shared via DM to ${sent.length}/${outcomes.length} recipient(s): ${sent.map((o) => o.label).join(', ')}`,
      );
    }
    if (failed.length > 0) {
      // One line per failing recipient would burn the 20-entry ring
      // buffer on a bad paste, so the whole batch coalesces into one.
      dmError = shortenError(failed.map((o) => `${o.label}: ${o.error}`).join('; '), 400);
      log.warn(
        `Clan #${clanId}: failed to DM digest to ${failed.length}/${outcomes.length} recipient(s) — ${dmError}`,
      );
    }
  }

  try {
    setClanLastDigestStatus(clanId, {
      at: now.toISOString(),
      gameDay: gameDayKey,
      channelError,
      dmError,
    });
  } catch (err) {
    // Status persistence is best-effort; a DB hiccup here shouldn't
    // mask the digest having actually been delivered.
    log.warn(`Clan #${clanId}: failed to persist digest status: ${String(err)}`);
  }
}

