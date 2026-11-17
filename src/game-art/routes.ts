/**
 * Serving the extracted game art.
 *
 *   GET /game-art/<version>/<name>.png   public, immutable for a year
 *   GET /api/game-art                    { version, base, names, categories, mappings }
 *
 * Public on purpose: static files never sit behind auth (Cloudflare caches by
 * extension whatever the origin says — docs/cloudflare-caching.md), and the
 * URL is versioned by the catalogue hash, so a new game version is a new URL.
 * Only the current and previous versions are served; anything not in that
 * version's index is a 404, and both path segments are matched against strict
 * patterns before they touch the file system.
 */
import path from 'path';
import { Router, type Response } from 'express';
import { ART_CATEGORIES, type ArtCategory } from './selection.js';
import { emptyMappings } from './mappings.js';
import { gameArtDir, servedVersions, loadIndex, currentGameArt, VERSION_RE, FILE_RE } from './store.js';

export interface GameArtRouterOptions {
  dir?: string;
}

function notFound(res: Response): void {
  res.status(404).type('text/plain').send('Not found');
}

export function createGameArtRouter(opts: GameArtRouterOptions = {}): Router {
  const router = Router();
  const dirOf = (): string => opts.dir ?? gameArtDir();

  router.get('/game-art/:version/:file', (req, res) => {
    const version = String(req.params.version ?? '');
    const file = String(req.params.file ?? '');
    if (!VERSION_RE.test(version) || !FILE_RE.test(file)) return notFound(res);
    const dir = dirOf();
    if (!servedVersions(dir).has(version)) return notFound(res);
    const img = loadIndex(dir, version)?.images[file.slice(0, -'.png'.length)];
    if (!img || img.file !== file) return notFound(res);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.type('png');
    res.sendFile(path.join(dir, version, file), { dotfiles: 'deny' }, (err) => {
      if (err && !res.headersSent) notFound(res);
    });
  });

  router.get('/api/game-art', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    const index = currentGameArt(dirOf());
    if (!index) {
      res.json({ version: null, base: null, names: [], categories: {}, mappings: emptyMappings() });
      return;
    }
    const categories = Object.fromEntries(ART_CATEGORIES.map((c) => [c, [] as string[]])) as Record<ArtCategory, string[]>;
    for (const [name, img] of Object.entries(index.images)) categories[img.category]?.push(name);
    res.json({
      version: index.version,
      base: `/game-art/${index.version}/`,
      names: Object.keys(index.images),
      categories,
      mappings: index.mappings,
    });
  });

  return router;
}
