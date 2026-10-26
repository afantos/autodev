import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './exec.ts';
import type { ExecResult } from './exec.ts';

/**
 * Automatic priming of a project's offline npm cache (npmCacheDir) when a candidate's lockfile adds packages.
 *
 * The validation sandbox installs with `npm ci --offline`, so a ticket that adds dependencies fails setup until the
 * cache holds the new tarballs. The agent that writes package.json / package-lock.json is untrusted, so nothing it
 * wrote is executed or handed to an online resolver. Instead:
 *  1. every lockfile entry must be an https://registry.npmjs.org/ tarball with an integrity hash (git+, file:, link:,
 *     http:, other registries, query strings, aliases and workspace entries outside the repo are refused);
 *  2. every entry that is new or changed against the base lockfile (name, version, resolved URL or integrity) is
 *     checked against the registry packument for that exact name@version: the packument's name, version,
 *     dist.tarball and dist.integrity must match the entry. That binds the entry to the package it claims to be
 *     and gives trusted dependency edges, taken from the registry rather than from the candidate lockfile;
 *  3. every package new to the candidate must be reachable through those trusted edges from a package already in
 *     the base lockfile or in the project's approvedDependencies; otherwise nothing is primed;
 *  4. only the verified tarballs are fetched, one `npm cache add <exact URL>` each, with --ignore-scripts, null
 *     user/global configs, an explicit registry, a scratch HOME and an environment of PATH/HOME/TMPDIR only, under a
 *     per-call timeout; after each add the cache must hold content for the lockfile's sha512, and the artifact count
 *     and bytes added are bounded outside npm. No manifest ever reaches npm.
 */

export const REGISTRY = 'https://registry.npmjs.org/';

export interface LockfilePackage { name?: string; version?: string; resolved?: string; integrity?: string; link?: boolean; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string> }
export interface Lockfile { lockfileVersion?: number; packages?: Record<string, LockfilePackage> }

/** A registry entry of the candidate lockfile that passed the shape checks. */
export interface Artifact { key: string; name: string; version: string; resolved: string; integrity: string; edges: string[] }
export interface Packument { name?: string; version?: string; dist?: { tarball?: string; integrity?: string; unpackedSize?: number }; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string> }
export type FetchPackument = (name: string, version: string) => Promise<Packument | null>;

export interface PrimeLimits { maxArtifacts: number; maxBytes: number }
export type PrimePlan =
  | { ok: true; artifacts: Artifact[]; newNames: string[]; totalEntries: number }
  | { ok: false; reason: string };

/** Package name from a lockfile `packages` key such as `node_modules/@scope/name` or `apps/web/node_modules/foo`. */
export function packageName(key: string): string | null {
  const i = key.lastIndexOf('node_modules/');
  return i < 0 ? null : key.slice(i + 'node_modules/'.length);
}

const SRI = /^sha(256|384|512)-[A-Za-z0-9+/]+={0,2}$/;

/** The exact registry tarball URL for name@version. */
export function tarballUrl(name: string, version: string): string {
  const base = name.includes('/') ? name.slice(name.indexOf('/') + 1) : name;
  return `${REGISTRY}${name}/-/${base}-${version}.tgz`;
}

function edgesOf(p: { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string> }): string[] {
  return [...new Set([...Object.keys(p.dependencies ?? {}), ...Object.keys(p.optionalDependencies ?? {}), ...Object.keys(p.peerDependencies ?? {})])];
}

/** Parse and shape-check a lockfile. Returns the registry entries or the first refusal. */
export function parseLockfile(text: string): { ok: true; entries: Artifact[]; names: Set<string> } | { ok: false; reason: string } {
  let lock: Lockfile;
  try { lock = JSON.parse(text) as Lockfile; } catch { return { ok: false, reason: 'package-lock.json is not valid JSON' }; }
  if (!lock.packages || typeof lock.packages !== 'object') return { ok: false, reason: 'package-lock.json has no "packages" map (lockfile v1 is not supported)' };
  const entries: Artifact[] = [];
  const workspaceNames = new Set<string>();
  for (const [key, pkg] of Object.entries(lock.packages)) {
    if (key === '' || key.includes('node_modules/')) continue;
    if (key.startsWith('..') || key.startsWith('/') || key.includes('/../')) return { ok: false, reason: `workspace entry "${key}" points outside the repository` };
    if (pkg.resolved || pkg.link) return { ok: false, reason: `workspace entry "${key}" is a link or has a resolved URL` };
    if (pkg.name) workspaceNames.add(pkg.name);
  }
  for (const [key, pkg] of Object.entries(lock.packages)) {
    const name = packageName(key);
    if (!name) continue;
    if (pkg.link || (!pkg.resolved && !pkg.integrity)) {
      // npm records a workspace package under node_modules/<name> as a link to its in-repo path; accept only those.
      if (workspaceNames.has(name) && (!pkg.resolved || !/^(https?:|git|file:)/i.test(pkg.resolved))) continue;
      return { ok: false, reason: `"${name}" is a link, not a registry package` };
    }
    if (pkg.name && pkg.name !== name) return { ok: false, reason: `"${name}" is an alias for "${pkg.name}"; aliases are not primed` };
    if (!pkg.version || !/^[0-9A-Za-z.+-]+$/.test(pkg.version)) return { ok: false, reason: `"${name}" has no usable version` };
    const resolved = String(pkg.resolved ?? '');
    if (resolved !== tarballUrl(name, pkg.version)) return { ok: false, reason: `"${name}@${pkg.version}" does not resolve to its registry tarball: ${resolved.slice(0, 120) || '(none)'}` };
    if (!pkg.integrity || !SRI.test(pkg.integrity)) return { ok: false, reason: `"${name}" has no usable integrity hash` };
    entries.push({ key, name, version: pkg.version, resolved, integrity: pkg.integrity, edges: edgesOf(pkg) });
  }
  return { ok: true, entries, names: new Set(entries.map((e) => e.name)) };
}

