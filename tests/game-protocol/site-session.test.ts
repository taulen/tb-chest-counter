import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { SiteCookieJar, parseSetCookie } from '../../src/game-protocol/site-session.js';

const tmpFiles: string[] = [];
afterEach(() => {
  for (const f of tmpFiles.splice(0)) fs.rmSync(f, { force: true });
});

function stateFile(cookies: unknown[]): string {
  const f = path.join(os.tmpdir(), `jar-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify({ cookies, origins: [{ origin: 'https://totalbattle.com', localStorage: [] }] }));
  tmpFiles.push(f);
  return f;
}

const cookie = (name: string, value: string, domain = 'totalbattle.com') => ({
  name, value, domain, path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax',
});

describe('Set-Cookie parsing', () => {
  it('reads attributes into Playwright storage form', () => {
    const now = 1_794_870_000;
    const p = parseSetCookie('__Host-user_auth_token=eyJ.a.b; Path=/; Max-Age=2592000; Secure; SameSite=None', now);
    expect(p).toEqual({
      cookie: { name: '__Host-user_auth_token', value: 'eyJ.a.b', domain: 'totalbattle.com', path: '/', expires: now + 2592000, httpOnly: false, secure: true, sameSite: 'None' },
      deleted: false,
    });
    expect(parseSetCookie('language=en; Domain=.totalbattle.com; Path=/', now)?.cookie.domain).toBe('.totalbattle.com');
  });

  it('treats Max-Age=0 and past expiry as deletion', () => {
    expect(parseSetCookie('a=; Max-Age=0')?.deleted).toBe(true);
    expect(parseSetCookie('a=x; Expires=Thu, 01 Jan 1970 00:00:00 GMT')?.deleted).toBe(true);
  });
});

describe('site cookie jar', () => {
  it('applies rotated cookies, drops deleted ones, ignores other sites, and writes back', () => {
    const f = stateFile([cookie('PTBHSSID', 'old'), cookie('__Host-user_auth_token', 'eyJ.old'), cookie('gone', '1'), cookie('_ga', 'x', '.google.com')]);
    const jar = SiteCookieJar.load(f);
    expect(jar.header()).toBe('PTBHSSID=old; __Host-user_auth_token=eyJ.old; gone=1');
    jar.apply(['PTBHSSID=new; Path=/; HttpOnly', '__Host-user_auth_token=eyJ.new; Path=/; Secure', 'gone=; Max-Age=0', 'x=1; Domain=evil.example']);
    expect(jar.get('PTBHSSID')).toBe('new');
    expect(jar.get('__Host-user_auth_token')).toBe('eyJ.new');
    expect(jar.save()).toBe('saved');
    const saved = JSON.parse(fs.readFileSync(f, 'utf8'));
    expect(saved.cookies.map((c: { name: string; value: string }) => `${c.name}=${c.value}`).sort()).toEqual(
      ['PTBHSSID=new', '__Host-user_auth_token=eyJ.new', '_ga=x'].sort(),
    );
    expect(saved.origins).toHaveLength(1); // the rest of the storage state survives
  });

  it('does not overwrite a login saved on disk after it was loaded', () => {
    const f = stateFile([cookie('PTBHSSID', 'old')]);
    const jar = SiteCookieJar.load(f);
    jar.apply(['PTBHSSID=rotated; Path=/']);
    const fresher = JSON.stringify({ cookies: [cookie('PTBHSSID', 'admin-saved')] });
    fs.writeFileSync(f, fresher);
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(f, later, later);
    expect(jar.save()).toBe('superseded');
    expect(fs.readFileSync(f, 'utf8')).toBe(fresher);
  });

  it('writes nothing when nothing changed', () => {
    const f = stateFile([cookie('PTBHSSID', 'same')]);
    const jar = SiteCookieJar.load(f);
    jar.apply(['PTBHSSID=same; Path=/; HttpOnly; Secure']);
    expect(jar.save()).toBe('unchanged');
  });
});
