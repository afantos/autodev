import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REGISTRY, listManifests, looksLikeOfflineMiss, packageName, planPrime, primeNpmCache } from '../src/npm-cache-prime.ts';
import { makeEnv, job } from './helpers.ts';
import { answerBlocked } from '../src/pipeline.ts';
import { getJob } from '../src/db.ts';
import type { ExecResult } from '../src/exec.ts';

// 2026-10-26: dependency-adding tickets blocked three times on luckywinclub because the offline npm cache lacked
// their packages and an operator had to prime it by hand. Priming is now automatic, under the rules tested here.

const tgz = (name: string, v = '1.0.0') => `${REGISTRY}${name}/-/${name.split('/').pop()}-${v}.tgz`;
const SRI = 'sha512-' + 'A'.repeat(86) + '==';
function lock(packages: Record<string, object>): string {
  return JSON.stringify({ name: 'demo', lockfileVersion: 3, requires: true, packages: { '': { name: 'demo', dependencies: {} }, ...packages } });
}
const reg = (name: string, extra: object = {}) => ({ version: '1.0.0', resolved: tgz(name), integrity: SRI, ...extra });
const BASE = lock({ 'node_modules/existing': reg('existing') });

test('packageName reads the name from any lockfile key', () => {
  assert.equal(packageName('node_modules/foo'), 'foo');
  assert.equal(packageName('node_modules/@s/foo'), '@s/foo');
  assert.equal(packageName('apps/web/node_modules/foo/node_modules/bar'), 'bar');
  assert.equal(packageName('packages/core'), null);
});

test('planPrime: nothing new → nothing to prime', () => {
  const p = planPrime(BASE, BASE, [], 10);
  assert.deepEqual(p, { ok: true, newPackages: [], totalPackages: 1 });
});

test('planPrime: an approved new package and its transitive deps are primed', () => {
  const cand = lock({ 'node_modules/existing': reg('existing'), 'node_modules/pg': reg('pg', { dependencies: { 'pg-pool': '^3' } }), 'node_modules/pg-pool': reg('pg-pool') });
  const p = planPrime(cand, BASE, ['pg'], 10);
  assert.ok(p.ok); assert.deepEqual(p.newPackages.sort(), ['pg', 'pg-pool']);
});

test('planPrime: a new dependency of an existing package is primed (updates), but an unrelated new package is refused', () => {
  const cand = lock({ 'node_modules/existing': reg('existing', { dependencies: { helper: '^1' } }), 'node_modules/helper': reg('helper'), 'node_modules/sneaky': reg('sneaky') });
  const p = planPrime(cand, BASE, [], 10);
  assert.ok(!p.ok); assert.match(p.reason, /neither approved nor dependencies.*sneaky/);
  const ok = planPrime(lock({ 'node_modules/existing': reg('existing', { dependencies: { helper: '^1' } }), 'node_modules/helper': reg('helper') }), BASE, [], 10);
  assert.ok(ok.ok); assert.deepEqual(ok.newPackages, ['helper']);
});

test('planPrime: no base lockfile means every new package must be approved (or reachable from an approved one)', () => {
  const cand = lock({ 'node_modules/next': reg('next', { dependencies: { react: '^19' } }), 'node_modules/react': reg('react') });
  assert.ok(!planPrime(cand, null, [], 10).ok);
  assert.ok(planPrime(cand, null, ['next'], 10).ok);
});

for (const [label, pkg] of Object.entries({
  'git dependency': { version: '1.0.0', resolved: 'git+ssh://git@github.com/x/y.git#abc', integrity: SRI },
  'file dependency': { version: '1.0.0', resolved: 'file:../y', integrity: SRI },
  'http (not https) registry': { version: '1.0.0', resolved: 'http://registry.npmjs.org/y/-/y-1.0.0.tgz', integrity: SRI },
  'another registry': { version: '1.0.0', resolved: 'https://npm.pkg.github.com/x/-/y-1.0.0.tgz', integrity: SRI },
  'registry URL that is not a tarball': { version: '1.0.0', resolved: `${REGISTRY}y/-/y-1.0.0.tgz?token=1`, integrity: SRI },
  'missing integrity': { version: '1.0.0', resolved: tgz('y') },
  'malformed integrity': { version: '1.0.0', resolved: tgz('y'), integrity: 'md5-abc' },
  'link entry': { version: '1.0.0', link: true, resolved: '../y' },
  'no resolved URL': { version: '1.0.0', integrity: SRI },
})) {
  test(`planPrime refuses: ${label}`, () => {
    const p = planPrime(lock({ 'node_modules/existing': reg('existing'), 'node_modules/y': pkg }), BASE, ['y'], 10);
    assert.ok(!p.ok, label); assert.match(p.reason, /"y"/);
  });
}