const ident = (a: { name: string; version: string; resolved: string; integrity: string }) => `${a.name}@${a.version}|${a.resolved}|${a.integrity}`;

/**
 * Decide what may be primed. Pure apart from the registry lookups, which go through `fetchPackument` (seam for tests).
 * `base` is the base branch's lockfile text (null when the base has none).
 */
export async function planPrime(candidate: string, base: string | null, approved: readonly string[], limits: PrimeLimits, fetchPackument: FetchPackument): Promise<PrimePlan> {
  const cand = parseLockfile(candidate);
  if (!cand.ok) return cand;
  const baseParsed = base ? parseLockfile(base) : null;
  const baseByIdent = new Map<string, Artifact>();
  const baseNames = new Set<string>();
  if (baseParsed?.ok) for (const e of baseParsed.entries) { baseByIdent.set(ident(e), e); baseNames.add(e.name); }
  // Unchanged entries (same name, version, URL, integrity AND the same declared edges as the base) are trusted as the base.
  const changed: Artifact[] = [];
  const trustedEdges = new Map<string, Set<string>>();
  const addEdges = (name: string, edges: string[]) => { const s = trustedEdges.get(name) ?? new Set<string>(); for (const d of edges) s.add(d); trustedEdges.set(name, s); };
  const seen = new Set<string>();
  for (const e of cand.entries) {
    const b = baseByIdent.get(ident(e));
    const sameEdges = !!b && b.edges.length === e.edges.length && b.edges.every((d) => e.edges.includes(d));
    if (b && sameEdges) { addEdges(e.name, b.edges); continue; }
    if (seen.has(`${e.name}@${e.version}`)) { continue; }
    seen.add(`${e.name}@${e.version}`);
    changed.push(e);
  }
  const newNames = [...cand.names].filter((n) => !baseNames.has(n));
  if (!changed.length) return { ok: true, artifacts: [], newNames: [], totalEntries: cand.entries.length };
  if (changed.length > limits.maxArtifacts) return { ok: false, reason: `${changed.length} new or changed artifacts exceed the limit of ${limits.maxArtifacts}` };
  // Registry verification of every new/changed entry: identity, tarball, integrity and trusted edges.
  for (const e of changed) {
    let p: Packument | null;
    try { p = await fetchPackument(e.name, e.version); } catch (err) { return { ok: false, reason: `registry lookup failed for ${e.name}@${e.version}: ${String((err as Error)?.message ?? err).slice(0, 200)}` }; }
    if (!p) return { ok: false, reason: `${e.name}@${e.version} is not on the registry` };
    if (p.name !== e.name || p.version !== e.version) return { ok: false, reason: `registry packument for ${e.name}@${e.version} describes ${p.name}@${p.version}` };
    if (!p.dist?.tarball || !p.dist.tarball.startsWith(REGISTRY) || p.dist.tarball !== e.resolved) return { ok: false, reason: `${e.name}@${e.version}: lockfile tarball ${e.resolved} differs from the registry's ${p.dist?.tarball ?? '(none)'}` };
    if (!p.dist?.integrity || p.dist.integrity !== e.integrity) return { ok: false, reason: `${e.name}@${e.version}: lockfile integrity differs from the registry's` };
    addEdges(e.name, edgesOf(p));
  }
  // Reachability over trusted edges only, from approved names and base names that are still present.
  const reachable = new Set<string>([...cand.names].filter((n) => baseNames.has(n) || approved.includes(n)));
  const queue = [...reachable];
  while (queue.length) {
    const n = queue.shift()!;
    for (const dep of trustedEdges.get(n) ?? []) if (cand.names.has(dep) && !reachable.has(dep)) { reachable.add(dep); queue.push(dep); }
  }
  const unreachable = newNames.filter((n) => !reachable.has(n));
  if (unreachable.length) return { ok: false, reason: `new packages are neither approved nor dependencies of approved/existing ones: ${unreachable.slice(0, 10).join(', ')}${unreachable.length > 10 ? ', …' : ''}` };
  return { ok: true, artifacts: changed, newNames, totalEntries: cand.entries.length };
}

