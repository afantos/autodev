import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeEnv, job, sandboxAvailable } from './helpers.ts';
import { DEFAULTS } from '../src/agents/fake.ts';
import type { AgentRunSpec } from '../src/agents/runner.ts';
import { ClaudeRunner } from '../src/agents/runner.ts';
import { runAgent, RunGateClosed } from '../src/context.ts';
import { canStartRun, reserveBudget } from '../src/budget.ts';
import { openDb, spentSince, getJob, updateJob } from '../src/db.ts';
import { answerBlocked } from '../src/pipeline.ts';
import { draftPlan, publishPlan } from '../src/planning.ts';
import { commandEnv, runSandboxed } from '../src/command-sandbox.ts';
import type { Plan } from '../src/agents/schemas.ts';
import { run } from '../src/exec.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=audit', '-c', 'user.email=audit@example.com', ...args], { cwd, stdio: 'pipe' }).toString();
const ticket = (e: ReturnType<typeof makeEnv>, title = 'Audit ticket', description = '') => e.tracker.createTicket({ projectKey: 'demo', title, description, status: 'ready', priority: 2 });
const syntheticKey = () => 'ghp_' + 'A'.repeat(36);
const specFor = (cwd: string): AgentRunSpec => ({ role: 'coding', prompt: 'probe', systemAppend: '', cwd, model: 'fake', mode: 'write', maxTurns: 1, maxBudgetUsd: 1, timeoutMs: 1000 });
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";

test('a detected secret blocks without publishing WIP', async () => {
  const e = makeEnv({ behaviors: { coding: async s => { writeFileSync(join(s.cwd, 'CHANGES.md'), syntheticKey()); return {}; } } });
  const t = await ticket(e);
  await e.cycle();
  const j = job(e, t.identifier);
  assert.equal(j.status, 'blocked');
  assert.match(await e.ctx.ws.git(j.worktree, ['show', `${await e.ctx.ws.headSha(j.worktree)}:CHANGES.md`]), /ghp_A/);
  assert.equal(git(e.repo, 'for-each-ref', '--format=%(refname)', 'refs/heads/autodev/'), '');
});

test('agent-created intermediate commits are rejected before they can be published', async () => {
  const e = makeEnv({ behaviors: { coding: async (s, n) => {
    writeFileSync(join(s.cwd, 'secret.txt'), syntheticKey());
    git(s.cwd, 'add', '-A'); git(s.cwd, 'commit', '-m', 'synthetic credential');
    git(s.cwd, 'rm', 'secret.txt'); git(s.cwd, 'commit', '-m', 'remove fixture');
    return DEFAULTS.coding!(s, n);
  } } });
  const t = await ticket(e);
  await e.cycle();
  assert.equal(job(e, t.identifier).status, 'blocked');
  assert.equal(git(e.repo, 'for-each-ref', '--format=%(refname)', 'refs/heads/autodev/'), '');
});

test('setup receives no inherited cloud, Anthropic or arbitrary host secrets', async () => {
  const previous = process.env.AWS_ACCESS_KEY_ID;
  process.env.AWS_ACCESS_KEY_ID = 'AUDIT_SENTINEL';
  try {
    const e = makeEnv({ project: { setup: ['node -e \'require("fs").writeFileSync("setup.txt", process.env.AWS_ACCESS_KEY_ID || "absent")\''] } });
    const t = await ticket(e);
    await e.cycle();
    assert.equal(readFileSync(join(job(e, t.identifier).worktree, 'setup.txt'), 'utf8'), 'absent');
    const coder = e.runner.calls.find(s => s.role === 'coding')!;
    const reviewer = e.runner.calls.find(s => s.role === 'review')!;
    assert.ok(coder.gitReadPaths?.length, 'shared git metadata is readable without opening all orchestrator state');
    assert.deepEqual(reviewer.gitReadPaths, [], 'review uses the supplied diff and a file-only candidate snapshot');
    assert.equal('gitWritePaths' in coder, false, 'agents get no git metadata write grant; the orchestrator commits');
    assert.equal(commandEnv().ANTHROPIC_API_KEY, undefined);
    assert.throws(() => commandEnv({ AWS_ACCESS_KEY_ID: 'fake' }), /Refusing/);
    assert.throws(() => commandEnv({ NODE_OPTIONS: '--require evil.js' }), /Refusing/);
  } finally {
    if (previous === undefined) delete process.env.AWS_ACCESS_KEY_ID; else process.env.AWS_ACCESS_KEY_ID = previous;
  }
});

