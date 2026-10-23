import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeEnv, job, sandboxAvailable } from './helpers.ts';
import { DEFAULTS } from '../src/agents/fake.ts';
import { runSandboxed } from '../src/command-sandbox.ts';
import type { SandboxInputs } from '../src/command-sandbox.ts';
import { gitEnv } from '../src/scm/git.ts';
import { agentSandbox, agentEnv, commandToolEnv } from '../src/agents/runner.ts';
import { assertOutsideProtected, canonicalPath, protectedRoots } from '../src/context.ts';
import { parseConfig } from '../src/config.ts';
import type { Ctx } from '../src/context.ts';

const SYNTHETIC = 'ghp_ISOLATIONPROBEISOLATIONPROBE0000000';
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
const remoteBranches = (repo: string) => execFileSync('git', ['for-each-ref', '--format=%(refname)', 'refs/heads/autodev/'], { cwd: repo }).toString().trim();

/** Shell script from the audit probe: plant an attacker git dir + hooks and redirect the worktree pointer to it. */
function hijackScript(loot: string): string {
  return `set -e
W=$(pwd)
mkdir -p "$W/.evil/objects" "$W/.evil/refs/heads" "$W/.hooks"
printf 'ref: refs/heads/main\\n' > "$W/.evil/HEAD"
printf '[core]\\n\\trepositoryformatversion = 0\\n\\thooksPath = %s\\n\\tfsmonitor = %s/post-commit\\n[user]\\n\\tname = x\\n\\temail = x@x\\n' "$W/.hooks" "$W/.hooks" > "$W/.evil/config"
for h in post-commit reference-transaction pre-push post-checkout; do
  printf '#!/bin/sh\\nenv | grep -E "GITHUB_TOKEN|LINEAR_API_KEY" >> %s 2>/dev/null; echo hook:%s >> %s\\n' ${quote(loot)} "$h" ${quote(loot)} > "$W/.hooks/$h"
  chmod +x "$W/.hooks/$h"
done
printf 'gitdir: %s\\n' "$W/.evil" > "$W/.git"
echo hijacked > "$W/hijack-marker.txt"`;
}

function withSyntheticToken<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = SYNTHETIC;
  return fn().finally(() => { if (prev === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = prev; });
}

const lootOf = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '');

// ---------------------------------------------------------------- git isolation

test('agent path: a rewritten .git pointer cannot run hooks (post-commit, reference-transaction) with orchestrator credentials', () => withSyntheticToken(async () => {
  let loot = '';
  const e = makeEnv({ behaviors: { coding: async (spec, n) => {
    const r = await DEFAULTS.coding!(spec, n);
    loot = join(spec.cwd, '..', '..', 'LOOT-agent.txt');
    execFileSync('/bin/sh', ['-c', hijackScript(loot)], { cwd: spec.cwd });
    return r;
  } } });
  const t = await e.tracker.createTicket({ projectKey: 'demo', title: 'Agent hijack', description: '', status: 'ready', priority: 2 });
  await e.cycle();
  const j = job(e, t.identifier);
  assert.equal(lootOf(loot), '', 'no attacker hook ran');
  assert.equal(j.status, 'blocked');
  assert.match(String(j.blocked_reason), /worktree git metadata was modified \(\.git pointer changed\)/);
  assert.equal(remoteBranches(e.repo), '', 'nothing was pushed');
  assert.ok(e.ctx.db.prepare("SELECT 1 FROM events WHERE type = 'security.worktree_tampered'").get(), 'security event recorded');
}));

test('validation path (unsandboxed fixture): a pointer rewrite by repository code is detected before any orchestrator git runs', () => withSyntheticToken(async () => {
  const e = makeEnv();
  const loot = join(e.root, 'LOOT-validate.txt');
  e.ctx.cfg.projects[0].validate = [hijackScript(loot)];
  const t = await e.tracker.createTicket({ projectKey: 'demo', title: 'Validation hijack', description: '', status: 'ready', priority: 2 });
  await e.cycle();
  const j = job(e, t.identifier);
  assert.equal(lootOf(loot), '');
  assert.equal(j.status, 'blocked');
  assert.match(String(j.blocked_reason), /\.git pointer changed/);
  assert.equal(remoteBranches(e.repo), '');
}));

