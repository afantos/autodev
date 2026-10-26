import { createHash } from 'node:crypto';
import { closeSync, constants, cpSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import semver from 'semver';
import { run } from './exec.ts';
import type { ExecResult } from './exec.ts';

/**
 * Automatic priming of a project's offline npm cache (npmCacheDir) when a candidate's lockfile adds packages.
 *
 * The validation sandbox installs with `npm ci --offline`, so a ticket that adds dependencies fails setup until the
 * cache holds the new tarballs. The agent that writes package.json / package-lock.json is untrusted, so nothing it
 * wrote is executed or handed to an online resolver. Instead:
 *  1. the lockfile is read only after the candidate snapshot is re-verified, through a no-follow, regular-file,
 *     size-capped read, and every entry must be an https://registry.npmjs.org/ tarball for its own name and version
 *     with an integrity hash (git+, file:, link:, http:, other registries, query strings, aliases and workspace
 *     entries outside the repo are refused);
 *  2. every entry that is new or changed against the base lockfile is checked against the registry packument for
 *     that exact name@version: name, version, dist.tarball and dist.integrity must match. That binds the entry to the
 *     package it claims to be and gives trusted dependency specs, taken from the registry rather than from the
 *     candidate lockfile;
 *  3. reachability is artifact-level: a parent authorizes a child only when the child's name is the spec's target
 *     (npm: aliases and non-registry specs authorize nothing) and the child's version satisfies the spec's range.
 *     Roots are approved names and artifacts unchanged from the base lockfile. Anything unreachable → refused;
 *  4. only the verified tarballs are fetched: streamed by the orchestrator itself (registry host, no redirects,
 *     aborted past the remaining byte budget), checked against the lockfile integrity, then ingested offline with
 *     `npm cache add <local file>` into a scratch cache, with
 *     --ignore-scripts, two distinct empty config files, an explicit registry, a scratch HOME and an environment of
 *     PATH/HOME/TMPDIR only, under a per-call timeout. The scratch cache must then hold content for the lockfile's
 *     sha512 and stay within the byte budget; only then is it promoted into the shared cache. No manifest ever
 *     reaches npm.
 */

export const REGISTRY = 'https://registry.npmjs.org/';
export const MAX_PACKUMENT_BYTES = 2_000_000;
export const MAX_LOCKFILE_BYTES = 50_000_000;

export interface LockfilePackage { name?: string; version?: string; resolved?: string; integrity?: string; link?: boolean; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string> }
export interface Lockfile { lockfileVersion?: number; packages?: Record<string, LockfilePackage> }

/** A registry entry of the candidate lockfile that passed the shape checks; `specs` are its declared dependency specs. */
export interface Artifact { key: string; name: string; version: string; resolved: string; integrity: string; specs: Record<string, string>; unpackedSize?: number }
export interface Packument { name?: string; version?: string; dist?: { tarball?: string; integrity?: string; unpackedSize?: number }; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string> }
export type FetchPackument = (name: string, version: string, signal?: AbortSignal) => Promise<Packument | null>;

/** maxArtifacts bounds both registry verifications (every new or changed entry) and fetched tarballs; deadlineMs bounds planning. */
export interface PrimeLimits { maxArtifacts: number; maxBytes: number; deadlineMs?: number }
export type PrimePlan =
  | { ok: true; artifacts: Artifact[]; newNames: string[]; totalEntries: number }
  | { ok: false; reason: string };

/** Package name from a lockfile `packages` key such as `node_modules/@scope/name` or `apps/web/node_modules/foo`. */
export function packageName(key: string): string | null {
  const i = key.lastIndexOf('node_modules/');
  return i < 0 ? null : key.slice(i + 'node_modules/'.length);
}

const SRI = /^sha(256|384|512)-[A-Za-z0-9+/]+={0,2}$/;
const NAME = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i;

/** The exact registry tarball URL for name@version. */
export function tarballUrl(name: string, version: string): string {
  const base = name.includes('/') ? name.slice(name.indexOf('/') + 1) : name;
  return `${REGISTRY}${name}/-/${base}-${version}.tgz`;
}

function specsOf(p: { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string> }): Record<string, string> {
  return { ...(p.peerDependencies ?? {}), ...(p.optionalDependencies ?? {}), ...(p.dependencies ?? {}) };
}

/**
 * Does the dependency spec `spec` (as a parent declares it for `depName`) authorize the artifact `child`?
 * Only plain registry ranges count: npm: aliases, git/github/http/file/link/workspace specs and tags authorize nothing.
 */
export function specAuthorizes(depName: string, spec: string, child: { name: string; version: string }): boolean {
  if (child.name !== depName) return false;
  const s = spec.trim();
  if (!s || /^(npm:|git|github:|gitlab:|bitbucket:|gist:|https?:|file:|link:|workspace:|\.|\/)/i.test(s)) return false;
  // npm's own semantics: a prerelease satisfies a range only when the range names a prerelease of that tuple.
  if (!semver.validRange(s)) return false;
  return semver.satisfies(child.version, s);
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
    if (!NAME.test(name)) return { ok: false, reason: `"${name}" is not a valid package name` };
    if (pkg.name && pkg.name !== name) return { ok: false, reason: `"${name}" is an alias for "${pkg.name}"; aliases are not primed` };
    if (!pkg.version || !semver.valid(pkg.version)) return { ok: false, reason: `"${name}" has no usable version` };
    const resolved = String(pkg.resolved ?? '');
    if (resolved !== tarballUrl(name, pkg.version)) return { ok: false, reason: `"${name}@${pkg.version}" does not resolve to its registry tarball: ${resolved.slice(0, 120) || '(none)'}` };
    if (!pkg.integrity || !SRI.test(pkg.integrity)) return { ok: false, reason: `"${name}" has no usable integrity hash` };
    entries.push({ key, name, version: pkg.version, resolved, integrity: pkg.integrity, specs: specsOf(pkg) });
  }
  return { ok: true, entries, names: new Set(entries.map((e) => e.name)) };
}

