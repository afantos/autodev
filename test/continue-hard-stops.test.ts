import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, job } from './helpers.ts';
import type { SecondReviewer } from '../src/agents/second-review.ts';

class Reviewer implements SecondReviewer {
  provider = 'openai'; model = 'test'; maxCostUsd() { return 0.1; } maxTestUpdateCostUsd() { return 0.1; }
  async reviewTestUpdate(): Promise<never> { throw new Error('unexpected'); }
  async review() { return { verdict: { verdict: 'approve' as const, summary: 'ok', findings: [], specConformance: 'ok' }, model: this.model, costUsd: 0.01, inputTokens: 1, outputTokens: 1 }; }
}

test('continue: a ticket over its budget stops once instead of re-blocking on every pass', async () => {
  const e = makeEnv({ project: { autoMerge: true, decisionMode: 'continue' }, config: { budget: { perTicketUsd: 0.001 }, secondReview: { enabled: true } }, secondReviewer: new Reviewer() });
  const t = await e.tracker.createTicket({ projectKey: 'demo', title: 'Small change', description: 'Implement it.', status: 'ready', priority: 2 });
  for (let i = 0; i < 6; i++) await e.cycle();
  const j = job(e, t.identifier);
  assert.equal(j.status, 'blocked');
  const delegated = e.ctx.db.prepare("SELECT COUNT(*) n FROM events WHERE type = 'blocker.delegated'").get() as { n: number };
  assert.equal(delegated.n, 0);
  const codingRuns = e.runner.calls.filter(c => c.role === 'coding').length;
  for (let i = 0; i < 4; i++) await e.cycle();
  assert.equal(job(e, t.identifier).status, 'blocked');
  assert.equal(e.runner.calls.filter(c => c.role === 'coding').length, codingRuns);
});
