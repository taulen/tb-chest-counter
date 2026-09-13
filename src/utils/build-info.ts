import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

/**
 * Build identity baked into the image at Docker build time. The
 * Dockerfile writes two files alongside the runtime:
 *
 *   /app/BUILD_TIME         ISO-8601 timestamp of when `docker build` ran
 *   /app/BUILD_FINGERPRINT  7-char sha256 prefix of dist/index.js
 *
 * Together these answer "did the running container actually pick up
 * the latest commit?" without depending on the build context having
 * .git available — Portainer's stack-from-git deploys don't ship .git,
 * so a true commit SHA isn't available at build time. Time +
 * fingerprint are enough: if the timestamp is fresh, the image was
 * rebuilt; if the fingerprint matches `sha256sum dist/index.js |
 * cut -c1-7` of the operator's local checkout, the rebuilt image
 * contains the operator's specific code.
 *
 * Resolution order at startup:
 *   1. Read /app/BUILD_TIME and /app/BUILD_FINGERPRINT (production / Docker).
 *   2. Read project-root copies (`node dist/index.js` outside Docker).
 *   3. Compute on the fly from the runtime dist file (dev / `npm start`).
 *   4. Final fallback: now() and 'unknown'.
 *
 * Captured exactly once when this module first loads. The result is a
 * frozen object so callers can hand it directly to JSON.stringify.
 */

interface BuildInfo {
  /** ISO-8601 build timestamp (or container start time as fallback). */
  builtAt: string;
  /** 7-char prefix of the compiled server entry point's sha256 — a stable
   *  identity for this build. Different commits that touch server code
   *  produce different fingerprints. */
  fingerprint: string;
}

function readFileTrim(filepath: string): string | null {
  try {
    const raw = fs.readFileSync(filepath, 'utf8').trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Walk a directory recursively and return all file paths matching the
 * given extensions. Used by the dev-fallback fingerprint to mirror the
 * Dockerfile's `find ... | sort` step.
 */
function collectFiles(rootDir: string, exts: Set<string>): string[] {
  const out: string[] = [];
  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && exts.has(path.extname(entry.name))) {
        out.push(full);
      }
    }
  }
  walk(rootDir);
  return out.sort();
}

function fingerprintOfDistAndPublic(): string | null {
  // Dev fallback: hash the same set of files the Dockerfile hashes,
  // in the same sorted order, so dev runs report the same fingerprint
  // a docker build would compute for the same source.
  const exts = new Set(['.js', '.json', '.html', '.css']);
  const roots = [
    { container: '/app/dist', dev: path.resolve('dist') },
    { container: '/app/src/web/public', dev: path.resolve('src/web/public') },
  ];

  const files: string[] = [];
  for (const { container, dev } of roots) {
    if (fs.existsSync(container)) {
      files.push(...collectFiles(container, exts));
    } else if (fs.existsSync(dev)) {
      files.push(...collectFiles(dev, exts));
    }
  }
  if (files.length === 0) return null;

  // Same digest scheme as the Dockerfile: hash each file, hash the
  // newline-joined list of "<sha>  <path>" lines.
  const lines: string[] = [];
  for (const file of files) {
    try {
      const buf = fs.readFileSync(file);
      const sha = crypto.createHash('sha256').update(buf).digest('hex');
      // Strip the absolute prefix so dev and container compute the
      // same hash for the same logical path.
      const rel = file.startsWith('/app/') ? file.slice('/app/'.length) : path.relative(process.cwd(), file).replace(/\\/g, '/');
      lines.push(`${sha}  ${rel}`);
    } catch {
      return null;
    }
  }
  return crypto.createHash('sha256').update(lines.join('\n') + '\n').digest('hex').slice(0, 7);
}

function resolveBuildInfo(): BuildInfo {
  const builtAt =
    readFileTrim('/app/BUILD_TIME')
    ?? readFileTrim(path.resolve('BUILD_TIME'))
    ?? new Date().toISOString();

  const fingerprint =
    readFileTrim('/app/BUILD_FINGERPRINT')
    ?? readFileTrim(path.resolve('BUILD_FINGERPRINT'))
    ?? fingerprintOfDistAndPublic()
    ?? 'unknown';

  return Object.freeze({ builtAt, fingerprint });
}

export const BUILD_INFO: BuildInfo = resolveBuildInfo();