test('command OS sandbox denies sibling credential reads and symlink escapes, and protects host writes', async t => {
  const e = makeEnv();
  const cwd = join(e.root, 'seed');
  const ready = await sandboxAvailable(e.root);
  if (!ready.ok) {
    assert.notEqual(process.env.AUTODEV_REQUIRE_SANDBOX_TEST, '1', `Required OS sandbox unavailable: ${ready.why}`);
    t.skip(`OS sandbox unavailable in this environment: ${ready.why}`); return;
  }
  const secret = join(e.root, 'private.env');
  const escaped = join(e.root, 'escaped');
  writeFileSync(secret, 'AUDIT_SENTINEL');
  writeFileSync(escaped, 'host-original');
  // Linux may allow writes to a private tmpfs shadow at this path; those must
  // never change the real host file. Darwin denies the write directly.
  const script = `const fs=require('fs'); fs.symlinkSync(${JSON.stringify(secret)}, 'credential-link'); for(const p of [${JSON.stringify(secret)}, 'credential-link']) { try { fs.readFileSync(p); process.exit(10); } catch {} } try { fs.writeFileSync(${JSON.stringify(escaped)},'x'); } catch {} fs.writeFileSync('allowed.txt','ok');`;
  const result = await runSandboxed(`${quote(process.execPath)} -e ${quote(script)}`, cwd, {}, 3000);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(readFileSync(escaped, 'utf8'), 'host-original');
  assert.equal(readFileSync(join(cwd, 'allowed.txt'), 'utf8'), 'ok');
});

test('Claude runner refuses disabled sandbox before making an API call', async () => {
  const r = await new ClaudeRunner().run(specFor('/tmp'));
  assert.equal(r.ok, false);
  assert.match(r.error!, /sandbox must be enabled/);
  assert.equal(r.costUsd, 0);
});

test('concurrent runs reserve shared budget atomically across SQLite connections', async () => {
  const e = makeEnv({ config: { budget: { dailyUsd: 1, monthlyUsd: 1, perRunUsd: 1 } } });
  let entered!: () => void; let release!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const barrier = new Promise<void>(r => { release = r; });
  e.runner.behaviors.coding = async s => { entered(); await barrier; return { costUsd: s.maxBudgetUsd }; };
  const pending = runAgent(e.ctx, specFor(e.root), {});
  await started;
  const other = openDb(join(e.ctx.cfg.dataDir, 'autodev.db'));
  try {
    assert.equal(reserveBudget(other, e.ctx.cfg, 'other-process', {}, 1).ok, false);
    await assert.rejects(runAgent(e.ctx, specFor(e.root), {}), RunGateClosed);
  } finally { other.close(); release(); }
  await pending;
  assert.equal(spentSince(e.ctx.db, 0), 1);
  assert.equal((e.ctx.db.prepare('SELECT COUNT(*) n FROM budget_reservations').get() as { n: number }).n, 0);
});

test('budget has no five-cent floor and reservations survive unknown runner failures', async () => {
  const e = makeEnv({ config: { budget: { dailyUsd: 0.01 } } });
  assert.equal(canStartRun(e.ctx.db, e.ctx.cfg).allowanceUsd, 0.01);
  e.runner.behaviors.coding = async () => { throw new Error('lost result'); };
  await assert.rejects(runAgent(e.ctx, specFor(e.root), {}), /lost result/);
  assert.equal(canStartRun(e.ctx.db, e.ctx.cfg).ok, false);
});

test('an aborted SDK run without a terminal usage result retains its reservation', async () => {
  const e = makeEnv({ config: { budget: { dailyUsd: 1, monthlyUsd: 1 } } });
  e.runner.behaviors.coding = async () => ({ ok: false, costUsd: 0, errorKind: 'timeout', usageComplete: false });
  await runAgent(e.ctx, specFor(e.root), {});
  assert.equal(canStartRun(e.ctx.db, e.ctx.cfg).ok, false);
  assert.equal((e.ctx.db.prepare('SELECT COUNT(*) n FROM budget_reservations').get() as { n: number }).n, 1);
});

test('mandatory diff policy blocks unrequested dependencies before validation or push', async () => {
  const e = makeEnv({ behaviors: { coding: async s => {
    writeFileSync(join(s.cwd, 'package.json'), JSON.stringify({ dependencies: { 'audit-unapproved': '1.0.0' } }));
    writeFileSync(join(s.cwd, 'CHANGES.md'), 'done'); return {};
  } } });
  const marker = join(e.root, 'validation-started');
  e.ctx.cfg.projects[0].validate = [`touch ${quote(marker)}`];
  const t = await ticket(e);
  await e.cycle();
  assert.equal(job(e, t.identifier).status, 'blocked');
  assert.match(job(e, t.identifier).blocked_reason, /unapproved dependency change/);
  assert.equal(existsSync(marker), false);
  assert.equal(git(e.repo, 'for-each-ref', '--format=%(refname)', 'refs/heads/autodev/'), '');
  await answerBlocked(e.ctx, getJob(e.ctx.db, job(e, t.identifier).id)!, 'approve');
  await e.cycle();
  assert.equal(job(e, t.identifier).status, 'awaiting_merge');
  assert.equal(e.runner.calls.filter(s => s.role === 'coding').length, 1, 'approval revalidates exact diff without rerunning coder');
});

