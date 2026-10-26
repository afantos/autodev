import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, symlinkSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { REGISTRY, MAX_PACKUMENT_BYTES, cacheBytes, contentPath, looksLikeOfflineMiss, npmIsolationArgs, packageName, packumentUrl, parseLockfile, planPrime, primeNpmCache, readCapped, readLockfileSafely, specAuthorizes, sriOf, tarballUrl } from '../src/npm-cache-prime.ts';
import type { Artifact, Packument } from '../src/npm-cache-prime.ts';
import { makeEnv, job } from './helpers.ts';
import { answerBlocked } from '../src/pipeline.ts';
import { getJob } from '../src/db.ts';
import type { ExecResult } from '../src/exec.ts';

// 2026-10-26: dependency-adding tickets blocked three times on luckywinclub because the offline npm cache lacked
// their packages and an operator had to prime it by hand. Priming is now automatic, under the rules tested here.
// The agent that writes the lockfile is untrusted: identities and edges come from the registry, never from it.

const SRI = (s: string) => sriOf(Buffer.from(s));
function lock(packages: Record<string, object>, root: object = { name: 'demo' }): string {
  return JSON.stringify({ name: 'demo', lockfileVersion: 3, requires: true, packages: { '': root, ...packages } });
}
/** A well-formed registry entry whose integrity is derived from its name@version (so a fake registry can agree). */
const reg = (name: string, v = '1.0.0', extra: object = {}) => ({ version: v, resolved: tarballUrl(name, v), integrity: SRI(`${name}@${v}`), ...extra });
/** A fake registry: packuments agree with reg() unless overridden. */
function registry(overrides: Record<string, Packument | null | Error> = {}, deps: Record<string, Record<string, string>> = {}) {
  const calls: string[] = [];
  const fetchPackument = async (name: string, version: string): Promise<Packument | null> => {
    calls.push(`${name}@${version}`);
    const key = `${name}@${version}`;
    if (key in overrides) { const o = overrides[key]; if (o instanceof Error) throw o; return o; }
    return { name, version, dist: { tarball: tarballUrl(name, version), integrity: SRI(key) }, dependencies: deps[key] ?? {} };
  };
  return { fetchPackument, calls };
}
const LIMITS = { maxArtifacts: 10, maxBytes: 10_000_000 };
const BASE = lock({ 'node_modules/existing': reg('existing') });

test('packageName and tarballUrl', () => {
  assert.equal(packageName('node_modules/@s/foo'), '@s/foo');
  assert.equal(packageName('apps/web/node_modules/foo/node_modules/bar'), 'bar');
  assert.equal(packageName('packages/core'), null);
  assert.equal(tarballUrl('@s/foo', '1.2.3'), `${REGISTRY}@s/foo/-/foo-1.2.3.tgz`);
  assert.equal(packumentUrl('@s/foo', '1.2.3'), `${REGISTRY}@s%2Ffoo/1.2.3`);
  assert.throws(() => packumentUrl('../etc', '1'), /invalid package name/);
  assert.ok(MAX_PACKUMENT_BYTES > 0);
});

// ---------------------------------------------------------------- shape checks on the candidate lockfile

