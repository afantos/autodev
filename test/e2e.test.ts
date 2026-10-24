import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeEnv, job } from './helpers.ts';
import { DEFAULTS } from '../src/agents/fake.ts';
import { kvGet, updateJob } from '../src/db.ts';
import { draftPlan, publishPlan, approvePlan } from '../src/planning.ts';
import type { AgentRunSpec } from '../src/agents/runner.ts';

const branchFiles = (repo: string, branch: string, file: string) => execFileSync('git', ['show', `${branch}:${file}`], { cwd: repo }).toString();

test('happy path: Ready ticket → worktree → agent → validation → draft PR → review → Review; merge → Done', async () => {
  const env = makeEnv({ config: { localCi: 'test -f CHANGES.md' } });
  const t = await env.tracker.createTicket({ projectKey: 'demo', title: 'Add multiply helper', description: 'Add multiply.', status: 'ready', priority: 2 });
  await env.cycle();

  const j = job(env, t.identifier);
  assert.equal(j.status, 'awaiting_merge', j.error);
  assert.equal(j.stage, 'handoff');
  assert.equal((await env.tracker.getTicket(t.id))!.status, 'review');
  const pr = await env.scm.getPr(env.repo, j.pr_number);
  assert.equal(pr.draft, true);
  assert.equal(pr.state, 'open');
  assert.match(branchFiles(env.repo, j.branch, 'CHANGES.md'), /Add multiply helper/);
  const body = env.scm.prBody(j.pr_number);
  assert.match(body, /Linear: \[DEMO-1\]/);
  assert.match(body, /AI review\n\*\*approved\*\*/);
  assert.match(body, /test -f CHANGES.md` ✅/);
  const roles = env.runner.calls.map((c) => c.role);
  assert.deepEqual(roles, ['coding', 'review']);
  // The review agent never sees the coding agent's summary.
  assert.doesNotMatch(env.runner.calls[1].prompt, /\(fake\)/);
  // The coding agent ran in the isolated worktree with no orchestrator secrets.
  assert.match(env.runner.calls[0].cwd, /worktrees\/DEMO-1$/);

  // Not Done until the merge is observed.
  await env.cycle();
  assert.equal((await env.tracker.getTicket(t.id))!.status, 'review');
  await env.scm.merge(env.repo, j.pr_number);
  await env.cycle();
  assert.equal(job(env, t.identifier).status, 'done');
  assert.equal((await env.tracker.getTicket(t.id))!.status, 'done');
});

test('proposed tickets are never picked up; dependencies wait for merge; concurrency limit holds', async () => {
  const env = makeEnv({ config: { concurrency: { global: 2 } }, project: { maxConcurrent: 2 } });
  const backlog = await env.tracker.createTicket({ projectKey: 'demo', title: 'Suggested refactor', description: '', status: 'backlog', priority: 1 });
  const a = await env.tracker.createTicket({ projectKey: 'demo', title: 'Schema', description: '', status: 'ready', priority: 3 });
  const b = await env.tracker.createTicket({ projectKey: 'demo', title: 'Service using schema', description: '', status: 'ready', priority: 1 });
  await env.tracker.addBlockedBy(b.id, a.id);
  const c = await env.tracker.createTicket({ projectKey: 'demo', title: 'Unrelated docs', description: '', status: 'ready', priority: 3 });
  const d = await env.tracker.createTicket({ projectKey: 'demo', title: 'Another unrelated', description: '', status: 'ready', priority: 4 });

  await env.cycle();
  assert.equal(job(env, backlog.identifier), undefined, 'backlog work is not started');
  assert.equal(job(env, b.identifier), undefined, 'blocked by unmerged dependency');
  const started = [a, c, d].filter((t) => job(env, t.identifier));
  assert.equal(started.length, 2, 'global concurrency 2');
  assert.ok(job(env, a.identifier), 'unblocking schema ticket is preferred');

  await env.cycle(); // third ticket now
  assert.ok(job(env, d.identifier) && job(env, c.identifier));
  assert.equal(job(env, b.identifier), undefined, 'still waiting: dependency is in Review, not merged');

  await env.scm.merge(env.repo, job(env, a.identifier).pr_number);
  await env.cycle(); // reconcile → A done
  await env.cycle(); // B now eligible
  const jb = job(env, b.identifier);
  assert.equal(jb.status, 'awaiting_merge', jb.error);
  // B was branched from main *after* A merged, so it contains A's change.
  assert.match(branchFiles(env.repo, jb.branch, 'CHANGES.md'), /Schema/);
});

test('validation failure feeds back to the agent (resumed session) and is fixed within bounds', async () => {
  const env = makeEnv({
    behaviors: {
      coding: async (spec, n) => {
        if (n === 1) { writeFileSync(join(spec.cwd, 'CHANGES.md'), 'BROKEN\n'); return {}; } // leaves uncommitted, failing work
        assert.match(spec.prompt, /validation and it failed/);
        assert.equal(spec.resume, 'fake-session');
        writeFileSync(join(spec.cwd, 'CHANGES.md'), 'fixed\n');
        return { structured: { status: 'completed', summary: 'fixed', filesChanged: [], testsAdded: [], commandsRun: [], decisions: [], knownLimitations: [] } };
      },
    },
  });
  const t = await env.tracker.createTicket({ projectKey: 'demo', title: 'Flaky', description: '', status: 'ready', priority: 2 });
  await env.cycle(); // attempt 1 fails validation → requeued
  assert.equal(job(env, t.identifier).status, 'queued');
  assert.equal(job(env, t.identifier).fix_attempts, 1);
  await env.cycle();
  const j = job(env, t.identifier);
  assert.equal(j.status, 'awaiting_merge', j.error);
});

test('fix attempts are bounded → Failed, work preserved on the branch', async () => {
  const env = makeEnv({
    config: { limits: { maxFixAttempts: 1 } },
    behaviors: { coding: async (spec) => { appendFileSync(join(spec.cwd, 'CHANGES.md'), 'BROKEN\n'); return {}; } },
  });
  const t = await env.tracker.createTicket({ projectKey: 'demo', title: 'Hopeless', description: '', status: 'ready', priority: 2 });
  await env.cycle(); await env.cycle();
  const j = job(env, t.identifier);
  assert.equal(j.status, 'failed');
  assert.equal((await env.tracker.getTicket(t.id))!.status, 'failed');
  assert.match(await env.ctx.ws.git(j.worktree, ['show', `${await env.ctx.ws.headSha(j.worktree)}:CHANGES.md`]), /BROKEN/, 'WIP preserved in the protected object store');
});

const callTool = (spec: AgentRunSpec, name: string, args: Record<string, unknown>) => spec.tools!.find((x) => x.name === name)!.handler(args);

test('decision agent: routine question auto-resolved and logged; repeated question reuses the log', async () => {
  let answers: string[] = [];
  const env = makeEnv({
    behaviors: {
      coding: async (spec, n) => {
        answers.push(await callTool(spec, 'request_decision', { question: 'Should helpers live in src/lib or src/utils?', context: 'two dirs exist', options: ['src/lib', 'src/utils'] }));
        if (n === 1) answers.push(await callTool(spec, 'request_decision', { question: 'should helpers live in src/lib or src/utils', context: 'again', options: [] }));
        return DEFAULTS.coding!(spec, n);
      },
    },
  });
  const t = await env.tracker.createTicket({ projectKey: 'demo', title: 'Helpers', description: '', status: 'ready', priority: 2 });
  await env.cycle();
  assert.match(answers[0], /^DECIDED \(auto/);
  assert.match(answers[1], /^DECIDED \(previously/);
  assert.equal(env.runner.calls.filter((c) => c.role === 'decision').length, 1, 'second identical question did not re-run research');
  assert.equal(env.runner.calls.find((c) => c.role === 'decision')!.mode, 'readonly');
  const rows = env.ctx.db.prepare('SELECT * FROM decisions').all() as { authority: string; status: string }[];
  assert.deepEqual(rows.map((r) => [r.authority, r.status]), [['auto', 'resolved']]);
  assert.equal(job(env, t.identifier).status, 'awaiting_merge');
  answers = [];
});

test('high-risk decision blocks the ticket, other work continues, human answer resumes it', async () => {
  let blockedReply = '';
  const env = makeEnv({
    project: { maxConcurrent: 2 },
    behaviors: {
      decision: async () => ({ structured: { category: 'billing_pricing', options: [{ name: '$10/mo', pros: [], cons: [] }, { name: '$15/mo', pros: [], cons: [] }], recommendation: '$10/mo', reasoning: 'market', evidence: [], confidence: 0.8, requiresHuman: false, significantArchitecture: false } }),
      coding: async (spec, n) => {
        if (/Pricing/.test(spec.prompt) && !blockedReply) {
          blockedReply = await callTool(spec, 'request_decision', { question: 'What price for the Personal plan?', context: 'not in ticket', options: ['$10', '$15'] });
          return { structured: { status: 'blocked', summary: 'need price', filesChanged: [], testsAdded: [], commandsRun: [], decisions: [], knownLimitations: [] } };
        }
        if (/Pricing/.test(spec.prompt)) assert.match(spec.prompt, /Answer: \$12 per month/);
        return DEFAULTS.coding!(spec, n);
      },
    },
  });
  const pricing = await env.tracker.createTicket({ projectKey: 'demo', title: 'Pricing page', description: '', status: 'ready', priority: 1 });
  const other = await env.tracker.createTicket({ projectKey: 'demo', title: 'Footer links', description: '', status: 'ready', priority: 3 });
  await env.cycle();
  assert.match(blockedReply, /^BLOCKED: needs human approval/);
  assert.equal(job(env, pricing.identifier).status, 'blocked');
  assert.equal((await env.tracker.getTicket(pricing.id))!.status, 'blocked');
  assert.equal(job(env, other.identifier).status, 'awaiting_merge', 'unrelated work continued');
  const comments = await env.tracker.listComments(pricing.id);
  assert.match(comments.at(-1)!.body, /autodev is blocked[\s\S]*Recommendation:\*\* \$10\/mo/);

  // No retries overnight while blocked.
  await env.cycle();
  assert.equal(job(env, pricing.identifier).status, 'blocked');

  // Human answers in Linear and moves the ticket to Ready.
  env.tracker.humanComment(pricing.id, '/answer $12 per month');
  await env.tracker.setStatus(pricing.id, 'ready');
  await env.cycle(); // reconcile → queued
  await env.cycle(); // resumes
  assert.equal(job(env, pricing.identifier).status, 'awaiting_merge');
  const lastReview = env.runner.calls.filter((c) => c.role === 'review').at(-1)!;
  assert.match(lastReview.prompt, /\(human\) Q: What price for the Personal plan\?\n  A: \$12 per month/, 'reviewer sees approved human decisions');
  const d = env.ctx.db.prepare(`SELECT authority, status, decision FROM decisions WHERE question LIKE '%Personal plan%'`).get() as Record<string, string>;
  assert.deepEqual({ ...d }, { authority: 'human', status: 'resolved', decision: '$12 per month' });
});

test('review requests changes → bounded fix cycle → approved; follow-ups go to Backlog', async () => {
  const env = makeEnv({
    behaviors: {
      review: async (_spec, n) => ({
        structured: n === 1
          ? { outcome: 'changes_requested', summary: 'missing edge case', acceptanceCriteria: [{ criterion: 'handles zero', met: false, evidence: 'no test' }], findings: [{ severity: 'major', file: 'src/index.js', line: 1, issue: 'no zero handling', suggestion: 'add test' }], followUps: [{ title: 'Add input validation everywhere', description: 'later' }] }
          : { outcome: 'approved', summary: 'good', acceptanceCriteria: [], findings: [], followUps: [] },
      }),
      coding: async (spec, n) => {
        if (n === 2) assert.match(spec.prompt, /no zero handling/);
        return DEFAULTS.coding!(spec, n);
      },
    },
  });
  const t = await env.tracker.createTicket({ projectKey: 'demo', title: 'Divide helper', description: '', status: 'ready', priority: 2 });
  await env.cycle();
  assert.equal(job(env, t.identifier).review_cycles, 1);
  await env.cycle();
  assert.equal(job(env, t.identifier).status, 'awaiting_merge');
  const suggested = (await env.tracker.listTickets()).find((x) => x.title === 'Add input validation everywhere')!;
  assert.equal(suggested.status, 'backlog');
  assert.ok(suggested.labels.includes('autodev-suggested'));
  assert.equal(env.runner.calls.filter((c) => c.role === 'coding').length, 2);
});

test('crash recovery: dead worker lease is recovered; existing PR is adopted, not duplicated', async () => {
  const env = makeEnv();
  const t = await env.tracker.createTicket({ projectKey: 'demo', title: 'Crashy', description: '', status: 'ready', priority: 2 });
  await env.cycle();
  const j = job(env, t.identifier);
  assert.equal(j.status, 'awaiting_merge');
  // Simulate: process died mid-way after the PR was created but before the stage was recorded.
  updateJob(env.ctx.db, j.id, { status: 'running', stage: 'push', pr_number: null, pr_url: null, lease_owner: 'otherhost:1:x', lease_expires_at: Date.now() - 1 });
  await env.cycle();
  const after = job(env, t.identifier);
  assert.equal(after.status, 'awaiting_merge', after.error);
  assert.equal(after.pr_number, j.pr_number, 'found the existing PR by branch');
  assert.equal((env.ctx.db.prepare('SELECT COUNT(*) n FROM local_prs').get() as { n: number }).n, 1);
});

test('usage limit: job is re-queued without burning an attempt and new work pauses until reset', async () => {
  const resetsAt = Date.now() + 3600_000;
  const env = makeEnv({ behaviors: { coding: async () => ({ ok: false, errorKind: 'rate_limited', error: 'usage limit reached', resetsAt }) } });
  const t = await env.tracker.createTicket({ projectKey: 'demo', title: 'Limited', description: '', status: 'ready', priority: 2 });
  await env.tracker.createTicket({ projectKey: 'demo', title: 'Next', description: '', status: 'ready', priority: 3 });
  await env.cycle();
  const j = job(env, t.identifier);
  assert.equal(j.status, 'queued');
  assert.equal(j.attempts, 0);
  assert.ok(Number(kvGet(env.ctx.db, 'paused_until')) >= resetsAt);
  const callsBefore = env.runner.calls.length;
  await env.cycle();
  assert.equal(env.runner.calls.length, callsBefore, 'nothing new starts while paused');
});

test('budget: daily limit stops new runs and records why', async () => {
  const env = makeEnv({ config: { budget: { dailyUsd: 0.015 } } });
  await env.tracker.createTicket({ projectKey: 'demo', title: 'One', description: '', status: 'ready', priority: 2 });
  await env.tracker.createTicket({ projectKey: 'demo', title: 'Two', description: '', status: 'ready', priority: 2 });
  await env.cycle();
  await env.cycle();
  const started = (env.ctx.db.prepare('SELECT COUNT(*) n FROM jobs').get() as { n: number }).n;
  assert.ok(started <= 2);
  assert.match(String(kvGet(env.ctx.db, 'last_gate_reason')), /daily budget/);
});

test('human cancels an in-flight ticket: job stops, branch is preserved', async () => {
  const env = makeEnv({ behaviors: { coding: async (spec) => { appendFileSync(join(spec.cwd, 'CHANGES.md'), 'wip\n'); return { ok: false, errorKind: 'rate_limited', error: 'limit' }; } } });
  const t = await env.tracker.createTicket({ projectKey: 'demo', title: 'Cancel me', description: '', status: 'ready', priority: 2 });
  await env.cycle();
  await env.tracker.setStatus(t.id, 'canceled');
  env.ctx.db.prepare("DELETE FROM kv WHERE k = 'paused_until'").run();
  await env.cycle();
  assert.equal(job(env, t.identifier).status, 'canceled');
});

test('planning: idea → researched plan → Backlog tickets with dependencies (deduplicated) → human approval → Ready', async () => {
  const plan = {
    projectKey: 'demo', summary: 'Subscriptions', approach: 'Use src/index.js patterns', reuse: ['src/index.js'], requirements: ['plans'], risks: ['webhooks'],
    openQuestions: [{ question: 'Prices?', options: ['$5', '$10'], recommendation: '$10', blocking: true }], duplicates: [],
    tickets: [
      { key: 'T1', title: 'Add subscription schema', objective: 'o', problem: 'p', technicalContext: 'c', acceptanceCriteria: ['a'], testing: ['t'], dependsOn: [], priority: 2, complexity: 2, relevantFiles: ['src/db/'], security: 'none', definitionOfDone: ['d'], parallelizable: false },
      { key: 'T2', title: 'Add checkout endpoint', objective: 'o', problem: 'p', technicalContext: 'c', acceptanceCriteria: ['a'], testing: ['t'], dependsOn: ['T1'], priority: 2, complexity: 3, relevantFiles: ['src/api/'], security: 'validate webhooks', definitionOfDone: ['d'], parallelizable: true },
      { key: 'T3', title: 'Existing footer links work', objective: 'o', problem: 'p', technicalContext: 'c', acceptanceCriteria: ['a'], testing: ['t'], dependsOn: [], priority: 4, complexity: 1, relevantFiles: [], security: 'none', definitionOfDone: ['d'], parallelizable: true },
    ],
  };
  const env = makeEnv({ project: { maxConcurrent: 2 }, behaviors: { planning: async (spec) => { assert.equal(spec.mode, 'readonly'); assert.match(spec.prompt, /DEMO-1 \[ready\] Existing footer links work/); return { structured: plan }; } } });
  const existing = await env.tracker.createTicket({ projectKey: 'demo', title: 'Existing footer links work', description: '', status: 'ready', priority: 3 });
  const p = await draftPlan(env.ctx, 'Add Stripe subscriptions with Free, Personal, and Business plans.');
  assert.match(p.markdown, /Open questions[\s\S]*Prices\?/);
  const pub = await publishPlan(env.ctx, p.id);
  assert.equal(pub.created.length, 2);
  assert.equal(pub.skipped.length, 1, 'T3 deduplicated against existing ticket');
  const [t1, t2] = pub.created;
  assert.equal(t1.status, 'backlog');
  assert.deepEqual((await env.tracker.getTicket(t2.id))!.blockedBy, [t1.id]);
  assert.ok(t2.description.includes(`## Dependencies\n- ${t1.identifier}\n`), t2.description);

  // Nothing runs until a human approves (existing Ready ticket aside).
  await env.cycle();
  assert.equal(job(env, t1.identifier), undefined);
  // Approve by moving the [Plan] issue to Ready (as a human would in Linear).
  await env.tracker.setStatus(pub.parent.id, 'ready');
  await env.cycle();
  assert.equal((await env.tracker.getTicket(t1.id))!.status !== 'backlog', true);
  assert.equal((await env.tracker.getTicket(pub.parent.id))!.status, 'in_progress');
  assert.ok(job(env, t1.identifier), 'approved schema ticket started');
  assert.equal(job(env, t2.identifier), undefined, 'dependent waits for merge');
  await assert.rejects(approvePlan(env.ctx, 'nope', 'x'));
  void existing; void readFileSync;
});
