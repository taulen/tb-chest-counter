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
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { decodeFrames, encodeFrame, messages, type Frame, type Wire, type BinValue } from './codec.js';
import { SiteCookieJar, authTokenAccounts } from './site-session.js';

const SITE = 'https://totalbattle.com';
const RPC_URL = `${SITE}/restapi/totalbattle/web/`;
const CHROME = '157.0.0.0';
export const USER_AGENT =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME} Safari/537.36`;
/**
 * The WebGL client's build version, sent at login. It isn't published in any
 * text endpoint (it's compiled into the game build), so it's a constant here;
 * a login failure after a game update is the cue to refresh it.
 */
export const DEFAULT_CLIENT_VERSION = process.env.GAME_CLIENT_VERSION || '349.9.1116';
const REQUEST_TIMEOUT_MS = 60_000;
const ALL_FIELDS = 2147483647;

export class GameProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GameProtocolError';
  }
}

/** The site served its logged-out page for the stored cookies: a definite re-auth. */
export class SessionLoggedOutError extends GameProtocolError {
  constructor() {
    super('totalbattle.com served the logged-out page for the stored session — the clan needs re-authentication');
    this.name = 'SessionLoggedOutError';
  }
}

/** Substrings only TB's public marketing / login page has. */
const LOGGED_OUT_SIGNATURES = ['register or log in', 'sign up with'];

export type SiteSessionState = 'ok' | 'logged-out' | 'unknown';

/** Classify the /en/ page. Pure; unit-tested. Ambiguous pages are 'unknown', never 'logged-out'. */
export function classifySitePage(status: number, html: string): SiteSessionState {
  if (status !== 200) return 'unknown';
  if (/"suid":"[a-z0-9]+:\d+"/.test(html)) return 'ok';
  const text = html.toLowerCase();
  return LOGGED_OUT_SIGNATURES.some((s) => text.includes(s)) ? 'logged-out' : 'unknown';
}

/**
 * Is the clan's stored login still alive? One GET of the site page with the
 * stored cookies — no token is presented, so this is safe to run as often as
 * we like. Network errors and odd pages answer 'unknown'.
 */
export async function checkSiteSession(storageStatePath: string): Promise<SiteSessionState> {
  return (await checkSiteSessionAccount(storageStatePath)).state;
}

/**
 * checkSiteSession, plus the website user id (`tb:<n>`) the stored login
 * belongs to when it is signed in — the same page carries it. The scan
 * scheduler keys its lanes on it: two clans on one account never scan at once.
 */
export async function checkSiteSessionAccount(
  storageStatePath: string,
): Promise<{ state: SiteSessionState; suid: string | null; tokenAccounts: string[] }> {
  let cookies: string;
  let tokenAccounts: string[] = [];
  try {
    cookies = siteCookieHeader(storageStatePath);
    tokenAccounts = storedTokenAccounts(storageStatePath);
  } catch {
    return { state: 'logged-out', suid: null, tokenAccounts };
  }
  try {
    const res = await fetch(`${SITE}/en/`, {
      headers: { cookie: cookies, 'user-agent': USER_AGENT, accept: 'text/html' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const html = await res.text();
    const state = classifySitePage(res.status, html);
    return { state, suid: state === 'ok' ? parseSitePage(html).suid : null, tokenAccounts };
  } catch {
    return { state: 'unknown', suid: null, tokenAccounts };
  }
}

/** The accounts the stored sign-in token(s) name, read from the file (local, nothing sent). */
export function storedTokenAccounts(storageStatePath: string): string[] {
  const raw = fs.readFileSync(storageStatePath, 'utf8').replace(/^﻿/, '').trim();
  const state = JSON.parse(raw) as { cookies?: Array<{ name: string; value: string; domain: string }> };
  return authTokenAccounts((state.cookies ?? []).filter((c) => /^\.?totalbattle\.com$/.test(c.domain)));
}

/** The saved login signs in to a different website account than the clan's known one. */
export class WrongAccountError extends GameProtocolError {
  constructor(message: string) {
    super(message);
    this.name = 'WrongAccountError';
  }
}

// ---------------------------------------------------------------------------
// Stored session + per-clan device identity
// ---------------------------------------------------------------------------

interface StoredCookie {
  name: string;
  value: string;
  domain: string;
}

/** Cookies the browser would send to totalbattle.com, from a Playwright storage state. */
export function siteCookieHeader(storageStatePath: string): string {
  const raw = fs.readFileSync(storageStatePath, 'utf8').replace(/^﻿/, '').trim();
  const state = JSON.parse(raw) as { cookies?: StoredCookie[] };
  const cookies = (state.cookies ?? []).filter((c) => /^\.?totalbattle\.com$/.test(c.domain));
  if (!cookies.some((c) => c.name === 'PTBHSSID')) {
    throw new GameProtocolError('stored session has no PTBHSSID cookie — the clan needs re-authentication');
  }
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

export interface DeviceIdentity {
  deviceId: string;
  fingerprintId: string;
  firstWebVisitTs: number;
  firstWebVisitRnd: string;
}

/**
 * One stable "device" per clan, like a browser keeps between visits. Generated
 * once and stored next to the clan's session so every connect looks the same.
 */
export function loadOrCreateDevice(file: string): DeviceIdentity {
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')) as DeviceIdentity;
  const now = Math.floor(Date.now() / 1000);
  const device: DeviceIdentity = {
    deviceId: `fpc${crypto.randomBytes(16).toString('hex')}`,
    fingerprintId: String(crypto.randomInt(100_000_000, 999_999_999)),
    firstWebVisitTs: now,
    firstWebVisitRnd: `${now}${crypto.randomInt(100, 999)}`,
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(device, null, 1));
  return device;
}

// ---------------------------------------------------------------------------
// Website bootstrap
// ---------------------------------------------------------------------------

export interface SiteBootstrap {
  token: string;
  suid: string;
  realmUrls: Map<number, string[]>;
  /** The rating server (events list 24001), then its fallback. */
  ratingUrls: string[];
}

/** The rating server's pseudo-realm in the site page's realm list. */
const RATING_REALM_ID = 100000;

const jsonUrls = (list: string): string[] => [...list.matchAll(/"([^"]+)"/g)].map((u) => u[1].replace(/\\\//g, '/'));

/**
 * Pull the game account id, the realm → server map and the rating server out
 * of the /en/ page. Pure; unit-tested. The rating server is NOT the realm's:
 * the client asks it for the event list (24001) — a realm server never answers
 * that (Nov 2026: every scan's event read failed "no 24001 reply" until this).
 * It is the page's `rating_url`, else realm 100000's logic_url.
 */
export function parseSitePage(html: string): { suid: string | null; realmUrls: Map<number, string[]>; ratingUrls: string[] } {
  const suid = html.match(/"suid":"([a-z0-9]+:\d+)"/)?.[1] ?? null;
  const realmUrls = new Map<number, string[]>();
  for (const m of html.matchAll(/\{"realm_id":(\d+),"logic_url":\[([^\]]*)\]/g)) {
    const urls = jsonUrls(m[2]);
    if (urls.length) realmUrls.set(Number(m[1]), urls);
  }
  const rating = html.match(/"rating_url":\[([^\]]*)\]/);
  const ratingUrls = rating ? jsonUrls(rating[1]) : (realmUrls.get(RATING_REALM_ID) ?? []);
  return { suid, realmUrls, ratingUrls };
}

function tokenFromSetCookie(setCookies: string[]): string | null {
  for (const c of setCookies) {
    const m = c.match(/^__Host-user_auth_token=([^;]+)/);
    if (m) return decodeURIComponent(m[1]);
  }
  return null;
}

export async function fetchSiteBootstrap(jar: SiteCookieJar): Promise<SiteBootstrap> {
  const res = await fetch(`${SITE}/en/`, {
    headers: { cookie: jar.header(), 'user-agent': USER_AGENT, accept: 'text/html' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  jar.apply(res.headers.getSetCookie());
  if (!res.ok) throw new GameProtocolError(`GET /en/ → HTTP ${res.status}`);
  const html = await res.text();
  const token = tokenFromSetCookie(res.headers.getSetCookie());
  const { suid, realmUrls, ratingUrls } = parseSitePage(html);
  if (classifySitePage(res.status, html) === 'logged-out') throw new SessionLoggedOutError();
  if (!token || !suid) {
    throw new GameProtocolError('totalbattle.com returned an unexpected page (no token or account id) — not treated as a logout');
  }
  return { token, suid, realmUrls, ratingUrls };
}

export interface GameStartData {
  sig: string;
  /** The rotated website token; the browser confirms it via bytokenoauth. */
  newToken: string | null;
  realmId: number;
  playerId: number;
  accountId: number;
  accountCreatedAt: number;
  humanData: Record<string, unknown>;
}

export async function getGameStartData(boot: SiteBootstrap, jar: SiteCookieJar, device: DeviceIdentity): Promise<GameStartData> {
  const body = {
    id: crypto.randomUUID(),
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
    headers: { 'content-type': 'application/json', origin: SITE, referer: `${SITE}/en/`, 'user-agent': USER_AGENT, cookie: jar.header() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  jar.apply(res.headers.getSetCookie());
  const json = (await res.json()) as { result?: Record<string, unknown> & { error?: { message?: string } } };
  const r = json.result;
  if (!r || r.error || typeof r.sig !== 'string') {
    throw new GameProtocolError(`GetGameStartData failed: ${r?.error?.message ?? `HTTP ${res.status}`}`);
  }
  const account = (r.account ?? {}) as { id?: number; createdAt?: number };
  return {
    sig: r.sig,
    newToken: typeof r.new_token === 'string' ? r.new_token : null,
    realmId: Number(r.realmID),
    playerId: Number(r.stringGuid),
    accountId: Number(r.accountId ?? account.id),
    accountCreatedAt: Number(account.createdAt ?? 0),
    humanData: (r.human_data ?? {}) as Record<string, unknown>,
  };
}

/**
 * The browser's follow-up to GetGameStartData: re-login the website session
 * with the rotated token. The reply sets fresh PTBHSSID and auth cookies, which
 * the jar keeps. Skipping this step is what ended CWB's session.
 */
export async function confirmRotatedToken(jar: SiteCookieJar, newToken: string): Promise<void> {
  const res = await fetch(`${SITE}/login/bytokenoauth/?token=${encodeURIComponent(newToken)}`, {
    headers: { cookie: jar.header(), 'user-agent': USER_AGENT, accept: 'text/html', referer: `${SITE}/en/` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  jar.apply(res.headers.getSetCookie());
  if (!res.ok) throw new GameProtocolError(`bytokenoauth → HTTP ${res.status}`);
}

// ---------------------------------------------------------------------------
// Game login
// ---------------------------------------------------------------------------

const DEVICE_INFO: Wire[] = [
  `Chrome ${CHROME}`, 'Windows 10', 'Chrome', [1920, 1080], 96, '', 'EN', 3600, 16384, 1023,
  'OpenGL ES 3.0 (WebGL 2.0 (OpenGL ES 3.0 Chromium))', 0,
];

/**
 * The login's human-data array, in the game client's own field order (not the
 * JSON key order: two empty slots sit after `email`, and nested objects become
 * arrays). Values the server knows (ip, country, language, email) are echoed
 * from GetGameStartData; the device fields are ours. Pure; unit-tested.
 */
export function loginHumanArray(hd: Record<string, unknown>, device: DeviceIdentity): Wire[] {
  const s = (k: string, d = ''): string => (typeof hd[k] === 'string' ? (hd[k] as string) : d);
  return [
    s('ref'), s('ref_p'), s('current_entry_point', 'site2'), s('ip'), s('continent_code'), s('country_code'),
    s('age'), s('isMale', '0'), s('city'), s('full_name'), s('lang', 'en'), s('email'),
    '', '',
    s('referrer', `${SITE}/en/`), 'webgl', 'chrome', ['', '', '', ''], 'auth_token',
    device.fingerprintId, device.firstWebVisitTs, device.firstWebVisitRnd, '', '',
    USER_AGENT, device.deviceId, ['', '', '', ''], false, ['', 'web'], 'unity',
  ];
}

export function buildLoginBody(start: GameStartData, suid: string, device: DeviceIdentity, clientVersion: string): Wire[] {
  return [[
    [suid], [''], start.sig, loginHumanArray(start.humanData, device), '', 0, 0, device.deviceId, 0, 1, '{}',
    [start.accountId, start.accountCreatedAt], DEVICE_INFO, ['webgl', clientVersion],
  ]];
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export interface ConnectOptions {
  storageStatePath: string;
  deviceFile: string;
  clientVersion?: string;
  /**
   * The website account (`tb:<n>`) this login must be. Checked on the site
   * page BEFORE any token is presented: a different account throws
   * WrongAccountError, nothing is sent to the game, the jar is not saved.
   */
  expectSuid?: string | null;
}

const ZERO_SESSION: BinValue = { $bin: 12, hex: '000000000000000000000000' };

export class GameClient {
  private seq = 1;

  private constructor(
    readonly url: string,
    readonly playerId: number,
    readonly realmId: number,
    readonly clanId: number,
    readonly nickname: string,
    private readonly session: BinValue,
    /** The website user id (`tb:<n>`), which is also the chat (Sendbird) user id. */
    readonly suid: string = '',
    /** The rating server (the site page's rating_url): the event list (24001) is asked there, never on the realm. */
    readonly ratingUrl: string | null = null,
  ) {}

  static async connect(opts: ConnectOptions): Promise<GameClient> {
    siteCookieHeader(opts.storageStatePath); // throws early when no session is stored at all
    const jar = SiteCookieJar.load(opts.storageStatePath);
    const device = loadOrCreateDevice(opts.deviceFile);
    // Exactly the browser's sequence, with every Set-Cookie kept: page → token
    // rotation → re-login with the rotated token → cookies written back.
    const boot = await fetchSiteBootstrap(jar);
    if (opts.expectSuid && boot.suid !== opts.expectSuid) {
      throw new WrongAccountError(
        `the saved login now signs in as ${boot.suid}, not this clan's account ${opts.expectSuid} — nothing was sent to the game; log in again with this clan's account`,
      );
    }
    const start = await getGameStartData(boot, jar, device);
    if (start.newToken) await confirmRotatedToken(jar, start.newToken);
    jar.save();
    const url = boot.realmUrls.get(start.realmId)?.[0];
    if (!url) throw new GameProtocolError(`no game server listed for realm ${start.realmId}`);

    const loginFrame = encodeFrame([203, 1, [[start.playerId], ZERO_SESSION], ''], buildLoginBody(start, boot.suid, device, opts.clientVersion ?? DEFAULT_CLIENT_VERSION));
    const reply = messages(decodeFrames(await post(url, loginFrame))).find((m) => m.type === 203);
    // Reply body[0]: [ [playerId], 0, sessionId, …, [ [playerId], [[suid], …, realm, …], [nickname, [clanId], …] ], … ]
    const root = reply?.body[0];
    const session = Array.isArray(root) ? root[2] : undefined;
    if (!session || typeof session !== 'object' || !('$bin' in session) || (session as BinValue).$bin !== 12) {
      throw new GameProtocolError('game login did not return a session (the client version may be outdated)');
    }
    const profile = Array.isArray(root) && Array.isArray(root[6]) ? (root[6][2] as Wire[] | undefined) : undefined;
    const nickname = Array.isArray(profile) && typeof profile[0] === 'string' ? profile[0] : '';
    const clanId = Array.isArray(profile) && Array.isArray(profile[1]) && typeof profile[1][0] === 'number' ? profile[1][0] : 0;
    return new GameClient(url, start.playerId, start.realmId, clanId, nickname, session as BinValue, boot.suid, boot.ratingUrls[0] ?? null);
  }

  /**
   * Send one message and return every message in the reply. `url` is the
   * realm server unless given: the rating server takes the same session and
   * the same running request number (the client numbers both from one counter).
   */
  async request(type: number, body: Wire[], url = this.url): Promise<Frame[]> {
    this.seq += 1;
    const frame = encodeFrame([type, this.seq, [[this.playerId], this.session], ''], body);
    return messages(decodeFrames(await post(url, frame)));
  }

  /** The first reply message of `type`, or throw. */
  async ask(type: number, body: Wire[], url = this.url): Promise<Frame> {
    const reply = (await this.request(type, body, url)).find((m) => m.type === type);
    if (!reply) throw new GameProtocolError(`no ${type} reply`);
    return reply;
  }

  clanRecord(clanId = this.clanId): Promise<Frame> {
    return this.ask(15000, [[[[[clanId], ALL_FIELDS]]]]);
  }

  /**
   * Every event the account's realm knows, with which run is live (24001 — what
   * the client asks at login). Asked on the RATING server: a realm server never
   * answers it (every scan's event read failed "no 24001 reply" until Nov 2026).
   */
  eventList(clanId = this.clanId, realmId = this.realmId): Promise<Frame> {
    if (!this.ratingUrl) return Promise.reject(new GameProtocolError('the site page lists no rating server (rating_url) for the event list'));
    return this.ask(24001, [[[[this.playerId], [clanId], realmId], []]], this.ratingUrl);
  }

  /** An event's "Clan members" standings for the account's clan (38003 — the event window's first tab). */
  eventStandings(type: number, run: number): Promise<Frame> {
    return this.ask(38003, [[[type, run]]]);
  }

  /** An event's header for the account's clan (38000 — what the client asks as the window opens): Rise of the Ancients' summons left and artifacts. */
  eventProgress(type: number, run: number): Promise<Frame> {
    return this.ask(38000, [[[type, run]]]);
  }

  /**
   * The clan's headline numbers (25): might and wealth points — what the game
   * asks for whenever its clan window opens. Read-only.
   */
  clanStats(clanId = this.clanId): Promise<Frame> {
    return this.ask(25, [[[clanId]]]);
  }

  /** The Clan Capital's Border tab (14003): help points among other counters. Read-only. */
  capitalBorder(capitalId: number): Promise<Frame> {
    return this.ask(14003, [[[capitalId]]]);
  }

  /** The medals on the clan's Information tab (28001). Read-only. */
  clanMedals(clanId = this.clanId): Promise<Frame> {
    return this.ask(28001, [[[clanId]]]);
  }

  /**
   * The kingdom's clan ranking (23) — the game's "Clan ranking" button. Kind 7
   * = wealth points (verified); the reply is not sorted. Read-only.
   */
  clanRanking(kind: number, count = 100): Promise<Frame> {
    return this.ask(23, [[kind, count, [], false]]);
  }

  /** Any clans' headline (15200): logo, tag, name, members / limit, might — what the ranking list shows. Read-only. */
  clanSummaries(clanIds: number[]): Promise<Frame> {
    return this.ask(15200, [[clanIds.map((id) => [id])]]);
  }

  players(playerIds: number[]): Promise<Frame> {
    return this.ask(402, [[playerIds.map((id) => [id])]]);
  }

  ledger(clanId = this.clanId, sinceEntryId = 0): Promise<Frame> {
    return this.ask(15031, [[[clanId], sinceEntryId]]);
  }

  city(cityId: number): Promise<Frame> {
    return this.ask(601, [[[[[cityId], 0, ALL_FIELDS]]]]);
  }

  /**
   * Several cities / map objects in ONE request — what the game client itself
   * sends for a clan's objects (19 in one 601 ask, Nov 2026). The reply lists
   * every record in body[0][0]; splitCityReply() cuts it into single-city
   * bodies.
   */
  cities(cityIds: number[]): Promise<Frame> {
    return this.ask(601, [[cityIds.map((id) => [[id], 0, ALL_FIELDS])]]);
  }

  /** Map objects in the given tiles (what the client loads as the view moves). */
  mapTiles(tileIds: number[]): Promise<Frame> {
    return this.ask(312, [[tileIds, tileIds.map(() => 0), [], []]]);
  }

  /**
   * Claim (open) chests from gifts: `{giftId: count}`. The in-game Open button
   * sends one id with count 1; "Claim chests" sends every unclaimed Gifts-tab id
   * at once. The reply's rewards are SUMMED across everything claimed, so claim
   * one gift per request to keep rewards per chest. IRREVERSIBLE.
   */
  /** A chat access token for this account (Sendbird; see game-protocol/chat.ts). */
  async chatToken(): Promise<string> {
    const reply = await this.ask(414, [[]]);
    const token = Array.isArray(reply.body[0]) ? reply.body[0][0] : undefined;
    if (typeof token !== 'string' || !/^[0-9a-f]{40}$/i.test(token)) throw new GameProtocolError('no chat token in the 414 reply');
    return token;
  }

  claim(gifts: Record<number, number>): Promise<Frame> {
    const body: Record<string, number> = {};
    for (const [id, n] of Object.entries(gifts)) body[id] = n;
    return this.ask(15013, [[body]]);
  }
}

async function post(url: string, body: Buffer): Promise<Buffer> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', accept: '*/*', origin: SITE, referer: `${SITE}/`, 'user-agent': USER_AGENT },
    body: new Uint8Array(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new GameProtocolError(`game server ${new URL(url).pathname} → HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