for (const [label, pkg] of Object.entries({
  'git dependency': { version: '1.0.0', resolved: 'git+ssh://git@github.com/x/y.git#abc', integrity: SRI('y') },
  'file dependency': { version: '1.0.0', resolved: 'file:../y', integrity: SRI('y') },
  'http (not https) registry': { version: '1.0.0', resolved: 'http://registry.npmjs.org/y/-/y-1.0.0.tgz', integrity: SRI('y') },
  'another registry': { version: '1.0.0', resolved: 'https://npm.pkg.github.com/y/-/y-1.0.0.tgz', integrity: SRI('y') },
  'query string on the tarball': { version: '1.0.0', resolved: `${REGISTRY}y/-/y-1.0.0.tgz?token=1`, integrity: SRI('y') },
  'tarball of a different version': { version: '1.0.0', resolved: tarballUrl('y', '1.0.1'), integrity: SRI('y') },
  'tarball of a different package (alias substitution by URL)': { version: '1.0.0', resolved: tarballUrl('other', '1.0.0'), integrity: SRI('y') },
  'npm: alias via the name field': { name: 'other', version: '1.0.0', resolved: tarballUrl('y', '1.0.0'), integrity: SRI('y') },
  'missing integrity': { version: '1.0.0', resolved: tarballUrl('y', '1.0.0') },
  'malformed integrity': { version: '1.0.0', resolved: tarballUrl('y', '1.0.0'), integrity: 'md5-abc' },
  'link entry': { version: '1.0.0', link: true, resolved: '../y' },
  'no resolved URL': { version: '1.0.0', integrity: SRI('y') },
  'no version': { resolved: tarballUrl('y', '1.0.0'), integrity: SRI('y') },
})) {
  test(`parseLockfile refuses: ${label}`, () => {
    const p = parseLockfile(lock({ 'node_modules/existing': reg('existing'), 'node_modules/y': pkg }));
    assert.ok(!p.ok, label); assert.match(p.reason, /"y/);
  });
}

test('parseLockfile refuses a workspace entry outside the repository and lockfile v1 / invalid JSON', () => {
  assert.match((parseLockfile(lock({ '../elsewhere': { name: 'evil', version: '1.0.0' } })) as { reason: string }).reason, /outside the repository/);
  assert.ok(!parseLockfile('{').ok);
  assert.ok(!parseLockfile(JSON.stringify({ lockfileVersion: 1, dependencies: {} })).ok);
});

test('parseLockfile accepts in-repo workspaces and their node_modules links', () => {
  const p = parseLockfile(JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'demo', workspaces: ['packages/*'] }, 'packages/core': { name: '@lwc/core', version: '0.0.0' }, 'node_modules/@lwc/core': { resolved: 'packages/core', link: true }, 'node_modules/existing': reg('existing') } }));
  assert.ok(p.ok, JSON.stringify(p)); assert.deepEqual([...p.names], ['existing']);
});

// ---------------------------------------------------------------- the plan: registry-verified identity and edges

test('planPrime: nothing new or changed → nothing to fetch, no registry call', async () => {
  const r = registry();
  const p = await planPrime(BASE, BASE, [], LIMITS, r.fetchPackument);
  assert.ok(p.ok); assert.equal(p.artifacts.length, 0); assert.deepEqual(r.calls, []);
});

test('planPrime: an approved new package and the deps the REGISTRY declares are primed', async () => {
  const cand = lock({ 'node_modules/existing': reg('existing'), 'node_modules/pg': reg('pg', '1.0.0', { dependencies: { 'pg-pool': '^1' } }), 'node_modules/pg-pool': reg('pg-pool') });
  const r = registry({}, { 'pg@1.0.0': { 'pg-pool': '^1' } });
  const p = await planPrime(cand, BASE, ['pg'], LIMITS, r.fetchPackument);
  assert.ok(p.ok, JSON.stringify(p)); assert.deepEqual(p.newNames.sort(), ['pg', 'pg-pool']); assert.equal(p.artifacts.length, 2);
  assert.deepEqual(r.calls.sort(), ['pg-pool@1.0.0', 'pg@1.0.0']);
});

test('planPrime: forged edges — the candidate claims an existing package depends on evil; the registry says otherwise → refused', async () => {
  const cand = lock({ 'node_modules/existing': reg('existing', '1.0.0', { dependencies: { evil: '^1' } }), 'node_modules/evil': reg('evil') });
  const r = registry(); // registry: existing@1.0.0 has no dependencies
  const p = await planPrime(cand, BASE, [], LIMITS, r.fetchPackument);
  assert.ok(!p.ok); assert.match(p.reason, /neither approved.*evil/);
  assert.ok(r.calls.includes('existing@1.0.0'), 'the changed base entry was re-verified against the registry');
});