test('planPrime refuses a workspace entry outside the repository', () => {
  const p = planPrime(lock({ '../elsewhere': { name: 'evil', version: '1.0.0' } }), BASE, [], 10);
  assert.ok(!p.ok); assert.match(p.reason, /outside the repository/);
});

test('planPrime accepts in-repo workspaces and their node_modules aliases', () => {
  const cand = JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'demo', workspaces: ['packages/*'] }, 'packages/core': { name: '@lwc/core', version: '0.0.0' }, 'node_modules/@lwc/core': { resolved: 'packages/core', link: true }, 'node_modules/existing': reg('existing') } });
  // npm writes the alias as a link to the workspace path: accepted only because a matching workspace entry exists
  const p = planPrime(cand.replace('"resolved":"packages/core","link":true', '"version":"0.0.0"'), BASE, [], 10);
  assert.ok(p.ok, JSON.stringify(p));
});

test('planPrime bounds the number of new packages', () => {
  const many: Record<string, object> = { 'node_modules/existing': reg('existing', { dependencies: Object.fromEntries([...Array(5)].map((_, i) => [`d${i}`, '^1'])) }) };
  for (let i = 0; i < 5; i++) many[`node_modules/d${i}`] = reg(`d${i}`);
  assert.ok(!planPrime(lock(many), BASE, [], 4).ok);
  assert.ok(planPrime(lock(many), BASE, [], 5).ok);
});

test('planPrime refuses lockfile v1 and invalid JSON', () => {
  assert.ok(!planPrime('{', BASE, [], 10).ok);
  assert.ok(!planPrime(JSON.stringify({ lockfileVersion: 1, dependencies: {} }), BASE, [], 10).ok);
});

test('looksLikeOfflineMiss matches npm offline-miss errors only', () => {
  assert.ok(looksLikeOfflineMiss("npm ERR! code ENOTCACHED\nnpm ERR! request to https://registry.npmjs.org/tslib failed: cache mode is 'only-if-cached' but no cached response is available."));
  assert.ok(!looksLikeOfflineMiss('npm ERR! code ERESOLVE\nunable to resolve dependency tree'));
  assert.ok(!looksLikeOfflineMiss('Error: Cannot find module'));
});

test('listManifests copies only package.json and package-lock.json, skipping node_modules, .git and symlinks', () => {
  const root = mkdtempSync(join(tmpdir(), 'prime-wt-'));
  mkdirSync(join(root, 'apps/web'), { recursive: true }); mkdirSync(join(root, 'node_modules/x'), { recursive: true }); mkdirSync(join(root, '.git'));
  for (const f of ['package.json', 'package-lock.json', '.npmrc', 'apps/web/package.json', 'node_modules/x/package.json', '.git/package.json']) writeFileSync(join(root, f), '{}');
  assert.deepEqual(listManifests(root), ['package-lock.json', 'package.json', 'apps/web/package.json']);
});

test('primeNpmCache runs npm with --ignore-scripts, a clean environment, null configs and the explicit registry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'prime-wt-'));
  writeFileSync(join(root, 'package.json'), '{"name":"demo"}'); writeFileSync(join(root, 'package-lock.json'), BASE); writeFileSync(join(root, '.npmrc'), '//registry.npmjs.org/:_authToken=SECRET');
  const cache = mkdtempSync(join(tmpdir(), 'prime-cache-'));
  const calls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
  const fakeExec = async (cmd: string, args: string[], opts: Record<string, unknown> = {}): Promise<ExecResult> => {
    calls.push({ cmd, args, opts });
    const cwd = String(opts.cwd);
    assert.ok(existsSync(join(cwd, 'package-lock.json')) && !existsSync(join(cwd, '.npmrc')), 'only manifests reach npm');
    return { code: 0, stdout: '', stderr: '', timedOut: false, truncated: false };
  };
  const out = await primeNpmCache({ worktree: root, cacheDir: cache, timeoutMs: 1000, exec: fakeExec as never });
  assert.ok(out.ok, JSON.stringify(out));
  const [c] = calls; assert.ok(c);
  assert.equal(c.cmd, 'npm'); assert.equal(c.args[0], 'ci');
  for (const flag of ['--ignore-scripts', '--no-audit', '--no-fund']) assert.ok(c.args.includes(flag), flag);
  assert.equal(c.args[c.args.indexOf('--userconfig') + 1], '/dev/null');
  assert.equal(c.args[c.args.indexOf('--globalconfig') + 1], '/dev/null');
  assert.equal(c.args[c.args.indexOf('--registry') + 1], REGISTRY);
  assert.equal(c.args[c.args.indexOf('--cache') + 1], cache);
  const env = c.opts.env as Record<string, string>;
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'PATH', 'TMPDIR', 'npm_config_cache']);
  assert.ok(!env.HOME.startsWith(process.env.HOME ?? '/nonexistent'), 'HOME is a scratch directory, not the user home');
  assert.equal(c.opts.timeoutMs, 1000);
  assert.ok(!existsSync(String(c.opts.cwd)), 'the scratch copy is removed afterwards');
});

