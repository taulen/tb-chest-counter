/**
 * The game client's asset catalogue: which bundle on the CDN holds which art.
 *
 *   versions.totalbattle.com/config?branch=current&simple=true
 *     .result.unity_catalog_version.webgl  → catalogue hash (= the art version)
 *   assets-unity.totalbattle.dev/webgl/<hash>          → the catalogue (~1.4 MB)
 *   assets-unity.totalbattle.dev/webgl/<bundle hash>   → a UnityFS bundle
 *
 * Catalogue format (little-endian), observed Nov 2026:
 *   8-byte header "I\x17P.08\0\0", then one entry per bundle to the end:
 *     u32 n, n bytes   bundle name
 *     u32              group (0–5; the client's load priority, not the asset type)
 *     16 bytes         content hash (not a URL)
 *     16 bytes         bundle hash — the CDN file name
 *     u32 k, k × (u32 n, n bytes)  addresses: the lower-cased names of the assets inside
 * Almost every bundle holds one asset named like the bundle; atlases such as
 * "flags" or "money_required_tutorial" list each sprite's address.
 */

export const VERSIONS_URL = 'https://versions.totalbattle.com/config?branch=current&simple=true';
export const UNITY_BASE = 'https://assets-unity.totalbattle.dev/webgl/';

const HEADER = Buffer.from([0x49, 0x17, 0x50, 0x2e, 0x30, 0x38, 0x00, 0x00]);

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
  if (buf.length < HEADER.length || !buf.subarray(0, HEADER.length).equals(HEADER)) {
    throw new Error('not a catalogue: unexpected header');
  }
  const entries: CatalogEntry[] = [];
  let o = HEADER.length;
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

/** The catalogue hash the live game uses, from the versions config. */
export function catalogVersionFromConfig(body: unknown): string {
  const v = (body as { result?: { unity_catalog_version?: { webgl?: unknown } } })?.result?.unity_catalog_version?.webgl;
  if (typeof v !== 'string' || !/^[0-9a-f]{32}$/.test(v)) throw new Error('versions config has no webgl catalogue version');
  return v;
}

export function isBundleHash(s: string): boolean {
  return /^[0-9a-f]{32}$/.test(s);
}
