import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { run } from './exec.ts';
import type { ExecResult } from './exec.ts';

/**
 * Automatic priming of a project's offline npm cache (npmCacheDir) when a candidate's lockfile adds packages.
 *
 * The validation sandbox installs with `npm ci --offline`, so a ticket that adds dependencies fails setup until the
 * operator primes the cache. With `npmCachePrime: true`, the orchestrator does that itself, under these rules:
 *  - only package.json and package-lock.json files are copied into a scratch directory; nothing else from the worktree
 *    (no .npmrc, no scripts, no git metadata) reaches npm;
 *  - every lockfile entry must be a registry tarball from https://registry.npmjs.org/ with an `integrity` field
 *    (git+, file:, link:, http:, other registries, workspace entries outside the repo → refused);
 *  - every package new to the candidate (not in the base lockfile) must be reachable through dependency edges from a
 *    package that is already in the base lockfile or in the project's approvedDependencies; anything else → refused;
 *  - the number of new packages is bounded, the run has a timeout, and npm runs with `--ignore-scripts`, an empty
 *    HOME, `--userconfig /dev/null --globalconfig /dev/null`, an explicit registry and an environment of PATH only.
 * A refusal never primes anything; the caller reports it as the setup failure it already had.
 */

export const REGISTRY = 'https://registry.npmjs.org/';

export interface LockfilePackage { version?: string; resolved?: string; integrity?: string; link?: boolean; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string>; devDependencies?: Record<string, string>; workspaces?: string[] }
export interface Lockfile { lockfileVersion?: number; packages?: Record<string, LockfilePackage> }

export type PrimePlan = { ok: true; newPackages: string[]; totalPackages: number } | { ok: false; reason: string };

/** Package name from a lockfile `packages` key such as `node_modules/@scope/name` or `apps/web/node_modules/foo`. */
export function packageName(key: string): string | null {
  const i = key.lastIndexOf('node_modules/');
  if (i < 0) return null;
  return key.slice(i + 'node_modules/'.length);
}

