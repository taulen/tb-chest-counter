"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FIRST_SEEN_FILE = void 0;
exports.firstSeenFor = firstSeenFor;
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
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
exports.FIRST_SEEN_FILE = 'first-seen.json';
const FORMAT = 1;
function staticDir() {
    return process.env.GAME_STATIC_DIR ? path_1.default.resolve(process.env.GAME_STATIC_DIR) : path_1.default.resolve('data', 'game-static');
}
function readJson(file) {
    try {
        return JSON.parse(fs_1.default.readFileSync(file, 'utf8'));
    }
    catch {
        return null;
    }
}
const earlier = (map, id, at) => {
    if (!map[id] || at < map[id])
        map[id] = at;
};
/** Fold one copy of the trees in, dated `at`. */
function foldTrees(seen, trees, at) {
    for (const t of trees ?? []) {
        earlier(seen.trees, String(t.id), at);
        for (const n of [...(t.nodes ?? []), ...(t.unplaced ?? [])])
            earlier(seen.techs, String(n.techId), at);
    }
}
/** Every copy on disk, oldest first: what the first run back-fills from. */
function bootstrap(dir) {
    const seen = { format: FORMAT, trees: {}, techs: {}, versions: [] };
    let entries = [];
    try {
        entries = fs_1.default.readdirSync(dir);
    }
    catch {
        return seen;
    }
    for (const key of entries) {
        const trees = readJson(path_1.default.join(dir, key, 'tech-trees.json'));
        if (trees?.builtAt)
            foldTrees(seen, trees.trees, trees.builtAt);
        // names.json lists every tech, in a tree or not: dates research older copies of the trees didn't keep.
        const names = readJson(path_1.default.join(dir, key, 'names.json'));
        if (names?.builtAt)
            for (const id of Object.keys(names.techs ?? {}))
                earlier(seen.techs, id, names.builtAt);
    }
    return seen;
}
/**
 * First-seen dates for the trees being served: the file's, with anything
 * these trees hold that it hasn't seen dated now. Written when it changes.
 */
function firstSeenFor(trees, dir = staticDir(), now = () => new Date()) {
    const file = path_1.default.join(dir, exports.FIRST_SEEN_FILE);
    const stored = readJson(file);
    const seen = stored && stored.format === FORMAT ? stored : bootstrap(dir);
    if (!seen.versions.includes(trees.version)) {
        foldTrees(seen, trees.trees, trees.builtAt && trees.builtAt < now().toISOString() ? trees.builtAt : now().toISOString());
        seen.versions = [...seen.versions, trees.version].slice(-50);
        try {
            fs_1.default.mkdirSync(dir, { recursive: true });
            const tmp = `${file}.${process.pid}.tmp`;
            fs_1.default.writeFileSync(tmp, JSON.stringify(seen));
            fs_1.default.renameSync(tmp, file);
        }
        catch {
            // Not written: recomputed next time, nothing lost.
        }
    }
    return seen;
}
//# sourceMappingURL=tech-first-seen.js.map