test('policy approval is bound to the reviewed diff; later changes require new approval', async () => {
  const e = makeEnv({ behaviors: { coding: async s => {
    writeFileSync(join(s.cwd, 'package.json'), '{"dependencies":{"first":"1"}}');
    writeFileSync(join(s.cwd, 'CHANGES.md'), 'done'); return {};
  } } });
  const t = await ticket(e);
  await e.cycle();
  const j = job(e, t.identifier);
  await answerBlocked(e.ctx, getJob(e.ctx.db, j.id)!, 'approve');
  writeFileSync(join(j.worktree, 'package.json'), '{"dependencies":{"second":"1"}}');
  await e.ctx.ws.commitAll(j.worktree, 'different dependency captured by the orchestrator');
  updateJob(e.ctx.db, j.id, { candidate_sha: await e.ctx.ws.headSha(j.worktree) });
  await e.cycle();
  assert.equal(job(e, t.identifier).status, 'blocked');
  assert.match(job(e, t.identifier).blocked_reason, /second/);
});

test('sensitive code changes trigger mandatory policy even when coder asks no question', async () => {
  const e = makeEnv({ behaviors: { coding: async s => {
    writeFileSync(join(s.cwd, 'src/index.js'), 'const sql = "DROP TABLE customers";');
    writeFileSync(join(s.cwd, 'CHANGES.md'), 'done'); return {};
  } } });
  const t = await ticket(e); await e.cycle();
  assert.equal(job(e, t.identifier).status, 'blocked');
  assert.match(job(e, t.identifier).blocked_reason, /destructive/);
});

test('dependency lockfile edits cannot bypass policy by leaving the manifest unchanged', async () => {
  const e = makeEnv({ behaviors: { coding: async s => {
    writeFileSync(join(s.cwd, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}');
    writeFileSync(join(s.cwd, 'CHANGES.md'), 'done'); return {};
  } } });
  const t = await ticket(e); await e.cycle();
  assert.equal(job(e, t.identifier).status, 'blocked');
  assert.match(job(e, t.identifier).blocked_reason, /dependency changes require human review/);
});

test('validation cannot change dependencies in the captured candidate', async () => {
  const e = makeEnv();
  e.ctx.cfg.projects[0].validate = ['node -e \'require("fs").writeFileSync("package.json", JSON.stringify({dependencies:{unexpected:"1"}}))\''];
  const t = await ticket(e); await e.cycle();
  assert.equal(job(e, t.identifier).status, 'blocked');
  assert.match(job(e, t.identifier).blocked_reason, /candidate snapshot invalid/);
  assert.equal(git(e.repo, 'for-each-ref', '--format=%(refname)', 'refs/heads/autodev/'), '');
});

test('temporary reservations do not set a permanent manual budget pause', async () => {
  const e = makeEnv({ config: { budget: { dailyUsd: 1, monthlyUsd: 1, onExhausted: 'manual' } } });
  const reservation = reserveBudget(e.ctx.db, e.ctx.cfg, e.ctx.owner, {}, 1);
  assert.equal(canStartRun(e.ctx.db, e.ctx.cfg).ok, false);
  assert.equal(e.ctx.db.prepare("SELECT v FROM kv WHERE k = 'manual_pause'").get(), undefined);
  e.ctx.db.prepare('DELETE FROM budget_reservations WHERE id = ?').run(reservation.reservationId!);
  assert.equal(canStartRun(e.ctx.db, e.ctx.cfg).ok, true);
});

test('cancellation inside coding cannot push, open a PR or overwrite ticket state', async () => {
  const e = makeEnv(); const t = await ticket(e);
  e.runner.behaviors.coding = async (s, n) => { await e.tracker.setStatus(t.id, 'canceled'); return DEFAULTS.coding!(s, n); };
  await e.cycle();
  assert.equal(job(e, t.identifier).status, 'canceled');
  assert.equal((await e.tracker.getTicket(t.id))!.status, 'canceled');
  assert.equal((e.ctx.db.prepare('SELECT COUNT(*) n FROM local_prs').get() as { n: number }).n, 0);
  assert.equal(git(e.repo, 'for-each-ref', '--format=%(refname)', 'refs/heads/autodev/'), '');
});

test('cancellation polling aborts a still-running agent through its signal', async () => {
  const e = makeEnv({ config: { loop: { cancellationPollSeconds: 0.01 } } });
  const t = await ticket(e); let aborted = false;
  e.runner.behaviors.coding = async s => {
    await e.tracker.setStatus(t.id, 'canceled');
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('cancellation did not reach runner')), 2000);
      s.signal!.addEventListener('abort', () => { clearTimeout(timeout); aborted = true; resolve(); }, { once: true });
    });
    return { ok: false, errorKind: 'other', error: 'aborted' };
  };
  await e.cycle();
  assert.equal(aborted, true);
  assert.equal(job(e, t.identifier).status, 'canceled');
});

