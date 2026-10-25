import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnv, job } from './helpers.ts';
import type { SecondReviewer, SecondReviewVerdict } from '../src/agents/second-review.ts';
import type { StructuredTask, Triage } from '../src/agents/triage.ts';
import type { FakeBehavior } from '../src/agents/fake.ts';
import { WorktreeTamperedError } from '../src/scm/git.ts';

// 2026-10-25 (DEV-17): a coding run was interrupted by a blocker that triage sequenced behind a fix ticket. The job was
// parked with the run's uncommitted work still in the workspace; when the fix merged, refreshing the base refused the
// dirty workspace (correctly), the error escaped reconciliation, and autodev's loop failed every 30 s.

const APPROVE: SecondReviewVerdict = { verdict: 'approve', summary: 'Correct.', findings: [], specConformance: 'ok' };
const DEFECT: Triage = { kind: 'defect', summary: 'Existing engine bug.', claim: '', checks: [], fixTickets: [], newTicket: { title: 'Engine: fix stuck hands', description: 'The engine leaves hands stuck.' }, instructions: 'Then finish the simulator.', recommendation: 'Fix first.' };

class Reviewer implements SecondReviewer {
  readonly provider = 'openai';
  readonly model = 'gpt-6.1-sol';
  triage: Triage[];
  constructor(triage: Triage[] = [DEFECT]) { this.triage = triage; }
  maxCostUsd() { return 0.1; }
  maxTestUpdateCostUsd() { return 0.1; }
  maxAskCostUsd() { return 0.1; }
  async review() { return { verdict: APPROVE, model: this.model, costUsd: 0.02, inputTokens: 1, outputTokens: 1 }; }
  async reviewTestUpdate(): Promise<never> { throw new Error('unexpected'); }
  async ask<T>(task: StructuredTask<T>) { return { value: task.parser.parse(this.triage.length > 1 ? this.triage.shift() : this.triage[0]), model: this.model, costUsd: 0.01, inputTokens: 1, outputTokens: 1 }; }
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'h', GIT_AUTHOR_EMAIL: 'h@h', GIT_COMMITTER_NAME: 'h', GIT_COMMITTER_EMAIL: 'h@h' } });
function pushToMain(repo: string, files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'seed-'));
  git(dir, 'clone', '-q', repo, '.');
  for (const [p, c] of Object.entries(files)) { mkdirSync(join(dir, p, '..'), { recursive: true }); writeFileSync(join(dir, p), c); }
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'main moves'); git(dir, 'push', '-q', 'origin', 'HEAD:main');
}
const done = (files: string[]) => ({ structured: { status: 'completed', summary: 'done', filesChanged: files, testsAdded: [], commandsRun: [], decisions: [], knownLimitations: [] } });
async function cycles(e: ReturnType<typeof makeEnv>, n: number) { for (let i = 0; i < n; i++) await e.cycle(); }
const events = (e: ReturnType<typeof makeEnv>, type: string) => (e.ctx.db.prepare('SELECT message FROM events WHERE type = ? ORDER BY id').all(type) as { message: string }[]).map((r) => r.message);
const comments = async (e: ReturnType<typeof makeEnv>, id: string) => (await e.tracker.listComments(id)).map((c) => c.body).join('\n---\n');
const merged = async (e: ReturnType<typeof makeEnv>, id: string) => { const pr = job(e, id)?.pr_number; return !!pr && (await e.scm.getPr(e.repo, pr)).state === 'merged'; };
const remoteHas = (e: ReturnType<typeof makeEnv>, ref: string) => { try { git(e.repo, 'rev-parse', '--verify', ref); return true; } catch { return false; } };
const mainHas = (e: ReturnType<typeof makeEnv>, file: string) => { try { git(e.repo, 'cat-file', '-e', `main:${file}`); return true; } catch { return false; } };

