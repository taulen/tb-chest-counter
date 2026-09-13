import path from 'path';
import fs from 'fs';
import { getIconTemplate } from '../data/repositories/resource-repo.js';

/** Path to a shipped default icon PNG, named by resource slug. */
export function defaultIconPath(slug: string): string {
  // __dirname is dist/utils/ at runtime, so ../.. reaches the repo root.
  return path.resolve(__dirname, '..', '..', 'assets', 'resource-icons', `${slug}.png`);
}

/**
 * Load the reference icon template for a given resource type.
 * Resolution order:
 *   1. Per-clan override stored in DB as a BLOB.
 *   2. Shipped default PNG from data/resource-icons/<slug>.png.
 *   3. null — type not yet calibrated.
 */
export async function loadIconTemplate(
  clanId: number,
  resourceTypeId: number,
  slug: string,
): Promise<Buffer | null> {
  const dbBlob = getIconTemplate(clanId, resourceTypeId);
  if (dbBlob) return dbBlob;

  const filePath = defaultIconPath(slug);
  try {
    return fs.readFileSync(filePath);
  } catch {
    return null;
  }
}
