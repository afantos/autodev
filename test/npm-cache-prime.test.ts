import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, symlinkSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { REGISTRY, MAX_PACKUMENT_BYTES, cacheBytes, contentPath, downloadCapped, integrityMatches, looksLikeOfflineMiss, npmIsolationArgs, packageName, packumentUrl, parseLockfile, planPrime, primeNpmCache, readCapped, readLockfileSafely, specAuthorizes, sriOf, tarballUrl } from '../src/npm-cache-prime.ts';
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
  assert.ok(!(await planPrime(cand, BASE, [], { ...LIMITS, maxArtifacts: 3 }, r.fetchPackument)).ok, '4 registry verifications (existing with new specs + 3 versions of d) exceed 3');
  const ok = await planPrime(cand, BASE, [], { ...LIMITS, maxArtifacts: 4 }, r.fetchPackument);
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
    const local = args[2]!;
    assert.ok(!local.startsWith('http'), 'npm only ever ingests a local, already verified file');
    assert.ok(args.includes('--offline'), 'npm runs offline');
    const stage = args[args.indexOf('--cache') + 1]!;
    assert.notEqual(stage, cache, 'npm writes into a staged cache, never straight into the shared one');
    if (!opts.skipContent) {
      // simulate npm storing the file under the content path of its own sha512
      const p = contentPath(stage, sriOf(readFileSync(local))); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, Buffer.alloc(opts.bytesPerAdd ?? 100));
    }
    return { code: 0, stdout: '', stderr: '', timedOut: false, truncated: false };
  };
  return { exec, calls };
}
/** A fake tarball server: the body is the bytes art() hashes into its integrity, unless overridden. */
function tarballs(over: Record<string, Buffer | { status: number }> = {}) {
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input); urls.push(url);
    assert.equal(init?.redirect, 'error', 'redirects are never followed');
    const name = url.slice(REGISTRY.length).split('/-/')[0]!; const version = url.match(/-(\d[^/]*)\.tgz$/)![1]!;
    const o = over[`${name}@${version}`];
    if (o && !Buffer.isBuffer(o)) return new Response(null, { status: o.status });
    return new Response(new Uint8Array(o ?? Buffer.from(`${name}@${version}`)), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, urls };
}
const art = (name: string, v = '1.0.0'): Artifact => ({ key: `node_modules/${name}`, name, version: v, resolved: tarballUrl(name, v), integrity: SRI(`${name}@${v}`), specs: {} });