/** Packument URL for one exact version; scoped names are encoded (`@s/n` → `@s%2Fn`). */
export function packumentUrl(name: string, version: string): string {
  if (!/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(name)) throw new Error(`invalid package name: ${name}`);
  return `${REGISTRY}${name.replace('/', '%2F')}/${encodeURIComponent(version)}`;
}

export const MAX_PACKUMENT_BYTES = 2_000_000;

/**
 * The registry packument for one exact version via global fetch: registry.npmjs.org only, no redirects followed,
 * a timeout and a response size cap. Anything else throws, which the planner reports as a refusal.
 */
export async function fetchRegistryPackument(name: string, version: string, timeoutMs = 20_000): Promise<Packument | null> {
  const url = packumentUrl(name, version);
  if (!url.startsWith(REGISTRY)) throw new Error(`refusing non-registry URL ${url}`);
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' }, redirect: 'error' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const length = Number(res.headers.get('content-length') ?? 0);
  if (length > MAX_PACKUMENT_BYTES) throw new Error(`packument for ${name}@${version} is too large (${length} bytes)`);
  const text = await res.text();
  if (text.length > MAX_PACKUMENT_BYTES) throw new Error(`packument for ${name}@${version} is too large`);
  return JSON.parse(text) as Packument;
}

/** The npm offline-miss signatures that mean "the cache lacks this lockfile's packages" (and nothing else is wrong). */
export function looksLikeOfflineMiss(output: string): boolean {
  return /ENOTCACHED|only-if-cached|no cached response/i.test(output);
}

export interface PrimeRequest {
  artifacts: Artifact[];
  cacheDir: string;
  timeoutMs: number;
  maxBytes: number;
  /** Test seam: the command runner (defaults to exec.run). */
  exec?: typeof run;
}
export type PrimeOutcome =
  | { ok: true; artifacts: number; bytesAdded: number; durationMs: number; command: string[] }
  | { ok: false; reason: string; artifacts: number; bytesAdded: number };

/** Fetch the verified tarballs into the cache, one at a time, bounded by bytes and a per-call timeout. */
export async function primeNpmCache(req: PrimeRequest): Promise<PrimeOutcome> {
  const exec = req.exec ?? run;
  const scratch = mkdtempSync(join(tmpdir(), 'autodev-npm-prime-'));
  const home = join(scratch, 'home'); mkdirSync(home);
  const started = Date.now();
  const before = cacheBytes(req.cacheDir);
  let done = 0;
  let command: string[] = [];
  try {
    for (const a of req.artifacts) {
      const args = ['cache', 'add', a.resolved, '--ignore-scripts', '--no-audit', '--no-fund', '--cache', req.cacheDir,
        '--userconfig', '/dev/null', '--globalconfig', '/dev/null', '--registry', REGISTRY, '--loglevel', 'error'];
      command = ['npm', ...args];
      const r: ExecResult = await exec('npm', args, { cwd: scratch, timeoutMs: req.timeoutMs, env: { PATH: process.env.PATH ?? '', HOME: home, TMPDIR: scratch, npm_config_cache: req.cacheDir } });
      if (r.code !== 0) return { ok: false, reason: `npm cache add ${a.name}@${a.version} exited ${r.code}${r.timedOut ? ' (timed out)' : ''}: ${(r.stderr || r.stdout).slice(-800)}`, artifacts: done, bytesAdded: Math.max(0, cacheBytes(req.cacheDir) - before) };
      if (!existsSync(contentPath(req.cacheDir, a.integrity))) return { ok: false, reason: `${a.name}@${a.version}: the cache holds no content for the lockfile's integrity after the fetch (registry served different bytes?)`, artifacts: done, bytesAdded: Math.max(0, cacheBytes(req.cacheDir) - before) };
      done++;
      const added = Math.max(0, cacheBytes(req.cacheDir) - before);
      if (added > req.maxBytes) return { ok: false, reason: `priming exceeded the byte budget (${added} > ${req.maxBytes}) after ${done} artifact(s)`, artifacts: done, bytesAdded: added };
    }
    return { ok: true, artifacts: done, bytesAdded: Math.max(0, cacheBytes(req.cacheDir) - before), durationMs: Date.now() - started, command };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** cacache content path for an SRI string: content-v2/<algo>/<hex 0-2>/<hex 2-4>/<hex 4->. */
export function contentPath(cacheDir: string, integrity: string): string {
  const [algo, b64] = integrity.split('-', 2) as [string, string];
  const hex = Buffer.from(b64, 'base64').toString('hex');
  return join(cacheDir, '_cacache', 'content-v2', algo, hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
}

/** The SRI of raw bytes (tests build cache fixtures with it). */
export function sriOf(bytes: Buffer, algo: 'sha512' | 'sha256' = 'sha512'): string {
  return `${algo}-${createHash(algo).update(bytes).digest('base64')}`;
}

function readdirSafe(dir: string) { try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; } }
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
