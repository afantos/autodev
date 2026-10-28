import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

/** Operator-owned setting outside releases. Missing settings default off; invalid settings never enable deployment. */
export function autoDeployEnabled(root: string): boolean {
  let raw: string;
  try { raw = readFileSync(join(root, 'deploy/config.json'), 'utf8'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
  const config: unknown = JSON.parse(raw);
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('deployment config must be an object');
  const value = (config as Record<string, unknown>).autoDeployEnabled;
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new Error('autoDeployEnabled must be true or false');
  return value;
}

if (process.argv[1] && realpathSync(process.argv[1]) === import.meta.filename) {
  process.exitCode = autoDeployEnabled(process.argv[2] ?? '/opt/autodev') ? 0 : 3;
}
