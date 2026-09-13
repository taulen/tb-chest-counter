import fs from 'fs';
import path from 'path';

/**
 * Resolve the persistent env file path. APP_CONFIG_PATH overrides; otherwise
 * defaults to data/app.env on the mounted volume.
 */
export function getPersistentEnvPath(): string {
  const configured = process.env.APP_CONFIG_PATH?.trim();
  return configured ? path.resolve(configured) : path.resolve('data', 'app.env');
}

/**
 * Read a value from the persistent env file. Returns null if the file
 * doesn't exist or the key isn't present.
 */
export function readEnvValue(key: string): string | null {
  const envPath = getPersistentEnvPath();
  if (!fs.existsSync(envPath)) return null;

  const content = fs.readFileSync(envPath, 'utf8');
  const regex = new RegExp(`^${key}=(.*)$`, 'm');
  const match = content.match(regex);
  return match ? match[1] : null;
}

/**
 * Write or update a key=value pair in the persistent env file. Creates the
 * file if it doesn't exist. Survives container redeploys because the file
 * lives on the mounted data volume.
 */
export function updateEnvValue(key: string, value: string): void {
  const envPath = getPersistentEnvPath();
  const line = `${key}=${value}`;

  if (!fs.existsSync(envPath)) {
    const dir = path.dirname(envPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(envPath, `${line}\n`);
    return;
  }

  const content = fs.readFileSync(envPath, 'utf8');
  const regex = new RegExp(`^${key}=.*$`, 'm');
  if (regex.test(content)) {
    fs.writeFileSync(envPath, content.replace(regex, line));
    return;
  }

  const suffix = content.endsWith('\n') ? '' : '\n';
  fs.writeFileSync(envPath, `${content}${suffix}${line}\n`);
}

/**
 * Remove a key from the persistent env file (no-op if missing).
 */
export function deleteEnvValue(key: string): void {
  const envPath = getPersistentEnvPath();
  if (!fs.existsSync(envPath)) return;

  const content = fs.readFileSync(envPath, 'utf8');
  const regex = new RegExp(`^${key}=.*$\\n?`, 'm');
  if (regex.test(content)) {
    fs.writeFileSync(envPath, content.replace(regex, ''));
  }
}