test('primeNpmCache: one `npm cache add <exact URL>` per artifact with --ignore-scripts, null configs, the registry and a clean environment', async () => {
  const cache = mkdtempSync(join(tmpdir(), 'prime-cache-'));
  const f = fakeExec(cache);
  const t = tarballs();
  const out = await primeNpmCache({ artifacts: [art('pg'), art('pg-pool')], cacheDir: cache, timeoutMs: 1000, maxBytes: 1e6, exec: f.exec as never, fetchImpl: t.fetchImpl });
  assert.deepEqual(t.urls, [tarballUrl('pg', '1.0.0'), tarballUrl('pg-pool', '1.0.0')], 'only the exact verified URLs are requested');
  assert.ok(out.ok, JSON.stringify(out)); assert.equal(out.artifacts, 2); assert.equal(out.bytesAdded, 200);
  assert.equal(f.calls.length, 2);
  for (const [i, c] of f.calls.entries()) {
    assert.deepEqual(c.args.slice(0, 2), ['cache', 'add']); assert.ok(c.args[2]!.endsWith('.tgz') && !c.args[2]!.startsWith('http'));
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
  const out = await primeNpmCache({ artifacts: [art('pg')], cacheDir: cache, timeoutMs: 1000, maxBytes: 1e6, exec: fakeExec(cache, { skipContent: true }).exec as never, fetchImpl: tarballs().fetchImpl });
  assert.ok(!out.ok); assert.match(out.reason, /no content for the lockfile's integrity/);
});

test('primeNpmCache stops at the byte budget and reports npm failures', async () => {
  const cache = mkdtempSync(join(tmpdir(), 'prime-cache-'));
  const f = fakeExec(cache, { bytesPerAdd: 600 });
  const out = await primeNpmCache({ artifacts: [art('a'), art('b'), art('c')], cacheDir: cache, timeoutMs: 1000, maxBytes: 1000, exec: f.exec as never, fetchImpl: tarballs().fetchImpl });
  assert.ok(!out.ok); assert.match(out.reason, /byte budget/); assert.equal(f.calls.length, 2, 'stopped at the add that would cross the budget');
  assert.equal(cacheBytes(cache), 600, 'only the first artifact was promoted; the over-budget one never reached the shared cache');
  const bad = await primeNpmCache({ artifacts: [art('a')], cacheDir: cache, timeoutMs: 1000, maxBytes: 1e6, exec: fakeExec(cache, { fail: true }).exec as never, fetchImpl: tarballs().fetchImpl });
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

test('specAuthorizes uses npm semver semantics: an ordinary range never admits a prerelease, an explicit one does', () => {
  assert.ok(!specAuthorizes('dep', '^1.2.0', { name: 'dep', version: '1.9.0-attacker.0' }));
  assert.ok(!specAuthorizes('dep', '>=1.0.0', { name: 'dep', version: '2.0.0-rc.1' }));
  assert.ok(specAuthorizes('dep', '^1.2.0-beta.1', { name: 'dep', version: '1.2.0-beta.3' }), 'same-tuple prerelease named by the range');
  assert.ok(!specAuthorizes('dep', '^1.2.0-beta.1', { name: 'dep', version: '1.3.0-beta.1' }), 'other-tuple prerelease');
});

test('planPrime refuses many spec-only changes before any registry access', async () => {
  const basePk: Record<string, object> = {}; const candPk: Record<string, object> = {};
  for (let i = 0; i < 50; i++) { basePk[`node_modules/b${i}`] = reg(`b${i}`); candPk[`node_modules/b${i}`] = reg(`b${i}`, '1.0.0', { dependencies: { x: '^1' } }); }
  const r = registry();
  const p = await planPrime(lock(candPk), lock(basePk), [], { maxArtifacts: 1, maxBytes: 1e6 }, r.fetchPackument);
  assert.ok(!p.ok); assert.match(p.reason, /50 new or changed lockfile entries exceed the limit of 1/);
  assert.equal(r.calls.length, 0, 'no registry request was made');
});

test('planPrime stops at its deadline and on the caller\'s abort signal, passing the signal to each lookup', async () => {
  const cand = lock({ 'node_modules/existing': reg('existing'), 'node_modules/pg': reg('pg'), 'node_modules/pg-pool': reg('pg-pool') });
  const seen: Array<AbortSignal | undefined> = [];
  const slow = async (_n: string, _v: string, signal?: AbortSignal) => { seen.push(signal); await new Promise((res, rej) => { const t = setTimeout(res, 5_000); signal?.addEventListener('abort', () => { clearTimeout(t); rej(new Error('aborted')); }); }); return null; };
  const t0 = Date.now();
  const p = await planPrime(cand, BASE, ['pg'], { maxArtifacts: 10, maxBytes: 1e6, deadlineMs: 100 }, slow);
  assert.ok(!p.ok); assert.match(p.reason, /deadline/); assert.ok(Date.now() - t0 < 2_000); assert.ok(seen[0] instanceof AbortSignal);
  const ctrl = new AbortController(); ctrl.abort();
  const q = await planPrime(cand, BASE, ['pg'], LIMITS, registry().fetchPackument, ctrl.signal);
  assert.ok(!q.ok); assert.match(q.reason, /cancelled/);
});

test('downloadCapped cuts an oversized response off at the cap and refuses non-registry URLs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dl-'));
  let pulled = 0;
  const endless = (async () => new Response(new ReadableStream<Uint8Array>({ pull(c) { pulled += 1024; c.enqueue(new Uint8Array(1024)); } }), { status: 200 })) as unknown as typeof fetch;
  const r = await downloadCapped(tarballUrl('big', '1.0.0'), join(dir, 'a.tgz'), 4096, 5_000, undefined, endless);
  assert.ok(!r.ok); assert.match(r.reason, /cut off past the remaining budget of 4096/); assert.ok(pulled <= 4096 + 2048, 'stopped reading right after the cap');
  const declared = (async () => new Response('x', { status: 200, headers: { 'content-length': '999999' } })) as unknown as typeof fetch;
  const d = await downloadCapped(tarballUrl('big', '1.0.0'), join(dir, 'b.tgz'), 4096, 5_000, undefined, declared);
  assert.ok(!d.ok); assert.match(d.reason, /over the remaining budget/);
  const other = await downloadCapped('https://evil.example/x.tgz', join(dir, 'c.tgz'), 4096, 5_000, undefined, declared);
  assert.ok(!other.ok); assert.match(other.reason, /refusing to download/);
  assert.ok(integrityMatches(Buffer.from('abc'), sriOf(Buffer.from('abc'))) && !integrityMatches(Buffer.from('abd'), sriOf(Buffer.from('abc'))));
});

test('primeNpmCache: a tarball larger than the remaining budget is never written past the cap nor promoted', async () => {
  const cache = mkdtempSync(join(tmpdir(), 'prime-cache-'));
  const huge = tarballs({ 'pg@1.0.0': Buffer.alloc(50_000) });
  const out = await primeNpmCache({ artifacts: [art('pg')], cacheDir: cache, timeoutMs: 1000, maxBytes: 10_000, exec: fakeExec(cache).exec as never, fetchImpl: huge.fetchImpl });
  assert.ok(!out.ok); assert.match(out.reason, /cut off past the remaining budget/);
  assert.equal(cacheBytes(cache), 0);
});

test('planPrime: optionalDependencies override dependencies for the same name, as in npm', async () => {
  const cand = (v: string) => lock({ 'node_modules/existing': reg('existing'), 'node_modules/pg': reg('pg'), 'node_modules/child': reg('child', v) });
  const r = registry({ 'pg@1.0.0': { name: 'pg', version: '1.0.0', dist: { tarball: tarballUrl('pg', '1.0.0'), integrity: SRI('pg@1.0.0') }, dependencies: { child: '^1' }, optionalDependencies: { child: '^2' } } });
  const one = await planPrime(cand('1.0.0'), BASE, ['pg'], LIMITS, r.fetchPackument);
  assert.ok(!one.ok, 'child@1 is not authorized: the optional ^2 spec wins'); assert.match(one.reason, /child@1\.0\.0/);
  assert.ok((await planPrime(cand('2.0.0'), BASE, ['pg'], LIMITS, r.fetchPackument)).ok);
});

test('planPrime fails fast on tens of thousands of duplicate placements of one approved package', async () => {
  const pk: Record<string, object> = { 'node_modules/existing': reg('existing'), 'node_modules/pg': reg('pg', '1.0.0', { dependencies: { child: '^1' } }) };
  for (let i = 0; i < 20_000; i++) pk[`node_modules/d${i}/node_modules/child`] = reg('child', '1.0.0', { dependencies: { child: '^1' } });
  const r = registry({}, { 'pg@1.0.0': { child: '^1' }, 'child@1.0.0': { child: '^1' } });
  const t0 = Date.now();
  const p = await planPrime(lock(pk), BASE, ['pg'], LIMITS, r.fetchPackument);
  assert.ok(!p.ok); assert.match(p.reason, /placements exceed the limit of 5000/);
  assert.ok(Date.now() - t0 < 2_000, 'refused quickly'); assert.equal(r.calls.length, 0, 'before any registry request');
});

test('planPrime: duplicate placements below the limit traverse a deduplicated graph within the work budget', async () => {
  const pk: Record<string, object> = { 'node_modules/existing': reg('existing'), 'node_modules/pg': reg('pg', '1.0.0', { dependencies: { child: '^1' } }) };
  for (let i = 0; i < 4_000; i++) pk[`node_modules/d${i}/node_modules/child`] = reg('child', '1.0.0');
  const r = registry({}, { 'pg@1.0.0': { child: '^1' } });
  const t0 = Date.now();
  const p = await planPrime(lock(pk), BASE, ['pg'], LIMITS, r.fetchPackument);
  assert.ok(p.ok, JSON.stringify(p).slice(0, 200)); assert.equal(p.artifacts.length, 2); assert.ok(Date.now() - t0 < 2_000);
  // 4,000 placements of child@1.0.0 collapse to one node: a handful of steps, independent of the placement count
  assert.ok((await planPrime(lock(pk), BASE, ['pg'], { ...LIMITS, maxWork: 5 }, r.fetchPackument)).ok, 'a few steps for 4,000 placements');
  const tight = await planPrime(lock(pk), BASE, ['pg'], { ...LIMITS, maxWork: 0 }, r.fetchPackument);
  assert.ok(!tight.ok); assert.match(tight.reason, /work budget of 0 steps/);
});

test('planPrime: 400 versions of an unapproved package nobody depends on are refused without a single registry lookup', async () => {
  const pk: Record<string, object> = { 'node_modules/existing': reg('existing') };
  for (let i = 0; i < 400; i++) pk[`node_modules/x${i}/node_modules/evil`] = reg('evil', `1.0.${i}`);
  const r = registry();
  const p = await planPrime(lock(pk), BASE, [], { ...LIMITS, maxArtifacts: 1000 }, r.fetchPackument);
  assert.ok(!p.ok); assert.match(p.reason, /neither approved.*evil@1\.0\./);
  assert.equal(r.calls.length, 0);
});

test('planPrime: huge registry dependency maps behind small declared edges are refused early, before all lookups', async () => {
  const pk: Record<string, object> = { 'node_modules/existing': reg('existing') };
  for (let i = 0; i < 20; i++) pk[`node_modules/p${i}`] = reg(`p${i}`);
  const huge = Object.fromEntries([...Array(30_000)].map((_, j) => [`dep${j}`, '^1']));
  const over: Record<string, Packument> = {};
  for (let i = 0; i < 20; i++) over[`p${i}@1.0.0`] = { name: `p${i}`, version: '1.0.0', dist: { tarball: tarballUrl(`p${i}`, '1.0.0'), integrity: SRI(`p${i}@1.0.0`) }, dependencies: huge };
  const r = registry(over);
  const p = await planPrime(lock(pk), BASE, [...Array(20)].map((_, i) => `p${i}`), { ...LIMITS, maxArtifacts: 100 }, r.fetchPackument);
  assert.ok(!p.ok); assert.match(p.reason, /registry-declared dependency edges exceed|registry metadata exceeded|work budget/);
  assert.ok(r.calls.length < 20, `stopped after ${r.calls.length} of 20 lookups`);
});

test('planPrime: a dependency that only becomes reachable through a verified parent is verified after it', async () => {
  const cand = lock({ 'node_modules/existing': reg('existing'), 'node_modules/child': reg('child'), 'node_modules/pg': reg('pg') });
  const r = registry({}, { 'pg@1.0.0': { child: '^1' } });
  const p = await planPrime(cand, BASE, ['pg'], LIMITS, r.fetchPackument);
  assert.ok(p.ok, JSON.stringify(p)); assert.deepEqual(r.calls, ['pg@1.0.0', 'child@1.0.0']);
});

test('parseLockfile validates dependency maps before copying them: huge string, array, non-string values, non-object entries', () => {
  const huge = 'x'.repeat(2_000_000);
  for (const [label, extra] of Object.entries<object>({
    'a huge string instead of a map': { dependencies: huge },
    'an array': { dependencies: ['a', 'b'] },
    'a non-string value': { optionalDependencies: { a: 1 } },
    'a nested object value': { peerDependencies: { a: { b: 'c' } } },
  })) {
    const t0 = Date.now();
    const p = parseLockfile(lock({ 'node_modules/y': reg('y', '1.0.0', extra) }));
    assert.ok(!p.ok, label); assert.match(p.reason, /not a plain object|not a string/, label);
    assert.ok(Date.now() - t0 < 1_000, `${label}: refused quickly`);
  }
  assert.ok(!parseLockfile(JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/y': 'string' } })).ok);
  assert.ok(!parseLockfile(JSON.stringify({ lockfileVersion: 3, packages: [] })).ok);
});

test('parseLockfile counts edges and spec bytes while scanning and refuses past either budget', () => {
  const many = Object.fromEntries([...Array(60_000)].map((_, j) => [`d${j}`, '^1']));
  const p = parseLockfile(lock({ 'node_modules/y': reg('y', '1.0.0', { dependencies: many }) }));
  assert.ok(!p.ok); assert.match(p.reason, /edges exceed the limit of 50000/);
  const fat = { dependencies: { a: '^1 || ' + '1.0.0 || '.repeat(700_000) } };
  const q = parseLockfile(lock({ 'node_modules/y': reg('y', '1.0.0', fat) }));
  assert.ok(!q.ok); assert.match(q.reason, /specs exceed the limit of 5000000 bytes/);
});

test('planPrime: thousands of duplicate placements of an artifact with a large registry dependency map build its node once', async () => {
  const pk: Record<string, object> = { 'node_modules/existing': reg('existing'), 'node_modules/pg': reg('pg') };
  for (let i = 0; i < 4_900; i++) pk[`node_modules/d${i}/node_modules/pg`] = reg('pg');
  const big = Object.fromEntries([...Array(20_000)].map((_, j) => [`dep${j}`, '^1']));
  const r = registry({ 'pg@1.0.0': { name: 'pg', version: '1.0.0', dist: { tarball: tarballUrl('pg', '1.0.0'), integrity: SRI('pg@1.0.0') }, dependencies: big } });
  const t0 = Date.now();
  const p = await planPrime(lock(pk), BASE, ['pg'], LIMITS, r.fetchPackument);
  assert.ok(p.ok, JSON.stringify(p).slice(0, 200)); assert.equal(r.calls.length, 1, 'one lookup for all 4,901 placements');
  assert.ok(Date.now() - t0 < 3_000, `built in ${Date.now() - t0} ms`);
  const tight = await planPrime(lock(pk), BASE, ['pg'], { ...LIMITS, maxWork: 25_000 }, r.fetchPackument);
  assert.ok(!tight.ok); assert.match(tight.reason, /work budget/);
});

test('planPrime: a registry packument with a malformed dependency map is refused', async () => {
  const cand = lock({ 'node_modules/existing': reg('existing'), 'node_modules/pg': reg('pg') });
  const r = registry({ 'pg@1.0.0': { name: 'pg', version: '1.0.0', dist: { tarball: tarballUrl('pg', '1.0.0'), integrity: SRI('pg@1.0.0') }, dependencies: 'x'.repeat(100_000) as never } });
  const p = await planPrime(cand, BASE, ['pg'], LIMITS, r.fetchPackument);
  assert.ok(!p.ok); assert.match(p.reason, /registry-declared .*not a plain object/);
});

test('planPrime: a large base spec map with thousands of altered duplicate placements is canonicalized once, within the work budget', async () => {
  const bigSpecs = Object.fromEntries([...Array(8_000)].map((_, j) => [`dep${j}`, '^1']));
  const base = lock({ 'node_modules/existing': reg('existing', '1.0.0', { dependencies: bigSpecs }) });
  const pk: Record<string, object> = { 'node_modules/existing': reg('existing', '1.0.0', { dependencies: { altered: '^1' } }) };
  for (let i = 0; i < 4_900; i++) pk[`node_modules/d${i}/node_modules/existing`] = reg('existing', '1.0.0', { dependencies: { altered: '^1' } });
  const r = registry({}, { 'existing@1.0.0': { altered: '^1' } });
  const t0 = Date.now();
  const p = await planPrime(lock(pk), base, [], LIMITS, r.fetchPackument);
  assert.ok(p.ok, JSON.stringify(p).slice(0, 200)); assert.ok(Date.now() - t0 < 2_000, `classified in ${Date.now() - t0} ms`);
  assert.equal(r.calls.length, 1, 'the altered base artifact is re-verified once');
  const tight = await planPrime(lock(pk), base, [], { ...LIMITS, maxWork: 5_000 }, r.fetchPackument);
  assert.ok(!tight.ok); assert.match(tight.reason, /work budget/);
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
  // fetch seam serves the fixture bytes; npm itself runs for real (offline) on the verified local file
  const fetchImpl = (async () => new Response(bytes, { status: 200 })) as unknown as typeof fetch;
  const exec = async (cmd: string, args: string[], o: Record<string, unknown> = {}): Promise<ExecResult> => {
    try { const stdout = execFileSync(cmd, args, { encoding: 'utf8', cwd: String(o.cwd), env: o.env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] }); return { code: 0, stdout, stderr: '', timedOut: false, truncated: false }; }
    catch (e) { const err = e as { status?: number; stdout?: string; stderr?: string }; return { code: err.status ?? 1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? ''), timedOut: false, truncated: false }; }
  };
  const artifact: Artifact = { key: 'node_modules/lwc-fixture', name: 'lwc-fixture', version: '1.0.0', resolved: tarballUrl('lwc-fixture', '1.0.0'), integrity: sriOf(bytes), specs: {} };
  const out = await primeNpmCache({ artifacts: [artifact], cacheDir: cache, timeoutMs: 60_000, maxBytes: 10_000_000, exec: exec as never, fetchImpl });
  assert.ok(out.ok, JSON.stringify(out));
  assert.ok(existsSync(contentPath(cache, sriOf(bytes))), 'content stored under the tarball sha512 in the shared cache');
  assert.ok(out.bytesAdded > 0);
  const wrong: Artifact = { ...artifact, integrity: sriOf(Buffer.from('not the tarball')) };
  const bad = await primeNpmCache({ artifacts: [wrong], cacheDir: mkdtempSync(join(tmpdir(), 'prime-cache-')), timeoutMs: 60_000, maxBytes: 10_000_000, exec: exec as never, fetchImpl });
  assert.ok(!bad.ok); assert.match(bad.reason, /downloaded bytes do not match the lockfile's integrity/);
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
