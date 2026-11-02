import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeEnv, job } from './helpers.ts';
import { DEFAULTS } from '../src/agents/fake.ts';
import { kvGet, updateJob } from '../src/db.ts';
import { autoMergeStep, requirementsHash } from '../src/automerge.ts';
import { resolveReview, ResolutionSchema, completeResolution } from '../src/review-resolution.ts';
import { snapshot } from '../src/report.ts';
import { riskReasons } from '../src/risk-tags.ts';
import { resolveQuestion, recordHumanDecision } from '../src/decisions.ts';
import type { Job } from '../src/types.ts';
import type { SecondReviewer, SecondReviewVerdict } from '../src/agents/second-review.ts';

const disputed = { outcome: 'changes_requested', summary: 'Consider a boundary case.', acceptanceCriteria: [],
  findings: [{ severity: 'major', file: 'CHANGES.md', issue: 'Boundary case lacks coverage', suggestion: 'Add a targeted regression test' }], followUps: [] };
const verdict: SecondReviewVerdict = { verdict: 'request_changes', summary: disputed.summary, specConformance: 'Requirements unchanged.',
  findings: [{ ...disputed.findings[0], severity: 'major', category: 'tests', line: 1 }] };
class Reviewer implements SecondReviewer {
  provider = 'openai'; model = 'test-reviewer';
  maxCostUsd() { return 0.1; }
  maxTestUpdateCostUsd() { return 0.1; }
  async reviewTestUpdate(): Promise<never> { throw new Error('unexpected integrity review'); }
  async review() { return { verdict, model: this.model, costUsd: 0.01, inputTokens: 1, outputTokens: 1 }; }
}
const resolution = (action: 'accept' | 'rework' | 'follow_up' = 'accept') => ({ summary: 'Checked the existing branch behavior.', riskTags: [],
  findings: [{ id: 'finding-0', action, reason: 'Existing bounds already reject malformed values; additional coverage can be tracked.',
    evidence: ['src/index.js:1'], futureTests: ['Reject Infinity without looping.'],
    followUp: action === 'follow_up' ? { title: 'Add parser boundary regression', description: 'Assert Infinity is rejected; acceptance: the test passes without a loop.' } : null }] });
const ready = (e: ReturnType<typeof makeEnv>, title = 'Parser improvement') => e.tracker.createTicket({ projectKey: 'demo', title, description: 'Implement existing requirements.', status: 'ready', priority: 2 });
const notes = async (e: ReturnType<typeof makeEnv>, id: string) => (await e.tracker.listComments(id)).map(c => c.body).join('\n');

for (const source of ['merge_review', 'review_loop'] as const) {
  for (const action of ['accept', 'follow_up'] as const) {
    test(`${source}: continue ${action} persists evidence and resumes without a human`, async () => {
      const e = makeEnv({ project: { autoMerge: source === 'merge_review', decisionMode: 'continue' },
        config: { limits: { maxReviewCycles: 0 }, secondReview: { enabled: source === 'merge_review' } }, secondReviewer: new Reviewer(),
        behaviors: { ...(source === 'review_loop' ? { review: async () => ({ structured: disputed }) } : {}), arbitration: async () => ({ structured: resolution(action) }) } });
      const t = await ready(e);
      await e.cycle();
      if (source === 'merge_review') await e.cycle();
      const j = job(e, t.identifier);
      assert.equal((await e.scm.getPr(e.repo, j.pr_number)).state, source === 'merge_review' ? 'merged' : 'open');
      assert.equal(j.status, 'awaiting_merge');
      assert.equal(e.runner.calls.filter(c => c.role === 'arbitration').length, 1);
      assert.equal(e.runner.calls.find(c => c.role === 'arbitration')!.model, 'opus');
      const row = e.ctx.db.prepare("SELECT * FROM decisions WHERE authority='review_tiebreaker'").get() as Record<string, any>;
      assert.equal(row.status, 'resolved');
      assert.ok((await snapshot(e.ctx, 0)).autoDecisions.some(d => d.id === row.id));
      assert.match(readFileSync(row.adr_path, 'utf8'), /Reject Infinity/);
      assert.match(await notes(e, t.id), /AI tie-breaker/);
      if (source === 'review_loop') assert.match(e.scm.prBody(j.pr_number), /Disagreement resolution/);
      if (action === 'follow_up') {
        const follow = (await e.tracker.listTickets()).filter(x => x.id !== t.id);
        assert.equal(follow.length, 1);
        assert.equal(follow[0].status, 'ready');
        assert.ok(follow[0].blockedBy.includes(t.id));
        assert.match(follow[0].description, /- \[ \] Reject Infinity/);
        assert.match(await notes(e, t.id), new RegExp(follow[0].identifier));
      }
    });
  }
}

