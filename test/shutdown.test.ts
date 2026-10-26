import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { makeRepo } from './helpers.ts';

const CLI = resolve(import.meta.dirname, '..', 'src', 'cli.ts');

/** Start `autodev run` in a child process, wait for its first tick, send SIGTERM and time the exit. */
async function runAndStop(config: Record<string, unknown>, env: Record<string, string> = {}, beforeStop?: () => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'autodev-shutdown-'));
  const repo = makeRepo(root);
  const cfgPath = join(root, 'autodev.config.yaml');
  // JSON is valid YAML. Long tick and drain windows: a timer left pending would hold the process for a minute.
  writeFileSync(cfgPath, JSON.stringify({
    dataDir: join(root, 'data'), workspaceDir: join(root, 'work'), tracker: 'local', scm: 'local', runner: 'fake',
    projects: [{ key: 'demo', repo, validate: ['true'] }], sandbox: { enabled: false }, report: { hour: -1 },
    loop: { tickSeconds: 60 }, ...config,
  }));
  const { AUTODEV_QUIET: _quiet, ...parentEnv } = process.env;
  const child = spawn(process.execPath, [CLI, '--config', cfgPath, 'run'], { env: { ...parentEnv, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => child.on('exit', (code, signal) => r({ code, signal })));
  // orchestrator.start is logged just before the first tick; the pause below lets that tick finish and the loop sleep.
  for (const deadline = Date.now() + 20_000; !out.includes('orchestrator.start'); ) {
    if (Date.now() > deadline || child.exitCode !== null) throw new Error(`orchestrator did not start:\n${out}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  await new Promise((r) => setTimeout(r, 500));
  await beforeStop?.();
  const sent = Date.now();
  child.kill('SIGTERM');
  const killer = setTimeout(() => child.kill('SIGKILL'), 15_000);
  const result = await exited;
  clearTimeout(killer);
  return { ...result, ms: Date.now() - sent, out };
}

test('autodev run exits promptly with code 0 on SIGTERM when idle', async () => {
  const r = await runAndStop({});
  assert.equal(r.signal, null, r.out);
  assert.equal(r.code, 0, r.out);
  assert.ok(r.ms < 5000, `exited ${r.ms}ms after SIGTERM:\n${r.out}`);
  assert.match(r.out, /orchestrator\.stop: workers remaining: 0/);
  assert.doesNotMatch(r.out, /event loop still held/, 'nothing should need the 5 s backstop');
});

test('autodev run exits promptly on SIGTERM with the dashboard serving a keep-alive client', async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const token = 'test-token';
  let status = 0;
  // The test process's fetch keeps its connection to the dashboard open (keep-alive) while the orchestrator stops.
  const keepAliveRequest = async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/status?token=${token}`);
    await res.text();
    status = res.status;
  };
  const r = await runAndStop({ dashboard: { enabled: true, host: '127.0.0.1', port } }, { AUTODEV_DASHBOARD_TOKEN: token }, keepAliveRequest);
  assert.equal(status, 200);
  assert.equal(r.signal, null, r.out);
  assert.equal(r.code, 0, r.out);
  assert.ok(r.ms < 5000, `exited ${r.ms}ms after SIGTERM:\n${r.out}`);
});
