"use strict";
/**
 * The game client's asset catalogue: which bundle on the CDN holds which art.
 *
 *   versions.totalbattle.com/config?branch=current&simple=true
 *     .result.unity_catalog_version.webgl  → catalogue hash (= the art version)
 *   assets-unity.totalbattle.dev/webgl/<hash>          → the catalogue (~1.4 MB)
 *   assets-unity.totalbattle.dev/webgl/<bundle hash>   → a UnityFS bundle
 *
 * Catalogue format (little-endian), observed Nov 2026:
 *   4-byte magic "I\x17P.", u32 entry count, then that many entries to the end:
 *     u32 n, n bytes   bundle name
 *     u32              group (0–5; the client's load priority, not the asset type)
 *     16 bytes         content hash (not a URL)
 *     16 bytes         bundle hash — the CDN file name
 *     u32 k, k × (u32 n, n bytes)  addresses: the lower-cased names of the assets inside
 * Almost every bundle holds one asset named like the bundle; atlases such as
 * "flags" or "money_required_tutorial" list each sprite's address.
 *
 * The count is NOT part of the magic: 14384 entries read as "08\0\0", which was
 * taken for a fixed header until the Nov 25 2026 patch (14523 entries) made
 * every catalogue "not a catalogue" — research trees and art updates stopped.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.UNITY_BASE = exports.VERSIONS_URL = void 0;
exports.parseCatalog = parseCatalog;
exports.addressIndex = addressIndex;
exports.nameIndex = nameIndex;
exports.catalogVersionFromConfig = catalogVersionFromConfig;
exports.isBundleHash = isBundleHash;
exports.VERSIONS_URL = 'https://versions.totalbattle.com/config?branch=current&simple=true';
exports.UNITY_BASE = 'https://assets-unity.totalbattle.dev/webgl/';
const MAGIC = Buffer.from([0x49, 0x17, 0x50, 0x2e]);
const HEADER_LENGTH = 8; // magic + u32 entry count
function parseCatalog(buf) {
    if (buf.length < HEADER_LENGTH || !buf.subarray(0, MAGIC.length).equals(MAGIC)) {
        throw new Error('not a catalogue: unexpected header');
    }
    const declared = buf.readUInt32LE(MAGIC.length);
    const entries = [];
    let o = HEADER_LENGTH;
    const need = (n) => {
        if (o + n > buf.length)
            throw new Error(`catalogue truncated at ${o}`);
    };
    const u32 = () => {
        need(4);
        const v = buf.readUInt32LE(o);
        o += 4;
        return v;
    };
    const str = () => {
        const n = u32();
        need(n);
        const s = buf.toString('utf8', o, o + n);
        o += n;
        return s;
    };
    const hash = () => {
        need(16);
        const s = buf.toString('hex', o, o + 16);
        o += 16;
        return s;
    };
    while (o < buf.length) {
        const name = str();
        const group = u32();
        const contentHash = hash();
        const bundle = hash();
        const count = u32();
        if (count > 100_000)
            throw new Error(`catalogue entry ${name} claims ${count} addresses`);
        const addresses = [];
        for (let i = 0; i < count; i++)
            addresses.push(str().toLowerCase());
        entries.push({ name, group, contentHash, bundle, addresses });
    }
    if (entries.length !== declared) {
        throw new Error(`catalogue declares ${declared} entries but holds ${entries.length}`);
    }
    return entries;
}
/** Address → bundle hash. The first bundle listing an address wins. */
function addressIndex(entries) {
    const out = new Map();
    for (const e of entries) {
        for (const a of e.addresses)
            if (!out.has(a))
                out.set(a, e.bundle);
    }
    return out;
}
/**
 * Lower-cased bundle name OR address → bundle hash; the first entry naming it
 * wins. For an asset looked up by its own name — the tech trees' layout
 * TextAssets ("guardtree"), whose bundles are named like the asset.
 */
function nameIndex(entries) {
    const out = new Map();
    for (const e of entries) {
        for (const a of [e.name.toLowerCase(), ...e.addresses])
            if (!out.has(a))
                out.set(a, e.bundle);
    }
    return out;
}
/** The catalogue hash the live game uses, from the versions config. */
function catalogVersionFromConfig(body) {
    const v = body?.result?.unity_catalog_version?.webgl;
    if (typeof v !== 'string' || !/^[0-9a-f]{32}$/.test(v))
        throw new Error('versions config has no webgl catalogue version');
    return v;
}
function isBundleHash(s) {
    return /^[0-9a-f]{32}$/.test(s);
}
//# sourceMappingURL=catalog.js.map