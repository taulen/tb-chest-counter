/**
 * The clan's stored totalbattle.com login, kept current the way a browser keeps
 * its cookie jar.
 *
 * Every site reply re-sets cookies (the session cookie PTBHSSID and, at key
 * steps, the rotating JWT in __Host-user_auth_token). A browser stores each one
 * and sends the new values next time; a client that keeps replaying the
 * original cookies drifts away from the session the server is tracking. Two
 * direct logins that did exactly that ended CWB's website session (Nov 17
 * 2026). So the direct client loads the clan's Playwright storage state into
 * this jar, applies every Set-Cookie, and writes the result back — the
 * scanner's browser then starts from the same current cookies.
 *
 * Write-back is guarded: if the file changed on disk since it was loaded (an
 * admin saved a fresh login through the login bridge meanwhile), the jar does
 * not overwrite it — the newer login wins. The write itself is atomic.
 */
import fs from 'fs';

export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Unix seconds; -1 = session cookie (Playwright's convention). */
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
}

interface StorageState {
  cookies?: StoredCookie[];
  origins?: unknown[];
  [key: string]: unknown;
}

const SITE_DOMAIN = /^\.?totalbattle\.com$/;

/** The site's sign-in token cookie: a JWT naming the website account (`suid`). */
export const AUTH_TOKEN_COOKIE = '__Host-user_auth_token';

/**
 * Which website account(s) the stored sign-in token(s) belong to, decoded
 * locally from the JWT payload (no request, nothing presented). Pure.
 *
 * Why it matters (Nov 17 2026): SK7's saved login held a site session for one
 * account and, left over from an earlier login in the same browser profile, a
 * sign-in token for ANOTHER (SIK's). When the session ended, the site signed
 * in with the leftover token — as SIK's account — and two scans read SIK as SK7.
 */
export function authTokenAccounts(cookies: ReadonlyArray<{ name: string; value: string }>): string[] {
  const out: string[] = [];
  for (const c of cookies) {
    if (c.name !== AUTH_TOKEN_COOKIE) continue;
    const parts = decodeURIComponent(c.value ?? '').split('.');
    if (parts.length !== 3) continue;
    try {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { suid?: unknown };
      if (typeof payload.suid === 'string' && /^[a-z]+:\d+$/.test(payload.suid)) out.push(payload.suid);
    } catch {
      // Not a JWT we can read: says nothing about the account.
    }
  }
  return out;
}

/** Parse one Set-Cookie header into a stored cookie (or a deletion). Pure; unit-tested. */
export function parseSetCookie(header: string, nowSec = Math.floor(Date.now() / 1000)): { cookie: StoredCookie; deleted: boolean } | null {
  const [pair, ...attrs] = header.split(';');
  const eq = pair.indexOf('=');
  if (eq <= 0) return null;
  const cookie: StoredCookie = {
    name: pair.slice(0, eq).trim(),
    value: pair.slice(eq + 1).trim(),
    domain: 'totalbattle.com',
    path: '/',
    expires: -1,
    httpOnly: false,
    secure: false,
    sameSite: 'Lax',
  };
  let maxAge: number | null = null;
  for (const a of attrs) {
    const [k, ...rest] = a.split('=');
    const key = k.trim().toLowerCase();
    const val = rest.join('=').trim();
    if (key === 'domain' && val) cookie.domain = `.${val.replace(/^\./, '')}`;
    else if (key === 'path' && val) cookie.path = val;
    else if (key === 'expires' && val) {
      const t = Date.parse(val);
      if (!Number.isNaN(t)) cookie.expires = Math.floor(t / 1000);
    } else if (key === 'max-age' && val) maxAge = Number(val);
    else if (key === 'httponly') cookie.httpOnly = true;
    else if (key === 'secure') cookie.secure = true;
    else if (key === 'samesite') {
      const v = val.toLowerCase();
      cookie.sameSite = v === 'strict' ? 'Strict' : v === 'none' ? 'None' : 'Lax';
    }
  }
  if (maxAge !== null && Number.isFinite(maxAge)) cookie.expires = nowSec + maxAge;
  const deleted = (maxAge !== null && maxAge <= 0) || (cookie.expires !== -1 && cookie.expires <= nowSec);
  return { cookie, deleted };
}

export class SiteCookieJar {
  private dirty = false;

  private constructor(
    private readonly file: string,
    private readonly state: StorageState,
    private readonly loadedMtimeMs: number,
  ) {}

  static load(file: string): SiteCookieJar {
    const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').trim();
    return new SiteCookieJar(file, JSON.parse(raw) as StorageState, fs.statSync(file).mtimeMs);
  }

  private get siteCookies(): StoredCookie[] {
    const now = Math.floor(Date.now() / 1000);
    return (this.state.cookies ?? []).filter((c) => SITE_DOMAIN.test(c.domain) && (c.expires === -1 || c.expires > now));
  }

  /** The Cookie header a browser would send to totalbattle.com. */
  header(): string {
    return this.siteCookies.map((c) => `${c.name}=${c.value}`).join('; ');
  }

  get(name: string): string | undefined {
    const c = this.siteCookies.find((x) => x.name === name);
    return c ? decodeURIComponent(c.value) : undefined;
  }

  /** Apply a reply's Set-Cookie headers, exactly as a browser would. */
  apply(setCookies: string[]): void {
    const cookies = (this.state.cookies ??= []);
    for (const h of setCookies) {
      const parsed = parseSetCookie(h);
      if (!parsed || !SITE_DOMAIN.test(parsed.cookie.domain)) continue;
      const { cookie, deleted } = parsed;
      const i = cookies.findIndex((c) => c.name === cookie.name && c.domain === cookie.domain && c.path === cookie.path);
      if (deleted) {
        if (i >= 0) {
          cookies.splice(i, 1);
          this.dirty = true;
        }
        continue;
      }
      if (i >= 0) {
        const old = cookies[i];
        if (old.value === cookie.value && old.expires === cookie.expires) continue;
        cookies[i] = { ...old, ...cookie };
      } else {
        cookies.push(cookie);
      }
      this.dirty = true;
    }
  }

  /**
   * Write the jar back to the clan's storage state. Skipped when nothing
   * changed, and when the file changed on disk after it was loaded (a newer
   * login saved meanwhile must win).
   */
  save(): 'saved' | 'unchanged' | 'superseded' {
    if (!this.dirty) return 'unchanged';
    if (fs.statSync(this.file).mtimeMs !== this.loadedMtimeMs) return 'superseded';
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.file);
    this.dirty = false;
    return 'saved';
  }
}
