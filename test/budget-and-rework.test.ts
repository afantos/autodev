import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeEnv, job } from './helpers.ts';
import type { SecondReviewer, SecondReviewInput, SecondReviewVerdict } from '../src/agents/second-review.ts';
import type { FakeBehavior } from '../src/agents/fake.ts';

// 2026-10-25: DEV-56 reached its $3 ticket budget in a rework loop (GPT's cached verdict predated the owner's
// clarification; the coding agent correctly changed nothing), then retried every ~14 s forever, holding the project's
// only slot so DEV-57 could not run.

const APPROVE: SecondReviewVerdict = { verdict: 'approve', summary: 'Correct.', findings: [], specConformance: 'ok' };
const CHANGES: SecondReviewVerdict = { verdict: 'request_changes', summary: 'Missing the simulator change.', findings: [{ severity: 'major', category: 'spec', file: 'src/a.js', line: 1, issue: 'simulator skip not removed', suggestion: 'remove it' }], specConformance: 'incomplete' };

class Reviewer implements SecondReviewer {
  readonly provider = 'openai';
  readonly model = 'gpt-6.1-sol';
  inputs: SecondReviewInput[] = [];
  verdicts: SecondReviewVerdict[];
  constructor(verdicts: SecondReviewVerdict[]) { this.verdicts = verdicts; }
  maxCostUsd() { return 0.1; }
  maxTestUpdateCostUsd() { return 0.1; }
  async review(input: SecondReviewInput) { this.inputs.push(input); return { verdict: this.verdicts.length > 1 ? this.verdicts.shift()! : this.verdicts[0]!, model: this.model, costUsd: 0.02, inputTokens: 1, outputTokens: 1 }; }
  async reviewTestUpdate(): Promise<never> { throw new Error('unexpected'); }
}

/** Always writes the same content: a rework produces no new candidate. */
const sameEveryTime: FakeBehavior = async (spec) => {
  writeFileSync(join(spec.cwd, 'CHANGES.md'), `- change\n`);
  writeFileSync(join(spec.cwd, 'fix.txt'), 'fixed content\n');
  return { structured: { status: 'completed', summary: 'done', filesChanged: ['CHANGES.md'], testsAdded: [], commandsRun: [], decisions: [], knownLimitations: [] } };
};
async function cycles(e: ReturnType<typeof makeEnv>, n: number) { for (let i = 0; i < n; i++) await e.cycle(); }
const events = (e: ReturnType<typeof makeEnv>, type: string, like = '%') => (e.ctx.db.prepare('SELECT message FROM events WHERE type = ? AND message LIKE ?').all(type, like) as { message: string }[]).map((r) => r.message);
const ticket = (e: ReturnType<typeof makeEnv>, title: string) => e.tracker.createTicket({ projectKey: 'demo', title, description: 'Do it.', status: 'ready', priority: 2 });

test('a run refused by the ticket budget blocks for a human instead of retrying forever, and frees the slot for the next ticket', async () => {
  // Each fake agent run costs $0.01: the coding run spends the whole $0.01 ticket budget, so the review run is refused.
  const e = makeEnv({ config: { budget: { perTicketUsd: 0.01 } } });
  const a = await ticket(e, 'First');
  const b = await ticket(e, 'Second');
  await cycles(e, 8);
  for (const t of [a, b]) {
    assert.equal(job(e, t.identifier).status, 'blocked', `${t.identifier} blocked`);
    assert.equal((await e.tracker.getTicket(t.id))!.status, 'blocked');
  }
  assert.equal(events(e, 'job.requeued', '%ticket budget%').length, 0, 'never requeued on the ticket budget');
  assert.match(events(e, 'job.blocked')[0]!, /ticket budget \$0\.01 exhausted \(\$0\.01 spent\)/);
});

test('global limits still wait (requeue) rather than block', async () => {
  const e = makeEnv({ config: { budget: { dailyUsd: 0.005 } } });
  const t = await ticket(e, 'Waits');
  await cycles(e, 3);
  assert.notEqual(job(e, t.identifier)?.status, 'blocked');
  assert.equal(events(e, 'job.blocked').length, 0);
});

test('an owner-approved per-ticket override applies to that ticket only', async () => {
  const e = makeEnv({ config: { budget: { perTicketUsd: 0.01, perTicketOverrides: { 'DEMO-1': 1 } } } });
  const a = await ticket(e, 'Has an override');
  const b = await ticket(e, 'No override');
  await cycles(e, 10);
  assert.equal(job(e, a.identifier).status, 'awaiting_merge', 'DEMO-1 finished within its $1 override');
  assert.equal(job(e, b.identifier).status, 'blocked', 'DEMO-2 keeps the $0.01 global limit');
});

test('no progress: when a rework leaves the candidate unchanged and the second review still requests changes, it holds instead of looping', async () => {
  const reviewer = new Reviewer([CHANGES]);
  const e = makeEnv({ secondReviewer: reviewer, project: { autoMerge: true }, config: { secondReview: { enabled: true } }, behaviors: { coding: sameEveryTime } });
  const t = await ticket(e, 'Engine fix');
  await cycles(e, 10);
  assert.equal(events(e, 'automerge.rework').length, 1, 'one rework, not a loop');
  assert.equal(reviewer.inputs.length, 1, 'the verdict for the unchanged candidate is reused, not re-bought');
  assert.match(events(e, 'automerge.hold')[0]!, /the last rework left the candidate unchanged/);
  assert.equal(job(e, t.identifier).status, 'awaiting_merge');
  const codingRuns = e.runner.calls.filter((c) => c.role === 'coding').length;
  await cycles(e, 3);
  assert.equal(e.runner.calls.filter((c) => c.role === 'coding').length, codingRuns, 'no further spend while held');
});

test('a clarified ticket gets a fresh second review: the cached verdict predates the clarification', async () => {
  const reviewer = new Reviewer([CHANGES, APPROVE]);
  const e = makeEnv({ secondReviewer: reviewer, project: { autoMerge: true }, config: { secondReview: { enabled: true } }, behaviors: { coding: sameEveryTime } });
  const t = await ticket(e, 'Engine fix');
  await cycles(e, 10);
  assert.equal(reviewer.inputs.length, 1);
  e.ctx.db.prepare('UPDATE local_tickets SET description = ? WHERE id = ?').run('Do it.\n\n## Owner clarification\nThe simulator skip is removed in another ticket; do not change it here.', t.id);
  await cycles(e, 3);
  assert.equal(reviewer.inputs.length, 2, 'reviewed again with the clarification');
  assert.match(reviewer.inputs[1]!.ticket.description, /Owner clarification/);
  assert.equal((await e.scm.getPr(e.repo, job(e, t.identifier).pr_number)).state, 'merged');
});
