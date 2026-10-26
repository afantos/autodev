import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { excerptCiLog } from '../src/ci-log.ts';
import { failingTestFiles, failingTestFilesOfChecks, inDiff } from '../src/ci-flake.ts';
import { GitHubScm } from '../src/scm/github.ts';
import { makeEnv, job } from './helpers.ts';
import type { Env } from './helpers.ts';
import type { CheckResult, PullRequest } from '../src/types.ts';

// 2026-10-26 (luckywinclub LWC-29, LWC-27): test-integration/entry-concurrency.test.ts failed intermittently while each
// PR's own tests passed. autodev fed the failure to the coding agent, which cannot fix code outside its diff, and the
// ticket blocked for a human. A failure confined to test files outside the diff now re-runs the failed jobs once per
// candidate. A repeat failure is evidence of a real regression (an unchanged test may cover changed code), so it is
// called likely pre-existing only when the base branch's latest CI fails the same tests.

const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');

test('failing test files are parsed from the node:test summary of real CI logs', () => {
  assert.deepEqual(failingTestFiles(excerptCiLog(fixture('ci-hook-error-repeated.log'))), ['test-integration/entry-concurrency.test.ts']);
  assert.deepEqual(failingTestFiles(excerptCiLog(fixture('ci-compose-node-test.log'))), ['test-integration/entry-concurrency.test.ts']);
  assert.deepEqual(failingTestFiles(excerptCiLog(fixture('ci-node-test-assertion.log'))), ['test-integration/claims-deadline-dst.test.ts']);
  assert.deepEqual(failingTestFiles('npm ERR! lint failed\nError: boom'), []);
});

test('every failing check must name a failing test file; absolute runner paths match the diff by suffix', () => {
  const failure = (logExcerpt: string, names = ['test']): CheckResult => ({ state: 'failure', failures: names.map((name) => ({ name, summary: 'failure' })), logExcerpt });
  assert.deepEqual(failingTestFilesOfChecks(failure('✖ failing tests:\n\ntest at ./test/a.test.ts:3:1\ntest at test/b.test.ts:9:5\ntest at test/a.test.ts:7:1')), ['test/a.test.ts', 'test/b.test.ts']);
  const two = '===== test =====\n✖ failing tests:\ntest at test/a.test.ts:1:1\n===== lint =====\nerror  no-unused-vars';
  assert.equal(failingTestFilesOfChecks(failure(two, ['test', 'lint'])), null, 'lint failed too: not a flake');
  assert.deepEqual(failingTestFilesOfChecks(failure(two.replace('error  no-unused-vars', 'test at test/c.test.ts:1:1'), ['test', 'lint'])), ['test/a.test.ts', 'test/c.test.ts']);
  assert.equal(failingTestFilesOfChecks(failure('exit 1')), null);
  // Two failing checks with one name (different workflows): their logs cannot be told apart, so neither explains the other.
  const sameName = '===== test =====\n✖ failing tests:\ntest at test/a.test.ts:1:1\n===== test =====\nerror TS2304: Cannot find name';
  assert.equal(failingTestFilesOfChecks(failure(sameName, ['test', 'test'])), null);
  assert.ok(inDiff('/home/runner/work/app/app/test/a.test.ts', ['test/a.test.ts']));
  assert.ok(!inDiff('test/a.test.ts', ['src/a.ts']));
});

const FLAKY = `✖ failing tests:\n\ntest at test-integration/entry-concurrency.test.ts:1:1\n✖ concurrent entries (812ms)\n  Error: Test hook "after" at test-integration/entry-concurrency.test.ts:20:3 generated asynchronous activity after the test ended`;

/** The PR's CI reports `results` in turn (the last one repeats); the base branch reports `base`. Re-runs are counted. */
function scriptedCi(e: Env, results: CheckResult[], base: CheckResult = { state: 'success', failures: [], logExcerpt: '' }, opts: { realRerun?: boolean } = {}) {
  const calls = { checks: 0, reruns: [] as string[] };
  e.ctx.scm.checks = async (_repo: string, pr: PullRequest) => (pr.headBranch === 'main' ? base : results[Math.min(calls.checks++, results.length - 1)]!);
  if (!opts.realRerun) e.ctx.scm.rerunFailedJobs = async (_repo: string, pr: PullRequest) => { calls.reruns.push(pr.headSha); };
  return calls;
}
const failed = (logExcerpt: string): CheckResult => ({ state: 'failure', failures: [{ name: 'test', summary: 'failure' }], logExcerpt });
const passed: CheckResult = { state: 'success', failures: [], logExcerpt: '' };
const events = (e: Env, type: string) => e.ctx.db.prepare('SELECT message, data_json FROM events WHERE type = ?').all(type) as { message: string; data_json: string | null }[];

