"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GameClient = exports.WrongAccountError = exports.SessionLoggedOutError = exports.GameProtocolError = exports.USER_AGENT = void 0;
exports.classifySitePage = classifySitePage;
exports.checkSiteSession = checkSiteSession;
exports.oneSiteCallAtATime = oneSiteCallAtATime;
exports.checkSiteSessionAccount = checkSiteSessionAccount;
exports.storedTokenAccounts = storedTokenAccounts;
exports.siteCookieHeader = siteCookieHeader;
exports.loadOrCreateDevice = loadOrCreateDevice;
exports.parseSitePage = parseSitePage;
exports.fetchSiteBootstrap = fetchSiteBootstrap;
exports.getGameStartData = getGameStartData;
exports.confirmRotatedToken = confirmRotatedToken;
exports.loginHumanArray = loginHumanArray;
exports.buildLoginBody = buildLoginBody;
/**
 * A direct client for Total Battle's game server — no browser.
 *
 *   1. GET https://totalbattle.com/en/ with the clan's stored session cookies.
 *      The reply sets a fresh website token (__Host-user_auth_token) and embeds
 *      the game account id ("suid") and the realm → game-server map.
 *   2. JSON-RPC GetGameStartData(suid, token) → `sig`, realm, player id.
 *   3. Game login (message 203, seq 1, zero session id) carrying `sig` and the
 *      account's human/device data → the reply holds the session id.
 *   4. Every further message is `[type, ++seq, [[playerId], sessionId], ""]`.
 *
 * The game host gets no cookies at all; the session id is the whole auth. The
 * website token rotates on every GetGameStartData, which is why step 1 runs on
 * every connect instead of reusing a stored token: the session cookie always
 * yields the current one. A direct login takes over the account's game session,
 * which is why the scan loop pauses while the login bridge has the game open.
 * Full background: docs/game-protocol.md.
 */