test('planPrime: forged edges on an APPROVED package are ignored too; only registry edges count', async () => {
  const cand = lock({ 'node_modules/existing': reg('existing'), 'node_modules/pg': reg('pg', '1.0.0', { dependencies: { evil: '^1' } }), 'node_modules/evil': reg('evil') });
  const p = await planPrime(cand, BASE, ['pg'], LIMITS, registry().fetchPackument);
  assert.ok(!p.ok); assert.match(p.reason, /evil/);
});

test('planPrime: alias substitution by integrity — pg\'s URL with another tarball\'s hash → registry mismatch → refused', async () => {
  const cand = lock({ 'node_modules/existing': reg('existing'), 'node_modules/pg': { version: '1.0.0', resolved: tarballUrl('pg', '1.0.0'), integrity: SRI('other@1.0.0') } });
  const p = await planPrime(cand, BASE, ['pg'], LIMITS, registry().fetchPackument);
  assert.ok(!p.ok); assert.match(p.reason, /integrity differs from the registry/);
});

test('planPrime: packument identity, tarball host and missing dist.integrity all fail closed', async () => {
  const cand = lock({ 'node_modules/existing': reg('existing'), 'node_modules/pg': reg('pg') });
  for (const [label, override] of Object.entries<Packument | null>({
    'wrong name': { name: 'other', version: '1.0.0', dist: { tarball: tarballUrl('pg', '1.0.0'), integrity: SRI('pg@1.0.0') } },
    'wrong version': { name: 'pg', version: '1.0.1', dist: { tarball: tarballUrl('pg', '1.0.0'), integrity: SRI('pg@1.0.0') } },
    'other tarball host': { name: 'pg', version: '1.0.0', dist: { tarball: 'https://evil.example/pg-1.0.0.tgz', integrity: SRI('pg@1.0.0') } },
    'no dist.integrity': { name: 'pg', version: '1.0.0', dist: { tarball: tarballUrl('pg', '1.0.0') } },
    'not on the registry': null,
  })) {
    const p = await planPrime(cand, BASE, ['pg'], LIMITS, registry({ 'pg@1.0.0': override }).fetchPackument);
    assert.ok(!p.ok, label);
  }
  const err = await planPrime(cand, BASE, ['pg'], LIMITS, registry({ 'pg@1.0.0': new Error('ECONNRESET') }).fetchPackument);
  assert.ok(!err.ok); assert.match(err.reason, /registry lookup failed/);
});

test('planPrime: no base lockfile means every new package must be approved or reachable from an approved one', async () => {
  const cand = lock({ 'node_modules/next': reg('next'), 'node_modules/react': reg('react') });
  const r = registry({}, { 'next@1.0.0': { react: '^1' } });
  assert.ok(!(await planPrime(cand, null, [], LIMITS, r.fetchPackument)).ok);
  assert.ok((await planPrime(cand, null, ['next'], LIMITS, r.fetchPackument)).ok);
});

test('planPrime bounds artifacts by new/changed name@version placements, not names', async () => {
  const cand = lock({
    'node_modules/existing': reg('existing', '1.0.0', { dependencies: { d: '^1' } }), 'node_modules/d': reg('d', '1.0.0'),
    'node_modules/existing/node_modules/d': reg('d', '1.0.1'), 'apps/web/node_modules/d': reg('d', '1.0.2'),
  });
  const r = registry({}, { 'existing@1.0.0': { d: '^1' } });
  assert.ok(!(await planPrime(cand, BASE, [], { ...LIMITS, maxArtifacts: 2 }, r.fetchPackument)).ok, '3 new artifacts (3 versions of d) exceed 2');
  const ok = await planPrime(cand, BASE, [], { ...LIMITS, maxArtifacts: 3 }, r.fetchPackument);
  assert.ok(ok.ok, JSON.stringify(ok)); assert.equal(ok.artifacts.length, 3, 'existing@1.0.0 is re-verified but not fetched again');
  assert.ok(r.calls.includes('existing@1.0.0'), 'the base entry with new specs was re-verified against the registry');
});

