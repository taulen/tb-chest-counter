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

export const VERSIONS_URL = 'https://versions.totalbattle.com/config?branch=current&simple=true';
export const UNITY_BASE = 'https://assets-unity.totalbattle.dev/webgl/';

const MAGIC = Buffer.from([0x49, 0x17, 0x50, 0x2e]);
const HEADER_LENGTH = 8; // magic + u32 entry count

export interface CatalogEntry {
  name: string;
  group: number;
  contentHash: string;
  /** 32 hex characters; the bundle's file name on the CDN. */
  bundle: string;
  /** Lower-cased asset addresses inside the bundle. */
  addresses: string[];
}

export function parseCatalog(buf: Buffer): CatalogEntry[] {
  if (buf.length < HEADER_LENGTH || !buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('not a catalogue: unexpected header');
  }
  const declared = buf.readUInt32LE(MAGIC.length);
  const entries: CatalogEntry[] = [];
  let o = HEADER_LENGTH;
  const need = (n: number): void => {
    if (o + n > buf.length) throw new Error(`catalogue truncated at ${o}`);
  };
  const u32 = (): number => {
    need(4);
    const v = buf.readUInt32LE(o);
    o += 4;
    return v;
  };
  const str = (): string => {
    const n = u32();
    need(n);
    const s = buf.toString('utf8', o, o + n);
    o += n;
    return s;
  };
  const hash = (): string => {
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
    if (count > 100_000) throw new Error(`catalogue entry ${name} claims ${count} addresses`);
    const addresses: string[] = [];
    for (let i = 0; i < count; i++) addresses.push(str().toLowerCase());
    entries.push({ name, group, contentHash, bundle, addresses });
  }
  if (entries.length !== declared) {
    throw new Error(`catalogue declares ${declared} entries but holds ${entries.length}`);
  }
  return entries;
}

/** Address → bundle hash. The first bundle listing an address wins. */
export function addressIndex(entries: CatalogEntry[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of entries) {
    for (const a of e.addresses) if (!out.has(a)) out.set(a, e.bundle);
  }
  return out;
}

/**
 * Lower-cased bundle name OR address → bundle hash; the first entry naming it
 * wins. For an asset looked up by its own name — the tech trees' layout
 * TextAssets ("guardtree"), whose bundles are named like the asset.
 */
export function nameIndex(entries: CatalogEntry[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of entries) {
    for (const a of [e.name.toLowerCase(), ...e.addresses]) if (!out.has(a)) out.set(a, e.bundle);
  }
  return out;
}

/** The catalogue hash the live game uses, from the versions config. */
export function catalogVersionFromConfig(body: unknown): string {
  const v = (body as { result?: { unity_catalog_version?: { webgl?: unknown } } })?.result?.unity_catalog_version?.webgl;
  if (typeof v !== 'string' || !/^[0-9a-f]{32}$/.test(v)) throw new Error('versions config has no webgl catalogue version');
  return v;
}

export function isBundleHash(s: string): boolean {
  return /^[0-9a-f]{32}$/.test(s);
}
