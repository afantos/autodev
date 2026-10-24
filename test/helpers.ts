import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseConfig } from '../src/config.ts';
import { createCtx } from '../src/context.ts';
import type { Ctx } from '../src/context.ts';
import { openDb } from '../src/db.ts';
import { FakeRunner } from '../src/agents/fake.ts';
import type { FakeBehavior } from '../src/agents/fake.ts';
import { LocalTracker } from '../src/tracker/local.ts';
import { LocalScm } from '../src/scm/local.ts';
import { Orchestrator } from '../src/orchestrator.ts';
import type { AgentRunSpec } from '../src/agents/runner.ts';
import { run } from '../src/exec.ts';
import { commandEnv } from '../src/command-sandbox.ts';

process.env.AUTODEV_QUIET = '1';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e.com', ...args], { cwd, stdio: 'pipe' }).toString();

/** A bare repo with an initial commit on main. */
export function makeRepo(root: string): string {
  const bare = join(root, 'remote.git');
  execFileSync('git', ['init', '--bare', '-b', 'main', bare], { stdio: 'pipe' });
  const seed = join(root, 'seed');
  mkdirSync(seed);
  git(seed, 'init', '-b', 'main');
  writeFileSync(join(seed, 'README.md'), '# demo app\n');
  mkdirSync(join(seed, 'src'));
  writeFileSync(join(seed, 'src', 'index.js'), 'export const add = (a, b) => a + b;\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-m', 'init');
  git(seed, 'remote', 'add', 'origin', bare);
  git(seed, 'push', 'origin', 'main');
  return bare;
}

export interface Env {
  root: string; repo: string; ctx: Ctx; tracker: LocalTracker; scm: LocalScm; runner: FakeRunner; orch: Orchestrator;
  cycle: () => Promise<void>;
}

export function makeEnv(opts: { behaviors?: Partial<Record<AgentRunSpec['role'], FakeBehavior>>; config?: Record<string, unknown>; project?: Record<string, unknown> } = {}): Env {
  const root = mkdtempSync(join(tmpdir(), 'autodev-test-'));
  const repo = makeRepo(root);
  // Production layout: config, state and workspaces are separate trees (agents are denied the first two).
  mkdirSync(join(root, 'config'), { recursive: true });
  const cfg = parseConfig({
    dataDir: join(root, 'data'), workspaceDir: join(root, 'work'), tracker: 'local', scm: 'local', runner: 'fake',
    projects: [{ key: 'demo', repo, validate: ['test -f CHANGES.md', '! grep -q BROKEN CHANGES.md'], ...opts.project }],
    concurrency: { global: 2 }, sandbox: { enabled: false }, report: { hour: -1 },
    ...opts.config,
  }, join(root, 'config'));
  const db = openDb(join(cfg.dataDir, 'autodev.db'));
  const tracker = new LocalTracker(db);
  const fixtureCommand: Ctx['runCommand'] = (cmd, cwd, env, timeoutMs, signal) => run(cmd, [], { cwd, env: commandEnv(env), timeoutMs, signal, shell: true });
  const scm = new LocalScm(db, cfg.dataDir, cfg.localCi, fixtureCommand);
  const runner = new FakeRunner(opts.behaviors);
  // Only trusted generated fixtures use this test double. The CLI has no config
  // switch that bypasses command isolation, including fake/local mode.
  const ctx = createCtx(cfg, { db, tracker, scm, runner, runCommand: fixtureCommand });
  const orch = new Orchestrator(ctx);
  return { root, repo, ctx, tracker, scm, runner, orch, cycle: async () => { await orch.tick(); await orch.drain(Infinity); } };
}

export function job(env: Env, identifier: string) {
  return env.ctx.db.prepare('SELECT * FROM jobs WHERE ticket_identifier = ? ORDER BY created_at DESC').get(identifier) as Record<string, any>;
}

/** Whether the production command sandbox can run here (nested sandboxes are refused in some hosts). */
export async function sandboxAvailable(root: string): Promise<{ ok: boolean; why: string }> {
  const dir = join(root, 'sandbox-probe');
  mkdirSync(dir, { recursive: true });
  const { diagnoseSandbox } = await import('../src/sandbox-diagnostics.ts');
  const result = await diagnoseSandbox(dir);
  if (result.status === 'profile_failed') throw new Error(`OS sandbox baseline works, but autodev's profile failed: ${result.probe?.stderr || `exit ${result.probe?.code}`}`);
  return { ok: result.status === 'ready', why: (result.baseline.stderr || `baseline exit ${result.baseline.code}`).trim() };
}