test('looksLikeOfflineMiss matches npm offline-miss errors only', () => {
  assert.ok(looksLikeOfflineMiss("npm ERR! code ENOTCACHED\nrequest to https://registry.npmjs.org/tslib failed: cache mode is 'only-if-cached' but no cached response is available."));
  assert.ok(!looksLikeOfflineMiss('npm ERR! code ERESOLVE'));
});

// ---------------------------------------------------------------- fetching: one exact tarball at a time, bounded

function fakeExec(cache: string, opts: { bytesPerAdd?: number; skipContent?: boolean; fail?: boolean } = {}) {
  const calls: Array<{ args: string[]; opts: Record<string, unknown> }> = [];
  const exec = async (cmd: string, args: string[], o: Record<string, unknown> = {}): Promise<ExecResult> => {
    calls.push({ args, opts: o });
    assert.equal(cmd, 'npm');
    if (opts.fail) return { code: 1, stdout: '', stderr: 'npm ERR! 503', timedOut: false, truncated: false };
    const url = args[2]!;
    const stage = args[args.indexOf('--cache') + 1]!;
    assert.notEqual(stage, cache, 'npm writes into a staged cache, never straight into the shared one');
    if (!opts.skipContent) {
      // simulate npm storing the tarball under the content path of the integrity the test registry agrees on
      const name = url.slice(REGISTRY.length).split('/-/')[0]!; const version = url.match(/-(\d[^/]*)\.tgz$/)![1]!;
      const p = contentPath(stage, SRI(`${name}@${version}`)); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, Buffer.alloc(opts.bytesPerAdd ?? 100));
    }
    return { code: 0, stdout: '', stderr: '', timedOut: false, truncated: false };
  };
  return { exec, calls };
}
const art = (name: string, v = '1.0.0'): Artifact => ({ key: `node_modules/${name}`, name, version: v, resolved: tarballUrl(name, v), integrity: SRI(`${name}@${v}`), specs: {} });

test('primeNpmCache: one `npm cache add <exact URL>` per artifact with --ignore-scripts, null configs, the registry and a clean environment', async () => {
  const cache = mkdtempSync(join(tmpdir(), 'prime-cache-'));
  const f = fakeExec(cache);
  const out = await primeNpmCache({ artifacts: [art('pg'), art('pg-pool')], cacheDir: cache, timeoutMs: 1000, maxBytes: 1e6, exec: f.exec as never });
  assert.ok(out.ok, JSON.stringify(out)); assert.equal(out.artifacts, 2); assert.equal(out.bytesAdded, 200);
  assert.equal(f.calls.length, 2);
  for (const [i, c] of f.calls.entries()) {
    assert.deepEqual(c.args.slice(0, 3), ['cache', 'add', tarballUrl(i === 0 ? 'pg' : 'pg-pool', '1.0.0')]);
    for (const flag of ['--ignore-scripts', '--no-audit', '--no-fund']) assert.ok(c.args.includes(flag), flag);
    const user = c.args[c.args.indexOf('--userconfig') + 1]!; const global = c.args[c.args.indexOf('--globalconfig') + 1]!;
    assert.notEqual(user, global, 'distinct config files (npm refuses to double-load one path)');
    assert.ok(user.endsWith('npmrc-user') && global.endsWith('npmrc-global'));
    assert.equal(c.args[c.args.indexOf('--registry') + 1], REGISTRY);
    assert.ok(existsSync(contentPath(cache, SRI(i === 0 ? 'pg@1.0.0' : 'pg-pool@1.0.0'))), 'promoted into the shared cache');
    const env = c.opts.env as Record<string, string>;
    assert.deepEqual(Object.keys(env).sort(), ['HOME', 'PATH', 'TMPDIR', 'npm_config_cache']);
    assert.ok(!env.HOME.startsWith(process.env.HOME ?? '/nonexistent'), 'HOME is a scratch directory');
    assert.equal(c.opts.timeoutMs, 1000);
    assert.ok(!existsSync(String(c.opts.cwd)), 'the scratch directory is removed afterwards');
  }
});