const ident = (a: Artifact) => `${a.name}@${a.version}|${a.resolved}|${a.integrity}`;
const sameSpecs = (a: Record<string, string>, b: Record<string, string>) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

/**
 * Decide what may be primed. Pure apart from the registry lookups, which go through `fetchPackument` (seam for tests).
 * `base` is the base branch's lockfile text (null when the base has none).
 */
export async function planPrime(candidate: string, base: string | null, approved: readonly string[], limits: PrimeLimits, fetchPackument: FetchPackument, signal?: AbortSignal): Promise<PrimePlan> {
  const cand = parseLockfile(candidate);
  if (!cand.ok) return cand;
  const baseParsed = base ? parseLockfile(base) : null;
  const baseByIdent = new Map<string, Artifact>();
  const baseNames = new Set<string>();
  if (baseParsed?.ok) for (const e of baseParsed.entries) { baseByIdent.set(ident(e), e); baseNames.add(e.name); }
  // Trusted specs per artifact: from the base lockfile for unchanged entries, from the registry for new/changed ones.
  const trusted = new Map<Artifact, Record<string, string>>();
  const unchanged: Artifact[] = [];
  const changed: Artifact[] = [];
  const seen = new Set<string>();
  for (const e of cand.entries) {
    const b = baseByIdent.get(ident(e));
    if (b && sameSpecs(b.specs, e.specs)) { trusted.set(e, b.specs); unchanged.push(e); continue; }
    const id = `${e.name}@${e.version}`;
    if (seen.has(id)) { const first = changed.find((c) => `${c.name}@${c.version}` === id)!; trusted.set(e, trusted.get(first) ?? {}); continue; }
    seen.add(id);
    changed.push(e);
  }
  const newNames = [...cand.names].filter((n) => !baseNames.has(n));
  // Artifacts to fetch: new name@version tarballs. A base artifact whose only change is its declared specs is
  // re-verified against the registry (below) but its tarball is already in the cache.
  const toFetch = changed.filter((e) => !baseByIdent.has(ident(e)));
  if (!changed.length) return { ok: true, artifacts: [], newNames: [], totalEntries: cand.entries.length };
  // Every changed entry costs one registry request, so bound them all (spec-only edits included) before any request.
  if (changed.length > limits.maxArtifacts) return { ok: false, reason: `${changed.length} new or changed lockfile entries exceed the limit of ${limits.maxArtifacts} registry verifications` };
  // Registry verification of every new/changed entry: identity, tarball, integrity, size hint and trusted specs,
  // under one overall deadline and the caller's abort signal.
  const deadline = AbortSignal.timeout(limits.deadlineMs ?? 5 * 60_000);
  const planSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  for (const e of changed) {
    if (planSignal.aborted) return { ok: false, reason: signal?.aborted ? 'priming was cancelled' : `registry verification exceeded its deadline of ${Math.round((limits.deadlineMs ?? 300_000) / 1000)}s` };
    let p: Packument | null;
    try { p = await fetchPackument(e.name, e.version, planSignal); } catch (err) { return { ok: false, reason: planSignal.aborted && !signal?.aborted ? `registry verification exceeded its deadline` : `registry lookup failed for ${e.name}@${e.version}: ${String((err as Error)?.message ?? err).slice(0, 200)}` }; }
    if (!p) return { ok: false, reason: `${e.name}@${e.version} is not on the registry` };
    if (p.name !== e.name || p.version !== e.version) return { ok: false, reason: `registry packument for ${e.name}@${e.version} describes ${p.name}@${p.version}` };
    if (!p.dist?.tarball || !p.dist.tarball.startsWith(REGISTRY) || p.dist.tarball !== e.resolved) return { ok: false, reason: `${e.name}@${e.version}: lockfile tarball ${e.resolved} differs from the registry's ${p.dist?.tarball ?? '(none)'}` };
    if (!p.dist?.integrity || p.dist.integrity !== e.integrity) return { ok: false, reason: `${e.name}@${e.version}: lockfile integrity differs from the registry's` };
    if (typeof p.dist.unpackedSize === 'number') { e.unpackedSize = p.dist.unpackedSize; if (p.dist.unpackedSize > limits.maxBytes) return { ok: false, reason: `${e.name}@${e.version} unpacks to ${p.dist.unpackedSize} bytes, above the budget of ${limits.maxBytes}` }; }
    const specs = specsOf(p);
    trusted.set(e, specs);
    for (const dup of cand.entries) if (dup !== e && dup.name === e.name && dup.version === e.version) trusted.set(dup, specs);
  }
  // Artifact-level reachability over trusted specs: roots are approved names and artifacts the base already had
  // (same name, version, URL and integrity; their specs are now registry-verified when they differed).
  const all = cand.entries;
  const reachable = new Set<Artifact>([...unchanged, ...all.filter((a) => approved.includes(a.name) || baseByIdent.has(ident(a)))]);
  const queue = [...reachable];
  while (queue.length) {
    const parent = queue.shift()!;
    for (const [depName, spec] of Object.entries(trusted.get(parent) ?? {})) {
      for (const child of all) if (!reachable.has(child) && specAuthorizes(depName, spec, child)) { reachable.add(child); queue.push(child); }
    }
  }
  const unreachable = toFetch.filter((a) => !reachable.has(a));
  if (unreachable.length) return { ok: false, reason: `new packages are neither approved nor dependencies of approved/existing ones: ${unreachable.slice(0, 10).map((a) => `${a.name}@${a.version}`).join(', ')}${unreachable.length > 10 ? ', …' : ''}` };
  return { ok: true, artifacts: toFetch, newNames, totalEntries: cand.entries.length };
}