/** Does `candidate` (a lockfile v2/v3 JSON string) qualify for priming, given the base lockfile and the approved names? */
export function planPrime(candidate: string, base: string | null, approved: readonly string[], maxNewPackages: number): PrimePlan {
  let lock: Lockfile;
  try { lock = JSON.parse(candidate) as Lockfile; } catch { return { ok: false, reason: 'package-lock.json is not valid JSON' }; }
  if (!lock.packages || typeof lock.packages !== 'object') return { ok: false, reason: 'package-lock.json has no "packages" map (lockfile v1 is not supported)' };
  let baseNames = new Set<string>();
  if (base) {
    try {
      const b = JSON.parse(base) as Lockfile;
      for (const key of Object.keys(b.packages ?? {})) { const n = packageName(key); if (n) baseNames.add(n); }
    } catch { baseNames = new Set(); }
  }
  // Workspace entries (keys without node_modules/) are the repo's own packages: they must stay inside the repo.
  const entries: Array<{ key: string; name: string; pkg: LockfilePackage }> = [];
  for (const [key, pkg] of Object.entries(lock.packages)) {
    if (key === '') continue;
    const name = packageName(key);
    if (!name) {
      if (key.startsWith('..') || key.startsWith('/') || key.includes('/../')) return { ok: false, reason: `workspace entry "${key}" points outside the repository` };
      if (pkg.resolved || pkg.link) return { ok: false, reason: `workspace entry "${key}" is a link or has a resolved URL` };
      continue;
    }
    if (pkg.link) return { ok: false, reason: `"${name}" is a link, not a registry package` };
    if (!pkg.resolved) {
      // A workspace symlink inside node_modules (e.g. node_modules/@lwc/core → packages/core) has no resolved URL.
      if (isWorkspaceAlias(lock, key)) continue;
      return { ok: false, reason: `"${name}" has no resolved URL` };
    }
    const resolved = String(pkg.resolved);
    if (!resolved.startsWith(REGISTRY)) return { ok: false, reason: `"${name}" resolves outside the registry: ${resolved.slice(0, 120)}` };
    if (!/^https:\/\/registry\.npmjs\.org\/[^\s?#]+\.tgz$/.test(resolved)) return { ok: false, reason: `"${name}" is not a registry tarball: ${resolved.slice(0, 120)}` };
    if (!pkg.integrity || !/^sha(256|384|512)-[A-Za-z0-9+/=]+$/.test(pkg.integrity)) return { ok: false, reason: `"${name}" has no usable integrity hash` };
    entries.push({ key, name, pkg });
  }
  const names = new Set(entries.map((e) => e.name));
  const newNames = [...names].filter((n) => !baseNames.has(n));
  if (!newNames.length) return { ok: true, newPackages: [], totalPackages: entries.length };
  if (newNames.length > maxNewPackages) return { ok: false, reason: `${newNames.length} new packages exceed the limit of ${maxNewPackages}` };
  // Reachability: start from every package already in the base lockfile or explicitly approved, follow dependency edges.
  const edges = new Map<string, Set<string>>();
  for (const { name, pkg } of entries) {
    const set = edges.get(name) ?? new Set<string>();
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) for (const dep of Object.keys(pkg[field] ?? {})) set.add(dep);
    edges.set(name, set);
  }
  // Root and workspace manifests declare direct dependencies; those are reachable only if approved or already present.
  const reachable = new Set<string>([...names].filter((n) => baseNames.has(n) || approved.includes(n)));
  const queue = [...reachable];
  while (queue.length) {
    const n = queue.shift()!;
    for (const dep of edges.get(n) ?? []) if (names.has(dep) && !reachable.has(dep)) { reachable.add(dep); queue.push(dep); }
  }
  const unreachable = newNames.filter((n) => !reachable.has(n));
  if (unreachable.length) return { ok: false, reason: `new packages are neither approved nor dependencies of approved/existing ones: ${unreachable.slice(0, 10).join(', ')}${unreachable.length > 10 ? ', …' : ''}` };
  return { ok: true, newPackages: newNames, totalPackages: entries.length };
}

function isWorkspaceAlias(lock: Lockfile, key: string): boolean {
  // npm writes workspace packages twice: the real path ("packages/core") and a link under node_modules with `link: true`.
  // Some npm versions omit `link` and `resolved` on the alias; accept it only if a workspace entry with the same name exists.
  const name = packageName(key);
  return Object.entries(lock.packages ?? {}).some(([k, p]) => !k.includes('node_modules/') && k !== '' && (p as { name?: string }).name === name);
}

/** The npm offline-miss signatures that mean "the cache lacks this lockfile's packages" (and nothing else is wrong). */
export function looksLikeOfflineMiss(output: string): boolean {
  return /ENOTCACHED|only-if-cached|no cached response|cache mode is 'only-if-cached'/i.test(output);
}

export interface PrimeRequest {
  worktree: string;
  cacheDir: string;
  timeoutMs: number;
  /** Test seam: the command runner (defaults to exec.run). */
  exec?: typeof run;
}
export type PrimeOutcome = { ok: true; bytesAdded: number; durationMs: number; command: string[] } | { ok: false; reason: string; command?: string[] };

/** Copy only manifests out of the worktree and run one online `npm ci` against the cache directory. */
export async function primeNpmCache(req: PrimeRequest): Promise<PrimeOutcome> {
  const exec = req.exec ?? run;
  const scratch = mkdtempSync(join(tmpdir(), 'autodev-npm-prime-'));
  try {
    const manifests = listManifests(req.worktree);
    if (!manifests.includes('package-lock.json')) return { ok: false, reason: 'no package-lock.json at the worktree root' };
    for (const rel of manifests) {
      const dst = join(scratch, 'repo', rel);
      mkdirSync(dirname(dst), { recursive: true });
      cpSync(join(req.worktree, rel), dst, { dereference: false });
    }
    const home = join(scratch, 'home');
    mkdirSync(home);
    const args = ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--offline=false', '--prefer-online',
      '--cache', req.cacheDir, '--userconfig', '/dev/null', '--globalconfig', '/dev/null', '--registry', REGISTRY, '--loglevel', 'error'];
    const before = cacheBytes(req.cacheDir);
    const started = Date.now();
    const r: ExecResult = await exec('npm', args, { cwd: join(scratch, 'repo'), timeoutMs: req.timeoutMs, env: { PATH: process.env.PATH ?? '', HOME: home, TMPDIR: scratch, npm_config_cache: req.cacheDir } });
    const command = ['npm', ...args];
    if (r.code !== 0) return { ok: false, reason: `npm ci exited ${r.code}${r.timedOut ? ' (timed out)' : ''}: ${(r.stderr || r.stdout).slice(-1500)}`, command };
    return { ok: true, bytesAdded: Math.max(0, cacheBytes(req.cacheDir) - before), durationMs: Date.now() - started, command };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** package.json / package-lock.json paths (relative) outside node_modules and .git, root first. */
export function listManifests(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 6) return;
    for (const entry of readdirSafe(dir)) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { if (entry.name === 'node_modules' || entry.name === '.git') continue; walk(full, depth + 1); continue; }
      if (entry.name === 'package.json' || entry.name === 'package-lock.json') out.push(relative(root, full).split(sep).join('/'));
    }
  };
  walk(resolve(root), 0);
  return out.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
}

function readdirSafe(dir: string) {
  try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

function cacheBytes(cacheDir: string): number {
  const root = join(cacheDir, '_cacache');
  if (!existsSync(root)) return 0;
  let total = 0;
  const walk = (dir: string) => { for (const e of readdirSafe(dir)) { const p = join(dir, e.name); if (e.isDirectory()) walk(p); else if (e.isFile()) { try { total += statSync(p).size; } catch { /* vanished */ } } } };
  walk(root);
  return total;
}

export function readBaseLockfile(worktree: string, baseSha: string): Promise<string | null> {
  return run('git', ['-C', worktree, 'show', `${baseSha}:package-lock.json`], { maxOutput: 50_000_000 }).then((r) => (r.code === 0 ? r.stdout : null));
}

