"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.decodeClanLogo = decodeClanLogo;
exports.clanLogoLayers = clanLogoLayers;
exports.composeClanLogo = composeClanLogo;
exports.clanLogoUrl = clanLogoUrl;
exports.clanLogoFile = clanLogoFile;
exports.createClanLogoRouter = createClanLogoRouter;
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
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const crypto_1 = __importDefault(require("crypto"));
const sharp_1 = __importDefault(require("sharp"));
const express_1 = require("express");
const logger_js_1 = require("../utils/logger.js");
const store_js_1 = require("./store.js");
const log = (0, logger_js_1.childLogger)('game-art');
/** The three layer ids of a logo code, or null when it isn't one. */
function decodeClanLogo(code) {
    if (typeof code !== 'number' || !Number.isInteger(code) || code <= 0 || code > 0xffffff)
        return null;
    const parts = { background: (code >> 16) & 0xff, frame: (code >> 8) & 0xff, emblem: code & 0xff };
    return parts.background && parts.frame && parts.emblem ? parts : null;
}
/** The large sprites a logo is drawn from (art index names). */
function clanLogoLayers(p) {
    return {
        background: `clan_background_${p.background}_lg`,
        mask: `clan_mask_${p.frame}_lg`,
        frame: `clan_frame_${p.frame}_lg`,
        emblem: `clan_emblem_${p.emblem}_lg`,
    };
}
/** The layer files of a code in an art index — all four, or null. */
function layerFiles(index, code) {
    const p = decodeClanLogo(code);
    if (!p)
        return null;
    const names = clanLogoLayers(p);
    const files = {
        background: index.images[names.background]?.file,
        mask: index.images[names.mask]?.file,
        frame: index.images[names.frame]?.file,
        emblem: index.images[names.emblem]?.file,
    };
    return files.background && files.mask && files.frame && files.emblem ? files : null;
}
/**
 * Compose a logo from its four layer PNGs: the background cut to the mask's
 * shape, the frame over it, the emblem on top — each centred on a square as
 * large as the biggest layer.
 */
async function composeClanLogo(layers) {
    const metas = await Promise.all([layers.background, layers.mask, layers.frame, layers.emblem].map((b) => (0, sharp_1.default)(b).metadata()));
    const size = Math.max(...metas.flatMap((m) => [m.width ?? 0, m.height ?? 0]));
    const centre = async (buf) => {
        const m = await (0, sharp_1.default)(buf).metadata();
        const dx = size - (m.width ?? 0);
        const dy = size - (m.height ?? 0);
        return (0, sharp_1.default)(buf).ensureAlpha()
            .extend({ left: Math.floor(dx / 2), right: Math.ceil(dx / 2), top: Math.floor(dy / 2), bottom: Math.ceil(dy / 2), background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .png().toBuffer();
    };
    const [background, mask, frame, emblem] = await Promise.all([layers.background, layers.mask, layers.frame, layers.emblem].map(centre));
    // dest-in keeps the background only where the mask is opaque; a full-size
    // mask, so nothing outside it survives either.
    const field = await (0, sharp_1.default)(background).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
    return (0, sharp_1.default)({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
        .composite([{ input: field }, { input: frame }, { input: emblem }])
        .png({ compressionLevel: 9 })
        .toBuffer();
}
const LOGO_DIR = 'clan-logos';
const CODE_FILE_RE = /^(\d{1,8})\.png$/;
/** URL of a clan's logo in the current art version, or null when the art has no such logo (yet). */
function clanLogoUrl(code, dir = (0, store_js_1.gameArtDir)()) {
    const index = (0, store_js_1.currentGameArt)(dir);
    if (!index || typeof code !== 'number' || !layerFiles(index, code))
        return null;
    return `/game-art/${index.version}/clan-logo/${code}.png`;
}
const building = new Map();
/** The logo's PNG for a served art version, composed and cached on first use; null when it can't be. */
function clanLogoFile(dir, version, code) {
    const file = path_1.default.join(dir, version, LOGO_DIR, `${code}.png`);
    if (fs_1.default.existsSync(file))
        return Promise.resolve(file);
    const pending = building.get(file);
    if (pending)
        return pending;
    const job = (async () => {
        const index = (0, store_js_1.loadIndex)(dir, version);
        const files = index ? layerFiles(index, code) : null;
        if (!files)
            return null;
        const read = (f) => fs_1.default.readFileSync(path_1.default.join(dir, version, f));
        const png = await composeClanLogo({ background: read(files.background), mask: read(files.mask), frame: read(files.frame), emblem: read(files.emblem) });
        fs_1.default.mkdirSync(path_1.default.dirname(file), { recursive: true });
        const tmp = `${file}.${crypto_1.default.randomBytes(4).toString('hex')}.tmp`;
        fs_1.default.writeFileSync(tmp, png);
        fs_1.default.renameSync(tmp, file);
        return file;
    })()
        .catch((err) => {
        log.warn({ noAlert: true }, `Clan logo ${code} (${version}) could not be composed: ${String(err)}`);
        return null;
    })
        .finally(() => building.delete(file));
    building.set(file, job);
    return job;
}
function notFound(res) {
    res.status(404).type('text/plain').send('Not found');
}
/** GET /game-art/<version>/clan-logo/<code>.png — public, immutable (the art version is in the path). */
function createClanLogoRouter(opts = {}) {
    const router = (0, express_1.Router)();
    router.get('/game-art/:version/clan-logo/:file', async (req, res) => {
        const version = String(req.params.version ?? '');
        const m = CODE_FILE_RE.exec(String(req.params.file ?? ''));
        const code = m ? Number(m[1]) : NaN;
        if (!store_js_1.VERSION_RE.test(version) || !decodeClanLogo(code))
            return notFound(res);
        const dir = opts.dir ?? (0, store_js_1.gameArtDir)();
        if (!(0, store_js_1.servedVersions)(dir).has(version))
            return notFound(res);
        const file = await clanLogoFile(dir, version, code);
        if (!file)
            return notFound(res);
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.type('png');
        res.sendFile(file, { dotfiles: 'deny' }, (err) => {
            if (err && !res.headersSent)
                notFound(res);
        });
    });
    return router;
}
//# sourceMappingURL=clan-logo.js.map