#!/usr/bin/env node
// RUNS-BY-HAND: it redeploys the very container the boot path lives in (the restart it triggers would kill it mid-run), and it fires from the dev machine right after a push.
//
// Redeploy prod: POST the Portainer stack webhook, but only once the scanner
// is idle, then wait until the new build answers.
//
//   node scripts/deploy-when-idle.mjs            wait for idle, deploy, confirm
//   node scripts/deploy-when-idle.mjs --check    print the verdict, deploy nothing
//   node scripts/deploy-when-idle.mjs --max-wait 120   give up after 120 min (default 90)
//
// A redeploy restarts the container, and a restart mid-scan loses the cycle:
// every Open click has already claimed its chest in-game. Waiting on one scan
// session is NOT enough. A cycle scans every active clan back to back, with
// about half a minute between clans where no session is pending (the might and
// resource phases, then the next clan's login). On Nov 13 2026 a deploy fired
// in that gap and killed the next clan's scan 10 s in. So this waits on the
// loop's own state, /api/health → scanner.busy, which holds for the whole
// cycle and for manual scans, and on the next scheduled cycle being far enough
// off that it can't start while Portainer rebuilds.
//
// Config (never committed: the repo is public): deploy.local.json at the repo
// root, {"webhook": "<Portainer stack webhook URL>", "site": "https://<prod>"},
// or the env vars TB_DEPLOY_WEBHOOK / TB_SITE_URL.
//
// A Claude Code hook (.claude/hooks/guard-deploy.mjs) refuses any shell command
// that calls the webhook directly, so this script is the only way to deploy.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The next scheduled cycle must be at least this far off when the webhook fires. */
export const NEXT_SCAN_MARGIN_MS = 5 * 60_000;
const POLL_MS = 20_000;
const BUILD_WAIT_MS = 10 * 60_000;

/**
 * Whether prod can be redeployed now, from its /api/health body. Fails closed:
 * a body without scanner state (an older build, an error page) is a no.
 *
 * @returns {{ ok: boolean, final: boolean, reason: string }} final = waiting won't change it
 */
export function deployVerdict(health, now = Date.now()) {
  const scanner = health && typeof health === 'object' ? health.scanner : undefined;
  if (!scanner || typeof scanner !== 'object' || typeof scanner.busy !== 'boolean') {
    return {
      ok: false,
      final: true,
      reason: "prod's /api/health reports no scanner state (a build older than this script?). Check by hand that no scan cycle is running.",
    };
  }
  if (scanner.busy) return { ok: false, final: false, reason: 'a scan cycle is running' };
  const next = typeof scanner.nextScanAt === 'number' ? scanner.nextScanAt : null;
  if (next !== null && next - now < NEXT_SCAN_MARGIN_MS) {
    const secs = Math.max(0, Math.round((next - now) / 1000));
    return { ok: false, final: false, reason: `the next scan cycle starts in ${secs}s` };
  }
  const when = next === null ? 'none scheduled' : `next cycle in ${Math.round((next - now) / 60_000)} min`;
  return { ok: true, final: false, reason: `scanner idle (${when})` };
}

function loadConfig() {
  let file = {};
  try {
    file = JSON.parse(readFileSync(path.join(ROOT, 'deploy.local.json'), 'utf8'));
  } catch { /* fall back to env */ }
  const webhook = process.env.TB_DEPLOY_WEBHOOK || file.webhook;
  const site = (process.env.TB_SITE_URL || file.site || '').replace(/\/+$/, '');
  if (!webhook || !site) {
    throw new Error('Missing config: put {"webhook": "...", "site": "https://..."} in deploy.local.json (gitignored), or set TB_DEPLOY_WEBHOOK and TB_SITE_URL.');
  }
  return { webhook, site };
}

async function readHealth(site) {
  try {
    const res = await fetch(`${site}/api/health`, { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Deploying an unpushed HEAD ships nothing new; say so before waiting. */
function assertPushed() {
  const status = execFileSync('git', ['status', '-sb'], { cwd: ROOT, encoding: 'utf8' }).split('\n')[0];
  if (/\[ahead \d+/.test(status)) throw new Error(`Local commits are not pushed (${status.trim()}). Push first.`);
}

const stamp = () => new Date().toISOString().slice(11, 19);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes('--check');
  const maxWaitIdx = args.indexOf('--max-wait');
  const maxWaitMs = (maxWaitIdx >= 0 ? Number(args[maxWaitIdx + 1]) : 90) * 60_000;
  const { webhook, site } = loadConfig();

  if (checkOnly) {
    const v = deployVerdict(await readHealth(site));
    console.log(`${v.ok ? 'OK' : 'NOT NOW'}: ${v.reason}`);
    return v.ok ? 0 : 1;
  }

  assertPushed();
  const deadline = Date.now() + maxWaitMs;
  let lastReason = '';
  let before = null;
  for (;;) {
    const health = await readHealth(site);
    const v = deployVerdict(health);
    if (v.reason !== lastReason) {
      console.log(`[${stamp()}] ${v.ok ? 'ready' : 'waiting'}: ${v.reason}`);
      lastReason = v.reason;
    }
    if (v.final) return 2;
    if (v.ok) { before = health; break; }
    if (Date.now() > deadline) {
      console.log(`[${stamp()}] gave up after ${Math.round(maxWaitMs / 60_000)} min: ${v.reason}. Nothing deployed.`);
      return 3;
    }
    await sleep(POLL_MS);
  }

  const res = await fetch(webhook, { method: 'POST', signal: AbortSignal.timeout(30_000) });
  console.log(`[${stamp()}] webhook: HTTP ${res.status}`);
  if (res.status !== 204 && res.status !== 200) return 4;

  const buildDeadline = Date.now() + BUILD_WAIT_MS;
  while (Date.now() < buildDeadline) {
    await sleep(10_000);
    const now = await readHealth(site);
    if (now && now.fingerprint && now.fingerprint !== before.fingerprint) {
      console.log(`[${stamp()}] new build live: ${now.builtAt} (${now.fingerprint})`);
      return 0;
    }
  }
  console.log(`[${stamp()}] webhook accepted, but the build fingerprint has not changed after ${BUILD_WAIT_MS / 60_000} min. Check Portainer.`);
  return 5;
}

// Exit codes: 0 deployed (or --check: go), 1 error / --check: not now,
// 2 prod reports no scanner state, 3 gave up waiting, 4 webhook refused,
// 5 deployed but the new build never answered. exitCode, not exit(): on
// Windows, exit() right after a fetch trips a libuv assertion.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(
    (code) => { process.exitCode = code; },
    (err) => {
      console.error(String(err?.message ?? err));
      process.exitCode = 1;
    },
  );
}