for (const source of ['merge_review', 'review_loop'] as const) {
  test(`${source}: tie-breaker requests one rework and revalidates the new candidate`, async () => {
    const e = makeEnv({ project: { autoMerge: source === 'merge_review', decisionMode: 'continue' },
      config: { limits: { maxReviewCycles: 0 }, secondReview: { enabled: source === 'merge_review' } }, secondReviewer: new Reviewer(),
      behaviors: { ...(source === 'review_loop' ? { review: async () => ({ structured: disputed }) } : {}), arbitration: async (_s, n) => ({ structured: resolution(n === 1 ? 'rework' : 'accept') }) } });
    const t = await ready(e);
    for (let i = 0; i < 4; i++) await e.cycle();
    const j = job(e, t.identifier);
    assert.equal(e.runner.calls.filter(c => c.role === 'arbitration').length, 2);
    assert.equal(j.validated_sha, j.candidate_sha);
    assert.equal(j.reviewed_sha, j.candidate_sha);
    assert.equal(e.runner.calls.filter(c => c.role === 'coding').length, 2);
    assert.match(e.runner.calls.filter(c => c.role === 'coding')[1].prompt, /targeted|finding-0/);
    assert.equal((await e.scm.getPr(e.repo, j.pr_number)).state, source === 'merge_review' ? 'merged' : 'open');
  });
}

test('always-ask list covers protected topics and paths without treating spec conformance as a spec edit', () => {
  for (const text of ['change payment amounts', 'award prizes', 'export user data', 'security fix', 'GitHub settings', 'change branch protection', 'deployment', 'rotate secrets', 'increase budget', 'change the spec']) {
    assert.ok(riskReasons(text).length, text);
  }
  for (const path of ['docs/product-spec.md', '.github/workflows/ci.yml', 'deploy/worker.env', '.env.local']) assert.ok(riskReasons('', [path]).length, path);
  assert.deepEqual(riskReasons('Fix the implementation to match the spec.', ['test/parser.spec.ts']), []);
});

test('protected questions are delegated under continue', async () => {
  const e = makeEnv({ project: { decisionMode: 'continue' }, behaviors: { decision: async () => ({ structured: {
    category: 'internal_structure', options: [{ name: 'Raise', pros: [], cons: [] }], recommendation: 'Raise the budget', reasoning: 'More capacity',
    evidence: [], confidence: 1, requiresHuman: false, significantArchitecture: false, futureTests: ['Verify the limit'],
  } }) } });
  const t = await ready(e); await e.cycle(); const j = job(e, t.identifier);
  const out = await resolveQuestion(e.ctx, { job: j as Job, ticket: t, project: e.ctx.cfg.projects[0], worktree: j.worktree, question: 'Increase budget?', context: '', options: [] });
  assert.equal(out.kind, 'answered');
  assert.match(out.kind === 'answered' ? out.text : '', /delegated/);
});

test('ask preserves protected spec review', async () => {
  const e = makeEnv({ project: { decisionMode: 'ask', humanReviewPaths: ['^docs/product-spec\\.md$'] }, behaviors: { coding: async (s, n) => {
    mkdirSync(join(s.cwd, 'docs')); writeFileSync(join(s.cwd, 'docs/product-spec.md'), 'new requirement'); return DEFAULTS.coding!(s, n);
  } } });
  const t = await ready(e); await e.cycle();
  assert.equal(job(e, t.identifier).status, 'blocked');
  assert.match(await notes(e, t.id), /protected path/);
  assert.equal(e.runner.calls.filter(c => c.role === 'arbitration').length, 0);
});

test('incomplete or duplicate complaint IDs and missing follow-up details are rejected', () => {
  const r = ResolutionSchema.parse(resolution());
  assert.equal(completeResolution(r, [{ id: 'finding-0', issue: 'x' }, { id: 'finding-1', issue: 'y' }]), false);
  assert.equal(completeResolution({ ...r, findings: [r.findings[0], r.findings[0]] }, [{ id: 'finding-0', issue: 'x' }, { id: 'finding-1', issue: 'y' }]), false);
  assert.equal(completeResolution({ ...r, findings: [{ ...r.findings[0], action: 'follow_up', followUp: null }] }, [{ id: 'finding-0', issue: 'x' }]), false);
});

