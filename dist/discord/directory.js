"use strict";
/**
 * Read-only lookups against Discord's REST API so the admin UI can offer
 * *names* — "Announcements" in "THE - Family Gang" — instead of asking an
 * operator to turn on Developer Mode and right-click-copy three snowflakes.
 *
 * Everything here runs off the clan's own bot token. There is no OAuth flow
 * and no extra scope: a bot token can already read the guilds it is in
 * (`/users/@me/guilds`) and their channel list (`/guilds/{id}/channels`).
 * The member list is the one exception — it needs the GUILD_MEMBERS
 * privileged intent switched on in the Developer Portal — so it is fetched
 * separately and a failure there degrades to "type the ID yourself" rather
 * than failing the whole lookup.
 *
 * These calls are NOT made through the gateway Client in bot.ts. That client
 * only identifies with the Guilds intent, is shared per-token, and may not be
 * connected at all (the token can be typed into the form and looked up before
 * it is ever saved). A throwaway REST instance keeps the lookup independent
 * of bot lifecycle entirely.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.describeDiscordError = describeDiscordError;
exports.fetchBotGuilds = fetchBotGuilds;
exports.fetchGuildChannels = fetchGuildChannels;
exports.fetchGuildMembers = fetchGuildMembers;
exports.fetchDiscordDirectory = fetchDiscordDirectory;
const node_crypto_1 = require("node:crypto");
const discord_js_1 = require("discord.js");
const logger_js_1 = require("../utils/logger.js");
const log = (0, logger_js_1.childLogger)('discord-directory');
/** Channel types that can receive a plain message from a bot. */
const TEXT_CHANNEL_TYPES = new Set([
    0, // GuildText
    5, // GuildAnnouncement
]);
const CATEGORY_CHANNEL_TYPE = 4;
/** One page is 1000; a clan Discord well under that, so one page is the cap. */
const MEMBER_PAGE_LIMIT = 1000;
/**
 * Discord is the slow, rate-limited dependency here and the clans page
 * re-renders on every mutation, so the same three calls would otherwise go
 * out several times a minute. Short enough that adding a channel in Discord
 * and reloading the page shows it.
 */
const CACHE_TTL_MS = 60_000;
const cache = new Map();
/**
 * Token-keyed cache entries are keyed by a hash, never the token itself —
 * a secret that is already held in one place shouldn't get copied into a
 * second long-lived structure just to serve as a map key.
 */
function tokenKey(token) {
    return (0, node_crypto_1.createHash)('sha256').update(token).digest('hex').slice(0, 16);
}
/**
 * Caches successes only. A rejection is deliberately not stored: the usual
 * failure is a token that was just pasted wrong, and making the operator
 * wait out a TTL after fixing it would read as "the fix didn't work".
 */
async function cachedFetch(key, compute) {
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && hit.expires > now)
        return hit.value;
    const value = await compute();
    cache.set(key, { value, expires: now + CACHE_TTL_MS });
    // Bounded: one entry per (token, scope, guild). Clear wholesale rather than
    // tracking an LRU — the cost of a cold miss is one REST call.
    if (cache.size > 200) {
        for (const [k, entry] of cache) {
            if (entry.expires <= now)
                cache.delete(k);
        }
    }
    return value;
}
function restFor(token) {
    return new discord_js_1.REST({ timeout: 15_000 }).setToken(token);
}
function httpStatus(err) {
    const status = err?.status;
    return typeof status === 'number' ? status : null;
}
/**
 * Turn a REST failure into something an admin can act on. The raw
 * DiscordAPIError text ("Missing Access") names no fix and reads as a bug in
 * this app rather than a setting in theirs.
 */