test('primeNpmCache fails closed when the cache holds no content for the lockfile integrity after the add', async () => {
  const cache = mkdtempSync(join(tmpdir(), 'prime-cache-'));
  const out = await primeNpmCache({ artifacts: [art('pg')], cacheDir: cache, timeoutMs: 1000, maxBytes: 1e6, exec: fakeExec(cache, { skipContent: true }).exec as never });
  assert.ok(!out.ok); assert.match(out.reason, /does not match the lockfile's integrity/);
});

test('primeNpmCache stops at the byte budget and reports npm failures', async () => {
  const cache = mkdtempSync(join(tmpdir(), 'prime-cache-'));
  const f = fakeExec(cache, { bytesPerAdd: 600 });
  const out = await primeNpmCache({ artifacts: [art('a'), art('b'), art('c')], cacheDir: cache, timeoutMs: 1000, maxBytes: 1000, exec: f.exec as never });
  assert.ok(!out.ok); assert.match(out.reason, /byte budget/); assert.equal(f.calls.length, 2, 'stopped at the add that would cross the budget');
  assert.equal(cacheBytes(cache), 600, 'only the first artifact was promoted; the over-budget one never reached the shared cache');
  const bad = await primeNpmCache({ artifacts: [art('a')], cacheDir: cache, timeoutMs: 1000, maxBytes: 1e6, exec: fakeExec(cache, { fail: true }).exec as never });
  assert.ok(!bad.ok); assert.match(bad.reason, /exited 1.*503/s);
});


// ---------------------------------------------------------------- artifact-level edges

test('specAuthorizes: only plain registry ranges authorize, and only versions inside the range', () => {
  assert.ok(specAuthorizes('dep', '^1.2.0', { name: 'dep', version: '1.9.0' }));
  assert.ok(!specAuthorizes('dep', '^1.2.0', { name: 'dep', version: '2.0.0' }), 'outside the range');
  assert.ok(!specAuthorizes('dep', '^1.2.0', { name: 'other', version: '1.9.0' }), 'different package');
  for (const spec of ['npm:real@^1', 'github:x/y', 'git+ssh://git@github.com/x/y.git', 'https://x/y.tgz', 'file:../y', 'link:../y', 'workspace:*', 'latest', 'next', '']) {
    assert.ok(!specAuthorizes('dep', spec, { name: 'dep', version: '1.0.0' }), spec);
  }
  assert.ok(specAuthorizes('dep', '1.0.0', { name: 'dep', version: '1.0.0' }));
  assert.ok(specAuthorizes('dep', '>=1 <3', { name: 'dep', version: '2.5.0' }));
});

test('planPrime: a registry dep that is an npm: alias authorizes nothing (an unrelated package by that name is refused)', async () => {
  const cand = lock({ 'node_modules/existing': reg('existing'), 'node_modules/pg': reg('pg'), 'node_modules/alias': reg('alias') });
  const r = registry({}, { 'pg@1.0.0': { alias: 'npm:real@^1' } });
  const p = await planPrime(cand, BASE, ['pg'], LIMITS, r.fetchPackument);
  assert.ok(!p.ok); assert.match(p.reason, /alias@1\.0\.0/);
});

test('planPrime: a dependency version outside the parent\'s range is refused; inside is primed', async () => {
  const bad = lock({ 'node_modules/existing': reg('existing'), 'node_modules/pg': reg('pg'), 'node_modules/pg-pool': reg('pg-pool', '2.0.0') });
  const r = registry({}, { 'pg@1.0.0': { 'pg-pool': '^1' } });
  const p = await planPrime(bad, BASE, ['pg'], LIMITS, r.fetchPackument);
  assert.ok(!p.ok); assert.match(p.reason, /pg-pool@2\.0\.0/);
  const good = lock({ 'node_modules/existing': reg('existing'), 'node_modules/pg': reg('pg'), 'node_modules/pg-pool': reg('pg-pool', '1.4.0') });
  assert.ok((await planPrime(good, BASE, ['pg'], LIMITS, r.fetchPackument)).ok);
});

test('planPrime: a version bump of an existing direct dependency is primed only when approved or authorized by a parent range', async () => {
  const bumped = lock({ 'node_modules/existing': reg('existing', '1.1.0') });
  assert.ok(!(await planPrime(bumped, BASE, [], LIMITS, registry().fetchPackument)).ok, 'root manifests are untrusted, so nothing authorizes the bump');
  assert.ok((await planPrime(bumped, BASE, ['existing'], LIMITS, registry().fetchPackument)).ok);
});

test('planPrime refuses an artifact whose registry unpackedSize exceeds the byte budget', async () => {
  const cand = lock({ 'node_modules/existing': reg('existing'), 'node_modules/pg': reg('pg') });
  const r = registry({ 'pg@1.0.0': { name: 'pg', version: '1.0.0', dist: { tarball: tarballUrl('pg', '1.0.0'), integrity: SRI('pg@1.0.0'), unpackedSize: 5_000_000 } } });
  const p = await planPrime(cand, BASE, ['pg'], { maxArtifacts: 10, maxBytes: 1_000_000 }, r.fetchPackument);
  assert.ok(!p.ok); assert.match(p.reason, /unpacks to 5000000 bytes/);
});

// ---------------------------------------------------------------- reading the lockfile after untrusted commands ran

test('readLockfileSafely: regular file ok; absent → null; symlink, FIFO and oversized files are refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lock-'));
  writeFileSync(join(dir, 'ok.json'), '{"a":1}');
  assert.equal(readLockfileSafely(join(dir, 'ok.json')), '{"a":1}');
  assert.equal(readLockfileSafely(join(dir, 'missing.json')), null);
  symlinkSync('/dev/zero', join(dir, 'link.json'));
  assert.throws(() => readLockfileSafely(join(dir, 'link.json')), /refusing to read/);
  if (process.platform !== 'win32') {
    execFileSync('mkfifo', [join(dir, 'fifo.json')]);
    assert.throws(() => readLockfileSafely(join(dir, 'fifo.json')), /not a regular file/);
  }
  writeFileSync(join(dir, 'big.json'), Buffer.alloc(2048));
  assert.throws(() => readLockfileSafely(join(dir, 'big.json'), 1024), /exceeds the 1024-byte cap/);
});