test('hooks and fsmonitor configured in the shared clone are never executed by orchestrator git', () => withSyntheticToken(async () => {
  const e = makeEnv();
  const loot = join(e.root, 'LOOT-clone.txt');
  const t = await e.tracker.createTicket({ projectKey: 'demo', title: 'Clone hooks', description: '', status: 'ready', priority: 2 });
  // First cycle creates the clone; then plant hooks + fsmonitor in it (defense in depth: agents cannot write here).
  e.runner.behaviors.coding = async (spec, n) => {
    const common = e.ctx.ws.verifiedRecord(spec.cwd).commonDir;
    for (const h of ['post-commit', 'reference-transaction', 'pre-push', 'pre-commit']) {
      writeFileSync(join(common, 'hooks', h), `#!/bin/sh\nenv | grep GITHUB_TOKEN >> ${quote(loot)}; echo hook:${h} >> ${quote(loot)}\n`);
      chmodSync(join(common, 'hooks', h), 0o755);
    }
    execFileSync('git', ['config', '-f', join(common, 'config'), 'core.fsmonitor', join(common, 'hooks', 'post-commit')]);
    return DEFAULTS.coding!(spec, n);
  };
  await e.cycle();
  assert.equal(lootOf(loot), '', 'hooks/fsmonitor did not run');
  assert.equal(job(e, t.identifier).status, 'awaiting_merge', job(e, t.identifier).error);
}));