test('a failure only in tests outside the diff re-runs the failed jobs once and proceeds when the re-run passes', async () => {
  const e = makeEnv({ config: { loop: { ciPollSeconds: 0 } } });
  const ci = scriptedCi(e, [failed(FLAKY), passed]);
  const t = await e.tracker.createTicket({ projectKey: 'demo', title: 'Flaky', description: '', status: 'ready', priority: 2 });
  await e.cycle();
  let j = job(e, t.identifier);
  assert.equal(j.status, 'waiting_ci', String(j.blocked_reason ?? j.error));
  assert.deepEqual(ci.reruns, [j.candidate_sha]);
  assert.equal(j.fix_attempts, 0, 'the agent was not handed the failure');
  const retry = events(e, 'ci.flake_retry');
  assert.equal(retry.length, 1);
  assert.deepEqual(JSON.parse(retry[0]!.data_json!).files, ['test-integration/entry-concurrency.test.ts']);

  await e.cycle();
  j = job(e, t.identifier);
  assert.equal(j.status, 'awaiting_merge', String(j.blocked_reason ?? j.error));
  assert.equal(ci.reruns.length, 1);
  assert.equal(events(e, 'fix.ci').length, 0);
  assert.equal(events(e, 'ci.flake_suspected').length, 0);
});

/** Claim a ticket, let CI fail and be re-run, then let the worker see CI's second report. Returns the job after that. */
async function failTwice(e: Env) {
  const t = await e.tracker.createTicket({ projectKey: 'demo', title: 'Flaky', description: '', status: 'ready', priority: 2 });
  await e.cycle();
  const first = job(e, t.identifier);
  assert.equal(first.status, 'waiting_ci', String(first.blocked_reason ?? first.error));
  await e.orch.pollCi();
  assert.equal(job(e, t.identifier).status, 'queued');
  // The worker resumes at the CI stage, sees the failure again, and hands it to the agent instead of re-running again.
  await e.orch.tick();
  await e.orch.drain(Infinity);
  return { first, j: job(e, t.identifier) };
}

test('an unchanged test that fails again after the re-run goes to the agent as a possible regression, not as flaky', async () => {
  const e = makeEnv({ config: { loop: { ciPollSeconds: 0 } } });
  const ci = scriptedCi(e, [failed(FLAKY)]);
  const { first, j } = await failTwice(e);
  assert.deepEqual(ci.reruns, [first.candidate_sha], 'one re-run per candidate');
  assert.equal(j.status, 'queued');
  assert.equal(j.stage, 'workspace');
  assert.equal(j.fix_attempts, 1);
  assert.match(String(j.pending_feedback), /generated asynchronous activity/, 'the agent still sees the failure');
  assert.match(String(j.pending_feedback), /failed again when the failed CI jobs were re-run on this commit\. These tests are not in your diff but may test code you changed/);
  assert.doesNotMatch(String(j.pending_feedback), /flaky|predates|knownLimitations/);
  assert.equal(events(e, 'ci.flake_suspected').length, 0);
  assert.equal(events(e, 'ci.retry_failed').length, 1);
});

test('tests that fail again and also fail on the base branch are reported as likely pre-existing', async () => {
  const e = makeEnv({ config: { loop: { ciPollSeconds: 0 } } });
  const ci = scriptedCi(e, [failed(FLAKY)], failed(FLAKY));
  const { first, j } = await failTwice(e);
  assert.deepEqual(ci.reruns, [first.candidate_sha]);
  const suspected = events(e, 'ci.flake_suspected');
  assert.equal(suspected.length, 1);
  assert.match(suspected[0]!.message, /entry-concurrency\.test\.ts/);
  assert.deepEqual(JSON.parse(suspected[0]!.data_json!), { sha: first.candidate_sha, base: 'main', files: ['test-integration/entry-concurrency.test.ts'] });
  assert.equal(j.fix_attempts, 1);
  assert.match(String(j.pending_feedback), /also fail on the latest CI run of `main`\. The failure likely predates this change/);
});

test('base-branch failures in other tests do not make a repeat failure look pre-existing', async () => {
  const e = makeEnv({ config: { loop: { ciPollSeconds: 0 } } });
  scriptedCi(e, [failed(FLAKY)], failed('✖ failing tests:\n\ntest at test-integration/other.test.ts:1:1'));
  const { j } = await failTwice(e);
  assert.equal(events(e, 'ci.flake_suspected').length, 0);
  assert.doesNotMatch(String(j.pending_feedback), /flaky|predates/);
});

test('a failure in a test file the PR changed goes to the agent without a re-run', async () => {
  const e = makeEnv({ config: { loop: { ciPollSeconds: 0 } } });
  // The fake coding agent writes CHANGES.md, so a failure located there is inside the diff.
  const ci = scriptedCi(e, [failed('✖ failing tests:\n\ntest at CHANGES.md:1:1\n✖ changes (3ms)\n  AssertionError: expected 1 to equal 2'), passed]);
  const t = await e.tracker.createTicket({ projectKey: 'demo', title: 'Real failure', description: '', status: 'ready', priority: 2 });
  await e.cycle();
  const j = job(e, t.identifier);
  assert.equal(ci.reruns.length, 0);
  assert.equal(events(e, 'ci.flake_retry').length, 0);
  assert.equal(events(e, 'fix.ci').length, 1);
  assert.equal(j.fix_attempts, 1);
  assert.doesNotMatch(String(j.pending_feedback ?? ''), /not in your diff|flaky/);
});