test('readCapped cancels a response stream past the cap', async () => {
  const big = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array(1024)); } });
  await assert.rejects(readCapped(big, 4096, 'thing'), /too large/);
  const small = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('{"ok":true}')); c.close(); } });
  assert.equal(await readCapped(small, 4096, 'thing'), '{"ok":true}');
});

// ---------------------------------------------------------------- real npm, offline

test('real npm: the isolation flags load without the double-loading config error', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'npm-iso-'));
  const args = npmIsolationArgs(scratch, join(scratch, 'cache'));
  const out = execFileSync('npm', ['config', 'get', 'registry', ...args.filter((a) => a !== '--ignore-scripts')], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: scratch }, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(out.trim(), REGISTRY.replace(/\/$/, '') + '/');
});

test('real npm: a local tarball staged through primeNpmCache lands in the shared cache under its sha512 content path', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'npm-real-'));
  mkdirSync(join(scratch, 'pkg')); writeFileSync(join(scratch, 'pkg', 'package.json'), '{"name":"lwc-fixture","version":"1.0.0"}');
  execFileSync('tar', ['-czf', join(scratch, 'fixture.tgz'), '-C', scratch, 'pkg']);
  const bytes = readFileSync(join(scratch, 'fixture.tgz'));
  const cache = mkdtempSync(join(tmpdir(), 'prime-cache-'));
  // exec seam: the same real npm, but with the exact URL swapped for the local tarball so no network is used
  const exec = async (cmd: string, args: string[], o: Record<string, unknown> = {}): Promise<ExecResult> => {
    const swapped = args.map((a) => (a === tarballUrl('lwc-fixture', '1.0.0') ? join(scratch, 'fixture.tgz') : a));
    try { const stdout = execFileSync(cmd, [...swapped, '--offline'], { encoding: 'utf8', cwd: String(o.cwd), env: o.env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] }); return { code: 0, stdout, stderr: '', timedOut: false, truncated: false }; }
    catch (e) { const err = e as { status?: number; stdout?: string; stderr?: string }; return { code: err.status ?? 1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? ''), timedOut: false, truncated: false }; }
  };
  const artifact: Artifact = { key: 'node_modules/lwc-fixture', name: 'lwc-fixture', version: '1.0.0', resolved: tarballUrl('lwc-fixture', '1.0.0'), integrity: sriOf(bytes), specs: {} };
  const out = await primeNpmCache({ artifacts: [artifact], cacheDir: cache, timeoutMs: 60_000, maxBytes: 10_000_000, exec: exec as never });
  assert.ok(out.ok, JSON.stringify(out));
  assert.ok(existsSync(contentPath(cache, sriOf(bytes))), 'content stored under the tarball sha512 in the shared cache');
  assert.ok(out.bytesAdded > 0);
  const wrong: Artifact = { ...artifact, integrity: sriOf(Buffer.from('not the tarball')) };
  const bad = await primeNpmCache({ artifacts: [wrong], cacheDir: mkdtempSync(join(tmpdir(), 'prime-cache-')), timeoutMs: 60_000, maxBytes: 10_000_000, exec: exec as never });
  assert.ok(!bad.ok); assert.match(bad.reason, /does not match the lockfile's integrity/);
});