test('cancellation during outgoing history inspection stops the subsequent push', async () => {
  const e = makeEnv(); const t = await ticket(e);
  const original = e.ctx.ws.git.bind(e.ctx.ws);
  e.ctx.ws.git = async (...args: Parameters<typeof original>) => {
    const result = await original(...args);
    if (args[1].includes('--diff-merges=separate')) await e.tracker.setStatus(t.id, 'canceled');
    return result;
  };
  await e.cycle();
  assert.equal(job(e, t.identifier).status, 'canceled');
  assert.equal(git(e.repo, 'for-each-ref', '--format=%(refname)', 'refs/heads/autodev/'), '');
});

test('late cancellation during handoff cannot be overwritten by Review', async () => {
  const e = makeEnv(); const t = await ticket(e);
  e.scm.previewUrl = async () => { await e.tracker.setStatus(t.id, 'canceled'); return null; };
  await e.cycle();
  assert.equal(job(e, t.identifier).status, 'canceled');
  assert.equal((await e.tracker.getTicket(t.id))!.status, 'canceled');
});

test('aborting a validation subprocess kills its process group', async () => {
  const controller = new AbortController();
  const pending = run(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  const r = await pending;
  assert.notEqual(r.code, 0);
});

test('same batch cannot claim two tickets declaring the same file', async () => {
  const e = makeEnv({ project: { maxConcurrent: 2 } });
  const description = '## Relevant files\n- `src/index.js`';
  await ticket(e, 'First', description); await ticket(e, 'Second', description);
  await e.cycle();
  assert.equal(e.runner.calls.filter(s => s.role === 'coding').length, 1);
});

test('plan publication repairs dependency links after a partial failure without duplicates', async () => {
  const pt = (key: string, dependsOn: string[]) => ({ key, title: `Implement unique ${key}`, objective: 'o', problem: 'p', technicalContext: 'c', acceptanceCriteria: ['a'], testing: ['t'], dependsOn, priority: 2, complexity: 2, relevantFiles: [], security: 's', definitionOfDone: ['d'], parallelizable: false });
  const plan: Plan = { projectKey: 'demo', summary: 's', approach: 'a', reuse: [], requirements: [], risks: [], openQuestions: [], duplicates: [], tickets: [pt('schema', []), pt('endpoint', ['schema'])] };
  const e = makeEnv({ behaviors: { planning: async () => ({ structured: plan }) } });
  const draft = await draftPlan(e.ctx, 'Publication recovery', 'demo');
  const original = e.tracker.addBlockedBy.bind(e.tracker); let failed = false;
  e.tracker.addBlockedBy = async (id, dep) => { if (!failed) { failed = true; throw new Error('outage'); } return original(id, dep); };
  await assert.rejects(publishPlan(e.ctx, draft.id), /outage/);
  await publishPlan(e.ctx, draft.id); await publishPlan(e.ctx, draft.id);
  const tickets = await e.tracker.listTickets();
  assert.equal(tickets.length, 3);
  const schema = tickets.find(t => t.title === 'Implement unique schema')!;
  assert.deepEqual(tickets.find(t => t.title === 'Implement unique endpoint')!.blockedBy, [schema.id]);
});

test('Linear Done write retries after outage; database never gets ahead of Linear', async () => {
  const e = makeEnv(); const t = await ticket(e); await e.cycle();
  await e.scm.merge(e.repo, job(e, t.identifier).pr_number);
  const original = e.tracker.setStatus.bind(e.tracker); let failed = false;
  e.tracker.setStatus = async (id, status) => { if (status === 'done' && !failed) { failed = true; throw new Error('outage'); } return original(id, status); };
  // The outage is contained to this job (reconciliation of other jobs continues) and recorded; nothing is marked done.
  await e.orch.reconcile();
  assert.match(String((e.ctx.db.prepare("SELECT message FROM events WHERE type = 'reconcile.job_error'").get() as { message: string } | undefined)?.message), /outage/);
  assert.equal(job(e, t.identifier).status, 'awaiting_merge');
  await e.orch.reconcile();
  assert.equal(job(e, t.identifier).status, 'done');
  assert.equal((await e.tracker.getTicket(t.id))!.status, 'done');
});
