import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, job } from './helpers.ts';
import { getJob, kvSet } from '../src/db.ts';
import { answerBlocked } from '../src/pipeline.ts';
import { flaggedReviewAccepted } from '../src/triage.ts';
import type { FlaggedReview, StructuredTask } from '../src/agents/triage.ts';
import type { SecondReviewer, SecondReviewInput, SecondReviewVerdict, TestIntegrityVerdict, TestUpdateReviewInput } from '../src/agents/second-review.ts';

// flaggedDiffApprover 'second-review': the owner delegates approval of policy-flagged diffs to the second reviewer.

const APPROVE: SecondReviewVerdict = { verdict: 'approve', summary: 'Correct and matches the spec.', findings: [], specConformance: 'ok' };

/** Second reviewer with a programmable flagged-diff verdict; records every structured request and every review. */
class Reviewer implements SecondReviewer {
  readonly provider = 'openai';
  readonly model = 'gpt-6.1-sol';
  asked: { name: string; prompt: string }[] = [];
  reviews: SecondReviewInput[] = [];
  flagged: (ids: string[]) => FlaggedReview;
  constructor(flagged: (ids: string[]) => FlaggedReview) { this.flagged = flagged; }
  maxCostUsd() { return 0.2; }
  maxAskCostUsd() { return 0.1; }
  maxTestUpdateCostUsd() { return 0.1; }
  async reviewTestUpdate(_input: TestUpdateReviewInput) {
    const verdict: TestIntegrityVerdict = { verdict: 'approve', implementsRequirement: true, preservesCoverage: true, summary: 'ok', concerns: [] };
    return { verdict, model: this.model, costUsd: 0.01, inputTokens: 1, outputTokens: 1 };
  }
  async review(input: SecondReviewInput) {
    this.reviews.push(input);
    return { verdict: APPROVE, model: this.model, costUsd: 0.05, inputTokens: 1, outputTokens: 1 };
  }
  async ask<T>(task: StructuredTask<T>) {
    this.asked.push({ name: task.name, prompt: task.prompt });
    if (task.name !== 'flagged_diff_review') throw new Error(`unexpected task ${task.name}`);
    const ids = [...task.prompt.matchAll(/^- (f\d+): /gm)].map((m) => m[1]!);
    return { value: task.parser.parse(this.flagged(ids)), model: this.model, costUsd: 0.01, inputTokens: 1, outputTokens: 1 };
  }
}

const accept = (ids: string[]): FlaggedReview => ({ verdict: 'approve', summary: 'Every flagged change is what the ticket asks for.', findings: ids.map((id) => ({ id, acceptable: true, explanation: 'in scope' })) });

function env(reviewer: SecondReviewer, project: Record<string, unknown> = {}) {
  return makeEnv({
    secondReviewer: reviewer,
    project: { autoMerge: true, humanReviewPaths: ['^CHANGES\\.md$'], flaggedDiffApprover: 'second-review', ...project },
    config: { secondReview: { enabled: true } },
  });
}
const ready = (e: ReturnType<typeof makeEnv>) => e.tracker.createTicket({ projectKey: 'demo', title: 'Feature', description: 'Do the thing.', status: 'ready', priority: 2 });
async function cycles(e: ReturnType<typeof makeEnv>, n: number) { for (let i = 0; i < n; i++) await e.cycle(); }
const comments = async (e: ReturnType<typeof makeEnv>, id: string) => (await e.tracker.listComments(id)).map((c) => c.body).join('\n---\n');

test('a flagged diff is approved by the second reviewer, then reviewed and merged with no human step', async () => {
  const reviewer = new Reviewer(accept);
  const e = env(reviewer);
  const t = await ready(e);
  await cycles(e, 4);
  const j = job(e, t.identifier);
  assert.equal(j.status, 'done', String(j.blocked_reason ?? j.error));
  assert.equal((await e.scm.getPr(e.repo, j.pr_number)).state, 'merged');
  assert.deepEqual(reviewer.asked.map((a) => a.name), ['flagged_diff_review']);
  assert.match(reviewer.asked[0]!.prompt, /CHANGES\.md: protected path/);
  assert.equal(reviewer.reviews.length, 1, 'the normal second review still runs');
  assert.match(await comments(e, t.id), /Flagged-diff approval \(gpt-6\.1-sol, delegated by the owner\)/);
});

test('a finding the second reviewer does not accept holds the PR for a human', async () => {
  const reviewer = new Reviewer((ids) => ({ verdict: 'escalate', summary: 'The test edit hides a regression.', findings: ids.map((id) => ({ id, acceptable: false, explanation: 'weakens a check' })) }));
  const e = env(reviewer);
  const t = await ready(e);
  await cycles(e, 4);
  const j = job(e, t.identifier);
  assert.equal(j.status, 'awaiting_merge');
  assert.equal((await e.scm.getPr(e.repo, j.pr_number)).state, 'open');
  assert.equal(reviewer.reviews.length, 0, 'no merge review without a flagged-diff approval');
  assert.match(await comments(e, t.id), /Second-review approval: gpt-6\.1-sol did not approve[\s\S]*hides a regression/);
});

test('a verdict that says approve but leaves a finding unaccepted still holds', async () => {
  const reviewer = new Reviewer((ids) => ({ verdict: 'approve', summary: 'Looks fine.', findings: ids.map((id) => ({ id, acceptable: false, explanation: 'no' })) }));
  const e = env(reviewer);
  const t = await ready(e);
  await cycles(e, 4);
  assert.equal((await e.scm.getPr(e.repo, job(e, t.identifier).pr_number)).state, 'open');
});