// ---------------------------------------------------------------- pipeline: an offline miss primes once, then setup is retried

/** The lockfile change is policy-flagged (dependency review); approve it like an owner would, then keep cycling. */
async function runThroughPolicy(e: ReturnType<typeof makeEnv>, identifier: string) {
  for (let i = 0; i < 6; i++) {
    await e.cycle();
    const j = job(e, identifier);
    if (j.status === 'blocked' && /dependency|package-lock|package\.json/.test(String(j.blocked_reason))) await answerBlocked(e.ctx, getJob(e.ctx.db, j.id)!, 'approve');
    if (['awaiting_merge', 'done', 'failed'].includes(j.status)) break;
  }
  return job(e, identifier);
}
const ENOTCACHED = { code: 1, stdout: '', stderr: "npm ERR! code ENOTCACHED\nnpm ERR! request to https://registry.npmjs.org/left-pad failed: cache mode is 'only-if-cached' but no cached response is available.", timedOut: false, truncated: false };

test('pipeline: a validation setup failing with ENOTCACHED primes the cache (once per candidate) and retries', async () => {
  const cache = mkdtempSync(join(tmpdir(), 'prime-cache-'));
  const primes: Artifact[][] = [];
  const e = makeEnv({
    project: { setup: ['true'], npmCacheDir: cache, npmCachePrime: true, approvedDependencies: ['left-pad'] },
    behaviors: { coding: async (spec) => {
      writeFileSync(join(spec.cwd, 'CHANGES.md'), '- ticket: change\n');
      writeFileSync(join(spec.cwd, 'package-lock.json'), lock({ 'node_modules/left-pad': reg('left-pad') }));
      return { structured: { status: 'completed', summary: 'done (fake)', filesChanged: ['CHANGES.md', 'package-lock.json'], testsAdded: [], commandsRun: [], decisions: [], knownLimitations: [] } };
    } },
  });
  let setupCalls = 0;
  const real = e.ctx.runCommand;
  e.ctx.runCommand = (async (cmd: string, cwd: string, ...rest: unknown[]) => {
    if (cmd === 'true' && cwd.includes('/candidates/') && ++setupCalls === 1) return ENOTCACHED;
    return (real as (...a: unknown[]) => Promise<unknown>)(cmd, cwd, ...rest);
  }) as typeof e.ctx.runCommand;
  e.ctx.fetchPackument = registry().fetchPackument;
  e.ctx.primeNpmCache = async (req) => { primes.push(req.artifacts); return { ok: true, artifacts: req.artifacts.length, bytesAdded: 12_345, durationMs: 10, command: ['npm', 'cache', 'add'] }; };
  const t = await e.tracker.createTicket({ projectKey: 'demo', title: 'Add left-pad', description: '', status: 'ready', priority: 2 });
  const j = await runThroughPolicy(e, t.identifier);
  assert.equal(primes.length, 1, 'primed exactly once'); assert.deepEqual(primes[0]!.map((a) => a.name), ['left-pad']);
  assert.equal(setupCalls, 2, 'setup was retried after priming');
  assert.ok(['awaiting_merge', 'done'].includes(j.status), String(j.blocked_reason ?? j.error ?? j.status));
  const ev = e.ctx.db.prepare("SELECT message FROM events WHERE type = 'cache.primed'").get() as { message: string } | undefined;
  assert.ok(ev && /1 artifact\(s\).*left-pad/.test(String(ev.message)), String(ev?.message));
});

