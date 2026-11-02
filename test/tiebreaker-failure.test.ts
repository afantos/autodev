import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { makeEnv, job } from './helpers.ts';
import { DEFAULTS } from '../src/agents/fake.ts';
import { FAILURE_RETRY_MS } from '../src/review-resolution.ts';
import type { AgentRunSpec } from '../src/agents/runner.ts';
import type { SecondReviewer } from '../src/agents/second-review.ts';

class Reviewer implements SecondReviewer {
  provider = 'openai'; model = 'test'; maxCostUsd() { return 0.1; } maxTestUpdateCostUsd() { return 0.1; }
  async reviewTestUpdate(): Promise<never> { throw new Error('unexpected'); }
  async review() { return { verdict: { verdict: 'approve' as const, summary: 'Matches requirements', findings: [], specConformance: 'ok' }, model: this.model, costUsd: 0.01, inputTokens: 1, outputTokens: 1 }; }
}
const payloadOf = (spec: AgentRunSpec) => JSON.parse(spec.prompt.split('<untrusted source="review-disagreement">')[1].split('</untrusted>')[0]);
const acceptAll = (spec: AgentRunSpec) => ({ summary: 'Approved under delegated authority.', riskTags: [], findings: payloadOf(spec).complaints.map((c: { id: string }) => ({
  id: c.id, action: 'accept', reason: 'This implements the requested change.', evidence: ['candidate diff'], futureTests: ['Verify the requested behavior and its failure case.'], followUp: null,
})) });

test('a failed policy tie-breaker stops the job once: no re-coding loop and no adjudication of the failure itself', async () => {
  const sources: string[] = [];
  const e = makeEnv({ project: { autoMerge: true, decisionMode: 'continue' }, config: { secondReview: { enabled: true } }, secondReviewer: new Reviewer(),
    behaviors: {
      coding: async (s, n) => { mkdirSync(dirname(join(s.cwd, 'src/pricing.ts')), { recursive: true }); writeFileSync(join(s.cwd, 'src/pricing.ts'), 'requested content\n'); return DEFAULTS.coding!(s, n); },
      arbitration: async s => { sources.push(payloadOf(s).source); return { ok: false, structured: null, error: 'Reached maximum budget ($0.5)' }; },
    } });
  const t = await e.tracker.createTicket({ projectKey: 'demo', title: 'Change pricing', description: 'Implement this approved change.', status: 'ready', priority: 2 });
  for (let i = 0; i < 5; i++) await e.cycle();
  const j = job(e, t.identifier);
  assert.equal(j.status, 'blocked');
  assert.deepEqual(sources, ['policy']);
  assert.equal(e.runner.calls.filter(c => c.role === 'coding').length, 1);
  assert.equal(j.pr_number ? (await e.scm.getPr(e.repo, j.pr_number)).state : 'none', 'none');
});

test('a failed adjudication is reused within the retry window and retried after it', async () => {
  let clock = Date.now();
  mock.method(Date, 'now', () => clock);
  try {
    const { resolveFailureFresh } = await import('../src/review-resolution.ts');
    assert.equal(resolveFailureFresh(JSON.stringify({ at: clock, note: 'x' })), true);
    clock += FAILURE_RETRY_MS + 1;
    assert.equal(resolveFailureFresh(JSON.stringify({ at: clock - FAILURE_RETRY_MS - 1, note: 'x' })), false);
    assert.equal(resolveFailureFresh('legacy plain note'), false);
  } finally {
    mock.restoreAll();
  }
});
