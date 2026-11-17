/**
 * Clan logos, drawn the way the game draws them (My Clan → Information).
 *
 * A clan's logo is one number — the clan record's f1[2], also f1 of every
 * clan in a 15200 reply — packing three layer ids, one byte each:
 *
 *     code = background << 16 | frame << 8 | emblem
 *
 *   CWB 1118480 = 0x11_11_10 → background 17, frame 17, emblem 16 (the axe);
 *   SIK  660741 = 0x0A_15_05 → background 10, frame 21, emblem 5;
 *   SIN 2168077 = 0x21_15_0D → background 33, frame 21, emblem 13.
 *
 * The client config `clan/logo` gives the ranges: numBacks 49, numFrames 37,
 * numElblems [sic] 37 (the last seven of each are NPC clans'). Each id is a
 * sprite of its own in the game's bundles, small and large ("_lg", 87 px):
 *
 *   clan_background_<b>  the coloured field, a full square;
 *   clan_mask_<f>        the frame's opening — only its alpha is used, to cut
 *                        the background to the frame's shape;
 *   clan_frame_<f>       the frame;
 *   clan_emblem_<e>      the emblem, centred on top.
 *
 * Composed bottom to top: background (cut by the mask), frame, emblem — every
 * layer centred on the frame's square. The result is a PNG cached next to the
 * extracted art (<art dir>/<version>/clan-logos/<code>.png), so it is only
 * built once per art version, and served public and immutable like the rest
 * (docs/cloudflare-caching.md): GET /game-art/<version>/clan-logo/<code>.png.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import sharp from 'sharp';
import { Router, type Response } from 'express';
import { childLogger } from '../utils/logger.js';
import { currentGameArt, gameArtDir, loadIndex, servedVersions, VERSION_RE, type GameArtIndex } from './store.js';

const log = childLogger('game-art');

export interface ClanLogoParts {
  background: number;
  frame: number;
  emblem: number;
}

/** The three layer ids of a logo code, or null when it isn't one. */
export function decodeClanLogo(code: number | null | undefined): ClanLogoParts | null {
  if (typeof code !== 'number' || !Number.isInteger(code) || code <= 0 || code > 0xffffff) return null;
  const parts = { background: (code >> 16) & 0xff, frame: (code >> 8) & 0xff, emblem: code & 0xff };
  return parts.background && parts.frame && parts.emblem ? parts : null;
}

/** The large sprites a logo is drawn from (art index names). */
export function clanLogoLayers(p: ClanLogoParts): { background: string; mask: string; frame: string; emblem: string } {
  return {
    background: `clan_background_${p.background}_lg`,
    mask: `clan_mask_${p.frame}_lg`,
    frame: `clan_frame_${p.frame}_lg`,
    emblem: `clan_emblem_${p.emblem}_lg`,
  };
}

/** The layer files of a code in an art index — all four, or null. */
function layerFiles(index: GameArtIndex, code: number): { background: string; mask: string; frame: string; emblem: string } | null {
  const p = decodeClanLogo(code);
  if (!p) return null;
  const names = clanLogoLayers(p);
  const files = {
    background: index.images[names.background]?.file,
    mask: index.images[names.mask]?.file,
    frame: index.images[names.frame]?.file,
    emblem: index.images[names.emblem]?.file,
  };
  return files.background && files.mask && files.frame && files.emblem ? (files as Record<keyof typeof files, string>) : null;
}

/**
 * Compose a logo from its four layer PNGs: the background cut to the mask's
 * shape, the frame over it, the emblem on top — each centred on a square as
 * large as the biggest layer.
 */
export async function composeClanLogo(layers: { background: Buffer; mask: Buffer; frame: Buffer; emblem: Buffer }): Promise<Buffer> {
  const metas = await Promise.all([layers.background, layers.mask, layers.frame, layers.emblem].map((b) => sharp(b).metadata()));
  const size = Math.max(...metas.flatMap((m) => [m.width ?? 0, m.height ?? 0]));
  const centre = async (buf: Buffer): Promise<Buffer> => {
    const m = await sharp(buf).metadata();
    const dx = size - (m.width ?? 0);
    const dy = size - (m.height ?? 0);
    return sharp(buf).ensureAlpha()
      .extend({ left: Math.floor(dx / 2), right: Math.ceil(dx / 2), top: Math.floor(dy / 2), bottom: Math.ceil(dy / 2), background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png().toBuffer();
  };
  const [background, mask, frame, emblem] = await Promise.all([layers.background, layers.mask, layers.frame, layers.emblem].map(centre));
  // dest-in keeps the background only where the mask is opaque; a full-size
  // mask, so nothing outside it survives either.
  const field = await sharp(background).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
  return sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: field }, { input: frame }, { input: emblem }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

const LOGO_DIR = 'clan-logos';
const CODE_FILE_RE = /^(\d{1,8})\.png$/;

/** URL of a clan's logo in the current art version, or null when the art has no such logo (yet). */
export function clanLogoUrl(code: number | null | undefined, dir: string = gameArtDir()): string | null {
  const index = currentGameArt(dir);
  if (!index || typeof code !== 'number' || !layerFiles(index, code)) return null;
  return `/game-art/${index.version}/clan-logo/${code}.png`;
}

const building = new Map<string, Promise<string | null>>();

/** The logo's PNG for a served art version, composed and cached on first use; null when it can't be. */
export function clanLogoFile(dir: string, version: string, code: number): Promise<string | null> {
  const file = path.join(dir, version, LOGO_DIR, `${code}.png`);
  if (fs.existsSync(file)) return Promise.resolve(file);
  const pending = building.get(file);
  if (pending) return pending;
  const job = (async (): Promise<string | null> => {
    const index = loadIndex(dir, version);
    const files = index ? layerFiles(index, code) : null;
    if (!files) return null;
    const read = (f: string) => fs.readFileSync(path.join(dir, version, f));
    const png = await composeClanLogo({ background: read(files.background), mask: read(files.mask), frame: read(files.frame), emblem: read(files.emblem) });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, png);
    fs.renameSync(tmp, file);
    return file;
  })()
    .catch((err: unknown) => {
      log.warn({ noAlert: true }, `Clan logo ${code} (${version}) could not be composed: ${String(err)}`);
      return null;
    })
    .finally(() => building.delete(file));
  building.set(file, job);
  return job;
}

function notFound(res: Response): void {
  res.status(404).type('text/plain').send('Not found');
}

/** GET /game-art/<version>/clan-logo/<code>.png — public, immutable (the art version is in the path). */
export function createClanLogoRouter(opts: { dir?: string } = {}): Router {
  const router = Router();
  router.get('/game-art/:version/clan-logo/:file', async (req, res) => {
    const version = String(req.params.version ?? '');
    const m = CODE_FILE_RE.exec(String(req.params.file ?? ''));
    const code = m ? Number(m[1]) : NaN;
    if (!VERSION_RE.test(version) || !decodeClanLogo(code)) return notFound(res);
    const dir = opts.dir ?? gameArtDir();
    if (!servedVersions(dir).has(version)) return notFound(res);
    const file = await clanLogoFile(dir, version, code);
    if (!file) return notFound(res);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.type('png');
    res.sendFile(file, { dotfiles: 'deny' }, (err) => {
      if (err && !res.headersSent) notFound(res);
    });
  });
  return router;
}