test('pipeline: an unapproved new package is refused, nothing is primed, and the reason reaches the coding agent', async () => {
  const cache = mkdtempSync(join(tmpdir(), 'prime-cache-'));
  let primes = 0;
  const prompts: string[] = [];
  const e = makeEnv({
    project: { setup: ['true'], npmCacheDir: cache, npmCachePrime: true, approvedDependencies: [] },
    behaviors: { coding: async (spec) => {
      prompts.push(spec.prompt);
      writeFileSync(join(spec.cwd, 'CHANGES.md'), '- ticket: change\n');
      writeFileSync(join(spec.cwd, 'package-lock.json'), lock({ 'node_modules/evil': reg('evil') }));
      return { structured: { status: 'completed', summary: 'done (fake)', filesChanged: ['CHANGES.md', 'package-lock.json'], testsAdded: [], commandsRun: [], decisions: [], knownLimitations: [] } };
    } },
  });
  const real2 = e.ctx.runCommand;
  e.ctx.runCommand = (async (cmd: string, cwd: string, ...rest: unknown[]) => (cmd === 'true' && cwd.includes('/candidates/') ? ENOTCACHED : (real2 as (...a: unknown[]) => Promise<unknown>)(cmd, cwd, ...rest))) as typeof e.ctx.runCommand;
  e.ctx.fetchPackument = registry().fetchPackument;
  e.ctx.primeNpmCache = async () => { primes++; return { ok: true, artifacts: 0, bytesAdded: 0, durationMs: 0, command: [] }; };
  const t = await e.tracker.createTicket({ projectKey: 'demo', title: 'Add evil', description: '', status: 'ready', priority: 2 });
  await runThroughPolicy(e, t.identifier);
  assert.equal(primes, 0, 'never primed');
  const refused = e.ctx.db.prepare("SELECT message FROM events WHERE type = 'cache.prime.refused'").get() as { message: string } | undefined;
  assert.ok(refused && /neither approved.*evil/.test(String(refused.message)), String(refused?.message));
  assert.ok(prompts.some((p) => /Automatic npm cache priming did not run: new packages are neither approved.*evil/s.test(p)), 'the refusal reason reached the coding agent in its rework prompt');
});