test('follow-up creation failure prevents merge, retry reuses the verdict and creates one ticket', async () => {
  const e = makeEnv({ project: { autoMerge: true, decisionMode: 'continue' }, config: { limits: { maxReviewCycles: 0 }, secondReview: { enabled: true } },
    secondReviewer: new Reviewer(), behaviors: { arbitration: async () => ({ structured: resolution('follow_up') }) } });
  const t = await ready(e); await e.cycle();
  const create = e.tracker.createTicket.bind(e.tracker);
  e.tracker.createTicket = async () => { throw new Error('tracker outage'); };
  await e.cycle();
  let j = job(e, t.identifier);
  assert.equal((await e.scm.getPr(e.repo, j.pr_number)).state, 'open');
  assert.equal(kvGet(e.ctx.db, `local-approval:${j.pr_number}`), null);
  e.tracker.createTicket = create;
  await e.cycle(); j = job(e, t.identifier);
  assert.equal((await e.scm.getPr(e.repo, j.pr_number)).state, 'merged');
  assert.equal(e.runner.calls.filter(c => c.role === 'arbitration').length, 1);
  assert.equal((await e.tracker.listTickets()).length, 2);
});

test('a hold-merge label stays a hard stop in continue', async () => {
  const e = makeEnv({ project: { autoMerge: true, decisionMode: 'continue' }, config: { linear: { holdMergeEnabled: true }, limits: { maxReviewCycles: 0 }, secondReview: { enabled: true } }, secondReviewer: new Reviewer(),
    behaviors: { arbitration: async () => { await e.tracker.addLabel(t.id, 'hold-merge'); return { structured: resolution() }; } } });
  const t = await ready(e); await e.cycle(); await e.cycle(); const j = job(e, t.identifier);
  assert.equal((await e.scm.getPr(e.repo, j.pr_number)).state, 'open');
  assert.equal(kvGet(e.ctx.db, `local-approval:${j.pr_number}`), null);
  assert.equal(e.runner.calls.filter(c => c.role === 'arbitration' && /merge hold/i.test(c.prompt ?? '')).length, 0);
});

test('risk tags do not pause continuation', async () => {
  const e = makeEnv({ project: { autoMerge: true, decisionMode: 'continue' }, config: { limits: { maxReviewCycles: 0 }, secondReview: { enabled: true } }, secondReviewer: new Reviewer(),
    behaviors: { arbitration: async () => ({ structured: { ...resolution(), riskTags: ['user_data_security'] } }) } });
  const t = await ready(e); await e.cycle(); await e.cycle(); const j = job(e, t.identifier);
  assert.equal((await e.scm.getPr(e.repo, j.pr_number)).state, 'merged');
  assert.match(await notes(e, t.id), /Risk tags.*user_data_security/);
  assert.equal(e.ctx.db.prepare("SELECT status FROM decisions WHERE authority='review_tiebreaker'").get()?.status, 'resolved');
});

test('continue keeps rework autonomous after the old retry boundary', async () => {
  const e = makeEnv({ project: { autoMerge: true, decisionMode: 'continue' }, config: { limits: { maxReviewCycles: 0 }, secondReview: { enabled: true } }, secondReviewer: new Reviewer(),
    behaviors: { arbitration: async () => ({ structured: resolution('rework') }) } });
  const t = await ready(e); for (let i = 0; i < 6; i++) await e.cycle(); const j = job(e, t.identifier);
  assert.ok(e.runner.calls.filter(c => c.role === 'coding').length > 2);
  assert.ok(e.runner.calls.filter(c => c.role === 'arbitration').length > 2);
  assert.equal((await e.scm.getPr(e.repo, j.pr_number)).state, 'open');
  assert.doesNotMatch(await notes(e, t.id), /a human needs to review/);
});

test('continue preserves failing CI and ask mode never invokes the tie-breaker', async () => {
  for (const mode of ['ask', 'continue'] as const) {
    const e = makeEnv({ project: { autoMerge: true, decisionMode: mode }, config: { limits: { maxReviewCycles: 0 }, secondReview: { enabled: true } }, secondReviewer: new Reviewer(),
      behaviors: { arbitration: async () => ({ structured: resolution() }) } });
    const t = await ready(e); await e.cycle();
    const j = job(e, t.identifier);
    if (mode === 'continue') e.scm.checks = async () => ({ state: 'failure', failures: [], logExcerpt: 'failed' });
    await autoMergeStep(e.ctx, j as Job, (await e.tracker.getTicket(t.id))!, e.ctx.cfg.projects[0]);
    assert.equal(e.runner.calls.filter(c => c.role === 'arbitration').length, mode === 'continue' ? 1 : 0);
    assert.equal((await e.scm.getPr(e.repo, j.pr_number)).state, 'open');
  }
});