/** Packument URL for one exact version; scoped names are encoded (`@s/n` → `@s%2Fn`). */
export function packumentUrl(name: string, version: string): string {
  if (!NAME.test(name)) throw new Error(`invalid package name: ${name}`);
  return `${REGISTRY}${name.replace('/', '%2F')}/${encodeURIComponent(version)}`;
}

/**
 * The registry packument for one exact version via global fetch: registry.npmjs.org only, no redirects followed,
 * a timeout and a streamed response size cap. Anything else throws, which the planner reports as a refusal.
 */
export async function fetchRegistryPackument(name: string, version: string, signal?: AbortSignal, timeoutMs = 20_000): Promise<Packument | null> {
  const url = packumentUrl(name, version);
  if (!url.startsWith(REGISTRY)) throw new Error(`refusing non-registry URL ${url}`);
  const per = AbortSignal.timeout(timeoutMs);
  const res = await fetch(url, { signal: signal ? AbortSignal.any([signal, per]) : per, headers: { accept: 'application/json' }, redirect: 'error' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const length = Number(res.headers.get('content-length') ?? 0);
  if (length > MAX_PACKUMENT_BYTES) throw new Error(`packument for ${name}@${version} is too large (${length} bytes)`);
  return JSON.parse(await readCapped(res.body, MAX_PACKUMENT_BYTES, `packument for ${name}@${version}`)) as Packument;
}

/** Read a response body with a byte counter, cancelling the stream as soon as the cap is exceeded. */
export async function readCapped(body: ReadableStream<Uint8Array> | null, cap: number, what: string): Promise<string> {
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) { await reader.cancel().catch(() => {}); throw new Error(`${what} is too large (over ${cap} bytes)`); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The npm offline-miss signatures that mean "the cache lacks this lockfile's packages" (and nothing else is wrong). */
export function looksLikeOfflineMiss(output: string): boolean {
  return /ENOTCACHED|only-if-cached|no cached response/i.test(output);
}

/**
 * Read a lockfile from a candidate snapshot that untrusted commands ran in: no symlink following, regular files
 * only, size-capped. Returns null when the file is absent; throws on anything suspicious.
 */
export function readLockfileSafely(path: string, cap = MAX_LOCKFILE_BYTES): string | null {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw new Error(`refusing to read ${path}: ${code ?? String(e)}`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`refusing to read ${path}: not a regular file`);
    if (st.size > cap) throw new Error(`refusing to read ${path}: ${st.size} bytes exceeds the ${cap}-byte cap`);
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) { const n = readSync(fd, buf, off, st.size - off, off); if (n <= 0) break; off += n; }
    return buf.subarray(0, off).toString('utf8');
  } finally { closeSync(fd); }
}

export interface PrimeRequest {
  artifacts: Artifact[];
  cacheDir: string;
  timeoutMs: number;
  maxBytes: number;
  signal?: AbortSignal;
  /** Test seam: the command runner (defaults to exec.run). */
  exec?: typeof run;
  /** Test seam: HTTP fetch (defaults to global fetch). */
  fetchImpl?: typeof fetch;
}
export type PrimeOutcome =
  | { ok: true; artifacts: number; bytesAdded: number; durationMs: number; command: string[] }
  | { ok: false; reason: string; artifacts: number; bytesAdded: number };

/** npm flags that keep every host and repository configuration out of the run. The two config files must differ. */
export function npmIsolationArgs(scratch: string, cacheDir: string): string[] {
  const user = join(scratch, 'npmrc-user'); const global = join(scratch, 'npmrc-global');
  for (const f of [user, global]) if (!existsSync(f)) writeFileSync(f, '');
  return ['--ignore-scripts', '--no-audit', '--no-fund', '--cache', cacheDir, '--userconfig', user, '--globalconfig', global, '--registry', REGISTRY, '--loglevel', 'error'];
}

/**
 * Fetch the verified tarballs: each into its own scratch cache, checked for integrity content and the byte budget,
 * then promoted into the shared cache. A failure or timeout leaves the shared cache without that artifact.
 */
export async function primeNpmCache(req: PrimeRequest): Promise<PrimeOutcome> {
  const exec = req.exec ?? run;
  const scratch = mkdtempSync(join(tmpdir(), 'autodev-npm-prime-'));
  const home = join(scratch, 'home'); mkdirSync(home);
  const started = Date.now();
  let done = 0;
  let bytes = 0;
  let command: string[] = [];
  try {
    for (const a of req.artifacts) {
      // 1. Download the exact verified URL ourselves: registry host only, no redirects, aborted past the remaining
      //    budget, then check the bytes against the lockfile integrity. npm never touches the network.
      const tgz = join(scratch, `artifact-${done}.tgz`);
      const dl = await downloadCapped(a.resolved, tgz, req.maxBytes - bytes, req.timeoutMs, req.signal, req.fetchImpl ?? fetch);
      if (!dl.ok) return { ok: false, reason: `${a.name}@${a.version}: ${dl.reason}`, artifacts: done, bytesAdded: bytes };
      if (!integrityMatches(readFileSync(tgz), a.integrity)) return { ok: false, reason: `${a.name}@${a.version}: the downloaded bytes do not match the lockfile's integrity (registry served different bytes?)`, artifacts: done, bytesAdded: bytes };
      // 2. Ingest the verified local file into a scratch cache, offline.
      const stage = join(scratch, `stage-${done}`); mkdirSync(stage);
      const args = ['cache', 'add', tgz, '--offline', ...npmIsolationArgs(scratch, stage)];
      command = ['npm', ...args];
      const r: ExecResult = await exec('npm', args, { cwd: scratch, timeoutMs: req.timeoutMs, env: { PATH: process.env.PATH ?? '', HOME: home, TMPDIR: scratch, npm_config_cache: stage } });
      if (r.code !== 0) return { ok: false, reason: `npm cache add ${a.name}@${a.version} exited ${r.code}${r.timedOut ? ' (timed out)' : ''}: ${(r.stderr || r.stdout).slice(-800)}`, artifacts: done, bytesAdded: bytes };
      if (!existsSync(contentPath(stage, a.integrity))) return { ok: false, reason: `${a.name}@${a.version}: the cache holds no content for the lockfile's integrity after ingesting the verified file`, artifacts: done, bytesAdded: bytes };
      rmSync(tgz, { force: true });
      const size = cacheBytes(stage);
      if (bytes + size > req.maxBytes) return { ok: false, reason: `priming would exceed the byte budget (${bytes + size} > ${req.maxBytes}) at ${a.name}@${a.version}; nothing from it was promoted`, artifacts: done, bytesAdded: bytes };
      // Promote: cacache paths are content/key hashed, so merging the staged tree into the shared cache is safe.
      mkdirSync(join(req.cacheDir, '_cacache'), { recursive: true });
      cpSync(join(stage, '_cacache'), join(req.cacheDir, '_cacache'), { recursive: true, force: true, dereference: false });
      rmSync(stage, { recursive: true, force: true });
      bytes += size; done++;
    }
    return { ok: true, artifacts: done, bytesAdded: bytes, durationMs: Date.now() - started, command };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Stream `url` (registry tarballs only) into `dest`, aborting past `cap` bytes, the timeout or the caller's signal. */
export async function downloadCapped(url: string, dest: string, cap: number, timeoutMs: number, signal: AbortSignal | undefined, fetchImpl: typeof fetch): Promise<{ ok: true; bytes: number } | { ok: false; reason: string }> {
  if (!url.startsWith(REGISTRY) || !/\.tgz$/.test(url)) return { ok: false, reason: `refusing to download ${url}` };
  if (cap <= 0) return { ok: false, reason: 'the byte budget is used up' };
  const ctrl = new AbortController();
  const per = AbortSignal.timeout(timeoutMs);
  const combined = AbortSignal.any([ctrl.signal, per, ...(signal ? [signal] : [])]);
  let fd: number | null = null;
  try {
    const res = await fetchImpl(url, { signal: combined, redirect: 'error' });
    if (!res.ok || !res.body) return { ok: false, reason: `HTTP ${res.status} for ${url}` };
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > cap) { ctrl.abort(); return { ok: false, reason: `tarball is ${declared} bytes, over the remaining budget of ${cap}` }; }
    fd = openSync(dest, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const reader = res.body.getReader();
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) { await reader.cancel().catch(() => {}); ctrl.abort(); return { ok: false, reason: `download cut off past the remaining budget of ${cap} bytes` }; }
      writeSync(fd, value);
    }
    return { ok: true, bytes: total };
  } catch (e) {
    return { ok: false, reason: combined.aborted && per.aborted ? `download timed out after ${timeoutMs} ms` : `download failed: ${String((e as Error)?.message ?? e).slice(0, 200)}` };
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** Does `bytes` match the SRI string (sha256/384/512)? */
export function integrityMatches(bytes: Buffer, integrity: string): boolean {
  const [algo, b64] = integrity.split('-', 2) as [string, string];
  if (!['sha256', 'sha384', 'sha512'].includes(algo)) return false;
  return createHash(algo).update(bytes).digest('base64') === b64;
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
export function cacheBytes(cacheDir: string): number {
  const root = join(cacheDir, '_cacache');
  if (!existsSync(root)) return 0;
  let total = 0;
  const walk = (dir: string) => { for (const e of readdirSafe(dir)) { const p = join(dir, e.name); if (e.isDirectory()) walk(p); else if (e.isFile()) { try { total += statSync(p).size; } catch { /* vanished */ } } } };
  walk(root);
  return total;
}

export function readBaseLockfile(worktree: string, baseSha: string): Promise<string | null> {
  return run('git', ['-C', worktree, 'show', `${baseSha}:package-lock.json`], { maxOutput: MAX_LOCKFILE_BYTES }).then((r) => (r.code === 0 ? r.stdout : null));
}
