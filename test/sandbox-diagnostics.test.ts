import { test } from 'node:test';
import assert from 'node:assert/strict';
import { macosSandboxProfile, runSandboxed } from '../src/command-sandbox.ts';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifySandbox, probeNetworkIsolation } from '../src/sandbox-diagnostics.ts';
import { run } from '../src/exec.ts';
import type { ExecResult } from '../src/exec.ts';
import { makeEnv, job, sandboxAvailable } from './helpers.ts';
import { updateJob } from '../src/db.ts';

const result = (code: number, stdout = '', stderr = ''): ExecResult => ({ code, stdout, stderr, timedOut: false, truncated: false, signal: null });

test('a broken autodev profile cannot masquerade as unavailable host sandboxing', () => {
  assert.equal(classifySandbox(result(71, '', 'sandbox_apply: Operation not permitted')).status, 'host_unavailable');
  assert.equal(classifySandbox(result(0), result(1)).status, 'profile_failed');
  assert.equal(classifySandbox(result(0), result(137)).status, 'profile_failed');
  assert.equal(classifySandbox(result(0), result(0)).status, 'profile_failed', 'exit zero without the execution marker is insufficient');
  assert.equal(classifySandbox(result(0), result(0, 'AUTODEV_SANDBOX_READY\n')).status, 'ready');
});

test('macOS bootstrap reads the literal root without granting recursive filesystem access', () => {
  const profile = macosSandboxProfile('/work', '/scratch', '/runtime', 'AUTODEV_TEST');
  assert.match(profile, /\(allow file-read\* file-test-existence \(literal "\/"\)\)/);
  assert.doesNotMatch(profile, /\(subpath "\/"\)/);
  assert.match(profile, /\(allow file-map-executable[^\n]*\(subpath "\/runtime"\)/);
  assert.match(profile, /\(deny default \(with message "AUTODEV_TEST"\)\)/);
  assert.doesNotMatch(profile, /\(allow (?:default|network\*)\)/);
  assert.match(profile, /\(deny file-write\* \(literal "\/work\/\.git"\)\)/);
});

if (process.platform === 'darwin') test('macOS profile compiles through the native parser without applying a nested sandbox', async () => {
  const profile = macosSandboxProfile('/work', '/scratch', '/runtime', 'AUTODEV_COMPILE_TEST');
  const python = `import ctypes,sys
lib=ctypes.CDLL('/usr/lib/libsandbox.1.dylib')
compile_profile=lib.sandbox_compile_string
compile_profile.argtypes=[ctypes.c_char_p,ctypes.c_void_p,ctypes.POINTER(ctypes.c_char_p)]
compile_profile.restype=ctypes.c_void_p
error=ctypes.c_char_p()
profile=compile_profile(sys.stdin.buffer.read(),None,ctypes.byref(error))
if not profile:
 print(error.value.decode() if error.value else 'profile compilation failed',file=sys.stderr)
 sys.exit(1)
lib.sandbox_free_profile.argtypes=[ctypes.c_void_p]
lib.sandbox_free_profile(profile)
print('compiled')`;
  const r = await run('/usr/bin/python3', ['-c', python], { input: profile, timeoutMs: 5000 });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'compiled');
});

test('process diagnostics retain a terminating signal instead of reporting a silent exit one', async () => {
  const r = await run(process.execPath, ['-e', 'process.kill(process.pid,"SIGKILL")'], { timeoutMs: 5000 });
  assert.equal(r.signal, 'SIGKILL');
  assert.equal(r.code, 137);
});

test('a broken command runtime blocks before any coding agent or AI usage', async () => {
  const e = makeEnv();
  e.ctx.runCommand = async () => ({ ...result(137), signal: 'SIGKILL' });
  const t = await e.tracker.createTicket({ projectKey: 'demo', title: 'Sandbox preflight', description: '', status: 'ready', priority: 2 });
  await e.cycle();
  assert.equal(job(e, t.identifier).status, 'blocked');
  assert.match(job(e, t.identifier).blocked_reason, /command sandbox preflight failed/);
  assert.match(job(e, t.identifier).blocked_reason, /SIGKILL/);
  assert.equal(e.runner.calls.length, 0);
  assert.equal((e.ctx.db.prepare('SELECT COUNT(*) n FROM usage').get() as { n: number }).n, 0);
});

test('requeued work also checks the host runtime before paying for another coding attempt', async () => {
  const e = makeEnv();
  const t = await e.tracker.createTicket({ projectKey: 'demo', title: 'Queued preflight', description: '', status: 'ready', priority: 2 });
  await e.cycle();
  const j = job(e, t.identifier); const calls = e.runner.calls.length;
  updateJob(e.ctx.db, j.id, { status: 'queued', stage: 'workspace' });
  await e.tracker.setStatus(t.id, 'in_progress');
  e.ctx.runCommand = async () => result(1);
  await e.cycle();
  assert.equal(job(e, t.identifier).status, 'blocked');
  assert.equal(e.runner.calls.length, calls);
});

// ---------------------------------------------------------------- network isolation (listener-based)

test('network probe: an unsandboxed command reaches the host listener and is reported as not isolated', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'net-unsandboxed-'));
  const r = await probeNetworkIsolation((cmd, dir) => run(cmd, [], { cwd: dir, shell: true, timeoutMs: 15_000 }), cwd);
  assert.equal(r.isolated, false);
  assert.match(String(r.reason), /reached a host listener/);
  assert.ok(r.acceptedDuringProbe >= 1, 'the listener saw the connection');
  assert.ok(Object.values(r.hostReachBefore).every(Boolean), 'positive control reached the listener');
});

test('network probe: a sandbox that never ran the probe is not accepted as isolation', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'net-notrun-'));
  const r = await probeNetworkIsolation(async () => result(1, '', 'launcher missing'), cwd);
  assert.equal(r.isolated, false);
  assert.match(String(r.reason), /did not run/);
});

test('network probe: the real OS sandbox cannot reach a listener the host can reach', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'net-real-'));
  const ready = await sandboxAvailable(root);
  if (!ready.ok) {
    assert.notEqual(process.env.AUTODEV_REQUIRE_SANDBOX_TEST, '1', `Required OS sandbox unavailable: ${ready.why}`);
    t.skip(`OS sandbox unavailable in this environment: ${ready.why}`); return;
  }
  const cwd = join(root, 'work'); mkdirSync(cwd);
  const r = await probeNetworkIsolation((cmd, dir) => runSandboxed(cmd, dir, {}, 15_000), cwd);
  assert.equal(r.isolated, true, String(r.reason));
  assert.ok(Object.values(r.hostReachBefore).every(Boolean) && Object.values(r.hostReachAfter).every(Boolean), 'host reached its listener before and after');
  assert.equal(r.acceptedDuringProbe, 0, 'the listener accepted nothing from the sandbox');
  for (const t of r.targets) assert.notEqual(r.sandbox[t], 'CONNECTED', t);
  assert.ok(r.targets.length >= 1);
});
