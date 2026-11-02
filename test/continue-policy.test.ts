import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { makeEnv, job } from './helpers.ts';
import { DEFAULTS } from '../src/agents/fake.ts';
import { snapshot } from '../src/report.ts';
import { resolveQuestion } from '../src/decisions.ts';
import { continuePolicyKey } from '../src/review-resolution.ts';
import type { Job } from '../src/types.ts';
import type { AgentRunSpec } from '../src/agents/runner.ts';
import type { SecondReviewer } from '../src/agents/second-review.ts';

function acceptAll(spec: AgentRunSpec) {
  const payload = JSON.parse(spec.prompt.split('<untrusted source="review-disagreement">')[1].split('</untrusted>')[0]);
  return { summary: 'Approved under delegated authority.', riskTags: ['user_data_security'], findings: payload.complaints.map((c: { id: string }) => ({
    id: c.id, action: 'accept', reason: 'This implements the requested change.', evidence: ['candidate diff'], futureTests: ['Verify the requested behavior and its failure case.'], followUp: null,
  })) };
}
class Reviewer implements SecondReviewer {
  provider = 'openai'; model = 'test'; maxCostUsd() { return 0.1; } maxTestUpdateCostUsd() { return 0.1; }
  async reviewTestUpdate(): Promise<never> { throw new Error('unexpected'); }
  async review() { return { verdict: { verdict: 'approve' as const, summary: 'Matches requirements', findings: [], specConformance: 'ok' }, model: this.model, costUsd: 0.01, inputTokens: 1, outputTokens: 1 }; }
}
const scenarios = [
  { name: 'alwaysHumanPaths', path: 'CHANGES.md', config: { alwaysHumanPaths: ['^CHANGES\\.md$'] } },
  { name: 'protected paths', path: 'CHANGES.md', config: { humanReviewPaths: ['^CHANGES\\.md$'] } },
  { name: 'payment', path: 'src/pricing.ts', config: {} },
  { name: 'security', path: 'src/auth/policy.ts', config: {} },
  { name: 'spec', path: 'docs/product-spec.md', config: { humanReviewPaths: ['^docs/product-spec\\.md$'] } },
  { name: 'deploy', path: 'deploy/worker.json', config: {} },
  { name: 'GitHub settings', path: '.github/settings.yml', config: {} },
];
for (const scenario of scenarios) for (const mode of ['ask', 'continue'] as const) {
  test(`${mode}: ${scenario.name} uses the selected approval authority`, async () => {
    const e = makeEnv({ project: { autoMerge: true, decisionMode: mode, ...scenario.config }, config: { secondReview: { enabled: true } }, secondReviewer: new Reviewer(),
      behaviors: { coding: async (s, n) => { mkdirSync(dirname(join(s.cwd, scenario.path)), { recursive: true }); writeFileSync(join(s.cwd, scenario.path), 'requested content\n'); return DEFAULTS.coding!(s, n); },
        arbitration: async s => ({ structured: acceptAll(s) }) } });
    const t = await e.tracker.createTicket({ projectKey: 'demo', title: `Change ${scenario.name}`, description: 'Implement this approved change.', status: 'ready', priority: 2 });
    await e.cycle();
    if (mode === 'ask') {
      assert.equal(job(e, t.identifier).status, 'blocked');
      assert.equal(e.runner.calls.filter(c => c.role === 'arbitration').length, 0);
    } else {
      assert.equal(job(e, t.identifier).status, 'awaiting_merge');
      await e.cycle(); const j = job(e, t.identifier);
      assert.equal((await e.scm.getPr(e.repo, j.pr_number)).state, 'merged');
      assert.equal(e.ctx.db.prepare("SELECT count(*) n FROM decisions WHERE status='pending_human'").get()?.n, 0);
      const records = e.ctx.db.prepare("SELECT authority,category FROM decisions WHERE authority='review_tiebreaker'").all();
      assert.ok(records.length); assert.ok(records.every(r => r.category === 'high_risk'));
      assert.ok((await snapshot(e.ctx, 0)).autoDecisions.length);
    }
  });
}

test('policy approval expires when protected findings or requirements change', () => {
  const k = continuePolicyKey('job', 'diff', 'req', ['one'], 'opus');
  assert.notEqual(k, continuePolicyKey('job', 'diff', 'req', ['one', 'new protected rule'], 'opus'));
  assert.notEqual(k, continuePolicyKey('job', 'diff', 'new req', ['one'], 'opus'));
});

test('general product blocker is decided and requeued without an owner question', async () => {
  const e = makeEnv({ project: { decisionMode: 'continue' }, behaviors: {
    coding: async (s, n) => {
      if (n === 1) await s.tools!.find(t => t.name === 'report_blocker')!.handler({ reason: 'Choose payment behavior', question: 'What pricing behavior should this use?', options: ['Use the proposed price'], recommendation: 'Use the proposed price' });
      return DEFAULTS.coding!(s, n);
    },
    decision: async () => ({ structured: { category: 'billing_pricing', options: [{ name: 'Use proposed price', pros: [], cons: [] }], recommendation: 'Use the proposed price', reasoning: 'Matches the request', evidence: ['ticket'], confidence: 0.9, requiresHuman: true, significantArchitecture: false, futureTests: ['Verify the selected price.'] } }),
    arbitration: async s => ({ structured: acceptAll(s) }),
  } });
  const t = await e.tracker.createTicket({ projectKey: 'demo', title: 'Price choice', description: '', status: 'ready', priority: 2 });
  await e.cycle(); assert.equal(job(e, t.identifier).status, 'queued');
  await e.cycle(); assert.equal(job(e, t.identifier).status, 'awaiting_merge');
  assert.equal(e.ctx.db.prepare("SELECT count(*) n FROM decisions WHERE status='pending_human'").get()?.n, 0);
  assert.match(e.runner.calls.filter(c => c.role === 'coding')[1].prompt, /Use the proposed price/);
});