test('files matching alwaysHumanPaths still go to the owner; the second reviewer is never asked', async () => {
  const reviewer = new Reviewer(accept);
  const e = env(reviewer, { alwaysHumanPaths: ['^CHANGES\\.md$'] });
  const t = await ready(e);
  await e.cycle();
  const j = job(e, t.identifier);
  assert.equal(j.status, 'blocked');
  assert.match(String(j.blocked_reason), /\/answer approve/);
  assert.equal(reviewer.asked.length, 0);
});

test('without the flag (default human) a flagged diff still blocks for the owner', async () => {
  const reviewer = new Reviewer(accept);
  const e = env(reviewer, { flaggedDiffApprover: 'human' });
  const t = await ready(e);
  await e.cycle();
  assert.equal(job(e, t.identifier).status, 'blocked');
  assert.equal(reviewer.asked.length, 0);
});

test('without autoMerge the flag does nothing', async () => {
  const reviewer = new Reviewer(accept);
  const e = env(reviewer, { autoMerge: false });
  const t = await ready(e);
  await e.cycle();
  assert.equal(job(e, t.identifier).status, 'blocked');
  assert.equal(reviewer.asked.length, 0);
});

test('flaggedReviewAccepted requires approve and every finding accepted exactly once', () => {
  const ok: FlaggedReview = { verdict: 'approve', summary: '', findings: [{ id: 'f1', acceptable: true, explanation: '' }, { id: 'f2', acceptable: true, explanation: '' }] };
  assert.equal(flaggedReviewAccepted(ok, ['f1', 'f2']), true);
  assert.equal(flaggedReviewAccepted({ ...ok, verdict: 'escalate' }, ['f1', 'f2']), false);
  assert.equal(flaggedReviewAccepted({ ...ok, findings: [ok.findings[0]!] }, ['f1', 'f2']), false, 'missing finding');
  assert.equal(flaggedReviewAccepted({ ...ok, findings: [ok.findings[0]!, ok.findings[0]!] }, ['f1', 'f2']), false, 'duplicate id');
  assert.equal(flaggedReviewAccepted({ ...ok, findings: [ok.findings[0]!, { id: 'f9', acceptable: true, explanation: '' }] }, ['f1', 'f2']), false, 'unknown id');
  assert.equal(flaggedReviewAccepted({ ...ok, findings: [ok.findings[0]!, { id: 'f2', acceptable: false, explanation: '' }] }, ['f1', 'f2']), false);
});

// ---------------------------------------------------------------- review fixes (GPT code review of 6c7a5a1)

test('an otherwise clean diff touching alwaysHumanPaths still goes to the owner', async () => {
  const reviewer = new Reviewer(accept);
  const e = env(reviewer, { humanReviewPaths: [], alwaysHumanPaths: ['^CHANGES\\.md$'] });
  const t = await ready(e);
  await e.cycle();
  const j = job(e, t.identifier);
  assert.equal(j.status, 'blocked');
  assert.match(String(j.blocked_reason), /CHANGES\.md: owner-only path/);
  assert.equal(reviewer.asked.length, 0);
});

test('mergeOwnerApprovedDiffs merges only an exact owner approval, not one carried over by fingerprint', async () => {
  const reviewer = new Reviewer(accept);
  const e = makeEnv({ secondReviewer: reviewer, project: { autoMerge: true, humanReviewPaths: ['^CHANGES\\.md$'] }, config: { secondReview: { enabled: true, mergeOwnerApprovedDiffs: true } } });
  const t = await ready(e);
  await e.cycle();
  const j = job(e, t.identifier);
  assert.equal(j.status, 'blocked');
  const hash = JSON.parse(j.blocked_reason!).policyHash as string;
  await answerBlocked(e.ctx, getJob(e.ctx.db, j.id)!, 'approve');
  // Downgrade the exact approval to what requireChangeApproval stores after a base refresh: same change, not this hash.
  kvSet(e.ctx.db, `policy-approved:${j.id}:${hash}`, 'human (carried over: same change, moved base)');
  await cycles(e, 4);
  const after = job(e, t.identifier);
  assert.ok(after.pr_number, `${after.status}/${after.stage}: ${after.blocked_reason ?? after.error}`);
  assert.equal((await e.scm.getPr(e.repo, after.pr_number)).state, 'open', 'a carried approval must not merge on its own');
  assert.match(await comments(e, t.id), /diff policy flags changes that need a human/);
});

test('a flagged-diff verdict is not reused once the ticket requirements change', async () => {
  let n = 0;
  const reviewer = new Reviewer((ids) => (++n === 1
    ? { verdict: 'escalate', summary: 'Out of scope for this ticket.', findings: ids.map((id) => ({ id, acceptable: false, explanation: 'scope' })) }
    : accept(ids)));
  const e = env(reviewer);
  const t = await ready(e);
  await cycles(e, 4);
  assert.equal((await e.scm.getPr(e.repo, job(e, t.identifier).pr_number)).state, 'open');
  assert.equal(reviewer.asked.length, 1);
  e.ctx.db.prepare('UPDATE local_tickets SET description = ? WHERE id = ?').run('Do the thing. Updating CHANGES.md is in scope.', t.id);
  await cycles(e, 3);
  assert.equal(reviewer.asked.length, 2, 'the clarified ticket gets a fresh flagged-diff judgment');
  assert.equal((await e.scm.getPr(e.repo, job(e, t.identifier).pr_number)).state, 'merged');
});