function describeDiscordError(err) {
    switch (httpStatus(err)) {
        case 401:
            return 'Discord rejected the bot token (401). Paste a fresh one from the Developer Portal → Bot → Reset Token.';
        case 403:
            return 'Discord refused the request (403). The bot is missing permission for that server.';
        case 404:
            return 'Discord returned 404 — the bot is not in that server any more.';
        case 429:
            return 'Discord is rate-limiting this bot token (429). Wait a minute and try again.';
        default:
            return `Could not reach Discord: ${err instanceof Error ? err.message : String(err)}`;
    }
}
/** Every guild this bot has been invited to. */
async function fetchBotGuilds(token) {
    return cachedFetch(`guilds:${tokenKey(token)}`, async () => {
        const raw = (await restFor(token).get(discord_js_1.Routes.userGuilds()));
        return raw
            .map((g) => ({ id: String(g.id), name: String(g.name ?? g.id) }))
            .sort((a, b) => a.name.localeCompare(b.name));
    });
}
/**
 * Text channels in a guild, in the order Discord shows them: by category,
 * then by position within it. Categories themselves are resolved to names
 * here so the dropdown can group without a second round trip.
 */
async function fetchGuildChannels(token, guildId) {
    return cachedFetch(`channels:${tokenKey(token)}:${guildId}`, async () => {
        const raw = (await restFor(token).get(discord_js_1.Routes.guildChannels(guildId)));
        const categories = new Map();
        for (const c of raw) {
            if (c.type === CATEGORY_CHANNEL_TYPE) {
                categories.set(String(c.id), { name: String(c.name ?? ''), position: c.position ?? 0 });
            }
        }
        return raw
            .filter((c) => TEXT_CHANNEL_TYPES.has(c.type))
            .map((c) => {
            const parent = c.parent_id ? categories.get(String(c.parent_id)) : undefined;
            return {
                id: String(c.id),
                name: String(c.name ?? c.id),
                categoryName: parent?.name ?? null,
                _categoryPosition: parent?.position ?? -1,
                _position: c.position ?? 0,
            };
        })
            .sort((a, b) => a._categoryPosition - b._categoryPosition || a._position - b._position)
            .map(({ id, name, categoryName }) => ({ id, name, categoryName }));
    });
}
/**
 * Guild members, for the digest DM recipient picker.
 *
 * Requires the SERVER MEMBERS privileged intent to be enabled on the
 * application — without it Discord answers 403 no matter what permissions the
 * bot has in the server. That is a portal toggle the operator can flip, so it
 * gets its own message rather than being folded into the generic 403.
 */
async function fetchGuildMembers(token, guildId) {
    return cachedFetch(`members:${tokenKey(token)}:${guildId}`, async () => {
        const raw = (await restFor(token).get(discord_js_1.Routes.guildMembers(guildId), {
            query: new URLSearchParams({ limit: String(MEMBER_PAGE_LIMIT) }),
        }));
        return raw
            .filter((m) => m.user?.id && !m.user.bot)
            .map((m) => ({
            id: String(m.user.id),
            name: String(m.nick || m.user.global_name || m.user.username || m.user.id),
            username: String(m.user.username ?? ''),
        }))
            .sort((a, b) => a.name.localeCompare(b.name));
    });
}
/**
 * One round trip for the whole form: the server list always, and the
 * channel/member lists for whichever guild is selected.
 *
 * A member-list failure is caught and reported in-band. It is the only part
 * that depends on a privileged intent, and letting it take the channel
 * dropdown down with it would mean one unticked portal checkbox costs the
 * operator the entire feature.
 */
async function fetchDiscordDirectory(token, guildId) {
    const guilds = await fetchBotGuilds(token);
    // A stored guild the bot has since been removed from would 404 both
    // follow-up calls; treat it as "nothing selected" so the server dropdown
    // still renders and the operator can pick a live one.
    const selected = guildId && guilds.some((g) => g.id === guildId) ? guildId : null;
    if (!selected) {
        return { guilds, channels: [], members: [], guildId: null, membersUnavailable: null };
    }
    const channels = await fetchGuildChannels(token, selected);
    let members = [];
    let membersUnavailable = null;
    try {
        members = await fetchGuildMembers(token, selected);
    }
    catch (err) {
        membersUnavailable = httpStatus(err) === 403
            ? 'Member list unavailable — switch on Developer Portal → Bot → Privileged Gateway Intents → SERVER MEMBERS INTENT, then reload this page.'
            : describeDiscordError(err);
        log.warn({ noAlert: true, guildId: selected }, `Discord member lookup failed: ${String(err)}`);
    }
    return { guilds, channels, members, guildId: selected, membersUnavailable };
}
//# sourceMappingURL=directory.js.map