test('changed requirements invalidate the cached tie-breaker and its follow-up receipts', async () => {
  const e = makeEnv({ project: { decisionMode: 'continue' }, behaviors: { arbitration: async () => ({ structured: resolution() }) } });
  const t = await ready(e); await e.cycle(); const j = job(e, t.identifier) as Job;
  const input = { source: 'merge_review' as const, requirements: requirementsHash(e.ctx, t), summary: 'Boundary coverage', complaints: [{ id: 'finding-0', issue: 'Check boundary' }] };
  assert.equal((await resolveReview(e.ctx, j, t, e.ctx.cfg.projects[0], input)).kind, 'accept');
  assert.equal((await resolveReview(e.ctx, j, t, e.ctx.cfg.projects[0], input)).kind, 'accept');
  assert.equal(e.runner.calls.filter(c => c.role === 'arbitration').length, 1);
  recordHumanDecision(e.ctx, null, 'Reject Infinity before parsing', { ticket: t, repo: j.repo, question: 'How should Infinity behave?' });
  assert.equal((await resolveReview(e.ctx, j, t, e.ctx.cfg.projects[0], { ...input, requirements: requirementsHash(e.ctx, t) })).kind, 'accept');
  assert.equal(e.runner.calls.filter(c => c.role === 'arbitration').length, 2);
  assert.match(e.runner.calls.filter(c => c.role === 'arbitration')[1].prompt, /Reject Infinity before parsing/);
});

test('a journal write failure cannot lead to approval', async () => {
  const e = makeEnv({ project: { autoMerge: true, decisionMode: 'continue' }, config: { limits: { maxReviewCycles: 0 }, secondReview: { enabled: true } }, secondReviewer: new Reviewer(),
    behaviors: { arbitration: async () => ({ structured: resolution() }) } });
  const t = await ready(e); await e.cycle();
  writeFileSync(join(e.ctx.cfg.dataDir, 'review-decisions'), 'cannot write a directory here');
  await e.cycle(); const j = job(e, t.identifier);
  assert.equal((await e.scm.getPr(e.repo, j.pr_number)).state, 'open');
  assert.equal(kvGet(e.ctx.db, `local-approval:${j.pr_number}`), null);
});

test('enabling continue resumes the existing exhausted-review stop without a new coding round', async () => {
  const e = makeEnv({ config: { limits: { maxReviewCycles: 0 } }, behaviors: { review: async () => ({ structured: disputed }), arbitration: async () => ({ structured: resolution() }) } });
  const t = await ready(e); await e.cycle();
  assert.equal(job(e, t.identifier).status, 'blocked');
  e.ctx.cfg.projects[0].decisionMode = 'continue';
  await e.cycle();
  assert.equal(job(e, t.identifier).status, 'awaiting_merge');
  assert.equal(e.runner.calls.filter(c => c.role === 'coding').length, 1);
  assert.equal(e.runner.calls.filter(c => c.role === 'arbitration').length, 1);
  assert.equal(e.ctx.db.prepare("SELECT count(*) n FROM decisions WHERE status='pending_human'").get()?.n, 0);
});


test('quoted Git paths cannot evade the always-ask list', async () => {
  const e = makeEnv({ project: { decisionMode: 'ask', humanReviewPaths: ['^\\.github/'] }, behaviors: { coding: async (s, n) => {
    mkdirSync(join(s.cwd, '.github/workflows'), { recursive: true });
    writeFileSync(join(s.cwd, '.github/workflows/ci\tname.yml'), 'name: example');
    return DEFAULTS.coding!(s, n);
  } } });
  const t = await ready(e); await e.cycle();
  assert.equal(job(e, t.identifier).status, 'blocked');
  assert.match(await notes(e, t.id), /protected path/);
});

test('invalid adjudication cannot approve or repeatedly spend on unchanged inputs', async () => {
  const e = makeEnv({ project: { autoMerge: true, decisionMode: 'continue' }, config: { limits: { maxReviewCycles: 0 }, secondReview: { enabled: true } }, secondReviewer: new Reviewer(),
    behaviors: { arbitration: async () => ({ structured: { ...resolution(), findings: [] } }) } });
  const t = await ready(e); for (let i = 0; i < 4; i++) await e.cycle(); const j = job(e, t.identifier);
  assert.equal(e.runner.calls.filter(c => c.role === 'arbitration').length, 1);
  assert.equal((await e.scm.getPr(e.repo, j.pr_number)).state, 'open');
  assert.equal(kvGet(e.ctx.db, `local-approval:${j.pr_number}`), null);
});