test('risk tags only sort the log, including delegated payment questions', async () => {
  const e = makeEnv({ project: { decisionMode: 'continue' }, behaviors: { decision: async () => ({ structured: {
    category: 'billing_pricing', options: [{ name: 'A', pros: [], cons: [] }], recommendation: 'A', reasoning: 'Pricing choice', evidence: [], confidence: 0.8, requiresHuman: true, significantArchitecture: false, futureTests: ['Verify A.'],
  } }) } });
  const t = await e.tracker.createTicket({ projectKey: 'demo', title: 'Fixture', description: '', status: 'ready', priority: 2 }); await e.cycle(); const j = job(e, t.identifier) as Job;
  const outcome = await resolveQuestion(e.ctx, { job: j, ticket: t, project: e.ctx.cfg.projects[0], worktree: j.worktree!, question: 'Choose payment amount', context: '', options: [] });
  assert.equal(outcome.kind, 'answered');
  e.ctx.db.prepare("INSERT INTO decisions (id,repo,question,question_hash,category,decision,authority,status,created_at,resolved_at) VALUES ('routine-log-fixture',?,'Routine layout','routine-log-fixture','internal_structure','Use a helper','auto','resolved',0,0)").run(e.repo);
  const log = (await snapshot(e.ctx, 0)).autoDecisions;
  assert.equal(log[0].category, 'billing_pricing');
  assert.equal(log[1].id, 'routine-log-fixture');
});

test('continue delegates the final handoff even when autoMerge is off; ask preserves it', async () => {
  for (const mode of ['ask', 'continue'] as const) {
    const e = makeEnv({ project: { autoMerge: false, decisionMode: mode }, config: { secondReview: { enabled: true } }, secondReviewer: new Reviewer() });
    const t = await e.tracker.createTicket({ projectKey: 'demo', title: 'Handoff', description: '', status: 'ready', priority: 2 });
    await e.cycle(); await e.cycle(); const j = job(e, t.identifier);
    assert.equal((await e.scm.getPr(e.repo, j.pr_number)).state, mode === 'continue' ? 'merged' : 'open');
    assert.match(e.scm.prBody(j.pr_number), mode === 'continue' ? /Approval and merge decisions are delegated to autodev/ : /Merge authority stays with a human/);
  }
});

test('switching to ask cannot reuse delegated protected-diff approval', async () => {
  const e = makeEnv({ project: { autoMerge: true, decisionMode: 'continue', alwaysHumanPaths: ['^CHANGES\\.md$'] }, config: { secondReview: { enabled: true } }, secondReviewer: new Reviewer(),
    behaviors: { arbitration: async s => ({ structured: acceptAll(s) }) } });
  const t = await e.tracker.createTicket({ projectKey: 'demo', title: 'Protected change', description: '', status: 'ready', priority: 2 });
  await e.cycle(); const j = job(e, t.identifier);
  e.ctx.cfg.projects[0].decisionMode = 'ask'; await e.cycle();
  assert.equal((await e.scm.getPr(e.repo, j.pr_number)).state, 'open');
  assert.match((await e.tracker.listComments(t.id)).map(c => c.body).join('\n'), /a human needs to review/);
});

test('a terminal validation stop is automatically adjudicated under continue', async () => {
  const e = makeEnv({ project: { decisionMode: 'continue', validate: ['false'] }, config: { limits: { maxFixAttempts: 0 } }, behaviors: {
    decision: async () => ({ structured: { category: 'validation', options: [{ name: 'Repair', pros: [], cons: [] }], recommendation: 'Repair the failing implementation and rerun validation.', reasoning: 'Validation must pass.', evidence: ['validation log'], confidence: 0.9, requiresHuman: false, significantArchitecture: false, futureTests: ['Run the original failing check successfully.'] } }),
  } });
  const t = await e.tracker.createTicket({ projectKey: 'demo', title: 'Validation recovery', description: '', status: 'ready', priority: 2 }); await e.cycle();
  assert.equal(job(e, t.identifier).status, 'queued');
  assert.equal(e.ctx.db.prepare("SELECT count(*) n FROM decisions WHERE status='pending_human'").get()?.n, 0);
  assert.equal(e.runner.calls.find(c => c.role === 'decision')?.model, 'opus');
  assert.match(job(e, t.identifier).pending_feedback, /Repair the failing implementation/);
});

test('protected-path rework returns to coding and validation without owner approval', async () => {
  const e = makeEnv({ project: { autoMerge: true, decisionMode: 'continue', alwaysHumanPaths: ['^CHANGES\\.md$'] }, config: { secondReview: { enabled: true } }, secondReviewer: new Reviewer(),
    behaviors: { arbitration: async (s, n) => { const result = acceptAll(s); if (n === 1) for (const f of result.findings) { f.action = 'rework'; f.reason = 'Add the requested boundary handling before continuing.'; } return { structured: result }; } } });
  const t = await e.tracker.createTicket({ projectKey: 'demo', title: 'Protected repair', description: '', status: 'ready', priority: 2 });
  await e.cycle(); assert.equal(job(e, t.identifier).status, 'queued');
  await e.cycle(); await e.cycle(); const j = job(e, t.identifier);
  assert.equal((await e.scm.getPr(e.repo, j.pr_number)).state, 'merged');
  assert.equal(e.runner.calls.filter(c => c.role === 'coding').length, 2);
  assert.equal(j.validated_sha, j.candidate_sha);
  assert.equal(e.ctx.db.prepare("SELECT count(*) n FROM decisions WHERE status='pending_human'").get()?.n, 0);
});
