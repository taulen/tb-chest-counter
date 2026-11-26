/**
 * When each research tree first showed up in the game's data, as far as this
 * install has seen it — the game's files carry no dates, so this is "since at
 * least": the oldest copy on disk that holds it (bootstrapped once from every
 * cached tech-trees.json and names.json, each dated by its builtAt), then the
 * read that first finds a new one. And whether a tree is LIVE: whether any
 * player (or, for a clan tree, any clan) the site reads has a level in it.
 * Modernization II was in the data from our first copy (Nov 18 2026) and no
 * one of 380 players had started it a week later: paid in Skylands Points.
 *
 * Kept in data/game-static/first-seen.json beside the versions it was read
 * from. See docs/game-protocol.md → "Whose tree it is".
 */
import fs from 'fs';
import path from 'path';
import type { TechTrees } from './tech-trees.js';

export const FIRST_SEEN_FILE = 'first-seen.json';
const FORMAT = 1;

export interface FirstSeen {
  format: number;
  /** Tree id → ISO date the earliest copy holding it was read. */
  trees: Record<string, string>;
  /** Tech id → the same, per research. */
  techs: Record<string, string>;
  /** Tree versions already folded in. */
  versions: string[];
}

function staticDir(): string {
  return process.env.GAME_STATIC_DIR ? path.resolve(process.env.GAME_STATIC_DIR) : path.resolve('data', 'game-static');
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

const earlier = (map: Record<string, string>, id: string, at: string): void => {
  if (!map[id] || at < map[id]) map[id] = at;
};

type TreeFile = { builtAt?: string; trees?: Array<{ id: number; nodes?: Array<{ techId: number }>; unplaced?: Array<{ techId: number }> }> };

/** Fold one copy of the trees in, dated `at`. */
function foldTrees(seen: FirstSeen, trees: TreeFile['trees'], at: string): void {
  for (const t of trees ?? []) {
    earlier(seen.trees, String(t.id), at);
    for (const n of [...(t.nodes ?? []), ...(t.unplaced ?? [])]) earlier(seen.techs, String(n.techId), at);
  }
}

/** Every copy on disk, oldest first: what the first run back-fills from. */
function bootstrap(dir: string): FirstSeen {
  const seen: FirstSeen = { format: FORMAT, trees: {}, techs: {}, versions: [] };
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return seen;
  }
  for (const key of entries) {
    const trees = readJson<TreeFile>(path.join(dir, key, 'tech-trees.json'));
    if (trees?.builtAt) foldTrees(seen, trees.trees, trees.builtAt);
    // names.json lists every tech, in a tree or not: dates research older copies of the trees didn't keep.
    const names = readJson<{ builtAt?: string; techs?: Record<string, unknown> }>(path.join(dir, key, 'names.json'));
    if (names?.builtAt) for (const id of Object.keys(names.techs ?? {})) earlier(seen.techs, id, names.builtAt);
  }
  return seen;
}

/**
 * First-seen dates for the trees being served: the file's, with anything
 * these trees hold that it hasn't seen dated now. Written when it changes.
 */
export function firstSeenFor(trees: TechTrees, dir: string = staticDir(), now: () => Date = () => new Date()): FirstSeen {
  const file = path.join(dir, FIRST_SEEN_FILE);
  const stored = readJson<FirstSeen>(file);
  const seen = stored && stored.format === FORMAT ? stored : bootstrap(dir);
  if (!seen.versions.includes(trees.version)) {
    foldTrees(seen, trees.trees, trees.builtAt && trees.builtAt < now().toISOString() ? trees.builtAt : now().toISOString());
    seen.versions = [...seen.versions, trees.version].slice(-50);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(seen));
      fs.renameSync(tmp, file);
    } catch {
      // Not written: recomputed next time, nothing lost.
    }
  }
  return seen;
}