/** DEMO-1's first coding run writes work in progress and stops on a blocker; every later run completes. */
function codingInterruptedOnce(): FakeBehavior {
  let first = true;
  return async (spec) => {
    const id = spec.prompt.match(/# ([A-Z0-9]+-\d+):/)?.[1];
    if (first && id === 'DEMO-1') {
      first = false;
      writeFileSync(join(spec.cwd, 'simulator.txt'), 'work in progress\n');
      return { structured: { status: 'blocked', summary: 'stuck', filesChanged: ['simulator.txt'], testsAdded: [], commandsRun: [], decisions: [], knownLimitations: [], blocker: 'An existing engine bug leaves hands stuck; fix it first?' } };
    }
    const name = id ? `${id}.txt` : 'resumed.txt';
    writeFileSync(join(spec.cwd, name), `${name}\n`);
    return done([name]);
  };
}

function env(reviewer = new Reviewer(), opts: { triage?: boolean } = {}) {
  const e = makeEnv({ secondReviewer: reviewer, project: { autoMerge: true }, config: { secondReview: { enabled: true, ...(opts.triage === false ? { triage: { enabled: false } } : {}) } }, behaviors: { coding: codingInterruptedOnce() } });
  pushToMain(e.repo, { 'CHANGES.md': 'changes\n' });
  return e;
}
const ticket = (e: ReturnType<typeof makeEnv>, title = 'Simulator') => e.tracker.createTicket({ projectKey: 'demo', title, description: 'Build it.', status: 'ready', priority: 2 });

test('regression (DEV-17): work in progress is preserved locally when triage parks a job, and the job resumes on the refreshed base after the fix merges', async () => {
  const e = env();
  const t = await ticket(e);
  await cycles(e, 1);
  const j = job(e, t.identifier);
  assert.equal(j.status, 'blocked', 'parked behind the fix ticket');
  assert.equal(events(e, 'triage.sequenced').length, 1);
  // autodev commits through its private trusted store: read it through the same hardened view.
  assert.match(await e.ctx.ws.git(j.worktree, ['log', '--format=%s', '-1']), /^WIP DEMO-1 \(autodev: blocked\)\n?$/, 'the interrupted run was committed locally');
  assert.match(await e.ctx.ws.git(j.worktree, ['show', '--name-only', '--format=', 'HEAD']), /simulator\.txt/);
  assert.equal((await e.ctx.ws.status(j.worktree)).trim(), '', 'the workspace is clean');
  assert.equal(e.ctx.ws.trustedState(j.worktree).head_sha, (await e.ctx.ws.git(j.worktree, ['rev-parse', 'HEAD'])).trim());
  assert.equal(remoteHas(e, `refs/heads/${j.branch}`), false, 'unvalidated work in progress was not pushed');
  await cycles(e, 14);
  assert.equal(await merged(e, 'DEMO-2'), true, 'the fix merged first');
  assert.equal(events(e, 'job.resume_failed').length, 0);
  assert.equal(events(e, 'reconcile.job_error').length, 0, 'reconciliation never failed');
  assert.match(events(e, 'job.base_refreshed')[0]!, /DEMO-1: merged the latest main before resuming/);
  assert.equal(await merged(e, t.identifier), true);
  assert.ok(mainHas(e, 'simulator.txt') && mainHas(e, 'DEMO-2.txt'), 'both the preserved work and the fix are on main');
  assert.ok(e.runner.calls.some((c) => c.role === 'coding' && /Every change that came from main is legitimate, merged work by other tickets: keep it exactly as it is/.test(c.prompt)), 'the agent was told the merged changes are legitimate');
});

for (const failure of ['refresh', 'tamper'] as const) {
  test(`a resume whose workspace can't be prepared (${failure}) holds the ticket once, never crashes reconciliation, and other tickets keep going`, async () => {
    const e = env();
    const t = await ticket(e);
    await cycles(e, 1);
    const parked = job(e, t.identifier);
    const pushedBefore = remoteHas(e, `refs/heads/${parked.branch}`) ? git(e.repo, 'rev-parse', `refs/heads/${parked.branch}`) : null;
    if (failure === 'refresh') e.ctx.ws.refreshBase = async () => { throw new Error('merge failed: unexpected state'); };
    else {
      const original = e.ctx.ws.commitAll.bind(e.ctx.ws);
      e.ctx.ws.commitAll = async (path, message) => { if (path === parked.worktree) throw new WorktreeTamperedError(path, 'private HEAD differs from trusted candidate'); return original(path, message); };
    }
    await cycles(e, 10);
    assert.equal(await merged(e, 'DEMO-2'), true, 'the fix ticket still merged');
    assert.equal(job(e, t.identifier).status, 'blocked');
    assert.equal((await e.tracker.getTicket(t.id))!.status, 'blocked');
    assert.equal(events(e, 'job.resume_failed').length, 1, 'held once, not retried every tick');
    assert.match(await comments(e, t.id), /autodev could not resume this ticket: preparing the workspace .* failed, so nothing was changed or pushed/);
    assert.equal(events(e, 'reconcile.job_error').length, 0);
    assert.equal(remoteHas(e, `refs/heads/${parked.branch}`) ? git(e.repo, 'rev-parse', `refs/heads/${parked.branch}`) : null, pushedBefore, 'nothing was pushed');
    const other = await ticket(e, 'Unrelated');
    await cycles(e, 6);
    assert.equal(await merged(e, other.identifier), true, 'later tickets are processed normally');
  });
}

test('a human resume of a blocked job also refreshes the moved base first and tells the agent', async () => {
  let reviews = 0;
  const e = makeEnv({ secondReviewer: new Reviewer(), project: { autoMerge: true }, config: { secondReview: { enabled: true, triage: { enabled: false } } }, behaviors: {
    coding: async (spec) => { writeFileSync(join(spec.cwd, 'feature.txt'), 'feature\n'); return done(['feature.txt']); },
    review: async () => (++reviews === 1 ? { structured: { outcome: 'blocked', summary: 'one question', acceptanceCriteria: [], findings: [], followUps: [], blockingQuestion: 'Which format?' } } : { structured: { outcome: 'approved', summary: 'ok', acceptanceCriteria: [], findings: [], followUps: [] } }),
  } });
  pushToMain(e.repo, { 'CHANGES.md': 'changes\n' });
  const t = await ticket(e, 'Feature');
  await cycles(e, 3);
  assert.equal(job(e, t.identifier).status, 'blocked');
  pushToMain(e.repo, { 'other.txt': 'merged by another ticket\n' });
  e.tracker.humanComment(t.id, '/answer Use JSON.');
  await e.tracker.setStatus(t.id, 'ready');
  await cycles(e, 6);
  assert.match(events(e, 'job.base_refreshed')[0]!, /merged the latest main before resuming/);
  assert.ok(e.runner.calls.some((c) => c.role === 'coding' && /Autodev merged the latest main/.test(c.prompt)));
  assert.equal(await merged(e, t.identifier), true);
  assert.ok(mainHas(e, 'other.txt') && mainHas(e, 'feature.txt'));
});

test('one job failing in reconciliation does not stop the others', async () => {
  const e = makeEnv({ secondReviewer: new Reviewer(), project: { autoMerge: true }, config: { secondReview: { enabled: true } } });
  pushToMain(e.repo, { 'CHANGES.md': 'changes\n' });
  const a = await ticket(e, 'A');
  // Linear keeps refusing to mark A Done (after its PR merged), which escapes A's reconciliation every pass.
  const setStatus = e.tracker.setStatus.bind(e.tracker);
  e.tracker.setStatus = async (id, status) => { if (id === a.id && status === 'done') throw new Error('Linear 502'); return setStatus(id, status); };
  await cycles(e, 4);
  assert.equal(await merged(e, a.identifier), true);
  assert.equal(job(e, a.identifier).status, 'awaiting_merge', 'not marked done ahead of Linear');
  const b = await ticket(e, 'B');
  await cycles(e, 8);
  assert.equal(await merged(e, b.identifier), true, 'B merged although A keeps failing');
  assert.match(events(e, 'reconcile.job_error')[0]!, /DEMO-1: Linear 502/);
  assert.equal(events(e, 'reconcile.job_error').length, 1, 'the same error is logged once');
});