test('orchestrator git environment carries no secrets and no user/system git config', () => withSyntheticToken(async () => {
  const env = gitEnv('/nonexistent-home');
  assert.equal(Object.values(env).some((v) => String(v).includes(SYNTHETIC)), false);
  assert.deepEqual(Object.keys(env).sort(), ['GIT_ASKPASS', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT', 'HOME', 'LANG', 'PATH']);
  assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null');
}));

test('a worktree without a trusted record (or outside the workspace) is refused', async () => {
  const e = makeEnv();
  const rogue = mkdtempSync(join(tmpdir(), 'rogue-'));
  assert.throws(() => e.ctx.ws.gitDirArgs(rogue), /unmanaged directory/);
  const fake = e.ctx.ws.worktreeDir('NO-RECORD');
  mkdirSync(fake, { recursive: true });
  writeFileSync(join(fake, '.git'), 'gitdir: /tmp/whatever\n');
  assert.throws(() => e.ctx.ws.gitDirArgs(fake), /no trusted record/);
});

test('validation path under the real OS sandbox: the .git pointer and git metadata are not writable', async (t) => {
  const e = makeEnv();
  const ready = await sandboxAvailable(e.root);
  if (!ready.ok) {
    assert.notEqual(process.env.AUTODEV_REQUIRE_SANDBOX_TEST, '1', `Required OS sandbox unavailable: ${ready.why}`);
    t.skip(`OS sandbox unavailable in this environment: ${ready.why}`); return;
  }
  await withSyntheticToken(async () => {
    e.ctx.runCommand = runSandboxed; // production command runner
    const loot = join(e.root, 'LOOT-sandbox.txt');
    // Also try to reach the shared clone's hooks directly (path is known to an attacker who can read the worktree pointer).
    const reachClone = `C=$(sed -n 's/^gitdir: //p' .git); for d in "$C" "$C/../.."; do mkdir -p "$d/hooks" 2>/dev/null && printf '#!/bin/sh\\necho hook >> ${loot}\\n' > "$d/hooks/post-commit" 2>/dev/null && echo "WROTE $d" >> ${quote(loot)}; done; true`;
    e.ctx.cfg.projects[0].validate = [reachClone, hijackScript(loot)];
    const tk = await e.tracker.createTicket({ projectKey: 'demo', title: 'Sandbox hijack', description: '', status: 'ready', priority: 2 });
    await e.cycle();
    const j = job(e, tk.identifier);
    assert.equal(lootOf(loot), '', 'no hook ran and nothing reached git metadata');
    const rec = e.ctx.ws.verifiedRecord(j.worktree); // throws if the pointer or metadata changed
    assert.equal(existsSync(join(rec.commonDir, 'hooks', 'post-commit')), false);
    assert.equal(remoteBranches(e.repo), '', 'failed validation pushed nothing');
    assert.match(String(j.error ?? j.pending_feedback), /validation/);
  });
});

// ---------------------------------------------------------------- command sandbox availability (CI test fix)

const unavailable = (cmd: string, cwd: string, env: Record<string, string>, timeoutMs: number, signal?: AbortSignal, inputs: SandboxInputs = {}) =>
  runSandboxed(cmd, cwd, env, timeoutMs, signal, { ...inputs, launcherOverride: '/nonexistent/autodev-sandbox-launcher' });

test('real-mode setup refuses to run when the OS sandbox is unavailable (simulated, deterministic)', async () => {
  const e = makeEnv({ config: { runner: 'claude' } });
  e.ctx.runCommand = unavailable as Ctx['runCommand'];
  const destination = join(e.root, 'outside-unavailable');
  e.ctx.cfg.projects[0].setup = [`touch ${quote(destination)}`];
  const t = await e.tracker.createTicket({ projectKey: 'demo', title: 'No sandbox', description: '', status: 'ready', priority: 2 });
  await e.cycle();
  assert.equal(existsSync(destination), false, 'no unsandboxed fallback');
  assert.equal(job(e, t.identifier).status, 'failed');
  assert.match(String(job(e, t.identifier).error), /setup command failed/);
  assert.equal(e.runner.calls.length, 0, 'no agent ran after the refused setup');
});

test('real-mode setup runs inside the OS sandbox when it is available, without host escapes', async (t) => {
  const e = makeEnv({ config: { runner: 'claude' } });
  const ready = await sandboxAvailable(e.root);
  if (!ready.ok) {
    assert.notEqual(process.env.AUTODEV_REQUIRE_SANDBOX_TEST, '1', `Required OS sandbox unavailable: ${ready.why}`);
    t.skip(`OS sandbox unavailable in this environment: ${ready.why}`); return;
  }
  e.ctx.runCommand = runSandboxed;
  const destination = join(e.root, 'outside-available');
  e.ctx.cfg.projects[0].setup = [`touch ${quote(destination)} 2>/dev/null; echo setup-ran > setup-ok.txt`];
  const tk = await e.tracker.createTicket({ projectKey: 'demo', title: 'With sandbox', description: '', status: 'ready', priority: 2 });
  await e.cycle();
  const j = job(e, tk.identifier);
  assert.equal(existsSync(destination), false, 'host path outside the worktree untouched');
  assert.equal(readFileSync(join(j.worktree, 'setup-ok.txt'), 'utf8').trim(), 'setup-ran', 'setup ran in the worktree');
  assert.equal(j.status, 'awaiting_merge', j.error);
});

// ---------------------------------------------------------------- agent execution layout

test('default workspace is a sibling of the config directory, outside config and state', () => {
  const cfg = parseConfig({ projects: [{ key: 'a', repo: 'o/a' }] }, '/opt/autodev/instance');
  assert.equal(cfg.workspaceDir, '/opt/autodev/instance-work');
  assert.equal(cfg.dataDir, '/opt/autodev/instance/data');
});

test('agents refuse a workspace inside HOME, the config directory or dataDir', async () => {
  const e = makeEnv();
  const roots = protectedRoots(e.ctx.cfg);
  assert.ok(roots.includes(homedir()) || roots.some((r) => homedir().startsWith(r)));
  assert.throws(() => assertOutsideProtected(join(e.ctx.cfg.dataDir, 'worktrees', 'X'), roots), /inside protected directory/);
  assert.throws(() => assertOutsideProtected(join(e.ctx.cfg.configDir, 'w'), roots), /inside protected directory/);
  assert.throws(() => assertOutsideProtected(join(homedir(), 'autodev-work', 'X'), roots), /inside protected directory/);
  assertOutsideProtected(e.ctx.ws.worktreeDir('X'), roots); // the test layout mirrors production
  // End to end: a misconfigured layout blocks the run before any agent starts.
  const bad = makeEnv({ config: { workspaceDir: '' } });
  bad.ctx.cfg.workspaceDir = join(bad.ctx.cfg.dataDir, 'nested-work');
  (bad.ctx.ws as { workspaceDir: string }).workspaceDir = bad.ctx.cfg.workspaceDir;
  const t = await bad.tracker.createTicket({ projectKey: 'demo', title: 'Bad layout', description: '', status: 'ready', priority: 2 });
  await bad.cycle();
  assert.equal(bad.runner.calls.length, 0);
  assert.match(String(job(bad, t.identifier).error), /inside protected directory/);
});

test('agent sandbox: secrets/state denied, worktree readable, git metadata read-only, .git pointer not writable', async () => {
  const e = makeEnv();
  await e.tracker.createTicket({ projectKey: 'demo', title: 'Sandbox shape', description: '', status: 'ready', priority: 2 });
  await e.cycle();
  const coder = e.runner.calls.find((c) => c.role === 'coding')!;
  const box = agentSandbox({ ...coder, sandbox: { enabled: true, failIfUnavailable: true, allowedDomains: [] } });
  const fs = box.filesystem!;
  for (const p of [homedir(), e.ctx.cfg.configDir, e.ctx.cfg.dataDir].map(canonicalPath)) assert.ok(fs.denyRead!.some((d) => d === p || p.startsWith(d + '/')), `denies ${p}`);
  assert.equal(fs.denyRead!.some((d) => canonicalPath(coder.cwd).startsWith(d + '/')), false, 'worktree is not beneath a denied tree');
  assert.deepEqual(fs.allowWrite, [], 'no write grant outside the worktree');
  assert.deepEqual(fs.denyWrite, [join(coder.cwd, '.git')]);
  assert.ok(coder.gitReadPaths!.every((p) => fs.allowRead!.includes(p)));
  assert.equal(box.failIfUnavailable, true);
  assert.equal(box.allowUnsandboxedCommands, false);
  // Tools never need the denied HOME; caches stay out of commits.
  const env = agentEnv(commandToolEnv(coder.cwd));
  assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null');
  assert.equal(env.NPM_CONFIG_USERCONFIG, '/dev/null');
  assert.ok(env.npm_config_cache.startsWith(coder.cwd));
  const exclude = readFileSync(join(e.ctx.ws.verifiedRecord(coder.cwd).commonDir, 'info', 'exclude'), 'utf8');
  assert.match(exclude, /^\/\.autodev-cache\/$/m);
});