test('a failure without failing test locations (lint, build) goes to the agent without a re-run', async () => {
  const e = makeEnv({ config: { loop: { ciPollSeconds: 0 } } });
  const ci = scriptedCi(e, [failed('npm ERR! code ELIFECYCLE\nError: lint failed'), passed]);
  const t = await e.tracker.createTicket({ projectKey: 'demo', title: 'Lint', description: '', status: 'ready', priority: 2 });
  await e.cycle();
  assert.equal(ci.reruns.length, 0);
  assert.equal(events(e, 'fix.ci').length, 1);
  assert.equal(job(e, t.identifier).fix_attempts, 1);
});

test('when the re-run cannot be requested, the agent gets the failure with a neutral outside-the-diff note', async () => {
  const e = makeEnv({ config: { loop: { ciPollSeconds: 0 } } });
  scriptedCi(e, [failed(FLAKY), passed]);
  e.ctx.scm.rerunFailedJobs = async () => { throw new Error('Resource not accessible by integration'); };
  const t = await e.tracker.createTicket({ projectKey: 'demo', title: 'No permission', description: '', status: 'ready', priority: 2 });
  await e.cycle();
  const j = job(e, t.identifier);
  assert.equal(events(e, 'ci.flake_retry_error').length, 1);
  assert.equal(events(e, 'ci.flake_retry').length, 0);
  assert.equal(j.fix_attempts, 1);
  assert.match(String(j.pending_feedback), /does not touch \(`test-integration\/entry-concurrency\.test\.ts`\)\. These tests are not in your diff but may test code you changed/);
  assert.doesNotMatch(String(j.pending_feedback), /flaky|predates/, 'without a re-run there is no evidence of flakiness');
});

test('local CI cannot re-run jobs: its cached failure is never read as a re-run result', async () => {
  const e = makeEnv({ config: { loop: { ciPollSeconds: 0 } } });
  scriptedCi(e, [failed(FLAKY), passed], undefined, { realRerun: true });
  const t = await e.tracker.createTicket({ projectKey: 'demo', title: 'Local', description: '', status: 'ready', priority: 2 });
  await e.cycle();
  const j = job(e, t.identifier);
  assert.match(events(e, 'ci.flake_retry_error')[0]?.message ?? '', /local CI cannot re-run jobs/);
  assert.equal(events(e, 'ci.flake_retry').length, 0);
  assert.equal(j.fix_attempts, 1);
  assert.doesNotMatch(String(j.pending_feedback), /re-run on this commit|flaky|predates/);
});

/** A GitHubScm whose Actions API is faked: one failed run (attempt 1) that GitHub reports re-run after `registerAfter` polls. */
function githubWithRun(registerAfter: number) {
  const scm = new GitHubScm('token');
  scm.rerunPollMs = 1;
  const calls = { reruns: [] as number[], polls: 0 };
  const actions = {
    listWorkflowRunsForRepo: async () => ({ data: { workflow_runs: [
      { id: 7, status: 'completed', conclusion: 'failure', run_attempt: 1 },
      { id: 8, status: 'completed', conclusion: 'success', run_attempt: 1 },
    ] } }),
    reRunWorkflowFailedJobs: async ({ run_id }: { run_id: number }) => { calls.reruns.push(run_id); },
    getWorkflowRun: async () => (++calls.polls > registerAfter
      ? { data: { status: 'queued', run_attempt: 2 } }
      : { data: { status: 'completed', conclusion: 'failure', run_attempt: 1 } }),
  };
  Object.assign(scm, { gh: { actions } });
  const pr: PullRequest = { number: 1, url: '', headBranch: 'b', baseBranch: 'main', headSha: 'abcdef1234567890', state: 'open', draft: false };
  return { scm, calls, pr };
}

test('GitHub re-run waits for GitHub to register the new attempt, re-running only failed runs', async () => {
  const { scm, calls, pr } = githubWithRun(4);
  await scm.rerunFailedJobs('o/r', pr);
  assert.deepEqual(calls.reruns, [7]);
  assert.equal(calls.polls, 5, 'returned on the first poll that showed the new attempt');
});

test('GitHub re-run that never registers throws, so the old failed attempt is not taken for the re-run result', async () => {
  const { scm, calls, pr } = githubWithRun(Infinity);
  await assert.rejects(scm.rerunFailedJobs('o/r', pr), /did not register the re-run of workflow run 7/);
  assert.equal(calls.polls, 10);
});