test('primeNpmCache reports npm failures without priming', async () => {
  const root = mkdtempSync(join(tmpdir(), 'prime-wt-')); writeFileSync(join(root, 'package-lock.json'), BASE);
  const out = await primeNpmCache({ worktree: root, cacheDir: mkdtempSync(join(tmpdir(), 'prime-cache-')), timeoutMs: 1000, exec: (async () => ({ code: 1, stdout: '', stderr: 'npm ERR! 503', timedOut: false, truncated: false })) as never });
  assert.ok(!out.ok); assert.match(out.reason, /exited 1.*503/s);
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

test('pipeline: a validation setup failing with ENOTCACHED primes the cache (once per candidate) and retries', async () => {
  const cache = mkdtempSync(join(tmpdir(), 'prime-cache-'));
  mkdirSync(join(cache, '_cacache'));
  const primes: string[] = [];
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
    // the workspace stage runs setup in the worktree (base lockfile: fine); the validate stage runs it in the candidate snapshot
    if (cmd === 'true' && cwd.includes('/candidates/') && ++setupCalls === 1) return { code: 1, stdout: '', stderr: "npm ERR! code ENOTCACHED\nnpm ERR! request to https://registry.npmjs.org/left-pad failed: cache mode is 'only-if-cached' but no cached response is available.", timedOut: false, truncated: false };
    return (real as (...a: unknown[]) => Promise<unknown>)(cmd, cwd, ...rest);
  }) as typeof e.ctx.runCommand;
  e.ctx.primeNpmCache = async (req) => { primes.push(req.worktree); return { ok: true, bytesAdded: 12_345, durationMs: 10, command: ['npm', 'ci'] }; };
  const t = await e.tracker.createTicket({ projectKey: 'demo', title: 'Add left-pad', description: '', status: 'ready', priority: 2 });
  const j = await runThroughPolicy(e, t.identifier);
  assert.equal(primes.length, 1, 'primed exactly once');
  assert.equal(setupCalls, 2, 'setup was retried after priming');
  assert.ok(['awaiting_merge', 'done'].includes(j.status), String(j.blocked_reason ?? j.error ?? j.status));
  const ev = e.ctx.db.prepare("SELECT message FROM events WHERE type = 'cache.primed'").get() as { message: string } | undefined;
  assert.ok(ev && /1 new package\(s\).*left-pad/.test(String(ev.message)), String(ev?.message));
});

test('pipeline: an unapproved new package is refused, nothing is primed, and the setup failure reaches the agent', async () => {
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
  e.ctx.runCommand = (async (cmd: string, cwd: string, ...rest: unknown[]) => (cmd === 'true' && cwd.includes('/candidates/')
    ? { code: 1, stdout: '', stderr: 'npm ERR! code ENOTCACHED', timedOut: false, truncated: false }
    : (real2 as (...a: unknown[]) => Promise<unknown>)(cmd, cwd, ...rest))) as typeof e.ctx.runCommand;
  e.ctx.primeNpmCache = async () => { primes++; return { ok: true, bytesAdded: 0, durationMs: 0, command: [] }; };
  const t = await e.tracker.createTicket({ projectKey: 'demo', title: 'Add evil', description: '', status: 'ready', priority: 2 });
  await runThroughPolicy(e, t.identifier);
  assert.equal(primes, 0, 'never primed');
  const refused = e.ctx.db.prepare("SELECT message FROM events WHERE type = 'cache.prime.refused'").get() as { message: string } | undefined;
  assert.ok(refused && /neither approved.*evil/.test(String(refused.message)), String(refused?.message));
  assert.ok(e.ctx.db.prepare("SELECT 1 FROM events WHERE type = 'fix.validation setup'").get(), 'the setup failure went back to the agent as feedback');
  assert.ok(prompts.some((p) => /Automatic npm cache priming did not run: new packages are neither approved.*evil/s.test(p)), 'the refusal reason reached the coding agent in its rework prompt');
});
