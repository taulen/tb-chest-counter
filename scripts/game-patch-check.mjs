#!/usr/bin/env node
/**
 * Read the live game patch with this checkout's own code, into a scratch dir,
 * and say whether every reader can: names and texts, research trees, art
 * (every bundle, the client's unit frames), the client version.
 *
 * RUNS-BY-HAND: it is the canary that must NOT depend on prod — the
 * game-patch GitHub workflow runs it hourly on GitHub's runners (it downloads
 * ~400 MB per patch and opens an issue on failure); the in-container
 * counterpart, src/game-patch/watch.ts, already runs on every boot. By hand it
 * is the first step of a fix (docs/game-patches.md).
 *
 *   node scripts/game-patch-check.mjs --fingerprint
 *       Print a key for the live patch (no build needed): the workflow checks
 *       each patch once.
 *
 *   node scripts/game-patch-check.mjs [--work <dir>] [--report <file.md>]
 *       Run every reader against the live game (dist/, so `npm run build`
 *       first). Downloads into <dir> (default: a temp dir). Writes a Markdown
 *       report; exits 1 when anything can't be read.
 *
 * Never touches data/game-* (GAME_STATIC_DIR, GAME_ART_DIR and GAME_PATCH_FILE
 * point into <dir>), never logs in to the game.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const VERSIONS_URL = 'https://versions.totalbattle.com/config?branch=current&simple=true';
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

async function liveFingerprint() {
  const res = await fetch(VERSIONS_URL, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`GET ${VERSIONS_URL} → HTTP ${res.status}`);
  const r = (await res.json())?.result ?? {};
  return {
    static: r.client_static_version?.production?.composite_hash ?? '',
    translations: String(r.client_translations_catalog_version ?? '').replace(/\.json$/, ''),
    catalog: r.unity_catalog_version?.webgl ?? '',
    client: r.webgl_client_version?.default ?? '',
  };
}

async function printFingerprint() {
  const fp = await liveFingerprint();
  const key = [fp.static, fp.translations, fp.catalog, fp.client].map((p) => p.slice(0, 16)).join('-');
  if (!/^[0-9a-zA-Z_]{4,}(-[0-9a-zA-Z_]{4,}){3}$/.test(key)) throw new Error(`unexpected fingerprint: ${key}`);
  console.log(key);
  return 0;
}

async function check() {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const work = path.resolve(opt('--work') ?? fs.mkdtempSync(path.join(os.tmpdir(), 'tbcc-patch-check-')));
  const reportFile = opt('--report') ? path.resolve(opt('--report')) : null;
  // The readers resolve a few files against the working directory (the troop list).
  process.chdir(repo);
  fs.mkdirSync(work, { recursive: true });
  process.env.GAME_STATIC_DIR = path.join(work, 'game-static');
  process.env.GAME_ART_DIR = path.join(work, 'game-art');
  process.env.GAME_PATCH_FILE = path.join(work, 'game-patch.json');
  delete process.env.GAME_CLIENT_VERSION;

  const dist = (p) => import(pathToFileURL(path.join(repo, 'dist', p)).href);
  const [{ loadGameNames }, { loadTechTrees }, store, { ensureClientVersion }, status] = await Promise.all([
    dist('game-protocol/static-data.js'),
    dist('game-protocol/tech-trees.js'),
    dist('game-art/store.js'),
    dist('game-patch/client-version.js'),
    dist('game-patch/status.js'),
  ]);

  /** @type {Array<{ reader: string, ok: boolean, detail: string, error?: string }>} */
  const results = [];
  const readerStatus = (r) => status.readPatchStatus().readers[r];
  const errorOf = (err) => (err instanceof Error ? err.stack ?? err.message : String(err));

  const step = async (reader, label, run) => {
    const started = Date.now();
    console.log(`… ${label}`);
    try {
      const { detail, problems = [] } = await run();
      const st = readerStatus(reader);
      if (st && !st.ok) problems.unshift(st.error ?? 'failed');
      const secs = Math.round((Date.now() - started) / 1000);
      results.push({ reader: label, ok: problems.length === 0, detail: `${detail} (${secs} s)`, error: problems.join('\n') || undefined });
    } catch (err) {
      results.push({ reader: label, ok: false, detail: 'threw', error: readerStatus(reader)?.error ?? errorOf(err) });
    }
  };

  const fp = await liveFingerprint();

  await step('names', 'Game names and texts', async () => {
    const names = await loadGameNames();
    const gifts = Object.keys(names.gifts ?? {}).length;
    const techs = Object.keys(names.techs ?? {}).length;
    const langs = names.textLanguages ?? [];
    const problems = [];
    if (gifts < 1000) problems.push(`only ${gifts} gift types`);
    if (techs < 500) problems.push(`only ${techs} techs`);
    if (langs.length < 4) problems.push(`texts in ${langs.join(', ') || 'no language'} only`);
    return { detail: `${gifts} gift types, ${techs} techs; texts ${langs.join(', ')}`, problems };
  });

  await step('trees', 'Research trees', async () => {
    const trees = await loadTechTrees();
    const nodes = trees.trees.reduce((n, t) => n + t.nodes.length, 0);
    const problems = [];
    if (trees.trees.length < 20) problems.push(`only ${trees.trees.length} trees`);
    const empty = trees.trees.filter((t) => !t.nodes.length).map((t) => t.name);
    if (empty.length) problems.push(`trees without nodes: ${empty.join(', ')}`);
    return { detail: `${trees.trees.length} trees, ${nodes} nodes`, problems };
  });

  await step('art', 'Game art', async () => {
    // No database here: resource icons are picked by the clans' resource names.
    const res = await store.ensureGameArt({ concurrency: 8, resourceNames: () => [] });
    if (res.status === 'failed') throw new Error(res.error ?? 'art run failed');
    const index = store.loadIndex(process.env.GAME_ART_DIR, res.version);
    const images = Object.values(index?.images ?? {});
    const ui = images.filter((i) => i.category === 'ui').length;
    const s = index?.stats ?? {};
    const problems = [];
    if (images.length < 3000) problems.push(`only ${images.length} images`);
    if (s.failed) problems.push(`${s.failed} bundle(s) failed to extract`);
    if (ui < 10) problems.push(`only ${ui} unit-frame images from client build ${index?.client ?? '(none)'}`);
    return { detail: `${images.length} images (${ui} from the client build) from ${s.bundles} bundles, ${s.failed ?? 0} failed`, problems };
  });

  await step('client', 'Client version', async () => {
    const info = await ensureClientVersion();
    const problems = info.source === 'game' ? [] : [`not read from the build (would send the ${info.source} ${info.version})`];
    return { detail: `${info.version} from build ${info.build ?? '?'}`, problems };
  });

  const failed = results.filter((r) => !r.ok);
  const report = [
    failed.length
      ? `**${failed.length} of ${results.length} readers can't read the live game patch.** Prod keeps serving the previous patch's data for these until a fix ships.`
      : 'Every reader reads the live game patch.',
    '',
    `Live patch: static \`${fp.static.slice(0, 16)}\` · translations \`${fp.translations}\` · catalogue \`${fp.catalog}\` · client build \`${fp.client}\``,
    `Code: \`${process.env.GITHUB_SHA?.slice(0, 7) ?? 'local checkout'}\``,
    '',
    '| Reader | Result | Detail |',
    '|---|---|---|',
    ...results.map((r) => `| ${r.reader} | ${r.ok ? '✓ read' : '✗ **failed**'} | ${r.detail} |`),
    '',
    ...failed.flatMap((r) => [`### ${r.reader}`, '', '```', String(r.error ?? '').slice(0, 4000), '```', '']),
    failed.length ? 'How to fix: docs/game-patches.md. Reproduce with `npm run build && node scripts/game-patch-check.mjs`.' : '',
  ].join('\n');

  console.log(`\n${report}`);
  if (reportFile) fs.writeFileSync(reportFile, report);
  return failed.length ? 1 : 0;
}

const code = await (args.includes('--fingerprint') ? printFingerprint() : check());
process.exitCode = code;
// A logger or throttle timer may hold the loop open; leave once output has
// flushed (an immediate process.exit() right after fetch trips a libuv assert on Windows).
setTimeout(() => process.exit(code), 1000).unref();