const crypto_1 = __importDefault(require("crypto"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const codec_js_1 = require("./codec.js");
const site_session_js_1 = require("./site-session.js");
const journal_token_js_1 = require("./journal-token.js");
const client_version_js_1 = require("../game-patch/client-version.js");
const SITE = 'https://totalbattle.com';
const RPC_URL = `${SITE}/restapi/totalbattle/web/`;
const CHROME = '157.0.0.0';
exports.USER_AGENT = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME} Safari/537.36`;
/**
 * The WebGL client's build version, sent at login, is the live build's own
 * (game-patch/client-version.ts reads it from the build each client patch);
 * GAME_CLIENT_VERSION overrides it, a hand-set fallback covers "not read yet".
 */
const REQUEST_TIMEOUT_MS = 60_000;
const ALL_FIELDS = 2147483647;
class GameProtocolError extends Error {
    constructor(message) {
        super(message);
        this.name = 'GameProtocolError';
    }
}
exports.GameProtocolError = GameProtocolError;
/** The site served its logged-out page for the stored cookies: a definite re-auth. */
class SessionLoggedOutError extends GameProtocolError {
    constructor() {
        super('totalbattle.com served the logged-out page for the stored session — the clan needs re-authentication');
        this.name = 'SessionLoggedOutError';
    }
}
exports.SessionLoggedOutError = SessionLoggedOutError;
/** Substrings only TB's public marketing / login page has. */
const LOGGED_OUT_SIGNATURES = ['register or log in', 'sign up with'];
/** Classify the /en/ page. Pure; unit-tested. Ambiguous pages are 'unknown', never 'logged-out'. */
function classifySitePage(status, html) {
    if (status !== 200)
        return 'unknown';
    if (/"suid":"[a-z0-9]+:\d+"/.test(html))
        return 'ok';
    const text = html.toLowerCase();
    return LOGGED_OUT_SIGNATURES.some((s) => text.includes(s)) ? 'logged-out' : 'unknown';
}
/**
 * Is the clan's stored login still alive? One GET of the site page with the
 * stored cookies — no token is presented, so this is safe to run as often as
 * we like. Network errors and odd pages answer 'unknown'.
 */
async function checkSiteSession(storageStatePath) {
    return (await checkSiteSessionAccount(storageStatePath)).state;
}
/**
 * checkSiteSession, plus the website user id (`tb:<n>`) the stored login
 * belongs to when it is signed in — the same page carries it. The scan
 * scheduler keys its lanes on it: two clans on one account never scan at once.
 */
/**
 * Calls that present a clan's site cookies — a sign-in, a session check — go
 * one at a time, process-wide, with a short settle after each. Whenever SIK
 * and SK7 scanned in parallel lanes and so signed in at the same moment from
 * this server, SK7's saved login came out signed in as SIK's account (Nov 17
 * 2026: after the 14:37 and 16:18 cycles; never when SK7 ran alone). The scans
 * themselves stay parallel: a sign-in takes 1–2 s.
 */
const SITE_CALL_SETTLE_MS = 3_000;
let siteCallChain = Promise.resolve();
async function oneSiteCallAtATime(fn) {
    const before = siteCallChain;
    let release;
    siteCallChain = new Promise((resolve) => { release = resolve; });
    await before;
    try {
        return await fn();
    }
    finally {
        setTimeout(release, SITE_CALL_SETTLE_MS).unref?.();
    }
}
function checkSiteSessionAccount(storageStatePath) {
    return oneSiteCallAtATime(() => checkSiteSessionAccountNow(storageStatePath));
}
async function checkSiteSessionAccountNow(storageStatePath) {
    let cookies;
    let tokenAccounts = [];
    try {
        cookies = siteCookieHeader(storageStatePath);
        tokenAccounts = storedTokenAccounts(storageStatePath);
    }
    catch {
        return { state: 'logged-out', suid: null, tokenAccounts };
    }
    try {
        const res = await fetch(`${SITE}/en/`, {
            headers: { cookie: cookies, 'user-agent': exports.USER_AGENT, accept: 'text/html' },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const html = await res.text();
        const state = classifySitePage(res.status, html);
        return { state, suid: state === 'ok' ? parseSitePage(html).suid : null, tokenAccounts };
    }
    catch {
        return { state: 'unknown', suid: null, tokenAccounts };
    }
}
/** The accounts the stored sign-in token(s) name, read from the file (local, nothing sent). */
function storedTokenAccounts(storageStatePath) {
    const raw = fs_1.default.readFileSync(storageStatePath, 'utf8').replace(/^﻿/, '').trim();
    const state = JSON.parse(raw);
    return (0, site_session_js_1.authTokenAccounts)((state.cookies ?? []).filter((c) => /^\.?totalbattle\.com$/.test(c.domain)));
}
/** The saved login signs in to a different website account than the clan's known one. */
class WrongAccountError extends GameProtocolError {
    constructor(message) {
        super(message);
        this.name = 'WrongAccountError';
    }
}
exports.WrongAccountError = WrongAccountError;
/** Cookies the browser would send to totalbattle.com, from a Playwright storage state. */
function siteCookieHeader(storageStatePath) {
    const raw = fs_1.default.readFileSync(storageStatePath, 'utf8').replace(/^﻿/, '').trim();
    const state = JSON.parse(raw);
    const cookies = (state.cookies ?? []).filter((c) => /^\.?totalbattle\.com$/.test(c.domain));
    if (!cookies.some((c) => c.name === 'PTBHSSID')) {
        throw new GameProtocolError('stored session has no PTBHSSID cookie — the clan needs re-authentication');
    }
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}
/**
 * One stable "device" per clan, like a browser keeps between visits. Generated
 * once and stored next to the clan's session so every connect looks the same.
 */
function loadOrCreateDevice(file) {
    if (fs_1.default.existsSync(file))
        return JSON.parse(fs_1.default.readFileSync(file, 'utf8'));
    const now = Math.floor(Date.now() / 1000);
    const device = {
        deviceId: `fpc${crypto_1.default.randomBytes(16).toString('hex')}`,
        fingerprintId: String(crypto_1.default.randomInt(100_000_000, 999_999_999)),
        firstWebVisitTs: now,
        firstWebVisitRnd: `${now}${crypto_1.default.randomInt(100, 999)}`,
    };
    fs_1.default.mkdirSync(path_1.default.dirname(file), { recursive: true });
    fs_1.default.writeFileSync(file, JSON.stringify(device, null, 1));
    return device;
}
/** The rating server's pseudo-realm in the site page's realm list. */
const RATING_REALM_ID = 100000;
const jsonUrls = (list) => [...list.matchAll(/"([^"]+)"/g)].map((u) => u[1].replace(/\\\//g, '/'));
/**
 * Pull the game account id, the realm → server map and the rating server out
 * of the /en/ page. Pure; unit-tested. The rating server is NOT the realm's:
 * the client asks it for the event list (24001) — a realm server never answers
 * that (Nov 2026: every scan's event read failed "no 24001 reply" until this).
 * It is the page's `rating_url`, else realm 100000's logic_url.
 *
 * Two more servers the Olympus window talks to (Nov 24 2026 recording): the
 * `rating_proxy_url` (its Clan ranking, 82000) and the `reg_url` (which
 * kingdom a rival clan is in, before asking that kingdom for its name).
 */
function parseSitePage(html) {
    const suid = html.match(/"suid":"([a-z0-9]+:\d+)"/)?.[1] ?? null;
    const realmUrls = new Map();
    for (const m of html.matchAll(/\{"realm_id":(\d+),"logic_url":\[([^\]]*)\]/g)) {
        const urls = jsonUrls(m[2]);
        if (urls.length)
            realmUrls.set(Number(m[1]), urls);
    }
    const rating = html.match(/"rating_url":\[([^\]]*)\]/);
    const ratingUrls = rating ? jsonUrls(rating[1]) : (realmUrls.get(RATING_REALM_ID) ?? []);
    const proxy = html.match(/"rating_proxy_url":"([^"]+)"/);
    const ratingProxyUrl = proxy ? proxy[1].replace(/\\\//g, '/') : null;
    const reg = html.match(/"reg_url":\[([^\]]*)\]/);
    return { suid, realmUrls, ratingUrls, ratingProxyUrl, regUrls: reg ? jsonUrls(reg[1]) : [] };
}
function tokenFromSetCookie(setCookies) {
    for (const c of setCookies) {
        const m = c.match(/^__Host-user_auth_token=([^;]+)/);
        if (m)
            return decodeURIComponent(m[1]);
    }
    return null;
}
async function fetchSiteBootstrap(jar) {
    const res = await fetch(`${SITE}/en/`, {
        headers: { cookie: jar.header(), 'user-agent': exports.USER_AGENT, accept: 'text/html' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    jar.apply(res.headers.getSetCookie());
    if (!res.ok)
        throw new GameProtocolError(`GET /en/ → HTTP ${res.status}`);
    const html = await res.text();
    const token = tokenFromSetCookie(res.headers.getSetCookie());
    const { suid, realmUrls, ratingUrls, ratingProxyUrl, regUrls } = parseSitePage(html);
    if (classifySitePage(res.status, html) === 'logged-out')
        throw new SessionLoggedOutError();
    if (!token || !suid) {
        throw new GameProtocolError('totalbattle.com returned an unexpected page (no token or account id) — not treated as a logout');
    }
    return { token, suid, realmUrls, ratingUrls, ratingProxyUrl, regUrls };
}
async function getGameStartData(boot, jar, device) {
    const body = {
        id: crypto_1.default.randomUUID(),
        jsonrpc: '2.0',
        method: 'GetGameStartData',
        params: [{
                suid: boot.suid,
                cluster: 'production',
                is_web_request: true,
                token: boot.token,
                human_data: {
                    deviceId: device.deviceId,
                    current_entry_point: 'site2',
                    ref: '',
                    ref_p: '',
                    referrer: `${SITE}/en/`,
                    browser: 'Chrome',
                    clientType: 'webgl',
                    clientFamily: 'unity',
                    age: null,
                    isMale: '0',
                    city: '',
                    full_name: '',
                    authOption: 'auth_token',
                    client_id: device.deviceId,
                    fingerprintId: device.fingerprintId,
                    firstWebVisitTs: device.firstWebVisitTs,
                    firstWebVisitRnd: device.firstWebVisitRnd,
                    attributionData: { attributionSource: 'web', attributionId: '' },
                    fbUserData: { fbId: '', fbp: '', firstName: '', lastName: '' },
                },
            }],
        deviceIdentifier: device.deviceId,
    };
    const res = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: SITE, referer: `${SITE}/en/`, 'user-agent': exports.USER_AGENT, cookie: jar.header() },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    jar.apply(res.headers.getSetCookie());
    const json = (await res.json());
    const r = json.result;
    if (!r || r.error || typeof r.sig !== 'string') {
        throw new GameProtocolError(`GetGameStartData failed: ${r?.error?.message ?? `HTTP ${res.status}`}`);
    }
    const account = (r.account ?? {});
    return {
        sig: r.sig,
        newToken: typeof r.new_token === 'string' ? r.new_token : null,
        realmId: Number(r.realmID),
        playerId: Number(r.stringGuid),
        accountId: Number(r.accountId ?? account.id),
        accountCreatedAt: Number(account.createdAt ?? 0),
        humanData: (r.human_data ?? {}),
    };
}
/**
 * The browser's follow-up to GetGameStartData: re-login the website session
 * with the rotated token. The reply sets fresh PTBHSSID and auth cookies, which
 * the jar keeps. Skipping this step is what ended CWB's session.
 */
async function confirmRotatedToken(jar, newToken) {
    const res = await fetch(`${SITE}/login/bytokenoauth/?token=${encodeURIComponent(newToken)}`, {
        headers: { cookie: jar.header(), 'user-agent': exports.USER_AGENT, accept: 'text/html', referer: `${SITE}/en/` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    jar.apply(res.headers.getSetCookie());
    if (!res.ok)
        throw new GameProtocolError(`bytokenoauth → HTTP ${res.status}`);
}
// ---------------------------------------------------------------------------
// Game login
// ---------------------------------------------------------------------------
const DEVICE_INFO = [
    `Chrome ${CHROME}`, 'Windows 10', 'Chrome', [1920, 1080], 96, '', 'EN', 3600, 16384, 1023,
    'OpenGL ES 3.0 (WebGL 2.0 (OpenGL ES 3.0 Chromium))', 0,
];
/**
 * The login's human-data array, in the game client's own field order (not the
 * JSON key order: two empty slots sit after `email`, and nested objects become
 * arrays). Values the server knows (ip, country, language, email) are echoed
 * from GetGameStartData; the device fields are ours. Pure; unit-tested.
 */
function loginHumanArray(hd, device) {
    const s = (k, d = '') => (typeof hd[k] === 'string' ? hd[k] : d);
    return [
        s('ref'), s('ref_p'), s('current_entry_point', 'site2'), s('ip'), s('continent_code'), s('country_code'),
        s('age'), s('isMale', '0'), s('city'), s('full_name'), s('lang', 'en'), s('email'),
        '', '',
        s('referrer', `${SITE}/en/`), 'webgl', 'chrome', ['', '', '', ''], 'auth_token',
        device.fingerprintId, device.firstWebVisitTs, device.firstWebVisitRnd, '', '',
        exports.USER_AGENT,
        device.deviceId, ['', '', '', ''], false, ['', 'web'], 'unity',
    ];
}
function buildLoginBody(start, suid, device, clientVersion) {
    return [[
            [suid], [''], start.sig, loginHumanArray(start.humanData, device), '', 0, 0, device.deviceId, 0, 1, '{}',
            [start.accountId, start.accountCreatedAt], DEVICE_INFO, ['webgl', clientVersion],
        ]];
}
const ZERO_SESSION = { $bin: 12, hex: '000000000000000000000000' };
class GameClient {
    url;
    playerId;
    realmId;
    clanId;
    nickname;
    session;
    suid;
    ratingUrl;
    servers;
    journalToken;
    seq = 1;
    constructor(url, playerId, realmId, clanId, nickname, session, 
    /** The website user id (`tb:<n>`), which is also the chat (Sendbird) user id. */
    suid = '', 
    /** The rating server (the site page's rating_url): the event list (24001) is asked there, never on the realm. */
    ratingUrl = null, 
    /** Every kingdom's server, the rating proxy and the registration server, from the site page. */
    servers = { realmUrls: new Map(), ratingProxyUrl: null, regUrl: null }, 
    /** The battle-report service's token from the login reply (journal-token.ts), or null when it had none. */
    journalToken = null) {
        this.url = url;
        this.playerId = playerId;
        this.realmId = realmId;
        this.clanId = clanId;
        this.nickname = nickname;
        this.session = session;
        this.suid = suid;
        this.ratingUrl = ratingUrl;
        this.servers = servers;
        this.journalToken = journalToken;
    }
    static connect(opts) {
        return oneSiteCallAtATime(() => GameClient.connectNow(opts));
    }
    static async connectNow(opts) {
        siteCookieHeader(opts.storageStatePath); // throws early when no session is stored at all
        const jar = site_session_js_1.SiteCookieJar.load(opts.storageStatePath);
        const device = loadOrCreateDevice(opts.deviceFile);
        // Exactly the browser's sequence, with every Set-Cookie kept: page → token
        // rotation → re-login with the rotated token → cookies written back.
        const boot = await fetchSiteBootstrap(jar);
        if (opts.expectSuid && boot.suid !== opts.expectSuid) {
            throw new WrongAccountError(`the saved login now signs in as ${boot.suid}, not this clan's account ${opts.expectSuid} — nothing was sent to the game; log in again with this clan's account`);
        }
        const start = await getGameStartData(boot, jar, device);
        if (start.newToken)
            await confirmRotatedToken(jar, start.newToken);
        jar.save();
        const url = boot.realmUrls.get(start.realmId)?.[0];
        if (!url)
            throw new GameProtocolError(`no game server listed for realm ${start.realmId}`);
        const clientVersion = opts.clientVersion ?? (0, client_version_js_1.gameClientVersion)();
        const loginFrame = (0, codec_js_1.encodeFrame)([203, 1, [[start.playerId], ZERO_SESSION], ''], buildLoginBody(start, boot.suid, device, clientVersion));
        const reply = (0, codec_js_1.messages)((0, codec_js_1.decodeFrames)(await post(url, loginFrame))).find((m) => m.type === 203);
        // Reply body[0]: [ [playerId], 0, sessionId, …, [ [playerId], [[suid], …, realm, …], [nickname, [clanId], …] ], … ]
        const root = reply?.body[0];
        const session = Array.isArray(root) ? root[2] : undefined;
        if (!session || typeof session !== 'object' || !('$bin' in session) || session.$bin !== 12) {
            throw new GameProtocolError(`game login did not return a session (sent client version ${clientVersion}; System → Game Patch shows the live build's)`);
        }
        const profile = Array.isArray(root) && Array.isArray(root[6]) ? root[6][2] : undefined;
        const nickname = Array.isArray(profile) && typeof profile[0] === 'string' ? profile[0] : '';
        const clanId = Array.isArray(profile) && Array.isArray(profile[1]) && typeof profile[1][0] === 'number' ? profile[1][0] : 0;
        return new GameClient(url, start.playerId, start.realmId, clanId, nickname, session, boot.suid, boot.ratingUrls[0] ?? null, {
            realmUrls: boot.realmUrls,
            ratingProxyUrl: boot.ratingProxyUrl,
            regUrl: boot.regUrls[0] ?? null,
        }, (0, journal_token_js_1.findJournalToken)(root ?? null));
    }
    /**
     * Send one message and return every message in the reply. `url` is the
     * realm server unless given: the rating server takes the same session and
     * the same running request number (the client numbers both from one counter).
     */
    async request(type, body, url = this.url, headers = {}) {
        this.seq += 1;
        const frame = (0, codec_js_1.encodeFrame)([type, this.seq, [[this.playerId], this.session], ''], body);
        return (0, codec_js_1.messages)((0, codec_js_1.decodeFrames)(await post(url, frame, headers)));
    }
    /** The first reply message of `type`, or throw. */
    async ask(type, body, url = this.url) {
        const reply = (await this.request(type, body, url)).find((m) => m.type === type);
        if (!reply)
            throw new GameProtocolError(`no ${type} reply`);
        return reply;
    }
    clanRecord(clanId = this.clanId) {
        return this.ask(15000, [[[[[clanId], ALL_FIELDS]]]]);
    }
    /**
     * Every event the account's realm knows, with which run is live (24001 — what
     * the client asks at login). Asked on the RATING server: a realm server never
     * answers it (every scan's event read failed "no 24001 reply" until Nov 2026).
     */
    eventList(clanId = this.clanId, realmId = this.realmId) {
        if (!this.ratingUrl)
            return Promise.reject(new GameProtocolError('the site page lists no rating server (rating_url) for the event list'));
        return this.ask(24001, [[[[this.playerId], [clanId], realmId], []]], this.ratingUrl);
    }
    /** An event's "Clan members" standings for the account's clan (38003 — the event window's first tab). */
    eventStandings(type, run) {
        return this.ask(38003, [[[type, run]]]);
    }
    /** An event's header for the account's clan (38000 — what the client asks as the window opens): Rise of the Ancients' summons left and artifacts. */
    eventProgress(type, run) {
        return this.ask(38000, [[[type, run]]]);
    }
    /**
     * Each run's ranking scope and group (24203 — what the client polls for the
     * running events): what its Ranking tab (24003) is asked with. Read-only.
     */
    eventRatingScopes(runs) {
        return this.ask(24203, [[runs.map((r) => [r.type, r.run])]]);
    }
    /**
     * An event's Ranking tab (24003), asked on the rating proxy with the run's
     * scope and group from 24203: the top 100 players best first, every clan
     * the scope spans (Sealed in Flame: the three clans of the Olympus matchup).
     * Read-only.
     */
    eventRanking(type, run, scope, group, clanId = this.clanId) {
        const proxy = this.servers.ratingProxyUrl;
        if (!proxy)
            return Promise.reject(new GameProtocolError('the site page lists no rating proxy (rating_proxy_url)'));
        return this.ask(24003, [[[[this.playerId], [clanId], this.realmId], [[type, run], [scope, group], [0, 0]]]], `${proxy.replace(/\/$/, '')}/`);
    }
    /** Trials of Olympus' Ranking → Clan members (82003): the members' Olympus points. Read-only. */
    olympusMembers(type, run) {
        return this.ask(82003, [[[type, run]]]);
    }
    /** The clan's Olympus matchup (82001): its group id, which the Clan ranking is asked by. Read-only. */
    olympusGroup(type, run) {
        return this.ask(82001, [[[type, run]]]);
    }
    /** Olympus' Ranking → Clan ranking (82000), asked on the rating proxy: the matchup's clans and their scores. Read-only. */
    olympusClanRanking(type, run, groupId) {
        const proxy = this.servers.ratingProxyUrl;
        if (!proxy)
            return Promise.reject(new GameProtocolError('the site page lists no rating proxy (rating_proxy_url)'));
        return this.ask(82000, [[[type, run], groupId]], `${proxy.replace(/\/$/, '')}/`);
    }
    /** Olympus' Ranking → Clan rewards (82002): the clan's minimum score and the rewards per place. Read-only. */
    olympusRewards(type, run) {
        return this.ask(82002, [[[type, run]]]);
    }
    /** Olympus' Talents → Clan Talents (74003): the clan's talent levels. Read-only. */
    olympusClanTalents(type, run) {
        return this.ask(74003, [[[type, run]]]);
    }
    /**
     * Which kingdom each clan is in — what the client asks the registration
     * server (message 192, also named in an `x-command-id` header) before
     * reading a rival clan on its own kingdom's server. The reply is
     * `[[kingdom, …]]` in the order asked (Nov 24 2026: CCH, GOF → 213, 157).
     * Read-only. Null when the site page lists no registration server.
     */
    async clanKingdoms(clanIds) {
        const regUrl = this.servers.regUrl;
        if (!regUrl || !clanIds.length)
            return null;
        const reply = (await this.request(192, [[clanIds.map((id) => [id])]], regUrl, { 'x-command-id': '192' })).find((m) => m.type === 192);
        if (!reply)
            throw new GameProtocolError('no 192 reply');
        const list = Array.isArray(reply.body[0]) && Array.isArray(reply.body[0][0]) ? reply.body[0][0] : [];
        return clanIds.map((_, i) => (typeof list[i] === 'number' ? list[i] : null));
    }
    /** A kingdom's own server, from the site page; null when it lists none. */
    kingdomUrl(kingdom) {
        return kingdom === this.realmId ? this.url : this.servers.realmUrls.get(kingdom)?.[0] ?? null;
    }
    /**
     * The clan's headline numbers (25): might and wealth points — what the game
     * asks for whenever its clan window opens. Read-only.
     */
    clanStats(clanId = this.clanId) {
        return this.ask(25, [[[clanId]]]);
    }
    /** The Clan Capital's Border tab (14003): help points among other counters. Read-only. */
    capitalBorder(capitalId) {
        return this.ask(14003, [[[capitalId]]]);
    }
    /** The medals on the clan's Information tab (28001). Read-only. */
    clanMedals(clanId = this.clanId) {
        return this.ask(28001, [[[clanId]]]);
    }
    /**
     * The kingdom's clan ranking (23) — the game's "Clan ranking" button. Kind 7
     * = wealth points (verified); the reply is not sorted. Read-only.
     */
    clanRanking(kind, count = 100) {
        return this.ask(23, [[kind, count, [], false]]);
    }
    /**
     * Any clans' headline (15200): logo, tag, name, members / limit, might — what
     * the ranking list shows. A clan of another kingdom is asked on that
     * kingdom's server (`url`, see kingdomUrl), with the same session, as the
     * client does for Olympus' rival clans. Read-only.
     */
    clanSummaries(clanIds, url = this.url) {
        return this.ask(15200, [[clanIds.map((id) => [id])]], url);
    }
    players(playerIds) {
        return this.ask(402, [[playerIds.map((id) => [id])]]);
    }
    ledger(clanId = this.clanId, sinceEntryId = 0) {
        return this.ask(15031, [[[clanId], sinceEntryId]]);
    }
    city(cityId) {
        return this.ask(601, [[[[[cityId], 0, ALL_FIELDS]]]]);
    }
    /**
     * Several cities / map objects in ONE request — what the game client itself
     * sends for a clan's objects (19 in one 601 ask, Nov 2026). The reply lists
     * every record in body[0][0]; splitCityReply() cuts it into single-city
     * bodies.
     */
    cities(cityIds) {
        return this.ask(601, [[cityIds.map((id) => [[id], 0, ALL_FIELDS])]]);
    }
    /** Map objects in the given tiles (what the client loads as the view moves). */
    mapTiles(tileIds) {
        return this.ask(312, [[tileIds, tileIds.map(() => 0), [], []]]);
    }
    /**
     * Claim (open) chests from gifts: `{giftId: count}`. The in-game Open button
     * sends one id with count 1; "Claim chests" sends every unclaimed Gifts-tab id
     * at once. The reply's rewards are SUMMED across everything claimed, so claim
     * one gift per request to keep rewards per chest. IRREVERSIBLE.
     */
    /** A chat access token for this account (Sendbird; see game-protocol/chat.ts). */
    async chatToken() {
        const reply = await this.ask(414, [[]]);
        const token = Array.isArray(reply.body[0]) ? reply.body[0][0] : undefined;
        if (typeof token !== 'string' || !/^[0-9a-f]{40}$/i.test(token))
            throw new GameProtocolError('no chat token in the 414 reply');
        return token;
    }
    claim(gifts) {
        const body = {};
        for (const [id, n] of Object.entries(gifts))
            body[id] = n;
        return this.ask(15013, [[body]]);
    }
    /**
     * Send one resource from the clan treasury to one member (15019 — the
     * treasury's send, one member at a time; recorded Nov 26 2026:
     * `[[[[31, 1]], [playerId]]]` → `[[]]`, and the ledger lists it at once as
     * a kind-1 entry). Only a Leader or Superior may. IRREVERSIBLE; used only by
     * scheduler/dragon-coin-returns.ts.
     */
    sendFromTreasury(playerId, resourceId, amount) {
        return this.ask(15019, [[[[resourceId, amount]], [playerId]]]);
    }
}
exports.GameClient = GameClient;
async function post(url, body, extraHeaders = {}) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', accept: '*/*', origin: SITE, referer: `${SITE}/`, 'user-agent': exports.USER_AGENT, ...extraHeaders },
        body: new Uint8Array(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok)
        throw new GameProtocolError(`game server ${new URL(url).pathname} → HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
}
//# sourceMappingURL=client.js.map